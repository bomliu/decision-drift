// Applies human label corrections to the frozen suite. Requests (state + questions) never change, so drift
// history stays comparable; only reference labels, gold and disputed sets are updated, and the manifest logs it.
// Usage: node src/apply-label-corrections.ts private/label-corrections-v1.1.json
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, readJsonl, sha256, canonical } from './lib.ts';

const corr = JSON.parse(fs.readFileSync(path.resolve(ROOT, process.argv[2]), 'utf8'));
const files = { public: 'suite/core-v1.public.jsonl', private: 'private/core-v1.private.jsonl' };
const L: Record<string, Record<string, any>> = {};
for (const l of ['openai_gpt-6.1-sol', 'google_gemini-4-argon'])
  for (const r of readJsonl<any>(path.join(ROOT, 'private/labels', `${l}.jsonl`))) (L[r.item_id] ??= {})[l] = r.labels ?? {};
const same = (a: unknown, b: unknown) => String(a) === String(b);
const log: any[] = [];
const out: Record<string, Item[]> = {};
for (const [split, f] of Object.entries(files)) {
  out[split] = readJsonl<Item>(path.join(ROOT, f)).map(it => {
    const c = corr.corrections[it.id]; if (!c) return it;
    const a = it as any;
    const reqBefore = sha256(canonical({ state: it.state, questions: it.questions }));
    for (const [qid, v] of Object.entries<any>(c)) {
      if (!(qid in it.questions)) throw new Error(`${it.id} has no question ${qid}`);
      const before = a.gold_reference?.[qid];
      (a.gold_reference ??= {})[qid] = v;
      const votes = ['openai_gpt-6.1-sol', 'google_gemini-4-argon'].map(l => L[it.id]?.[l]?.[qid]);
      const gold = votes.every(x => x !== undefined && same(x, v));
      if (gold) (it.gold ??= {})[qid] = v; else if (it.gold) delete it.gold[qid];
      a.disputed = gold ? (a.disputed ?? []).filter((q: string) => q !== qid) : [...new Set([...(a.disputed ?? []), qid])];
      log.push({ item: it.id, question: qid, from: before ?? null, to: v, gold_now: gold });
    }
    if (a.disputed.length && it.difficulty === 'clear') it.difficulty = 'boundary';
    if (sha256(canonical({ state: it.state, questions: it.questions })) !== reqBefore) throw new Error('request changed for ' + it.id);
    return it;
  });
}
const missing = Object.keys(corr.corrections).filter(id => !Object.values(out).flat().some(i => i.id === id));
if (missing.length) throw new Error('unknown items: ' + missing.join(', '));
for (const [split, f] of Object.entries(files)) fs.writeFileSync(path.join(ROOT, f), out[split].map(x => JSON.stringify(x)).join('\n') + '\n');

const mf = path.join(ROOT, 'suite/manifest-v1.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
const gq = (xs: Item[]) => xs.reduce((s, i) => s + Object.keys(i.gold ?? {}).length, 0);
for (const split of ['public', 'private'] as const) {
  m.splits[split].sha256 = sha256(out[split].map(canonical).join('\n'));
  m.splits[split].gold_questions = gq(out[split]);
}
m.coverage.difficulty = [...out.public, ...out.private].reduce((acc: any, i) => { acc[i.difficulty!] = (acc[i.difficulty!] ?? 0) + 1; return acc; }, {});
m.rules = [...new Set([...m.rules, 'Requests are immutable. Reference labels can be corrected after human review; corrections are logged here and never change what is sent to models.'])];
(m.label_corrections ??= []).push({ version: corr.version, reviewed_at: corr.reviewed_at, reviewer: corr.reviewer, changes: log.map(({ item, question, gold_now }) => ({ item, question, gold_now })) });
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
console.log(`applied ${log.length} label changes; now gold: ${log.filter(x => x.gold_now).length}; gold questions public ${m.splits.public.gold_questions}, private ${m.splits.private.gold_questions}`);
