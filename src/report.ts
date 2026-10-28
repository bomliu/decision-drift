// Computes per-model metrics for a run and writes reports/<date>-<run>.md + .json.
// Usage: node src/report.ts --date 2026-10-20 --run day1 [--dup day1-dup] [--compare-date 2026-10-20 --compare-run pilot]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, loadItems } from './lib.ts';
import { normalize, loadRun, tv, goldMatches, quantile, mean, wilson, type Rec, type Norm } from './answers.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] ?? 'true']); return acc;
}, []));
const date = args.date, run = args.run;
const items = loadItems('suite/core-v1.public.jsonl', 'private/core-v1.private.jsonl');
const itemById = new Map(items.map(i => [i.id, i]));
const main = loadRun(date, run);
const dup = args.dup ? loadRun(date, args.dup) : new Map<string, Rec[]>();
const cmp = new Map<string, Rec[]>();
for (const rn of (args['compare-run'] ?? '').split(',').filter(Boolean))
  for (const [m, recs] of loadRun(args['compare-date'] ?? date, rn)) cmp.set(m, [...(cmp.get(m) ?? []), ...recs]);

type Answers = Map<string, Norm>; // key `${item}|${qid}`
function index(recs: Rec[] | undefined, variant: string): Answers {
  const m: Answers = new Map();
  for (const r of recs ?? []) {
    if (r.variant !== variant || !r.ok || !r.answers || !itemById.has(r.item_id)) continue;
    for (const [qid, a] of Object.entries(r.answers)) { const n = normalize(a); if (n) { n.req = r.req_hash?.slice(0, 16); n.provider = r.provider; m.set(`${r.item_id}|${qid}`, n); } }
  }
  return m;
}
function compare(a: Answers, b: Answers, filter?: (key: string, n: Norm) => boolean, crossRequest = false) {
  let flips = 0, n = 0; const tvs: number[] = [];
  for (const [k, x] of a) { const y = b.get(k); if (!y || (filter && !filter(k, x))) continue; if (x.req && y.req && x.req !== y.req && !crossRequest) continue; n++; if (x.top !== y.top) flips++; tvs.push(tv(x.dist, y.dist)); }
  const [lo, hi] = wilson(flips, n);
  return { n, flips, flip_rate: n ? flips / n : NaN, ci: [lo, hi], mean_tv: mean(tvs) };
}
const qType = (k: string) => { const [id, q] = k.split('|'); return itemById.get(id)!.questions[q]?.type; };
const fam = (k: string) => itemById.get(k.split('|')[0])!.family;

const models = [...main.keys()].sort();
const perModel: Record<string, any> = {};
for (const m of models) {
  const recs = main.get(m)!;
  const base = index(recs, 'base');
  const ok = recs.filter(r => r.ok), lat = ok.map(r => r.latency_ms);
  const baseRecs = recs.filter(r => r.variant === 'base');
  const cost = recs.reduce((s, r) => s + Number(r.usage?.cost ?? 0), 0);
  // accuracy and calibration on gold questions
  let correct = 0, graded = 0; const conf: number[] = []; const hit: number[] = []; const brier: number[] = [];
  const byType: Record<string, [number, number]> = {};
  for (const [k, n] of base) {
    const [id, q] = k.split('|'); const g = itemById.get(id)!.gold?.[q];
    if (g === undefined) continue;
    const okAns = goldMatches(n, g); graded++; if (okAns) correct++;
    const t = byType[n.type] ??= [0, 0]; t[1]++; if (okAns) t[0]++;
    conf.push(Math.max(...Object.values(n.dist))); hit.push(okAns ? 1 : 0);
    if (n.type === 'noul') brier.push((n.p! - (g ? 1 : 0)) ** 2);
  }
  // 10-bin ECE on top-answer probability
  const bins = Array.from({ length: 10 }, () => ({ c: 0, a: 0, n: 0 }));
  conf.forEach((c, i) => { const b = bins[Math.min(9, Math.floor(c * 10))]; b.c += c; b.a += hit[i]; b.n++; });
  const ece = graded ? bins.reduce((s, b) => s + (b.n ? Math.abs(b.c / b.n - b.a / b.n) * b.n : 0), 0) / graded : NaN;
  const served = [...new Set(recs.map(r => r.model_served).filter(Boolean))];
  const providers = [...new Set(recs.map(r => r.provider).filter(Boolean))];
  perModel[m] = {
    served, providers,
    requests: recs.length, errors: recs.length - ok.length, error_rate: (recs.length - ok.length) / Math.max(1, recs.length),
    error_samples: [...new Set(recs.filter(r => !r.ok).map(r => `${r.status} ${String(r.error).slice(0, 120)}`))].slice(0, 3),
    latency_p50: quantile(lat, 0.5), latency_p95: quantile(lat, 0.95),
    cost_run: cost, cost_per_1k_states: baseRecs.length ? cost / recs.length * 1000 : NaN,
    decisions: base.size,
    accuracy: graded ? correct / graded : NaN, accuracy_ci: wilson(correct, graded), graded,
    accuracy_by_type: Object.fromEntries(Object.entries(byType).map(([t, [c, n]]) => [t, { acc: c / n, n }])),
    ece, brier_noul: mean(brier), overconfidence: graded ? mean(conf) - correct / graded : NaN,
    noise: compare(base, index(dup.get(m), 'base')),
    noise_same_provider: compare(base, index(dup.get(m), 'base'), (k, x) => x.provider === index(dup.get(m), 'base').get(k)?.provider),
    noise_cross_provider: compare(base, index(dup.get(m), 'base'), (k, x) => { const y = index(dup.get(m), 'base').get(k); return !!y && x.provider !== y.provider; }),
    shuffle: compare(base, index(recs, 'shuffle'), undefined, true),
    paraphrase: compare(base, index(recs, 'para'), undefined, true),
    drift_vs_compare: cmp.size ? compare(index(cmp.get(m), 'base'), base) : null,
    drift_by_type: cmp.size ? Object.fromEntries(['noul', 'choice', 'score'].map(t => [t, compare(index(cmp.get(m), 'base'), base, k => qType(k) === t)])) : null,
  };
}

// Jev 1.13 vs 1.14 (positive control)
function pair(a: string, b: string) {
  if (!main.has(a) || !main.has(b)) return null;
  const A = index(main.get(a), 'base'), B = index(main.get(b), 'base');
  const byT: Record<string, any> = {}, byF: Record<string, any> = {};
  for (const t of ['noul', 'choice', 'score']) byT[t] = compare(A, B, k => qType(k) === t);
  for (const f of [...new Set(items.map(i => i.family))]) byF[f] = compare(A, B, k => fam(k) === f);
  return { overall: compare(A, B), by_type: byT, by_family: byF };
}
const jev = pair('typesafe/jev-1.13', 'typesafe/jev-1.14');

// Cross-model disagreement on each question (majority share)
const allBase = models.map(m => index(main.get(m), 'base'));
const keys = new Set(allBase.flatMap(a => [...a.keys()]));
const disagreement: { key: string; majority_share: number; n: number }[] = [];
for (const k of keys) {
  const tops = allBase.map(a => a.get(k)?.top).filter(Boolean) as string[];
  if (tops.length < 5) continue;
  const c: Record<string, number> = {}; for (const t of tops) c[t] = (c[t] ?? 0) + 1;
  disagreement.push({ key: k, majority_share: Math.max(...Object.values(c)) / tops.length, n: tops.length });
}
const meanMajority = mean(disagreement.map(d => d.majority_share));

const summary = { date, run, dup: args.dup ?? null, compare: args['compare-run'] ?? null, items: items.length, models: models.length, perModel, jev_113_vs_114: jev, cross_model_mean_majority_share: meanMajority };
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'reports', `${date}-${run}.json`), JSON.stringify(summary, null, 1));

// ---- markdown ----
const pct = (x: number) => Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—';
const ci = (c: number[]) => Number.isFinite(c[0]) ? `${(c[0] * 100).toFixed(1)}–${(c[1] * 100).toFixed(1)}%` : '—';
let md = `# Run report: ${date} / ${run}\n\n${items.length} core states, ${models.length} models. Noise run: ${args.dup ?? 'none'}. Drift compared against: ${args['compare-run'] ?? 'none'}.\n\n`;
md += `Private-split items are included in these aggregates; no private item text appears in this report.\n\n`;
md += `## Per-model summary\n\n| Model | Err | p50 ms | p95 ms | Acc (gold) | 95% CI | Over-conf | ECE | Noise flip | Shuffle flip | Para flip | Drift flip vs ${args['compare-run'] ?? '—'} | $/1k req |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const m of models.sort((a, b) => (perModel[b].accuracy || 0) - (perModel[a].accuracy || 0))) {
  const p = perModel[m];
  md += `| ${m} | ${pct(p.error_rate)} | ${Math.round(p.latency_p50)} | ${Math.round(p.latency_p95)} | ${pct(p.accuracy)} | ${ci(p.accuracy_ci)} | ${Number.isFinite(p.overconfidence) ? (p.overconfidence * 100).toFixed(1) + ' pts' : '—'} | ${Number.isFinite(p.ece) ? p.ece.toFixed(3) : '—'} | ${pct(p.noise.flip_rate)} (n=${p.noise.n}) | ${pct(p.shuffle.flip_rate)} (n=${p.shuffle.n}) | ${pct(p.paraphrase.flip_rate)} (n=${p.paraphrase.n}) | ${p.drift_vs_compare ? pct(p.drift_vs_compare.flip_rate) + ` (n=${p.drift_vs_compare.n})` : '—'} | ${p.cost_per_1k_states.toFixed(4)} |\n`;
}
if (jev) {
  md += `\n## Positive control: Jev 1.13 vs 1.14\n\nOverall top-answer flip rate **${pct(jev.overall.flip_rate)}** (95% CI ${ci(jev.overall.ci)}, n=${jev.overall.n}), mean total-variation distance ${jev.overall.mean_tv.toFixed(3)}.\n`;
  md += `Noise floor: 1.13 ${pct(perModel['typesafe/jev-1.13']?.noise.flip_rate)}, 1.14 ${pct(perModel['typesafe/jev-1.14']?.noise.flip_rate)}.\n\n| Slice | n | Flip rate | 95% CI | Mean TV |\n|---|---|---|---|---|\n`;
  for (const [k, v] of [...Object.entries(jev.by_type).map(([k, v]) => [`type: ${k}`, v]), ...Object.entries(jev.by_family).map(([k, v]) => [`family: ${k}`, v])] as [string, any][])
    md += `| ${k} | ${v.n} | ${pct(v.flip_rate)} | ${ci(v.ci)} | ${Number.isFinite(v.mean_tv) ? v.mean_tv.toFixed(3) : '—'} |\n`;
}
md += `\n## Provider mixing\n\nSome models are served by several upstream providers. Noise flip rate when the duplicate request went to the same provider vs a different one:\n\n| Model | Providers | Same-provider flip | Cross-provider flip |\n|---|---|---|---|\n`;
for (const m of models) if (perModel[m].providers.length > 1) { const p = perModel[m]; md += `| ${m} | ${p.providers.join(', ')} | ${pct(p.noise_same_provider.flip_rate)} (n=${p.noise_same_provider.n}) | ${pct(p.noise_cross_provider.flip_rate)} (n=${p.noise_cross_provider.n}) |\n`; }
md += `\n## Served snapshots and providers\n\n| Requested | Served | Provider(s) |\n|---|---|---|\n`;
for (const m of models) md += `| ${m} | ${perModel[m].served.join(', ')} | ${perModel[m].providers.join(', ')} |\n`;
md += `\n## Cross-model agreement\n\nOn average the most common answer is given by ${pct(meanMajority)} of models (lower means models disagree more).\n`;
md += `\n## Errors\n\n`;
for (const m of models) if (perModel[m].errors) md += `- **${m}**: ${perModel[m].errors} errors. Samples: ${perModel[m].error_samples.map((s: string) => '`' + s.replace(/`/g, "'") + '`').join('; ')}\n`;
fs.writeFileSync(path.join(ROOT, 'reports', `${date}-${run}.md`), md);
console.log(md);
