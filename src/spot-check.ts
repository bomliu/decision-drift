// Writes private/spot-check.md: 50 items sampled across family x language x split for human review.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, loadItems, readJsonl, shuffled } from './lib.ts';

const items = loadItems('suite/core-v1.public.jsonl', 'private/core-v1.private.jsonl');
const L: Record<string, Record<string, any>> = {};
for (const l of ['openai_gpt-6.1-sol', 'google_gemini-4-argon'])
  for (const r of readJsonl<any>(path.join(ROOT, 'private/labels', `${l}.jsonl`))) (L[r.item_id] ??= {})[l] = r.labels;

// round-robin over families, preferring a mix of languages, splits, and disputed items
const fams = [...new Set(items.map(i => i.family))];
const byFam = Object.fromEntries(fams.map(f => [f, shuffled(items.filter(i => i.family === f), `spot-${f}`)
  .sort((a, b) => Number(b.language !== 'en') - Number(a.language !== 'en') || ((b as any).disputed?.length ?? 0) - ((a as any).disputed?.length ?? 0))]));
const pick: Item[] = [];
for (let round = 0; pick.length < 50; round++) {
  let added = false;
  for (const f of fams) { const x = byFam[f][round]; if (x && pick.length < 50) { pick.push(x); added = true; } }
  if (!added) break;
}

let md = `# Spot-check: 50 items\n\nFor each item, check: (1) the state reads like something real, (2) every question is answerable and unambiguous enough, and (3) the **reference** label is right. Mark anything off in the **Your note** line. Items are immutable once frozen, so a bad item gets retired and replaced in v1.1.\n\n`;
md += `Legend: **ref** = author, dataset or generator label · **gpt / gem** = LLM labelers · ⭐ = gold (all three agree) · ⚠️ = labelers disagree\n\n`;
pick.forEach((it, n) => {
  const anyIt = it as any;
  md += `---\n\n## ${n + 1}. \`${it.id}\` · ${it.family} · ${it.language} · ${it.difficulty} · ${it.split}${anyIt.anchor ? ' · anchor' : ''}\n\n`;
  md += '```\n' + (it.state.length > 1500 ? it.state.slice(0, 1500) + `\n… [${it.state.length - 1500} more chars]` : it.state) + '\n```\n\n';
  md += `| Question | Type | ref | gpt | gem | |\n|---|---|---|---|---|---|\n`;
  for (const [qid, q] of Object.entries(it.questions)) {
    const ref = anyIt.gold_reference?.[qid];
    const g = L[it.id]?.['openai_gpt-6.1-sol']?.[qid], m = L[it.id]?.['google_gemini-4-argon']?.[qid];
    const mark = it.gold && qid in it.gold ? '⭐' : (anyIt.disputed ?? []).includes(qid) ? '⚠️' : '';
    md += `| **${qid}**: ${q.instructions.replace(/\|/g, '/')} | ${q.type}${q.type !== 'noul' ? ` (${Array.isArray(q.criteria) ? q.criteria.length + ' levels' : Object.keys(q.criteria ?? {}).length + ' options'})` : ''} | ${ref ?? '—'} | ${g ?? '—'} | ${m ?? '—'} | ${mark} |\n`;
  }
  md += `\n**Your note:** \n\n`;
});
fs.writeFileSync(path.join(ROOT, 'private/spot-check.md'), md);
console.log('wrote private/spot-check.md with', pick.length, 'items');
