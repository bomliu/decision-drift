// Labels candidate items with LLMs via OpenRouter chat completions.
// Usage: node src/label.ts --model openai/gpt-6.1-sol [--limit 5] [--concurrency 6]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, chat, keyUsage, BUDGET_STOP, pool, readJsonl } from './lib.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const model = args.model;
const limit = args.limit ? Number(args.limit) : Infinity;
const conc = Number(args.concurrency ?? 6);
const spendCap = Number(args['spend-cap'] ?? 6); // dollars for this labeler

const items = readJsonl<Item>(path.join(ROOT, 'private/candidates.jsonl')).slice(0, limit);
const outFile = path.join(ROOT, 'private/labels', `${model.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const done = new Set(readJsonl(outFile).map((r: any) => r.item_id));

function render(item: Item): string {
  const qs = Object.entries(item.questions).map(([qid, q]) => {
    let ans = '';
    if (q.type === 'noul') ans = 'Answer: true or false.';
    else if (q.type === 'choice') ans = 'Answer with exactly one option key:\n' + Object.entries(q.criteria as Record<string, string>).map(([k, v]) => `  - ${k}: ${v}`).join('\n');
    else ans = 'Answer with the integer level:\n' + (q.criteria as string[]).map((v, i) => `  ${i}: ${v}`).join('\n');
    return `### ${qid}\n${q.instructions}\n${q.type === 'noul' && q.criteria ? `(true = ${(q.criteria as any).true}; false = ${(q.criteria as any).false})\n` : ''}${ans}`;
  }).join('\n\n');
  return `You are labeling items for an evaluation dataset. Read the STATE and answer every question with your single best judgment.\n\nSTATE:\n<<<\n${item.state}\n>>>\n\nQUESTIONS:\n${qs}\n\nReturn only a JSON object mapping each question id to its answer (boolean for true/false, string option key for choices, integer for levels). No commentary.`;
}

function parse(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const start = await keyUsage();
let spent = 0, n = 0, bad = 0;
const todo = items.filter(i => !done.has(i.id));
console.log(`labeler=${model} todo=${todo.length} key_usage=$${start.usage.toFixed(4)}`);
const out = fs.createWriteStream(outFile, { flags: 'a' });
await pool(todo, conc, async (item) => {
  if (spent >= spendCap) return;
  const u0 = await keyUsage().catch(() => null);
  if (u0 && u0.usage >= BUDGET_STOP) { spent = Infinity; console.error('BUDGET STOP'); return; }
  try {
    const r = await chat(model, [{ role: 'user', content: render(item) }], { reasoning: { effort: 'low' }, temperature: 0 });
    const text = r.choices?.[0]?.message?.content ?? '';
    const labels = parse(text);
    if (!labels) bad++;
    spent += Number(r.usage?.cost ?? 0);
    out.write(JSON.stringify({ item_id: item.id, labeler: model, served: r.model, labels, raw: labels ? undefined : text.slice(0, 500), usage: r.usage }) + '\n');
  } catch (e: any) { bad++; console.error(item.id, String(e.message).slice(0, 200)); }
  if (++n % 50 === 0) console.log(`  ${n} labeled, ~$${spent.toFixed(3)}, unparsed ${bad}`);
});
await new Promise(r => out.end(r));
console.log(`done ${n}, ~$${spent.toFixed(4)}, unparsed ${bad}`);
