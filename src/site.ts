// Builds the static site for decisiondrift.dev from committed reports, the suite manifest and posts.
// Usage: node src/site.ts [--out site-dist]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] ?? 'true']); return acc;
}, []));
const OUT = path.resolve(ROOT, args.out ?? 'site-dist');
const SITE = 'https://decisiondrift.dev';
const REPO = 'https://github.com/bomliu/decision-drift';
const BASELINE = { date: '2026-10-20', run: 'day1' };

// ---------- data ----------
type Report = { date: string; run: string; perModel: Record<string, any>; jev_113_vs_114: any; cross_model_mean_majority_share: number; items: number; models: number };
const reportsDir = path.join(ROOT, 'reports');
const reports: Report[] = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8')))
  .filter((r: Report) => (r.date === BASELINE.date && r.run === BASELINE.run) || (r.run === 'daily' && r.date > BASELINE.date))
  .sort((a: Report, b: Report) => a.date.localeCompare(b.date));
const latest = reports.at(-1)!;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/manifest-v1.json'), 'utf8'));
const status = fs.existsSync(path.join(ROOT, 'status.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'status.json'), 'utf8')) : null;
const excluded: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'suite/models-excluded.json'), 'utf8'));
const models = [...new Set(reports.flatMap(r => Object.keys(r.perModel)))].sort((a, b) => a.replace('~', '').localeCompare(b.replace('~', '')));
const slug = (m: string) => m.replace(/^~/, 'alias-').replace(/\//g, '--').replace(/[^a-zA-Z0-9.-]/g, '-');
const history = (m: string) => reports.map(r => ({ date: r.date, p: r.perModel[m] })).filter(x => x.p);

// drift vs the day-1 baseline; on the baseline day itself there is nothing to compare
const drift = (m: string, r: Report) => (r.date === BASELINE.date ? null : r.perModel[m]?.drift_vs_compare);
function verdict(m: string) {
  const p = latest.perModel[m]; const d = drift(m, latest);
  if (!p || !d || !d.n) return { key: 'none', label: 'No comparison yet' };
  if (d.ci[0] > (p.noise?.ci?.[1] ?? 0)) return { key: 'changed', label: 'Changed since Oct 20' };
  return { key: 'steady', label: 'Within noise' };
}

// ---------- formatting ----------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pct = (x: number | undefined | null, d = 1) => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const ci = (c?: number[]) => (c && Number.isFinite(c[0]) ? `${(c[0] * 100).toFixed(1)}–${(c[1] * 100).toFixed(1)}%` : '—');
const ms = (x?: number) => (x == null || !Number.isFinite(x) ? '—' : x >= 1000 ? (x / 1000).toFixed(1) + ' s' : Math.round(x) + ' ms');
const dateLong = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---------- tiny markdown (headings, paragraphs, lists, tables, emphasis, code, links) ----------
function inline(s: string) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function markdown(md: string) {
  const out: string[] = []; const lines = md.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = l.match(/^(#{2,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) { if (!/^\|[\s:-]+\|/.test(lines[i])) rows.push(lines[i].slice(1, -1).split('|').map(c => c.trim())); i++; }
      out.push(`<div class="table-wrap"><table><thead><tr>${rows[0].map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(\s*[-*]|\s*\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items: string[] = [];
      while (i < lines.length && /^(\s*[-*]|\s*\d+\.)\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s/, '')); i++; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{2,4}\s|\||\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
function readPost(file: string) {
  const raw = fs.readFileSync(file, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = Object.fromEntries((fm?.[1] ?? '').split('\n').map(l => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  return { slug: path.basename(file, '.md'), title: meta.title, date: meta.date, summary: meta.summary, draft: meta.draft === 'true', html: markdown(raw.slice(fm?.[0].length ?? 0)) };
}
// Published posts live in posts/; unpublished drafts live in the private repo and only appear with --drafts true.
const postDirs = [path.join(ROOT, 'posts'), ...(args.drafts === 'true' ? [path.join(ROOT, 'private/post-drafts')] : [])];
const posts = postDirs.filter(d => fs.existsSync(d)).flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.md')).map(f => readPost(path.join(d, f))))
  .filter(p => !p.draft || args.drafts === 'true').sort((a, b) => b.date.localeCompare(a.date));

// ---------- charts ----------
// One series per chart (flip rate vs the Oct 20 baseline), a dashed noise reference, hover/focus tooltips.
function trace(m: string, w = 220, h = 44, withAxis = false, sharedMax?: number) {
  const pts = reports.map(r => ({ date: r.date, d: drift(m, r), noise: r.perModel[m]?.noise?.flip_rate })).filter(x => x.d !== undefined);
  const vals = pts.map(x => (x.d ? x.d.flip_rate : 0)).concat(pts.map(x => x.noise ?? 0));
  const ymax = (sharedMax ?? Math.max(0.05, ...vals.filter(Number.isFinite))) * 1.15;
  const padL = withAxis ? 34 : 4, padR = 6, padT = 6, padB = withAxis ? 18 : 6;
  const x = (i: number) => padL + (pts.length <= 1 ? (w - padL - padR) / 2 : (i * (w - padL - padR)) / (pts.length - 1));
  const y = (v: number) => padT + (h - padT - padB) * (1 - v / ymax);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.d ? p.d.flip_rate : 0).toFixed(1)}`).join(' ');
  const noise = latest.perModel[m]?.noise?.flip_rate;
  const axis = withAxis ? `<g class="axis"><line x1="${padL}" x2="${w - padR}" y1="${y(0)}" y2="${y(0)}"/><text x="${padL - 6}" y="${y(0) + 4}" text-anchor="end">0%</text><text x="${padL - 6}" y="${y(ymax / 1.15) + 4}" text-anchor="end">${(ymax / 1.15 * 100).toFixed(0)}%</text>${pts.map((p, i) => `<text x="${x(i)}" y="${h - 4}" text-anchor="${pts.length > 1 && i === pts.length - 1 ? 'end' : pts.length > 1 && i === 0 ? 'start' : 'middle'}">${esc(dateLong(p.date).replace(/, \d{4}$/, ''))}</text>`).join('')}</g>` : '';
  const dots = pts.map((p, i) => {
    const v = p.d ? p.d.flip_rate : 0;
    const tip = p.d ? `${dateLong(p.date)}: ${pct(v)} of answers differ from Oct 20 (95% CI ${ci(p.d.ci)}); noise ${pct(p.noise)}` : `${dateLong(p.date)}: baseline`;
    return `<g class="pt" tabindex="0" data-tip="${esc(tip)}"><circle class="hit" cx="${x(i)}" cy="${y(v)}" r="10"/><circle class="dot" cx="${x(i)}" cy="${y(v)}" r="4"/></g>`;
  }).join('');
  return `<svg class="trace" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`${m}: share of answers that differ from the Oct 20 baseline, by run date`)}">${axis}${noise != null ? `<line class="noise" x1="${padL}" x2="${w - padR}" y1="${y(noise)}" y2="${y(noise)}"><title>Noise floor ${pct(noise)}</title></line>` : ''}<polyline class="line" points="${line}"/>${dots}</svg>`;
}

// ---------- layout ----------
const CSS = `
:root{--paper:#F7F9FA;--grid:#E6ECF0;--ink:#1B2430;--muted:#55636F;--trace:#2457C5;--warn:#B26A00;--panel:#FFFFFF;--focus:#2457C5;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#121A23;--grid:#263241;--ink:#E4EAF0;--muted:#9AA8B5;--trace:#5A82E0;--warn:#C0843A;--panel:#17212C;--focus:#7FA6FF;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#121A23;--grid:#263241;--ink:#E4EAF0;--muted:#9AA8B5;--trace:#5A82E0;--warn:#C0843A;--panel:#17212C;--focus:#7FA6FF;color-scheme:dark}
*{box-sizing:border-box}
html{font-size:17px}
body{margin:0;background:var(--paper);color:var(--ink);font:400 1rem/1.55 "Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;
 background-image:linear-gradient(var(--grid) 1px,transparent 1px);background-size:100% 28px;background-attachment:fixed}
a{color:var(--trace);text-underline-offset:.18em}
a:focus-visible,.pt:focus-visible,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header.site{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;justify-content:space-between;padding:22px 0 10px}
.mark{font-weight:600;font-size:1.15rem;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.mark span{color:var(--trace)}
nav.site{display:flex;flex-wrap:wrap;gap:4px 16px}
nav.site a{color:var(--muted);text-decoration:none}
nav.site a:hover,nav.site a[aria-current]{color:var(--ink)}
main{padding-bottom:64px}
h1{font-size:2.1rem;line-height:1.15;letter-spacing:-.02em;font-weight:600;max-width:24ch;margin:28px 0 12px}
h2{font-size:1.35rem;line-height:1.25;font-weight:600;margin:44px 0 10px}
h3{font-size:1.08rem;font-weight:600;margin:28px 0 6px}
p,li{max-width:70ch}
.lede{font-size:1.12rem;color:var(--muted);max-width:62ch}
.fresh{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;margin:6px 0 14px;color:var(--muted)}
.fresh .ok{width:9px;height:9px;border-radius:50%;background:var(--trace);align-self:center}
.fresh .bad{width:9px;height:9px;border-radius:50%;background:var(--warn);align-self:center}
.panel{background:var(--panel);border:1px solid var(--grid);border-radius:6px;padding:4px 0}
.strip{list-style:none;margin:20px 0 0;padding:0}
.strip li{display:grid;grid-template-columns:minmax(0,17.5rem) 220px minmax(0,1fr);gap:4px 18px;align-items:center;padding:6px 14px;border-bottom:1px solid var(--grid);max-width:none}
.strip li:last-child{border-bottom:0}
.strip .name{overflow-wrap:anywhere}
.strip .read{color:var(--muted)}
.strip .read strong{color:var(--ink);font-weight:600}
.flag{display:inline-flex;gap:5px;align-items:center;font-size:.9rem;font-weight:600;color:var(--ink)}
.flag svg{fill:var(--warn);flex:none;width:12px;height:12px}
.trace .line{fill:none;stroke:var(--trace);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.trace .noise{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.trace .dot{fill:var(--trace);stroke:var(--panel);stroke-width:2}
.trace .hit{fill:transparent}
.trace .axis line{stroke:var(--grid)}
.trace .axis text{fill:var(--muted);font-size:11px}
svg.trace.big{width:100%;max-width:640px;height:auto}
.table-wrap{overflow-x:auto;margin:12px 0;border:1px solid var(--grid);border-radius:6px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--grid);vertical-align:top;white-space:nowrap}
td.wrap-ok,th.wrap-ok{white-space:normal;min-width:12rem}
th{font-weight:600;color:var(--muted)}
td.num,th.num{text-align:right}
tbody tr:last-child td{border-bottom:0}
code{font-size:.9em;background:var(--grid);padding:.05em .3em;border-radius:3px}
.note{color:var(--muted);font-size:.92rem}
.posts{list-style:none;padding:0}
.posts li{margin:0 0 18px}
.posts .when{color:var(--muted);font-size:.92rem}
article{max-width:72ch}
footer.site{border-top:1px solid var(--grid);padding:20px 0 40px;color:var(--muted);font-size:.92rem}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--paper);padding:6px 9px;border-radius:4px;font-size:.85rem;max-width:280px;display:none;z-index:9}
@media (max-width:720px){h1{font-size:1.65rem}.strip li{grid-template-columns:1fr;padding:10px 12px}.strip svg.trace{width:100%;height:auto}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
const TIP_JS = `const t=document.getElementById('tip');function show(e,el){t.textContent=el.dataset.tip;t.style.display='block';const r=el.getBoundingClientRect();t.style.left=Math.min(innerWidth-290,r.left+12)+'px';t.style.top=(r.top-38)+'px'}
document.querySelectorAll('.pt').forEach(el=>{el.addEventListener('mouseenter',e=>show(e,el));el.addEventListener('focus',e=>show(e,el));el.addEventListener('mouseleave',()=>t.style.display='none');el.addEventListener('blur',()=>t.style.display='none')});`;

const NAV: [string, string][] = [['/', 'Tracker'], ['/models/', 'Models'], ['/posts/', 'Findings'], ['/method/', 'Method'], ['/data/', 'Data'], ['/status/', 'Status']];
function page(p: { path: string; title: string; description: string; body: string }) {
  const full = p.path === '/' ? 'Decision Drift: daily tracker for decision models' : `${p.title} · Decision Drift`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(full)}</title><meta name="description" content="${esc(p.description)}"><link rel="canonical" href="${SITE}${p.path}">
<meta property="og:title" content="${esc(full)}"><meta property="og:description" content="${esc(p.description)}"><meta property="og:type" content="website"><meta property="og:url" content="${SITE}${p.path}">
<link rel="alternate" type="application/rss+xml" title="Decision Drift" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><polyline points="1,11 5,11 7,4 9,13 11,8 15,8" fill="none" stroke="#2457C5" stroke-width="2"/></svg>')}">
<style>${CSS}</style></head><body><div class="wrap">
<header class="site"><a class="mark" href="/">decision<span>drift</span></a><nav class="site" aria-label="Main">${NAV.map(([h, l]) => `<a href="${h}"${(h === '/' ? p.path === '/' : p.path.startsWith(h)) ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav></header>
<main id="main">${p.body}</main>
<footer class="site">An independent tracker; not affiliated with any model vendor. Runs daily at 10:17 UTC against every compatible decision model on OpenRouter. Code, public suite and raw results: <a href="${REPO}">${REPO.replace('https://', '')}</a>. Suite items CC0 except Banking77 (CC BY 4.0) and CLINC150 (CC BY 3.0).</footer>
</div><div id="tip" role="tooltip"></div><script>${TIP_JS}</script></body></html>`;
}
function write(rel: string, content: string) {
  const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
}
const flagIcon = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11 10H1z"/></svg>';
const freshness = () => {
  const s = status?.last_run;
  const ok = !s || s.status === 'ok';
  const when = s ? dateLong(s.date) : dateLong(latest.date);
  return `<p class="fresh"><span class="${ok ? 'ok' : 'bad'}" aria-hidden="true"></span>${ok ? `Last run ${when}, ${latest.models} models.` : `The ${when} run had problems; see <a href="/status/">status</a>.`} <a href="/status/">Run status</a></p>`;
};

// ---------- pages ----------
fs.rmSync(OUT, { recursive: true, force: true });
// flagged models first, then by how far changed answers sit above the model's own noise
const excess = (m: string) => { const d = drift(m, latest); return d ? d.flip_rate - (latest.perModel[m].noise?.flip_rate ?? 0) : -1; };
const ordered = models.filter(m => latest.perModel[m]).sort((a, b) => Number(verdict(b).key === 'changed') - Number(verdict(a).key === 'changed') || excess(b) - excess(a));
const stripMax = Math.max(0.05, ...ordered.flatMap(m => reports.flatMap(r => [drift(m, r)?.flip_rate ?? 0, r.perModel[m]?.noise?.flip_rate ?? 0])));
const daysTracked = reports.length;
const jev = latest.jev_113_vs_114;

write('index.html', page({ path: '/', title: 'Tracker', description: 'Daily, independent measurements of whether decision models such as Jev, Clef and Decider change their answers over time.', body: `
<h1>Do decision models keep giving the same answers?</h1>
<p class="lede">Every day we send the same frozen suite (${latest.items} inputs, ${(manifest.splits.public.questions + manifest.splits.private.questions).toLocaleString()} questions) to every decision model on OpenRouter and record what changes. Each trace is the share of a model's answers that differ from its first run on Oct 20, 2026, all on one scale; the dashed line is how much it varies when asked the same thing twice.</p>
${freshness()}
<div class="panel"><ul class="strip">${ordered.map(m => {
  const d = drift(m, latest); const v = verdict(m); const p = latest.perModel[m];
  return `<li><div class="name"><a href="/models/${slug(m)}/">${esc(m)}</a></div>${trace(m, 220, 44, false, stripMax)}<div class="read">${d ? `<strong>${pct(d.flip_rate)}</strong> differ since Oct 20, noise ${pct(p.noise.flip_rate)}` : 'First run; no comparison yet'}${v.key === 'changed' ? ` <span class="flag">${flagIcon}${v.label}</span>` : ''}</div></li>`;
}).join('')}</ul></div>
<p class="note">${daysTracked} run${daysTracked === 1 ? '' : 's'} so far. A model is flagged when the lower end of its 95% interval for changed answers is above its own noise level. Hover or focus a point for the numbers; every value is also in the <a href="/models/">models table</a>.</p>
${jev ? `<h2>Jev 1.14 is not Jev 1.13</h2><p>TypeSafe's <code>~typesafe/jev-latest</code> alias now serves 1.14. On our suite the two versions give a different top answer ${pct(jev.overall.flip_rate)} of the time (95% CI ${ci(jev.overall.ci)}), about five times their noise level, and Score questions moved most (${pct(jev.by_type.score.flip_rate)}). <a href="/findings/jev-1-13-vs-1-14/">See the breakdown</a>.</p>` : ''}
${posts.length ? `<h2>Findings</h2><ul class="posts">${posts.slice(0, 3).map(p => `<li><a href="/posts/${p.slug}/">${esc(p.title)}</a><div class="when">${dateLong(p.date)}</div><div>${esc(p.summary)}</div></li>`).join('')}</ul>` : ''}
` }));

// models table + per-model pages
const modelRows = models.filter(m => latest.perModel[m]).map(m => {
  const p = latest.perModel[m]; const d = drift(m, latest);
  return `<tr><td><a href="/models/${slug(m)}/">${esc(m)}</a></td><td class="num">${d ? pct(d.flip_rate) : '—'}</td><td class="num">${pct(p.noise.flip_rate)}</td><td class="num">${pct(p.shuffle.flip_rate)}</td><td class="num">${pct(p.paraphrase.flip_rate)}</td><td class="num">${pct(p.accuracy)}</td><td>${ci(p.accuracy_ci)}</td><td class="num">${ms(p.latency_p50)}</td><td class="num">${pct(p.error_rate)}</td></tr>`;
}).join('');
write('models/index.html', page({ path: '/models/', title: 'Models', description: 'Latest drift, noise, robustness, accuracy and latency for every tracked decision model.', body: `
<h1>Models</h1><p class="lede">Latest run, ${dateLong(latest.date)}. Percentages are shares of top answers. Accuracy is on the gold-labeled questions, which are the easier, everyone-agrees part of the suite, so it is not a leaderboard; overlapping intervals mean no meaningful difference.</p>
<div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Changed since Oct 20</th><th class="num">Noise</th><th class="num">Option shuffle</th><th class="num">Paraphrase</th><th class="num">Gold accuracy</th><th>95% CI</th><th class="num">Median latency</th><th class="num">Errors</th></tr></thead><tbody>${modelRows}</tbody></table></div>
<h2>Not tracked</h2><ul>${Object.entries(excluded).map(([m, why]) => `<li><code>${esc(m)}</code>: ${esc(why)}</li>`).join('')}</ul>` }));

for (const m of models) {
  const h = history(m); const last = h.at(-1)?.p; if (!last) continue;
  const rows = h.map(({ date, p }) => {
    const d = date === BASELINE.date ? null : p.drift_vs_compare;
    return `<tr><td>${dateLong(date)}</td><td class="wrap-ok">${esc(p.served.join(', '))}</td><td class="wrap-ok">${esc(p.providers.join(', '))}</td><td class="num">${d ? pct(d.flip_rate) : 'baseline'}</td><td>${d ? ci(d.ci) : ''}</td><td class="num">${pct(p.noise.flip_rate)}</td><td class="num">${pct(p.shuffle.flip_rate)}</td><td class="num">${pct(p.paraphrase.flip_rate)}</td><td class="num">${pct(p.accuracy)}</td><td class="num">${ms(p.latency_p50)} / ${ms(p.latency_p95)}</td><td class="num">${pct(p.error_rate)}</td></tr>`;
  }).join('');
  const isAlias = m.startsWith('~');
  write(`models/${slug(m)}/index.html`, page({ path: `/models/${slug(m)}/`, title: m, description: `Daily drift, noise and robustness measurements for ${m}.`, body: `
<h1>${esc(m)}</h1>
<p class="lede">${isAlias ? `An alias. On ${dateLong(latest.date)} it served <code>${esc(last.served.join(', '))}</code>; a change of snapshot shows up in the table below.` : `Served by ${esc(last.providers.join(', '))}. Snapshot on ${dateLong(latest.date)}: <code>${esc(last.served.join(', '))}</code>.`}</p>
<h2>Answers that differ from Oct 20</h2>${trace(m, 640, 160, true).replace('class="trace"', 'class="trace big"')}
<p class="note">Solid line: share of top answers that differ from the Oct 20 baseline. Dashed line: the latest noise level, the share that differs between two identical requests sent minutes apart.</p>
<h2>Run history</h2>
<div class="table-wrap"><table><thead><tr><th>Run</th><th class="wrap-ok">Served snapshot</th><th class="wrap-ok">Providers</th><th class="num">Changed</th><th>95% CI</th><th class="num">Noise</th><th class="num">Shuffle</th><th class="num">Paraphrase</th><th class="num">Gold acc.</th><th class="num">p50 / p95</th><th class="num">Errors</th></tr></thead><tbody>${rows}</tbody></table></div>
${last.errors ? `<h2>Errors in the latest run</h2><ul>${last.error_samples.map((s: string) => `<li><code>${esc(s)}</code></li>`).join('')}</ul>` : ''}
${last.providers.length > 1 && last.noise_cross_provider?.n ? `<h2>Provider mixing</h2><p>This model is served by more than one upstream provider. Duplicate requests that went to a different provider changed ${pct(last.noise_cross_provider.flip_rate)} of answers (n=${last.noise_cross_provider.n}); same-provider duplicates changed ${pct(last.noise_same_provider.flip_rate)} (n=${last.noise_same_provider.n}).</p>` : ''}
` }));
}

// Jev finding
if (jev) {
  const rows = (o: Record<string, any>) => Object.entries(o).sort((a, b) => b[1].flip_rate - a[1].flip_rate).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${pct(v.flip_rate)}</td><td>${ci(v.ci)}</td><td class="num">${Number.isFinite(v.mean_tv) ? v.mean_tv.toFixed(3) : '—'}</td></tr>`).join('');
  const head = '<thead><tr><th>Slice</th><th class="num">Questions</th><th class="num">Different answer</th><th>95% CI</th><th class="num">Mean distance</th></tr></thead>';
  write('findings/jev-1-13-vs-1-14/index.html', page({ path: '/findings/jev-1-13-vs-1-14/', title: 'Jev 1.13 vs 1.14', description: 'How often TypeSafe Jev 1.14 gives a different answer than Jev 1.13 on the same questions.', body: `
<h1>Jev 1.14 vs 1.13</h1><p class="lede">Both versions remain available on OpenRouter, so we ask both the same ${jev.overall.n.toLocaleString()} questions in every run. Latest run: ${dateLong(latest.date)}.</p>
<p>The top answer differs ${pct(jev.overall.flip_rate)} of the time (95% CI ${ci(jev.overall.ci)}). Each version's own noise level is ${pct(latest.perModel['typesafe/jev-1.13']?.noise.flip_rate)} and ${pct(latest.perModel['typesafe/jev-1.14']?.noise.flip_rate)}. Gold accuracy is ${pct(latest.perModel['typesafe/jev-1.13']?.accuracy)} for 1.13 and ${pct(latest.perModel['typesafe/jev-1.14']?.accuracy)} for 1.14: the answers changed, but not toward being more often right on the clear cases.</p>
<h2>By question type</h2><div class="table-wrap"><table>${head}<tbody>${rows(jev.by_type)}</tbody></table></div>
<h2>By task family</h2><div class="table-wrap"><table>${head}<tbody>${rows(jev.by_family)}</tbody></table></div>
<p class="note">Mean distance is the total-variation distance between the two probability distributions, from 0 (identical) to 1. Families with few questions have wide intervals.</p>` }));
}

// posts
write('posts/index.html', page({ path: '/posts/', title: 'Findings', description: 'Write-ups of what the Decision Drift tracker has found.', body: `<h1>Findings</h1>${posts.length ? `<ul class="posts">${posts.map(p => `<li><a href="/posts/${p.slug}/">${esc(p.title)}</a><div class="when">${dateLong(p.date)}</div><div>${esc(p.summary)}</div></li>`).join('')}</ul>` : '<p>The first write-up is in progress. The <a href="/">tracker</a> is live in the meantime.</p>'}` }));
for (const p of posts) write(`posts/${p.slug}/index.html`, page({ path: `/posts/${p.slug}/`, title: p.title, description: p.summary, body: `<article><h1>${esc(p.title)}</h1><p class="note">${dateLong(p.date)}</p>${p.html}</article>` }));

// method
const cov = manifest.coverage;
const covList = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(', ');
write('method/index.html', page({ path: '/method/', title: 'Method', description: 'How Decision Drift measures drift, noise, robustness and calibration in decision models.', body: `<article>
<h1>Method</h1>
<p class="lede">Decision models answer typed questions (yes/no, pick one, score on a scale) with probabilities instead of text. We check whether those answers stay put.</p>
<h2>The suite</h2>
<p>Version 1 has ${manifest.splits.public.states + manifest.splits.private.states} states and ${manifest.splits.public.questions + manifest.splits.private.questions} questions across task families (${covList(cov.family)}) and languages (${covList(cov.language)}). Every model gets the identical request. Questions follow the published System One conventions and are never tuned against results. Items are immutable: a flawed item is retired and replaced, never edited, and the headline numbers always use the original cohort.</p>
<p>About 70% of the suite is public. The other 30% is private so that no vendor can train on the whole suite; we publish only its hash and aggregate scores. Public hash <code>${manifest.splits.public.sha256.slice(0, 16)}</code>, private hash <code>${manifest.splits.private.sha256.slice(0, 16)}</code>.</p>
<h2>What we measure</h2>
<ul>
<li><strong>Changed since Oct 20:</strong> the share of top answers that differ from the same model's first run, counting only byte-identical requests.</li>
<li><strong>Noise:</strong> the share that differs when 100 states are sent again minutes later. Drift only counts when its interval sits above this.</li>
<li><strong>Option shuffle and paraphrase:</strong> the share that changes when choice options are reordered, or when the instructions are reworded with the same meaning.</li>
<li><strong>Gold accuracy and calibration:</strong> on questions where the reference label and two independent LLM labelers (GPT-6.1 Sol, Gemini 4 Argon) all agree. These are the clearer cases, so accuracy runs high and is not a ranking.</li>
<li><strong>Latency, errors and cost</strong> as seen by our runner, network included.</li>
</ul>
<h2>Schedule and limits</h2>
<p>Runs daily at 10:17 UTC through OpenRouter's decisions API, which is in alpha. Every response is stored raw. All intervals are 95% Wilson intervals; we do not report slice results that are not meaningful at their size. Models that cannot answer Choice and Score questions are listed as not tracked.</p>
</article>` }));

// data + status
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'data/latest.json'), JSON.stringify(latest));
fs.writeFileSync(path.join(OUT, 'data/history.json'), JSON.stringify(Object.fromEntries(models.map(m => [m, history(m).map(({ date, p }) => ({ date, served: p.served, providers: p.providers, changed_since_baseline: date === BASELINE.date ? null : p.drift_vs_compare, noise: p.noise, shuffle: p.shuffle, paraphrase: p.paraphrase, accuracy: p.accuracy, accuracy_ci: p.accuracy_ci, latency_p50: p.latency_p50, latency_p95: p.latency_p95, error_rate: p.error_rate }))]))));
fs.copyFileSync(path.join(ROOT, 'suite/manifest-v1.json'), path.join(OUT, 'data/manifest-v1.json'));
fs.copyFileSync(path.join(ROOT, 'suite/core-v1.public.jsonl'), path.join(OUT, 'data/core-v1.public.jsonl'));
write('data/index.html', page({ path: '/data/', title: 'Data', description: 'Download Decision Drift results, the public probe suite and the manifest.', body: `<h1>Data</h1><p class="lede">Everything here is regenerated after each daily run.</p><ul>
<li><a href="/data/latest.json">latest.json</a>: every metric for every model in the latest run.</li>
<li><a href="/data/history.json">history.json</a>: per-model metrics for every run since Oct 20, 2026.</li>
<li><a href="/data/core-v1.public.jsonl">core-v1.public.jsonl</a>: the public split of the suite, with gold labels.</li>
<li><a href="/data/manifest-v1.json">manifest-v1.json</a>: coverage, labeling method and split hashes.</li>
<li>Raw responses for every request on public items: <a href="${REPO}/tree/main/results">${REPO.replace('https://', '')}/results</a>.</li></ul>` }));
fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(status ?? { last_run: { date: latest.date, status: 'ok' } }));
const s = status;
write('status/index.html', page({ path: '/status/', title: 'Status', description: 'Status of the latest Decision Drift collection run.', body: `<h1>Run status</h1>
${s ? `<p class="lede">Latest run ${dateLong(s.last_run.date)}: <strong>${s.last_run.status === 'ok' ? 'completed' : 'had problems'}</strong>, finished ${esc(new Date(s.last_run.finished_at).toUTCString())}. Next run ${esc(s.schedule)}.</p>
<ul><li>${s.models} models, ${s.requests.toLocaleString()} requests, ${s.errors} errors.</li>${s.models_with_errors.length ? `<li>Models with more than 5% errors: ${s.models_with_errors.map((m: string) => `<code>${esc(m)}</code>`).join(', ')}.</li>` : ''}</ul>` : `<p class="lede">Latest run ${dateLong(latest.date)}. Runs daily at 10:17 UTC.</p>`}
<p>If a day is missing from the <a href="/">tracker</a>, that run did not complete. Gaps are left as gaps; nothing is backfilled.</p>` }));

// feeds and machine-readable files
const feedItems = [
  ...posts.map(p => ({ title: p.title, link: `${SITE}/posts/${p.slug}/`, date: p.date, desc: p.summary })),
  ...reports.map(r => ({ title: `Daily run ${dateLong(r.date)}`, link: `${SITE}/models/`, date: r.date, desc: `${r.models} models measured.` })),
].sort((a, b) => b.date.localeCompare(a.date));
fs.writeFileSync(path.join(OUT, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Decision Drift</title><link>${SITE}/</link><description>Daily measurements of whether decision models change their answers.</description>${feedItems.map(i => `<item><title>${esc(i.title)}</title><link>${i.link}</link><guid isPermaLink="false">${esc(i.link + '#' + i.date)}</guid><pubDate>${new Date(i.date + 'T12:00:00Z').toUTCString()}</pubDate><description>${esc(i.desc)}</description></item>`).join('')}</channel></rss>`);
const pages = ['/', '/models/', '/posts/', '/method/', '/data/', '/status/', ...models.map(m => `/models/${slug(m)}/`), ...(jev ? ['/findings/jev-1-13-vs-1-14/'] : []), ...posts.map(p => `/posts/${p.slug}/`)];
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
fs.writeFileSync(path.join(OUT, 'llms.txt'), `# Decision Drift

> An independent, daily tracker of decision models (typed-answer models such as TypeSafe Jev, Cloudflare Clef, Perplexity Decider, OpenAI Luna Decisions). Every compatible model on OpenRouter gets the same frozen probe suite every day; we report how many answers change versus the first run (Oct 20, 2026), each model's noise level, sensitivity to option order and paraphrase, gold-label accuracy and calibration, latency and errors.

Latest run: ${latest.date}, ${latest.models} models, ${latest.items} states.
${jev ? `Jev 1.13 vs 1.14: ${pct(jev.overall.flip_rate)} of top answers differ (95% CI ${ci(jev.overall.ci)}).` : ''}

## Pages
- [Tracker](${SITE}/): per-model traces of answers changed since Oct 20
- [Models](${SITE}/models/): latest metrics table
${jev ? `- [Jev 1.13 vs 1.14](${SITE}/findings/jev-1-13-vs-1-14/): version comparison by question type and task family\n` : ''}- [Method](${SITE}/method/): suite design, metrics, limits
${posts.map(p => `- [${p.title}](${SITE}/posts/${p.slug}/): ${p.summary}`).join('\n')}

## Data
- [latest.json](${SITE}/data/latest.json)
- [history.json](${SITE}/data/history.json)
- [Public suite](${SITE}/data/core-v1.public.jsonl)
- [Source and raw results](${REPO})
`);
write('404.html', page({ path: '/404', title: 'Not found', description: 'Page not found.', body: '<h1>No page here</h1><p>Try the <a href="/">tracker</a> or the <a href="/models/">models table</a>.</p>' }));
console.log(`built ${pages.length} pages into ${path.relative(ROOT, OUT)} from ${reports.length} runs`);
