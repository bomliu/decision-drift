// Picks the v1 core from candidates using labels + pilot results, splits public/private, freezes with hashes.
// Usage: node src/select.ts --pilot-date 2026-10-20
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, readJsonl, sha256, canonical, shuffled } from './lib.ts';
import { normalize, loadRun } from './answers.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] ?? 'true']); return acc;
}, []));
const pilotDate = args['pilot-date'];

const cands = readJsonl<Item>(path.join(ROOT, 'private/candidates.jsonl'));
const labelers = ['openai_gpt-6.1-sol', 'google_gemini-4-argon'];
const labels = new Map<string, Record<string, Record<string, unknown>>>(); // item -> labeler -> labels
for (const l of labelers) for (const r of readJsonl<any>(path.join(ROOT, 'private/labels', `${l}.jsonl`))) {
  if (!labels.has(r.item_id)) labels.set(r.item_id, {});
  if (r.labels) labels.get(r.item_id)![l] = r.labels;
}
const same = (a: unknown, b: unknown) => String(typeof a === 'boolean' ? a : a) === String(b) || (typeof b === 'boolean' && String(a) === String(b));

// ---- gold by agreement: reference label (author or dataset) + both LLMs must agree ----
const goldStats = { questions: 0, gold: 0, disagree: 0, noRef: 0 };
for (const it of cands) {
  const L = labels.get(it.id) ?? {};
  const ref = it.gold ?? {};
  const agreed: Record<string, string | number | boolean> = {};
  const disputed: string[] = [];
  for (const qid of Object.keys(it.questions)) {
    goldStats.questions++;
    const votes = labelers.map(l => L[l]?.[qid]);
    if (!(qid in ref)) {
      goldStats.noRef++;
      // no reference label: LLM agreement alone marks the question as clear vs boundary, but it is not gold
      if (votes.every(v => v !== undefined) && String(votes[0]) !== String(votes[1])) disputed.push(qid);
      continue;
    }
    if (votes.every(v => v !== undefined && same(v, ref[qid]))) { agreed[qid] = ref[qid]; goldStats.gold++; }
    else { disputed.push(qid); goldStats.disagree++; }
  }
  (it as any).gold_reference = it.gold;
  it.gold = agreed;
  (it as any).disputed = disputed;
  if (!it.difficulty) it.difficulty = disputed.length ? 'boundary' : 'clear';
}

// ---- pilot informativeness ----
const pilot = loadRun(pilotDate, 'pilot');
// Banking77 items were rebuilt after a CSV parsing fix; their pilot lives in a separate run
for (const [m, recs] of pilot) pilot.set(m, recs.filter(r => !r.item_id.startsWith('banking77-')));
for (const [m, recs] of loadRun(pilotDate, 'pilot-b77')) pilot.set(m, [...(pilot.get(m) ?? []), ...recs]);
const excluded = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/models-excluded.json'), 'utf8'));
for (const m of Object.keys(excluded)) pilot.delete(m);
const byItem = new Map<string, { okModels: number; errModels: number; perQ: Record<string, string[]>; boundary: number[] }>();
for (const [, recs] of pilot) for (const r of recs) {
  if (r.variant !== 'base') continue;
  const e = byItem.get(r.item_id) ?? { okModels: 0, errModels: 0, perQ: {}, boundary: [] };
  if (!r.ok || !r.answers) { e.errModels++; byItem.set(r.item_id, e); continue; }
  e.okModels++;
  for (const [qid, a] of Object.entries(r.answers)) {
    const n = normalize(a); if (!n) continue;
    (e.perQ[qid] ??= []).push(n.top);
    const maxp = Math.max(...Object.values(n.dist));
    e.boundary.push(1 - maxp);
  }
  byItem.set(r.item_id, e);
}
function info(it: Item) {
  const e = byItem.get(it.id); if (!e || !e.okModels) return { score: -1, broken: true };
  const broken = e.errModels > e.okModels * 0.3;
  const disagreements = Object.values(e.perQ).map(tops => {
    const c: Record<string, number> = {}; for (const t of tops) c[t] = (c[t] ?? 0) + 1;
    return 1 - Math.max(...Object.values(c)) / tops.length;
  });
  const dis = disagreements.reduce((a, b) => a + b, 0) / Math.max(1, disagreements.length);
  const bnd = e.boundary.reduce((a, b) => a + b, 0) / Math.max(1, e.boundary.length);
  return { score: dis + bnd, broken };
}

// ---- quotas per family; seed all languages; keep ~30 anchors ----
const quota: Record<string, number> = { support: 50, guardrail: 45, review: 40, rag: 35, claim: 30, tool: 33, value: 18, entity: 20, banking77: 65, clinc: 50, logs: 12 };
const selected: Item[] = [];
const anchorsPerFamily = 3;
for (const [fam, q] of Object.entries(quota)) {
  const pool = cands.filter(c => c.family === fam).map(c => ({ c, ...info(c) })).filter(x => !x.broken);
  const nonEn = pool.filter(x => x.c.language !== 'en');
  const keep = new Set<string>();
  // keep every non-English item (they seed the language slices)
  for (const x of nonEn) keep.add(x.c.id);
  // anchors: lowest-information items that have full gold
  const anchors = pool.filter(x => Object.keys(x.c.gold ?? {}).length === Object.keys(x.c.questions).length && x.c.language === 'en')
    .sort((a, b) => a.score - b.score).slice(0, anchorsPerFamily);
  for (const a of anchors) { keep.add(a.c.id); (a.c as any).anchor = true; }
  // fill by informativeness, but guarantee each difficulty appears
  const rest = pool.filter(x => !keep.has(x.c.id)).sort((a, b) => b.score - a.score);
  for (const d of ['clear', 'boundary', 'edge']) {
    const first = rest.find(x => x.c.difficulty === d && !keep.has(x.c.id)); if (first && keep.size < q) keep.add(first.c.id);
  }
  // take ~70% by informativeness and ~30% clear items with gold, so accuracy metrics have data
  const clearGold = rest.filter(x => x.c.difficulty === 'clear' && Object.keys(x.c.gold ?? {}).length);
  for (const x of clearGold.slice(0, Math.round(q * 0.3))) if (keep.size < q) keep.add(x.c.id);
  for (const x of rest) { if (keep.size >= q) break; keep.add(x.c.id); }
  selected.push(...pool.filter(x => keep.has(x.c.id)).map(x => x.c));
}

// ---- split ~30% private, stratified by family x language ----
const strata = new Map<string, Item[]>();
for (const it of selected) { const k = `${it.family}|${it.language}`; (strata.get(k) ?? strata.set(k, []).get(k)!).push(it); }
// walk strata in a fixed order with one global counter so exactly ~30% go private and small strata are spread out
let k = 0;
for (const key of [...strata.keys()].sort()) for (const it of shuffled(strata.get(key)!, `split-${key}`)) {
  it.split = Math.floor((k + 1) * 0.3) > Math.floor(k * 0.3) ? 'private' : 'public'; k++;
}

// ---- variants: paraphrase on 50 stratified states; noise duplicates on 100 ----
const withPara = shuffled(selected.filter(i => (i as any).paraphrases), 'para-pick');
const paraIds = new Set<string>();
for (const fam of Object.keys(quota)) for (const it of withPara.filter(i => i.family === fam).slice(0, 5)) paraIds.add(it.id);
for (const it of withPara) { if (paraIds.size >= 50) break; paraIds.add(it.id); }
for (const it of selected) if (!paraIds.has(it.id)) delete (it as any).paraphrases;
const dupIds = new Set<string>();
for (const fam of Object.keys(quota)) for (const it of shuffled(selected.filter(i => i.family === fam), `dup-${fam}`).slice(0, 9)) dupIds.add(it.id);
for (const it of shuffled(selected, 'dup-fill')) { if (dupIds.size >= 100) break; dupIds.add(it.id); }

// ---- write frozen suite ----
const clean = (it: Item) => {
  const { disputed, gold_reference, ...rest } = it as any;
  return { ...rest, anchor: rest.anchor ?? false, gold_reference, disputed };
};
const pub = selected.filter(i => i.split === 'public').map(clean).sort((a, b) => a.id.localeCompare(b.id));
const priv = selected.filter(i => i.split === 'private').map(clean).sort((a, b) => a.id.localeCompare(b.id));
fs.mkdirSync(path.join(ROOT, 'suite'), { recursive: true });
const write = (f: string, xs: unknown[]) => fs.writeFileSync(path.join(ROOT, f), xs.map(x => JSON.stringify(x)).join('\n') + '\n');
write('suite/core-v1.public.jsonl', pub);
write('private/core-v1.private.jsonl', priv);
fs.writeFileSync(path.join(ROOT, 'suite/noise-ids-v1.json'), JSON.stringify([...dupIds].sort(), null, 1));

const counts = (xs: any[], k: string) => xs.reduce<Record<string, number>>((a, i) => { a[String(i[k])] = (a[String(i[k])] ?? 0) + 1; return a; }, {});
const qCount = (xs: any[]) => xs.reduce((a, i) => a + Object.keys(i.questions).length, 0);
const goldCount = (xs: any[]) => xs.reduce((a, i) => a + Object.keys(i.gold ?? {}).length, 0);
const manifest = {
  suite: 'decision-drift core', version: 'v1', frozen_at: new Date().toISOString(),
  rules: ['Items are immutable; fixes retire an item and add a new one.', 'Questions are never tuned against model results.', 'Headline metrics use the v1 cohort.'],
  splits: {
    public: { file: 'suite/core-v1.public.jsonl', states: pub.length, questions: qCount(pub), gold_questions: goldCount(pub), sha256: sha256(pub.map(canonical).join('\n')) },
    private: { file: '(withheld)', states: priv.length, questions: qCount(priv), gold_questions: goldCount(priv), sha256: sha256(priv.map(canonical).join('\n')) },
  },
  coverage: { family: counts([...pub, ...priv], 'family'), language: counts([...pub, ...priv], 'language'), difficulty: counts([...pub, ...priv], 'difficulty'), shape: counts([...pub, ...priv], 'shape') },
  variants: { paraphrase_states: paraIds.size, noise_duplicate_states: dupIds.size, option_shuffle: 'every choice question' },
  labeling: { reference: 'author label (authored items), dataset label (Banking77, CLINC150), generator truth (synthetic logs)', llm_labelers: ['openai/gpt-6.1-sol', 'google/gemini-4-argon'], gold_rule: 'reference and both LLM labelers agree', stats: goldStats },
  sources: { banking77: 'PolyAI, CC BY 4.0, https://github.com/PolyAI-LDN/task-specific-datasets', clinc150: 'clinc/clinc_oos (plus), CC BY 3.0', authored: 'CC0', synthetic_logs: 'CC0' },
  retired: [],
};
fs.writeFileSync(path.join(ROOT, 'suite/manifest-v1.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ selected: selected.length, public: pub.length, private: priv.length, questions: qCount(pub) + qCount(priv), gold: goldCount(pub) + goldCount(priv), goldStats, coverage: manifest.coverage }, null, 1));
