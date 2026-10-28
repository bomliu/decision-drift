// Builds the 50-item spot-check: private/spot-check.html (interactive, runs locally) and, with --md, the Markdown sheet.
// Items are sampled round-robin across families, preferring non-English and disputed items.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type Item, loadItems, readJsonl, shuffled } from './lib.ts';

const items = loadItems('suite/core-v1.public.jsonl', 'private/core-v1.private.jsonl');
const L: Record<string, Record<string, any>> = {};
for (const l of ['openai_gpt-6.1-sol', 'google_gemini-4-argon'])
  for (const r of readJsonl<any>(path.join(ROOT, 'private/labels', `${l}.jsonl`))) (L[r.item_id] ??= {})[l] = r.labels;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/manifest-v1.json'), 'utf8'));

const fams = [...new Set(items.map(i => i.family))];
const byFam = Object.fromEntries(fams.map(f => [f, shuffled(items.filter(i => i.family === f), `spot-${f}`)
  .sort((a, b) => Number(b.language !== 'en') - Number(a.language !== 'en') || ((b as any).disputed?.length ?? 0) - ((a as any).disputed?.length ?? 0))]));
const pick: Item[] = [];
for (let round = 0; pick.length < 50; round++) {
  let added = false;
  for (const f of fams) { const x = byFam[f][round]; if (x && pick.length < 50) { pick.push(x); added = true; } }
  if (!added) break;
}

// ---------- Markdown (only on request; never overwrites notes already typed into it) ----------
if (process.argv.includes('--md')) {
  const mdFile = path.join(ROOT, 'private/spot-check.md');
  if (fs.existsSync(mdFile) && /\*\*Your note:\*\* *\S/.test(fs.readFileSync(mdFile, 'utf8'))) {
    console.error('private/spot-check.md already contains notes; not overwriting it.');
  } else {
    let md = `# Spot-check: 50 items\n\nFor each item, check: (1) the state reads like something real, (2) every question is answerable and unambiguous enough, and (3) the **reference** label is right. Mark anything off in the **Your note** line.\n\n`;
    md += `Legend: **ref** = author, dataset or generator label · **gpt / gem** = LLM labelers · ⭐ = gold (all three agree) · ⚠️ = labelers disagree\n\n`;
    pick.forEach((it, n) => {
      const a = it as any;
      md += `---\n\n## ${n + 1}. \`${it.id}\` · ${it.family} · ${it.language} · ${it.difficulty} · ${it.split}${a.anchor ? ' · anchor' : ''}\n\n`;
      md += '```\n' + (it.state.length > 1500 ? it.state.slice(0, 1500) + `\n… [${it.state.length - 1500} more chars]` : it.state) + '\n```\n\n';
      md += `| Question | Type | ref | gpt | gem | |\n|---|---|---|---|---|---|\n`;
      for (const [qid, q] of Object.entries(it.questions)) {
        const g = L[it.id]?.['openai_gpt-6.1-sol']?.[qid], m = L[it.id]?.['google_gemini-4-argon']?.[qid];
        const mark = it.gold && qid in it.gold ? '⭐' : (a.disputed ?? []).includes(qid) ? '⚠️' : '';
        md += `| **${qid}**: ${q.instructions.replace(/\|/g, '/')} | ${q.type} | ${a.gold_reference?.[qid] ?? '—'} | ${g ?? '—'} | ${m ?? '—'} | ${mark} |\n`;
      }
      md += `\n**Your note:** \n\n`;
    });
    fs.writeFileSync(mdFile, md);
    console.log('wrote private/spot-check.md');
  }
}

// ---------- interactive HTML ----------
// Answers are shown with their meaning: option keys with descriptions, score levels with their text.
function describe(q: Item['questions'][string], v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (q.type === 'noul') return String(v) === 'true' ? 'yes' : String(v) === 'false' ? 'no' : String(v);
  if (q.type === 'score') { const lv = (q.criteria as string[])[Number(v)]; return lv ? `${v}: ${lv}` : String(v); }
  const desc = (q.criteria as Record<string, string>)[String(v)];
  return desc && !String(v).startsWith('option_') ? String(v) : desc ? desc : String(v);
}
const data = pick.map(it => {
  const a = it as any;
  return {
    id: it.id, family: it.family, language: it.language, difficulty: it.difficulty, split: it.split, anchor: !!a.anchor, source: it.source, state: it.state,
    questions: Object.entries(it.questions).map(([qid, q]) => ({
      qid, type: q.type, instructions: q.instructions,
      options: q.type === 'noul' ? (q.criteria ? [`yes: ${(q.criteria as any).true}`, `no: ${(q.criteria as any).false}`] : [])
        : q.type === 'score' ? (q.criteria as string[]).map((c, i) => `${i}: ${c}`)
        : Object.entries(q.criteria as Record<string, string>).map(([k, d]) => k.startsWith('option_') ? d : `${k}: ${d}`),
      ref: describe(q, a.gold_reference?.[qid]), gpt: describe(q, L[it.id]?.['openai_gpt-6.1-sol']?.[qid]), gem: describe(q, L[it.id]?.['google_gemini-4-argon']?.[qid]),
      mark: it.gold && qid in it.gold ? 'gold' : (a.disputed ?? []).includes(qid) ? 'disputed' : '',
    })),
  };
});
const suiteKey = `spotcheck:${manifest.splits.public.sha256.slice(0, 12)}:${manifest.splits.private.sha256.slice(0, 12)}`;
const json = JSON.stringify(data).replace(/</g, '\\u003c');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spot-check · Decision Drift</title>
<style>
:root{--paper:#F7F9FA;--panel:#FFFFFF;--grid:#DCE4EA;--ink:#1B2430;--muted:#55636F;--trace:#2457C5;--warn:#B26A00;--bad:#B3261E;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#121A23;--panel:#17212C;--grid:#263241;--ink:#E4EAF0;--muted:#9AA8B5;--trace:#7FA6FF;--warn:#E0A85A;--bad:#F2877F;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.wrap{max-width:980px;margin:0 auto;padding:0 16px 80px}
header{position:sticky;top:0;z-index:2;background:var(--paper);border-bottom:1px solid var(--grid);padding:12px 0;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
header h1{font-size:1.15rem;margin:0;font-weight:600}
.progress{color:var(--muted)}
.bar{flex:1 1 160px;height:6px;background:var(--grid);border-radius:3px;overflow:hidden;min-width:120px}
.bar span{display:block;height:100%;background:var(--trace);width:0}
.tools{display:flex;flex-wrap:wrap;gap:8px}
button,select{font:inherit;font-size:.92rem;padding:6px 12px;border-radius:5px;border:1px solid var(--grid);background:var(--panel);color:var(--ink);cursor:pointer}
button:focus-visible,select:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--trace);outline-offset:2px}
.primary{background:var(--trace);border-color:var(--trace);color:var(--panel);font-weight:600}
.intro{color:var(--muted);max-width:70ch;margin:16px 0}
.item{background:var(--panel);border:1px solid var(--grid);border-radius:8px;padding:16px 18px;margin:18px 0}
.item[data-verdict="ok"]{border-left:4px solid var(--trace)}
.item[data-verdict="fix"]{border-left:4px solid var(--warn)}
.item[data-verdict="retire"]{border-left:4px solid var(--bad)}
.item h2{font-size:1rem;margin:0 0 4px;font-weight:600}
.meta{color:var(--muted);font-size:.88rem;margin:0 0 10px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--paper);border:1px solid var(--grid);border-radius:6px;padding:10px 12px;max-height:18rem;overflow:auto;font:inherit;font-size:.95rem;margin:0 0 12px}
table{border-collapse:collapse;width:100%;font-size:.9rem;margin-bottom:12px}
th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--grid)}
th{color:var(--muted);font-weight:600}
td.q{min-width:16rem}
details{margin-top:4px;color:var(--muted)}
details ul{margin:4px 0 0;padding-left:18px}
.tag{font-size:.8rem;font-weight:600;padding:1px 6px;border-radius:4px;white-space:nowrap}
.tag.gold{color:var(--trace);border:1px solid var(--trace)}
.tag.disputed{color:var(--warn);border:1px solid var(--warn)}
.wrong{white-space:nowrap;color:var(--muted);font-size:.85rem}
.verdict{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 8px}
.verdict button[aria-pressed="true"][data-v="ok"]{background:var(--trace);border-color:var(--trace);color:var(--panel)}
.verdict button[aria-pressed="true"][data-v="fix"]{background:var(--warn);border-color:var(--warn);color:var(--panel)}
.verdict button[aria-pressed="true"][data-v="retire"]{background:var(--bad);border-color:var(--bad);color:var(--panel)}
textarea{width:100%;min-height:3.2rem;font:inherit;font-size:.95rem;padding:8px;border-radius:6px;border:1px solid var(--grid);background:var(--paper);color:var(--ink);resize:vertical}
.saved{color:var(--muted);font-size:.85rem;min-height:1.2em}
.hidden{display:none}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--paper);padding:8px 14px;border-radius:6px;display:none}
</style></head><body><div class="wrap">
<header><h1>Spot-check</h1><span class="progress" id="progress">0 of ${data.length} reviewed</span><div class="bar" aria-hidden="true"><span id="bar"></span></div>
<div class="tools"><label class="hidden" for="filter">Show</label><select id="filter" aria-label="Show"><option value="all">All items</option><option value="todo">Not reviewed</option><option value="flagged">Fix or retire</option></select>
<button id="copy">Copy notes</button><button class="primary" id="download">Download notes</button></div></header>
<p class="intro">For each item, check that the input reads like something real, that every question can be answered, and that the <strong>reference</strong> label (the author's, the dataset's or the generator's) is right. Mark <strong>OK</strong>, <strong>Fix</strong> (a label or wording is wrong) or <strong>Retire</strong> (the item is broken or misleading), tick any reference label you think is wrong, and add a note if it helps. Your answers save in this browser as you go. When you're done, download the notes and tell Claude where the file is.</p>
<div id="items"></div></div><div id="toast" role="status"></div>
<script>
const DATA = ${json};
const KEY = ${JSON.stringify(suiteKey)};
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch (e) { return false; } }
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); } for (const c of kids) if (c != null) n.append(c); return n; };
const root = document.getElementById('items');
DATA.forEach((it, idx) => {
  const s = state[it.id] ||= { verdict: '', note: '', wrong: [] };
  const card = el('section', { class: 'item', id: it.id, 'data-verdict': s.verdict, 'aria-labelledby': 'h-' + it.id });
  card.append(el('h2', { id: 'h-' + it.id, text: (idx + 1) + '. ' + it.id }));
  card.append(el('p', { class: 'meta', text: [it.family, it.language, it.difficulty, it.split + ' split', it.anchor ? 'anchor item' : null, 'source: ' + it.source].filter(Boolean).join(', ') }));
  card.append(el('pre', { text: it.state }));
  const tbody = el('tbody');
  for (const q of it.questions) {
    const opts = q.options.length ? el('details', {}, el('summary', { text: q.type === 'score' ? 'Levels' : q.type === 'noul' ? 'Criteria' : 'Options' }), el('ul', {}, ...q.options.map(o => el('li', { text: o })))) : null;
    const cb = el('input', { type: 'checkbox', id: it.id + ':' + q.qid });
    cb.checked = s.wrong.includes(q.qid);
    cb.addEventListener('change', () => { s.wrong = cb.checked ? [...new Set([...s.wrong, q.qid])] : s.wrong.filter(x => x !== q.qid); persist(card, s); });
    tbody.append(el('tr', {},
      el('td', { class: 'q' }, el('strong', { text: q.qid + ' (' + q.type + ')' }), el('br'), q.instructions, opts),
      el('td', { text: q.ref }), el('td', { text: q.gpt }), el('td', { text: q.gem }),
      el('td', {}, q.mark ? el('span', { class: 'tag ' + q.mark, text: q.mark === 'gold' ? 'gold' : 'labelers disagree' }) : ''),
      el('td', {}, q.ref === '—' ? el('span', { class: 'wrong', text: 'no reference' }) : el('label', { class: 'wrong', for: it.id + ':' + q.qid }, cb, ' ref wrong'))));
  }
  card.append(el('table', {}, el('thead', {}, el('tr', {}, ...['Question', 'Reference', 'GPT-6.1 Sol', 'Gemini 4 Argon', '', ''].map(h => el('th', { text: h })))), tbody));
  const vbox = el('div', { class: 'verdict', role: 'group', 'aria-label': 'Verdict for ' + it.id });
  for (const [v, label] of [['ok', 'OK'], ['fix', 'Fix'], ['retire', 'Retire']]) {
    const b = el('button', { type: 'button', 'data-v': v, 'aria-pressed': String(s.verdict === v), text: label });
    b.addEventListener('click', () => { s.verdict = s.verdict === v ? '' : v; vbox.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === s.verdict))); card.dataset.verdict = s.verdict; persist(card, s); });
    vbox.append(b);
  }
  card.append(vbox);
  const ta = el('textarea', { 'aria-label': 'Note for ' + it.id, placeholder: 'Optional note: what is wrong, or what the label should be' });
  ta.value = s.note;
  ta.addEventListener('input', () => { s.note = ta.value; persist(card, s); });
  card.append(ta, el('div', { class: 'saved', 'aria-live': 'polite' }));
  root.append(card);
});
function persist(card, s) { const ok = save(); card.querySelector('.saved').textContent = ok ? 'Saved in this browser' : 'Could not save in this browser; download your notes before closing.'; update(); }
function update() {
  const done = DATA.filter(it => state[it.id]?.verdict).length;
  document.getElementById('progress').textContent = done + ' of ' + DATA.length + ' reviewed';
  document.getElementById('bar').style.width = (100 * done / DATA.length) + '%';
  applyFilter();
}
function applyFilter() {
  const f = document.getElementById('filter').value;
  for (const it of DATA) { const v = state[it.id]?.verdict; document.getElementById(it.id).classList.toggle('hidden', f === 'todo' ? !!v : f === 'flagged' ? !(v === 'fix' || v === 'retire') : false); }
}
document.getElementById('filter').addEventListener('change', applyFilter);
function exportText() { return JSON.stringify({ suite: KEY, exported_at: new Date().toISOString(), reviewed: DATA.filter(it => state[it.id]?.verdict).length, total: DATA.length, items: Object.fromEntries(DATA.map(it => [it.id, state[it.id]])) }, null, 1); }
function toast(t) { const n = document.getElementById('toast'); n.textContent = t; n.style.display = 'block'; setTimeout(() => n.style.display = 'none', 2600); }
document.getElementById('download').addEventListener('click', () => {
  const a = el('a', { href: URL.createObjectURL(new Blob([exportText()], { type: 'application/json' })), download: 'spot-check-notes.json' });
  document.body.append(a); a.click(); a.remove(); toast('Saved spot-check-notes.json to your downloads');
});
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(exportText()); toast('Notes copied; paste them to Claude'); } catch (e) { toast('Copy was blocked; use Download notes instead'); }
});
update();
</script></body></html>`;
fs.writeFileSync(path.join(ROOT, 'private/spot-check.html'), html);
console.log('wrote private/spot-check.html with', data.length, 'items');
