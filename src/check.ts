// Pre-push check for code changes. Sends a few public items (one per family, so every question type and both
// variants are covered) to every model in the catalog, checks that the answers parse, then builds the site into a
// temp dir. It fails on patterns that point at our code, not on one vendor's outage: those are only listed.
// Spends real OpenRouter money (a cent or two). Results go to a throwaway run and are deleted afterwards.
// Usage: node src/check.ts [--models id1,id2] [--deadline 60] [--keep true]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, type Item, fetchCatalog, loadItems } from './lib.ts';
import { normalize, loadRun } from './answers.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const deadline = Number(args.deadline ?? 60);   // seconds for the model calls; a hung model must not block a push
const date = new Date().toISOString().slice(0, 10);
const run = `check-${process.pid}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-drift-check-'));
const runDir = path.join(ROOT, 'results', date, run);

// One item per family, preferring one with paraphrases so the `para` variant is exercised too.
const byFamily = new Map<string, Item>();
for (const it of loadItems('suite/core-v1.public.jsonl')) {
  const cur = byFamily.get(it.family);
  if (!cur || (!(cur as any).paraphrases && (it as any).paraphrases)) byFamily.set(it.family, it);
}
const items = [...byFamily.values()];
const itemsFile = path.join(tmp, 'items.jsonl');
fs.writeFileSync(itemsFile, items.map(i => JSON.stringify(i)).join('\n') + '\n');

// The jobs run.ts builds for these items (same rules as buildJobs there).
const shuffles = (it: Item) => Object.values(it.questions).some(q => q.type === 'choice' && q.criteria && !Array.isArray(q.criteria));
const variantsOf = (it: Item) => ['base', ...(shuffles(it) ? ['shuffle'] : []), ...((it as any).paraphrases ? ['para'] : [])];
const expected = items.reduce((n, it) => n + variantsOf(it).length, 0);
const types = [...new Set(items.flatMap(it => Object.values(it.questions).map(q => q.type)))].sort();
const variants = [...new Set(items.flatMap(variantsOf))];

const excluded: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/models-excluded.json'), 'utf8'));
const models = args.models ? args.models.split(',') : (await fetchCatalog()).map(m => m.id).filter(id => !(id in excluded));
console.log(`check: ${items.length} items (${items.map(i => i.id).join(', ')}), ${expected} calls/model, ${models.length} models, question types ${types.join('/')}`);

const fails: string[] = [];
const warns: string[] = [];
let siteOk = false;
try {
  const r = spawnSync(process.execPath, ['src/run.ts', '--items', itemsFile, '--run', run, '--date', date, '--models', args.models ?? 'all',
    '--variants', 'shuffle,para', '--parallel-models', '12', '--per-model', '5'], { cwd: ROOT, stdio: 'inherit', timeout: deadline * 1000 });
  const timedOut = (r.error as any)?.code === 'ETIMEDOUT';
  if (timedOut) warns.push(`model calls stopped at the ${deadline}s deadline; models it cut short show calls not made`);
  else if (r.status !== 0) fails.push(`run.ts exited with ${r.status ?? r.signal}`);

  const recs = loadRun(date, run);
  const itemOf = new Map(items.map(i => [i.id, i]));
  const okByType: Record<string, number> = Object.fromEntries(types.map(t => [t, 0]));
  const okByVariant: Record<string, number> = Object.fromEntries(variants.map(v => [v, 0]));
  let dead = 0;
  console.log('');
  for (const m of models) {
    const rs = recs.get(m) ?? [];
    const ok = rs.filter(r => r.ok);
    let bad = 0;   // questions whose answer is missing, unparseable or of the wrong type
    for (const r of ok) {
      okByVariant[r.variant]++;
      for (const [qid, q] of Object.entries(itemOf.get(r.item_id)!.questions)) {
        if (normalize(r.answers?.[qid])?.type === q.type) okByType[q.type]++; else bad++;
      }
    }
    const errs = [...new Set(rs.filter(r => !r.ok).map(r => `${r.status}${r.error ? ' ' + r.error.replace(/\s+/g, ' ').slice(0, 80) : ''}`))];
    const notes = [
      ...(rs.length < expected ? [rs.length ? `${expected - rs.length} calls not made` : 'no records'] : []),
      ...(bad ? [`${bad} answers did not parse`] : []),
      ...errs,
    ];
    if (!ok.length) dead++;
    console.log(`${notes.length ? (ok.length ? 'warn' : 'FAIL') : 'ok  '}  ${m.padEnd(40)} ${String(ok.length).padStart(3)}/${expected}${notes.length ? '  ' + notes.join('; ') : ''}`);
    if (notes.length) warns.push(`${m}: ${notes.join('; ')}`);
  }
  console.log('');

  if (dead === models.length) fails.push('no model returned a successful answer');
  else if (dead > models.length / 2) fails.push(`${dead} of ${models.length} models returned no successful answer`);
  else {
    for (const t of types) if (!okByType[t]) fails.push(`no model returned a valid "${t}" answer`);
    for (const v of variants) if (!okByVariant[v]) fails.push(`no model answered a "${v}" variant`);
  }

  // Models the next daily run will add or lose, compared with the latest committed report.
  const last = fs.readdirSync(path.join(ROOT, 'reports')).filter(f => f.endsWith('-daily.json')).sort().pop();
  if (last && !args.models) {
    const known = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', last), 'utf8')).perModel ?? {}));
    const added = models.filter(m => !known.has(m)), gone = [...known].filter(m => !models.includes(m));
    if (added.length) console.log(`new since ${last}: ${added.join(', ')}`);
    if (gone.length) console.log(`in ${last} but no longer collected: ${gone.join(', ')}`);
  }

  const s = spawnSync(process.execPath, ['src/site.ts', '--out', path.join(tmp, 'site')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  siteOk = s.status === 0;
  if (!siteOk) fails.push(`site build failed: ${(s.stderr || s.stdout || String(s.error ?? '')).trim().split('\n').slice(-3).join(' | ')}`);
  else console.log(`site: ${s.stdout.trim().split('\n').pop()?.replace(/ into .* from /, ' from ')}`);
} finally {
  if (args.keep !== 'true') {
    fs.rmSync(runDir, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(runDir)); } catch { /* today's real results are there: leave them */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  } else console.log(`kept: ${runDir} and ${tmp}`);
}

if (warns.length) console.log(`\n${warns.length} warning${warns.length > 1 ? 's' : ''} (not blocking):\n${warns.map(w => '  - ' + w).join('\n')}`);
if (fails.length) { console.error(`\nCHECK FAILED:\n${fails.map(f => '  - ' + f).join('\n')}`); process.exit(1); }
console.log('\nCHECK PASSED');
