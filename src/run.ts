// Runs probe items against decision models and stores raw responses.
// Usage: node src/run.ts --items suite/core.jsonl,private/core.jsonl --run base [--models all|id1,id2] [--variants shuffle,para] [--per-model 3] [--parallel-models 6]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, type Question, fetchCatalog, decide, keyUsage, BUDGET_STOP, pool, loadItems, sha256, canonical, shuffled } from './lib.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));

const itemFiles = (args.items ?? '').split(',').filter(Boolean);
const runName = args.run ?? 'base';
const date = args.date ?? new Date().toISOString().slice(0, 10);
const variants = new Set((args.variants ?? '').split(',').filter(Boolean));
const perModel = Number(args['per-model'] ?? 3);
const parallelModels = Number(args['parallel-models'] ?? 6);
const limitItems = args.limit ? Number(args.limit) : Infinity;

interface Job { item: Item; variant: 'base' | 'shuffle' | 'para'; questions: Record<string, Question>; }

function buildJobs(items: Item[]): Job[] {
  const jobs: Job[] = [];
  for (const item of items.slice(0, limitItems)) {
    jobs.push({ item, variant: 'base', questions: item.questions });
    if (variants.has('shuffle')) {
      const qs: Record<string, Question> = {};
      let any = false;
      for (const [qid, q] of Object.entries(item.questions)) {
        if (q.type === 'choice' && q.criteria && !Array.isArray(q.criteria)) {
          const keys = shuffled(Object.keys(q.criteria), `${item.id}:${qid}`);
          qs[qid] = { ...q, criteria: Object.fromEntries(keys.map(k => [k, (q.criteria as any)[k]])) };
          any = true;
        } else qs[qid] = q;
      }
      if (any) jobs.push({ item, variant: 'shuffle', questions: qs });
    }
    const para = (item as any).paraphrases as Record<string, string> | undefined;
    if (variants.has('para') && para) {
      const qs = Object.fromEntries(Object.entries(item.questions).map(([qid, q]) => [qid, para[qid] ? { ...q, instructions: para[qid] } : q]));
      jobs.push({ item, variant: 'para', questions: qs });
    }
  }
  return jobs;
}

const items = loadItems(...itemFiles);
const jobs = buildJobs(items);
const catalog = await fetchCatalog();
const excluded: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/models-excluded.json'), 'utf8'));
// Provider pins: from `since`, requests for these models go only to the maker (no fallback).
const pins: Record<string, { provider: string; since: string }> = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/provider-pins.json'), 'utf8'));
const pinOf = (m: string) => (pins[m]?.provider && pins[m].since <= date ? pins[m].provider : null);
const models = args.models && args.models !== 'all' ? args.models.split(',') : catalog.map(m => m.id).filter(id => !(id in excluded));

const start = await keyUsage();
console.log(`run=${runName} date=${date} items=${items.length} jobs/model=${jobs.length} models=${models.length} key_usage=$${start.usage.toFixed(4)} stop_at=$${BUDGET_STOP}`);
if (start.usage >= BUDGET_STOP) { console.error('Budget stop reached before start.'); process.exit(2); }

let done = 0, failed = 0, spent = 0, stopped = false;
const t0 = Date.now();
const safe = (m: string) => m.replace(/[^a-zA-Z0-9._-]/g, '_');

await pool(models, parallelModels, async (model) => {
  const outDirs = { public: path.join(ROOT, 'results', date, runName), private: path.join(ROOT, 'private', 'results', date, runName) };
  // open a stream lazily so runs with only private items leave no empty public files
  const opened: Partial<Record<'public' | 'private', fs.WriteStream>> = {};
  const stream = (k: 'public' | 'private') => {
    if (!opened[k]) { fs.mkdirSync(outDirs[k], { recursive: true }); opened[k] = fs.createWriteStream(path.join(outDirs[k], `${safe(model)}.jsonl`), { flags: 'a' }); }
    return opened[k]!;
  };
  let consecutiveFail = 0;
  await pool(jobs, perModel, async (job) => {
    if (stopped || consecutiveFail >= 8) return;
    const pin = pinOf(model);
    const res = await decide(model, job.item.state, job.questions, pin ? { provider: { only: [pin], allow_fallbacks: false } } : {});
    const rec = {
      item_id: job.item.id, variant: job.variant, model_requested: model,
      model_served: res.response?.model ?? null, provider: res.response?.provider ?? null, provider_pin: pin,
      ok: res.ok, status: res.status, latency_ms: res.latency_ms, attempts: res.attempts,
      answers: res.response?.answers ?? null, usage: res.response?.usage ?? null,
      error: res.error ?? null, ts: new Date().toISOString(),
      req_hash: sha256(canonical({ state: job.item.state, questions: job.questions })),
    };
    stream(job.item.split === 'private' ? 'private' : 'public').write(JSON.stringify(rec) + '\n');
    done++;
    spent += Number(res.response?.usage?.cost ?? 0);
    if (res.ok) consecutiveFail = 0; else { failed++; consecutiveFail++; }
    if (done % 500 === 0) {
      const u = await keyUsage();
      console.log(`  ${done} calls, ${failed} failed, ~$${spent.toFixed(4)} this run, key usage $${u.usage.toFixed(4)}, ${Math.round((Date.now() - t0) / 1000)}s`);
      // fall back to locally tracked spend when the key endpoint is unavailable
      const est = Number.isFinite(u.usage) ? u.usage : start.usage + spent;
      if (est >= BUDGET_STOP) { stopped = true; console.error('BUDGET STOP'); }
    }
  });
  if (consecutiveFail >= 8) console.log(`  gave up on ${model} after repeated failures`);
  await Promise.all(Object.values(opened).map(s => new Promise(r => s!.end(r))));
});

const end = await keyUsage();
console.log(`finished: ${done} calls, ${failed} failed, run cost ~$${spent.toFixed(4)}, key usage $${end.usage.toFixed(4)}, ${Math.round((Date.now() - t0) / 1000)}s${stopped ? ' (BUDGET STOP)' : ''}`);
