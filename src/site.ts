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
// Pooled noise (several days of repeats) is the better estimate; keep the single-day figure as noise_day.
for (const r of reports) for (const p of Object.values(r.perModel)) if (p.noise_pooled?.n) { p.noise_day = p.noise; p.noise = p.noise_pooled; }
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
  if (d.ci[0] > (p.noise?.ci?.[1] ?? 0)) return { key: 'changed', label: 'Change detected' };
  return { key: 'steady', label: 'No change detected' };
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

// ---------- display helpers ----------
const VENDOR: Record<string, string> = { typesafe: 'TypeSafe', perplexity: 'Perplexity', microsoft: 'Microsoft', cloudflare: 'Cloudflare', liquid: 'Liquid', 'nace-ai': 'Nace.AI', inception: 'Inception', upstage: 'Upstage', respan: 'Respan', togethercomputer: 'Together', jaredpalmer: 'Jared Palmer', scaledown: 'ScaleDown', openai: 'OpenAI' };
const vendorOf = (m: string) => m.replace(/^~/, '').split('/')[0];
const vendorName = (m: string) => VENDOR[vendorOf(m)] ?? vendorOf(m);
const nameOf = (m: string) => m.replace(/^~/, '').split('/').slice(1).join('/');
const isAlias = (m: string) => m.startsWith('~');
const baselineOf = (m: string) => reports[0]?.date === BASELINE.date ? reports[0].perModel[m] : undefined;
const TYPE_NAME: Record<string, string> = { noul: 'Yes/no', choice: 'Pick-one', score: 'Score' };
const shortDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const utcTime = (iso: string) => new Date(iso).toISOString().slice(11, 16) + ' UTC';

// Short factual notes for a flagged model, derived from the data.
function notes(m: string): string[] {
  const p = latest.perModel[m]; const b = baselineOf(m); const d = drift(m, latest);
  if (!p || !d || verdict(m).key !== 'changed') return [];
  const out: string[] = [];
  if (b && b.served.join() === p.served.join()) out.push('Same snapshot ID.');
  else if (b) out.push('New snapshot ID.');
  if (p.noise.flip_rate === 0) out.push('Zero noise.');
  const types = Object.entries<any>(p.drift_by_type ?? {}).filter(([, v]) => v.n >= 50).sort((a, b) => b[1].flip_rate - a[1].flip_rate);
  if (types[0] && types[0][1].flip_rate >= 2 * d.flip_rate) out.push(`${TYPE_NAME[types[0][0]]} answers: ${pct(types[0][1].flip_rate)} changed.`);
  return out.slice(0, 2);
}

// ---------- layout ----------
// Cookieless page analytics (self-hosted Umami); only counts visits on the production domain.
const UMAMI = process.env.UMAMI_SRC && process.env.UMAMI_WEBSITE_ID
  ? `<script defer src="${process.env.UMAMI_SRC}" data-website-id="${process.env.UMAMI_WEBSITE_ID}" data-domains="decisiondrift.dev"></script>` : '';

const CSS = `
:root{--bg:#FFFFFF;--ink:#1C2127;--muted:#4A5560;--faint:#7B8794;--rule:#E3E7EB;--soft:#F3F5F7;--band:#E3E7EB;--dot:#7B8794;--hot:#C2410C;--link:#1F4FB8;--base:#1C2127;--ok:#9FB3C8;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14181D;--ink:#E6E9ED;--muted:#A3ADB8;--faint:#7E8995;--rule:#2A3139;--soft:#1B2026;--band:#2B333C;--dot:#5B6B7C;--hot:#E06A2C;--link:#8AB4F8;--base:#E6E9ED;--ok:#4D5F72;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#14181D;--ink:#E6E9ED;--muted:#A3ADB8;--faint:#7E8995;--rule:#2A3139;--soft:#1B2026;--band:#2B333C;--dot:#5B6B7C;--hot:#E06A2C;--link:#8AB4F8;--base:#E6E9ED;--ok:#4D5F72;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.55 "Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:.16em;text-decoration-thickness:1px}
a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:2px}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.mast{display:flex;flex-wrap:wrap;gap:6px 20px;justify-content:space-between;align-items:baseline;border-bottom:2px solid var(--ink);padding:26px 0 10px}
.mark{font-weight:700;font-size:17px;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.mast nav{display:flex;flex-wrap:wrap;gap:4px 18px}.mast nav a{color:var(--muted);text-decoration:none;font-size:15px}
.mast nav a:hover,.mast nav a[aria-current]{color:var(--ink);text-decoration:underline;text-decoration-color:var(--rule)}
main{padding:0 0 56px}
h1,h2.serif{font-family:Newsreader,Georgia,serif;font-weight:600;letter-spacing:-.015em}
h1{font-size:40px;line-height:1.1;margin:34px 0 6px}
h2{font-size:17px;font-weight:700;margin:40px 0 10px}
h3{font-size:16px;font-weight:700;margin:24px 0 6px}
p,li{max-width:68ch}
.dek{font-size:18px;color:var(--muted);margin:0 0 22px}
.crumb{color:var(--faint);font-size:14px;margin:26px 0 0}.crumb a{color:var(--faint)}
.crumb+h1{margin-top:4px}
.meta{color:var(--muted);margin:0 0 24px}
.note,.foot{color:var(--faint);font-size:14px}
.foot{border-top:1px solid var(--rule);margin-top:18px;padding-top:12px}
.hot{color:var(--hot)}
code{font-size:.92em;background:var(--soft);padding:.05em .3em;border-radius:3px}
/* key */
.key{display:flex;flex-wrap:wrap;gap:8px 22px;font-size:14px;color:var(--muted);margin:0 0 10px}
.key i{display:inline-block;vertical-align:-2px;margin-right:7px}
.k-band{width:26px;height:12px;background:var(--band);border-radius:3px}.k-dot{width:11px;height:11px;border-radius:50%;background:var(--dot)}.k-hot{width:11px;height:11px;border-radius:50%;background:var(--hot)}
/* dot chart */
.dc{--name:15rem;--note:16rem}
.dc-axis,.dc-row{display:grid;grid-template-columns:var(--name) minmax(0,1fr) var(--note);gap:0 18px;align-items:center}
.dc-axis .ticks{position:relative;height:22px;border-bottom:1px solid var(--rule)}
.dc-axis .ticks span{position:absolute;bottom:4px;transform:translateX(-50%);font-size:12px;color:var(--faint)}
.dc ol{list-style:none;margin:0;padding:0}
.log{list-style:none;margin:8px 0 0;padding:0;max-width:44rem}
.log li{display:grid;grid-template-columns:4.5rem 1fr;gap:0 12px;padding:7px 0;border-top:1px solid var(--rule);font-size:15px}
.log time{color:var(--muted);font-variant-numeric:tabular-nums}
.log-change a{color:var(--hot);font-weight:600}
.dc-grp{margin:18px 0 4px;padding-left:calc(var(--name) + 18px);font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.dc-grp:first-child{margin-top:6px}
.dc-row{min-height:30px;max-width:none;padding:2px 0}
.dc-row .nm{text-align:right;font-size:14px;color:var(--ink);text-decoration:none;line-height:1.25;overflow-wrap:anywhere}
.dc-row .nm small{color:var(--faint);font-size:12px;margin-left:5px}
.dc-row .nm:hover b,.dc-row .nm:hover{text-decoration:underline;text-decoration-color:var(--rule)}
.dc-row.is-hot .nm{font-weight:700}
.dc-row .nm b{font-weight:inherit}
.track{position:relative;height:26px;background:linear-gradient(var(--rule),var(--rule)) left center/100% 1px no-repeat}
.track .grid{position:absolute;top:0;bottom:0;width:1px;background:var(--soft)}
.track .band{position:absolute;left:0;top:7px;height:12px;border-radius:3px;background:var(--band)}
.track .dot{position:absolute;top:7px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--dot);box-shadow:0 0 0 2px var(--bg)}
.is-hot .track .dot{background:var(--hot)}
.track .hit{position:absolute;top:1px;width:24px;height:24px;margin-left:-12px;border-radius:50%}
.track .val{position:absolute;top:3px;font-size:13px;color:var(--muted);margin-left:12px;white-space:nowrap}
.track .val.flip{margin-left:0;transform:translateX(calc(-100% - 12px))}
.is-hot .track .val{color:var(--hot);font-weight:700}
.dc-row .nt{font-family:Newsreader,Georgia,serif;font-style:italic;font-size:14px;line-height:1.3;color:var(--ink)}
.sub-list{color:var(--muted);font-size:14px;margin:14px 0 0}
/* stability ranking */
:root{--c-time:#2a78d6;--c-repeat:#1baf7a;--c-reorder:#6250d6;--c-reword:#eda100}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--c-time:#3987e5;--c-repeat:#199e70;--c-reorder:#9085e9;--c-reword:#c98500}}
:root[data-theme="dark"]{--c-time:#3987e5;--c-repeat:#199e70;--c-reorder:#9085e9;--c-reword:#c98500}
.s-time{background:var(--c-time)}.s-repeat{background:var(--c-repeat)}.s-reorder{background:var(--c-reorder)}.s-reword{background:var(--c-reword)}
.key .sw{width:12px;height:12px;border-radius:2px}.sw-inline{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px}.k-whisk{width:22px;height:2px;background:var(--ink);vertical-align:3px!important}
.prov{display:inline-block;background:var(--soft);border-radius:4px;padding:4px 10px;font-size:14px;color:var(--muted);margin:0 0 16px}
.rk-head,.rk-row{display:grid;grid-template-columns:2.2rem 15rem minmax(0,1fr) 4rem;gap:0 14px;align-items:center}
.rk-head{color:var(--faint);font-size:12px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
.rk-head .rk-axis{position:relative;height:16px}.rk-head .rk-axis i{position:absolute;transform:translateX(-50%);font-style:normal}
.rk-head .rk-axis i:first-child{transform:none}.rk-head .rk-axis i:last-child{transform:translateX(-100%)}
.rk-head span:last-child,.rk-v{text-align:right}
.rk-row{min-height:34px;padding:3px 0}
.rk-n{color:var(--faint);font-size:14px;text-align:right}
.rk-nm{color:var(--ink);text-decoration:none;font-size:14px;line-height:1.25;overflow-wrap:anywhere}.rk-nm:hover b{text-decoration:underline;text-decoration-color:var(--rule)}
.rk-nm b{font-weight:600}.rk-nm small{color:var(--faint);font-size:12px;margin-left:5px}
.rk-row:first-of-type .rk-nm b{font-weight:700}
.rk-bar{position:relative;height:22px}
.rk-bar .stack{position:absolute;left:0;top:4px;height:14px;display:flex;gap:2px;width:100%;outline-offset:3px}
.rk-bar .seg{height:14px;flex:none}.rk-bar .seg:first-child{border-radius:3px 0 0 3px}.rk-bar .seg:last-child{border-radius:0 3px 3px 0}.rk-bar .seg:only-child{border-radius:3px}
.rk-bar .whisk{position:absolute;top:21px;height:2px;background:var(--ink);opacity:.55}
.rk-v{font-weight:700;font-size:15px}
.rk-sep{border-top:1px dashed var(--faint);margin:6px 0 6px 2.2rem;opacity:.6}
h2.sect{font-size:28px;margin:52px 0 6px}.dek.small{font-size:16px;margin-bottom:16px}
.rk-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.wm{font-size:13px;font-weight:700;color:var(--faint);letter-spacing:.01em;white-space:nowrap}
.callout{border-left:3px solid var(--hot);padding:6px 0 6px 12px;margin:0 0 18px;font-size:15px;color:var(--ink)}
.rk-bar-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:10px 16px;border-bottom:1px solid var(--rule);margin:6px 0 14px}
.rk-tabs{display:flex;flex-wrap:wrap;gap:0}
.rk-tabs button{font:inherit;font-size:15px;color:var(--muted);background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px 7px;margin-bottom:-1px;cursor:pointer}
.rk-tabs button:first-child{padding-left:0}
.rk-tabs button[aria-selected="true"]{color:var(--ink);font-weight:600;border-bottom-color:var(--ink)}
.rk-tabs button:hover{color:var(--ink)}
.rk-tools{display:flex;gap:6px;padding-bottom:6px}
.rk-tools button{font:inherit;font-size:13px;color:var(--ink);background:var(--bg);border:1px solid var(--rule);border-radius:4px;padding:4px 10px;cursor:pointer}
.rk-tools button:hover{border-color:var(--faint)}.rk-tools button[aria-pressed="true"]{background:var(--soft)}
button:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.rk-sub{color:var(--muted);font-size:15px;margin:0 0 10px}
.rk-nm .flag{display:block;font-style:normal;font-size:12px;font-weight:600;color:var(--hot)}
.rk-bar .stack.over::after{content:"";position:absolute;right:-1px;top:-2px;bottom:-2px;width:6px;background:repeating-linear-gradient(135deg,var(--bg) 0 2px,transparent 2px 4px)}
.rk-bar .seg.zero{width:2px;background:var(--faint)}
.rk-table{margin:4px 0 0}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:7px 14px;border-radius:5px;font-size:14px;margin:0;z-index:9}
/* tables */
table{border-collapse:collapse;width:100%;font-size:15px}
th{color:var(--faint);font-weight:600;font-size:13px;text-align:right;padding:8px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--soft);text-align:right;vertical-align:top}
th:first-child,td:first-child{text-align:left;padding-left:0}
td.num-rank{color:var(--faint);width:2rem}
td small{display:block;color:var(--faint);font-size:12px}
td.l,th.l{text-align:left}
table.narrow{max-width:560px}
.tbl-models td.l a{color:var(--ink);font-weight:600;text-decoration:none}.tbl-models td.l a:hover{text-decoration:underline}
/* stats */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);margin:0 0 30px}
.stats div{padding:14px 16px 14px 0}.stats b{display:block;font-size:26px;font-weight:700;line-height:1.2}.stats span{color:var(--faint);font-size:14px}
/* daily squares */
.days{display:flex;gap:4px;margin:0 0 6px}.days span{flex:1 1 0;height:34px;border-radius:2px;min-width:0}
.d-base{background:var(--base)}.d-ok{background:var(--ok)}.d-hot{background:var(--hot)}.d-miss{border:1px dashed var(--faint)}.d-future{background:var(--soft)}
.days-axis{display:flex;justify-content:space-between;color:var(--faint);font-size:13px;margin:0 0 8px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:13px;margin:0 0 8px}.legend i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
/* prose */
article h2{font-family:Newsreader,Georgia,serif;font-size:24px;font-weight:600;margin:36px 0 8px;letter-spacing:-.01em}
article p,article li{font-size:17px;line-height:1.65}
article .tw{overflow-x:auto}
.posts{list-style:none;padding:0}.posts li{margin:0 0 20px}.posts a{font-weight:600}.posts .when{color:var(--faint);font-size:14px}
footer.site{border-top:1px solid var(--rule);padding:18px 0 40px;color:var(--faint);font-size:14px}
footer.site a{color:var(--faint)}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);padding:6px 9px;border-radius:4px;font-size:13px;max-width:280px;display:none;z-index:9}
@media (max-width:760px){
.dc-grp{padding-left:0}
 h1{font-size:30px}
 .dc-axis{display:none}
 .rk-head{display:none}
 .rk-row{grid-template-columns:1.8rem minmax(0,1fr) 3rem;grid-template-areas:'n nm v' 'n bar bar';padding:6px 0}
 .rk-n{grid-area:n;align-self:start}.rk-nm{grid-area:nm}.rk-v{grid-area:v}.rk-bar{grid-area:bar}
 .rk-sep{margin-left:1.8rem}
 .rk-tabs button,.rk-tabs button:first-child{padding:8px 16px 7px 0}
 .rk-top .wm{display:none}
 .dc-row{grid-template-columns:1fr;gap:2px;padding:8px 0;border-bottom:1px solid var(--soft)}
 .dc-row .nm{text-align:left}
 .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
 .opt,.long{display:none}
 table{font-size:14px}th,td{padding:8px 6px}th{white-space:normal}
 .tbl-models td.l{overflow-wrap:anywhere}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
const TIP_JS = `const t=document.getElementById('tip');function show(el){t.textContent=el.dataset.tip;t.style.display='block';const r=el.getBoundingClientRect();t.style.left=Math.max(8,Math.min(innerWidth-290,r.left))+'px';t.style.top=(r.top-40)+'px'}
document.querySelectorAll('[data-tip]').forEach(el=>{el.addEventListener('mouseenter',()=>show(el));el.addEventListener('focus',()=>show(el));el.addEventListener('mouseleave',()=>t.style.display='none');el.addEventListener('blur',()=>t.style.display='none')});`;

const NAV: [string, string][] = [['/models/', 'Models'], ['/changes/', 'Changes'], ['/posts/', 'Findings'], ['/method/', 'Method'], ['/data/', 'Data']];
function page(p: { path: string; title: string; description: string; body: string }) {
  const full = p.path === '/' ? 'Decision Drift: daily answer drift in decision models' : `${p.title} · Decision Drift`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(full)}</title><meta name="description" content="${esc(p.description)}"><link rel="canonical" href="${SITE}${p.path}">
<meta property="og:title" content="${esc(full)}"><meta property="og:description" content="${esc(p.description)}"><meta property="og:type" content="website"><meta property="og:url" content="${SITE}${p.path}">
<link rel="alternate" type="application/rss+xml" title="Decision Drift" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=Public+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="7" width="9" height="3" rx="1.5" fill="#9FB3C8"/><circle cx="12.5" cy="8.5" r="2.5" fill="#C2410C"/></svg>')}">
<style>${CSS}</style>${UMAMI}</head><body><div class="wrap">
<header class="mast"><a class="mark" href="/">Decision Drift</a><nav aria-label="Main">${NAV.map(([h, l]) => `<a href="${h}"${p.path.startsWith(h) ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav></header>
<main id="main">${p.body}</main>
<footer class="site">Independent; not affiliated with any model vendor. Runs daily at 10:17 UTC. <a href="/status/">Run status</a>. <a href="${REPO}">Source and raw data</a>. Code MIT; data CC BY 4.0, except CLINC150-derived items (CC BY 3.0).</footer>
</div><div id="tip" role="tooltip"></div><script>${TIP_JS}</script></body></html>`;
}
function write(rel: string, content: string) {
  const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
}
const lastRunLine = () => {
  const s = status?.last_run;
  const when = s ? `${shortDate(s.date)}, ${utcTime(s.finished_at)}` : shortDate(latest.date);
  return s && s.status !== 'ok' ? `Last run ${when} had problems; see <a href="/status/">run status</a>.` : `Last run ${when}. Next run 10:17 UTC.`;
};

// ---------- pages ----------
fs.rmSync(OUT, { recursive: true, force: true });
const tracked = models.filter(m => latest.perModel[m] && !isAlias(m));
const compared = tracked.filter(m => drift(m, latest)?.n);
const fresh = tracked.filter(m => !drift(m, latest)?.n);
const aliases = models.filter(m => latest.perModel[m] && isAlias(m));
const excess = (m: string) => drift(m, latest)!.flip_rate - latest.perModel[m].noise.flip_rate;
const detected = compared.filter(m => verdict(m).key === 'changed').sort((a, b) => excess(b) - excess(a));
const undetected = compared.filter(m => verdict(m).key !== 'changed').sort((a, b) => drift(a, latest)!.flip_rate - drift(b, latest)!.flip_rate || a.localeCompare(b));
const ordered = [...detected, ...undetected];
// axis fits the changed-answer values; wide noise bands clip at the right edge
const scaleMax = Math.max(0.04, Math.ceil((Math.max(...ordered.map(m => drift(m, latest)!.flip_rate)) + 0.005) / 0.02) * 0.02);
const xPct = (v: number) => (100 * Math.min(v, scaleMax) / scaleMax).toFixed(2) + '%';
const ticks = Array.from({ length: Math.round(scaleMax / 0.02) + 1 }, (_, i) => i * 0.02);
const jev = latest.jev_113_vs_114;

// ---------- change log: generated from the data, no prose ----------
// A change is logged once it is detected on two runs in a row; snapshot moves and new models the day they happen.
const reportOn = new Map(reports.map(r => [r.date, r]));
const detectedIn = (m: string, r: Report) => { const d = drift(m, r); const p = r.perModel[m]; return !!(d?.n && p?.noise?.ci && d.ci[0] > p.noise.ci[1]); };
type LogEntry = { date: string; m: string; kind: 'change' | 'serve' | 'new'; text: string };
const changeLog: LogEntry[] = [];
for (const m of models) {
  const h = history(m); let logged = false;
  h.forEach(({ date, p }, i) => {
    if (i === 0 && date !== BASELINE.date && !isAlias(m)) changeLog.push({ date, m, kind: 'new', text: 'Now tracked.' });
    if (i === 0) return;
    const prev = h[i - 1].p.served.join(', '), cur = p.served.join(', ');
    if (cur && prev && cur !== prev) changeLog.push({ date, m, kind: 'serve', text: `Now serves ${cur} (was ${prev}).` });
    if (!logged && !isAlias(m) && detectedIn(m, reportOn.get(date)!) && detectedIn(m, reportOn.get(h[i - 1].date)!)) {
      logged = true; const d = drift(m, reportOn.get(date)!)!;
      changeLog.push({ date, m, kind: 'change', text: `Change detected: ${pct(d.flip_rate)} of answers differ from ${shortDate(h[0].date)}, against ${pct(p.noise.flip_rate)} noise.${cur === h[0].p.served.join(', ') ? ' Same snapshot ID.' : ''}` });
    }
  });
}
changeLog.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind) || a.m.localeCompare(b.m));
const logHtml = changeLog.length ? `<h2 id="log">Log</h2><p class="sub-list">Written by the data: a change is listed once it has been detected on two runs in a row. Also in the <a href="/feed.xml">RSS feed</a>.</p>
<ol class="log">${changeLog.map(e => `<li class="log-${e.kind}"><time datetime="${e.date}">${shortDate(e.date)}</time><span><a href="/models/${slug(e.m)}/">${esc(isAlias(e.m) ? e.m : nameOf(e.m))}</a> ${esc(e.text)}</span></li>`).join('')}</ol>` : '';

// ---------- stability ranking ----------
const COMP = [['time', 'Over time'], ['repeat', 'On repeat'], ['reorder', 'Option order'], ['reword', 'Rewording']] as const;
const MIN_RUNS = 7;
const runsOf = (m: string) => history(m).length;
const ranked = compared.filter(m => latest.perModel[m].stability).sort((a, b) => latest.perModel[a].stability.index - latest.perModel[b].stability.index);
// groups: a model joins the current group while its interval overlaps the group leader's
const groupOf = new Map<string, number>(); { let g = 0, leaderHi = -Infinity;
  for (const m of ranked) { const st = latest.perModel[m].stability; if (st.ci[0] > leaderHi) { g++; leaderHi = st.ci[1]; } groupOf.set(m, g); } }
const rankOf = new Map(ranked.map((m, i) => [m, i + 1]));
const maxRuns = Math.max(...ranked.map(runsOf));
const provisional = maxRuns < MIN_RUNS;
// one run per day from here, so the ranking firms up MIN_RUNS - maxRuns days after the latest run
const finalOn = new Date(new Date(latest.date + 'T00:00:00Z').getTime() + 864e5 * Math.max(0, MIN_RUNS - maxRuns)).toISOString().slice(0, 10);
const stOf = (m: string) => latest.perModel[m].stability;

// A panel is one ranked bar list. Values beyond the axis (one extreme outlier) run to the edge and are marked.
type Seg = { k: string; v: number };
type PanelRow = { m: string; rank: number; segs: Seg[]; value: number; label: string; ci?: number[]; sep: boolean; flag: boolean; tip: string };
type Panel = { id: string; tab: string; title: string; sub: string; unit: string; rows: PanelRow[]; max: number; ticks: number[] };
const niceStep = (max: number) => { const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(f => f * p).find(s => s >= raw)!; };
function axisFor(vals: number[]) {
  const s = vals.slice().sort((a, b) => b - a);
  const top = s[0] > 1.5 * s[1] ? s[1] : s[0]; // let a lone outlier overflow instead of squashing everyone else
  const step = niceStep(top); const max = Math.ceil(top / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => +(i * step).toFixed(6)) };
}
const flagged = new Set(ordered.filter(m => verdict(m).key === 'changed'));
const overall: Panel = (() => {
  const ax = axisFor(ranked.map(m => stOf(m).ci[1]));
  return { id: 'overall', tab: 'Overall', title: 'Most stable decision models', sub: 'Instability index, lower is better. 100 = an average model.', unit: '', max: ax.max, ticks: ax.ticks,
    rows: ranked.map((m, i) => { const st = stOf(m);
      return { m, rank: i + 1, segs: COMP.map(([k]) => ({ k, v: st.parts[k] })), value: st.index, label: st.index.toFixed(0), ci: st.ci,
        sep: i > 0 && groupOf.get(m) !== groupOf.get(ranked[i - 1]), flag: flagged.has(m),
        tip: `${nameOf(m)}: ${st.index.toFixed(0)} (95% CI ${st.ci[0].toFixed(0)}–${st.ci[1].toFixed(0)}). ` + COMP.map(([k, l]) => `${l} ${st.parts[k].toFixed(0)}`).join(', ') };
    }) };
})();
const compPanels: Panel[] = COMP.map(([k, label]) => {
  const ms = ranked.slice().sort((a, b) => stOf(a).components[k] - stOf(b).components[k]);
  const ax = axisFor(ms.map(m => 100 * stOf(m).components[k]));
  const sub = { time: "Share of answers changed since Oct 20, beyond the model's own noise.", repeat: 'Share of answers that change when the same request is sent twice, minutes apart.', reorder: 'Share of pick-one answers that change when the options are reordered.', reword: 'Share of answers that change when the instructions are reworded with the same meaning.' }[k];
  return { id: k, tab: label, title: `${label}`, sub, unit: '%', max: ax.max, ticks: ax.ticks,
    rows: ms.map((m, i) => { const v = 100 * stOf(m).components[k];
      // equal shown values share a rank
      const rank = 1 + ms.filter(o => (100 * stOf(o).components[k]).toFixed(1) < v.toFixed(1) && 100 * stOf(o).components[k] < v).length;
      return { m, rank, segs: [{ k, v }], value: v, label: v.toFixed(1) + '%', sep: false, flag: k === 'time' && flagged.has(m), tip: `${nameOf(m)}: ${v.toFixed(1)}%` }; }) };
});
const panels = [overall, ...compPanels];

function panelHtml(p: Panel, active: boolean) {
  const w = (v: number) => (100 * Math.min(v, p.max) / p.max).toFixed(2) + '%';
  return `<div class="rk-panel" id="panel-${p.id}" role="tabpanel" aria-labelledby="tab-${p.id}"${active ? '' : ' hidden'}>
<p class="rk-sub">${esc(p.sub)}</p>
${p.id === 'overall' ? `<div class="key">${COMP.map(([k, l]) => `<span><i class="sw s-${k}"></i>${l} (${Math.round(stOf(ranked[0]).weights[k] * 100)}%)</span>`).join('')}<span><i class="k-whisk"></i>95% interval</span></div>` : ''}
<div class="rk" role="table" aria-label="${esc(p.title + '. ' + p.sub)}">
<div class="rk-head" role="row"><span role="columnheader">Rank</span><span role="columnheader">Model</span><span role="columnheader" class="rk-axis">${p.ticks.map(t => `<i style="left:${w(t)}">${t}${p.unit}</i>`).join('')}</span><span role="columnheader">${p.id === 'overall' ? 'Index' : 'Rate'}</span></div>
${p.rows.map(r => {
  const over = r.value > p.max;
  let used = 0; const segs = r.segs.filter(s => s.v > 0.05).map(s => { const room = Math.max(0, p.max - used); const v = Math.min(s.v, room); used += s.v; return v > 0 ? `<span class="seg s-${s.k}" style="width:${w(v)}"></span>` : ''; }).join('');
  return `${r.sep ? '<div class="rk-sep" role="presentation"></div>' : ''}<div class="rk-row" role="row"><span class="rk-n" role="cell">${r.rank}</span><a class="rk-nm" role="cell" href="/models/${slug(r.m)}/"><b>${esc(nameOf(r.m))}</b><small>${esc(vendorName(r.m))}</small>${r.flag ? '<em class="flag">▲ change detected</em>' : ''}</a>
<span class="rk-bar" role="cell"><span class="stack${over ? ' over' : ''}" tabindex="0" data-tip="${esc(r.tip)}" aria-label="${esc(r.tip)}">${segs || '<span class="seg zero"></span>'}</span>${r.ci ? `<span class="whisk" style="left:${w(r.ci[0])};width:calc(${w(r.ci[1])} - ${w(r.ci[0])})"></span>` : ''}</span><span class="rk-v" role="cell">${r.label}</span></div>`;
}).join('')}</div></div>`;
}
const rankTable = `<div class="rk-table" id="rk-table" hidden><table><thead><tr><th>#</th><th class="l">Model</th><th>Index</th><th class="opt">95% CI</th>${COMP.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${ranked.map((m, i) => { const st = stOf(m);
  return `<tr><td>${i + 1}</td><td class="l"><a href="/models/${slug(m)}/">${esc(nameOf(m))}</a></td><td><b>${st.index.toFixed(0)}</b></td><td class="opt">${st.ci[0].toFixed(0)}–${st.ci[1].toFixed(0)}</td>${COMP.map(([k]) => `<td>${pct(st.components[k])}</td>`).join('')}</tr>`; }).join('')}</tbody></table><p class="note">Component columns are raw shares of answers that changed. The index divides each by a fixed reference rate (Over time 0.75%, On repeat 1.75%, Option order 2.6%, Rewording 8.6%) and weights them 40/30/15/15.</p></div>`;
// data the PNG export draws from (only what is on screen)
const exportData = { date: latest.date, provisional, panels: panels.map(p => ({ id: p.id, title: p.title, sub: p.sub, unit: p.unit, max: p.max, ticks: p.ticks,
  rows: p.rows.map(r => ({ rank: r.rank, name: nameOf(r.m), vendor: vendorName(r.m), segs: r.segs, value: r.value, label: r.label, ci: r.ci ?? null, sep: r.sep, flag: r.flag })) })) };

const RANK_JS = `(()=>{const tabs=[...document.querySelectorAll('.rk-tabs [role=tab]')];const panels=[...document.querySelectorAll('.rk-panel')];const table=document.getElementById('rk-table');const tbtn=document.getElementById('rk-tablebtn');
function select(id,push){tabs.forEach(t=>{const on=t.dataset.id===id;t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1});panels.forEach(p=>p.hidden=p.id!=='panel-'+id||!table.hidden);if(push)history.replaceState(null,'',id==='overall'?location.pathname:'#'+id)}
tabs.forEach((t,i)=>{t.addEventListener('click',()=>select(t.dataset.id,true));t.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){const n=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];n.focus();select(n.dataset.id,true)}})});
const h=location.hash.slice(1);if(tabs.some(t=>t.dataset.id===h))select(h,false);
tbtn.addEventListener('click',()=>{table.hidden=!table.hidden;tbtn.setAttribute('aria-pressed',!table.hidden);tbtn.textContent=table.hidden?'Table':'Chart';const cur=tabs.find(t=>t.getAttribute('aria-selected')==='true').dataset.id;panels.forEach(p=>p.hidden=!table.hidden||p.id!=='panel-'+cur)});
const toast=m=>{const n=document.getElementById('rk-toast');n.textContent=m;n.hidden=false;setTimeout(()=>n.hidden=true,2200)};
document.getElementById('rk-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);toast('Link copied')}catch(e){toast('Copy failed; use the address bar')}});
document.getElementById('rk-png').addEventListener('click',()=>{const D=JSON.parse(document.getElementById('rk-data').textContent);const cur=tabs.find(t=>t.getAttribute('aria-selected')==='true').dataset.id;const P=D.panels.find(p=>p.id===cur);
const cs=getComputedStyle(document.documentElement);const v=n=>cs.getPropertyValue(n).trim();const s=2,W=1200,rowH=34,top=150,left=330,right=110,H=top+P.rows.length*rowH+P.rows.filter(r=>r.sep).length*10+70;
const c=document.createElement('canvas');c.width=W*s;c.height=H*s;const g=c.getContext('2d');g.scale(s,s);g.fillStyle=v('--bg');g.fillRect(0,0,W,H);
g.fillStyle=v('--ink');g.font='600 30px Newsreader, Georgia, serif';g.fillText(P.title,40,58);g.fillStyle=v('--muted');g.font='400 16px "Public Sans", sans-serif';g.fillText(P.sub+(D.provisional?' Provisional.':''),40,88);
const x0=left,xw=W-left-right,X=val=>x0+xw*Math.min(val,P.max)/P.max;g.font='400 12px "Public Sans", sans-serif';g.fillStyle=v('--faint');P.ticks.forEach(t=>{g.textAlign='center';g.fillText(t+P.unit,X(t),top-14)});
g.strokeStyle=v('--rule');g.beginPath();g.moveTo(x0,top-6);g.lineTo(x0+xw,top-6);g.stroke();let y=top;
P.rows.forEach(r=>{if(r.sep){g.setLineDash([3,3]);g.strokeStyle=v('--faint');g.beginPath();g.moveTo(40,y+2);g.lineTo(W-40,y+2);g.stroke();g.setLineDash([]);y+=10}
g.textAlign='right';g.fillStyle=v('--faint');g.font='400 14px "Public Sans", sans-serif';g.fillText(r.rank,64,y+21);g.textAlign='left';g.fillStyle=v('--ink');g.font='600 15px "Public Sans", sans-serif';g.fillText(r.name,80,y+21);
const nw=g.measureText(r.name).width;g.fillStyle=v('--faint');g.font='400 12px "Public Sans", sans-serif';g.fillText(r.vendor,86+nw,y+21);
let xs=x0;r.segs.forEach(sg=>{if(sg.v<=0.05)return;const w=Math.max(0,Math.min(X(sg.v+(xs-x0)/xw*P.max),x0+xw)-xs);g.fillStyle=v('--c-'+sg.k);g.fillRect(xs,y+9,Math.max(0,w-2),14);xs+=w});
if(r.ci){g.fillStyle=v('--ink');g.globalAlpha=.55;g.fillRect(X(r.ci[0]),y+26,X(r.ci[1])-X(r.ci[0]),2);g.globalAlpha=1}
g.textAlign='right';g.fillStyle=r.flag?v('--hot'):v('--ink');g.font='700 15px "Public Sans", sans-serif';g.fillText(r.label,W-40,y+21);y+=rowH});
g.textAlign='left';g.fillStyle=v('--faint');g.font='400 13px "Public Sans", sans-serif';g.fillText('Run of '+D.date+'. Same inputs every day; lower is better.',40,H-28);g.textAlign='right';g.font='700 15px "Public Sans", sans-serif';g.fillStyle=v('--ink');g.fillText('decisiondrift.dev',W-40,H-28);
const a=document.createElement('a');a.download='decision-drift-'+P.id+'-'+D.date+'.png';a.href=c.toDataURL('image/png');a.click();toast('Image saved')});})();`;

const rankSection = `<section class="rk-wrap" aria-labelledby="rk-title">
<div class="rk-top"><h1 id="rk-title">Most stable decision models</h1><span class="wm" aria-hidden="true">decisiondrift.dev</span></div>
<p class="dek">${ranked.length} models. The same ${latest.items} inputs and ${(manifest.splits.public.questions + manifest.splits.private.questions).toLocaleString()} questions, every day.</p>
${provisional ? `<p class="prov">Provisional: ${maxRuns} daily runs so far. Final after ${MIN_RUNS}, on ${shortDate(finalOn)}.</p>` : ''}
${flagged.size ? `<p class="callout"><b>Change detected since Oct 20:</b> ${[...flagged].map(m => `<a href="/models/${slug(m)}/">${esc(nameOf(m))}</a> ${pct(drift(m, latest)!.flip_rate)}${notes(m).includes('Same snapshot ID.') ? ' (same snapshot ID)' : ''}`).join(', ')}. <a href="/changes/">All changes</a>.</p>` : ''}
<div class="rk-bar-top"><div class="rk-tabs" role="tablist" aria-label="Ranking view">${panels.map((p, i) => `<button type="button" role="tab" id="tab-${p.id}" data-id="${p.id}" aria-controls="panel-${p.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(p.tab)}</button>`).join('')}</div>
<div class="rk-tools"><button type="button" id="rk-link">Copy link</button><button type="button" id="rk-png">Download image</button><button type="button" id="rk-tablebtn" aria-pressed="false">Table</button></div></div>
${panels.map((p, i) => panelHtml(p, i === 0)).join('')}
${rankTable}
<p class="foot">Lines separate groups whose intervals don't overlap. Over time counts only change beyond the model's own noise. <a href="/method/#stability">How the index works</a>. ${lastRunLine()}</p>
<p id="rk-toast" class="toast" role="status" hidden></p>
<script type="application/json" id="rk-data">${JSON.stringify(exportData).replace(/</g, '\\u003c')}</script>
<script>${RANK_JS}</script>
</section>`;

const chart = `<div class="dc" role="group" aria-label="Share of answers changed since Oct 20, per model, with each model's noise">
<div class="dc-axis" aria-hidden="true"><span></span><div class="ticks">${ticks.map(t => `<span style="left:${xPct(t)}">${Math.round(t * 100)}%</span>`).join('')}</div><span></span></div>
<ol>${ordered.map((m, i) => {
  const d = drift(m, latest)!; const p = latest.perModel[m]; const hot = verdict(m).key === 'changed'; const x = d.flip_rate / scaleMax;
  const tip = `${nameOf(m)}: ${pct(d.flip_rate)} changed since Oct 20 (95% CI ${ci(d.ci)}). Noise ${pct(p.noise.flip_rate)}.`;
  const grp = i === 0 && detected.length ? `<li class="dc-grp">Change detected</li>` : i === detected.length ? `<li class="dc-grp">No change detected, steadiest first</li>` : '';
  return `${grp}<li class="dc-row${hot ? ' is-hot' : ''}"><a class="nm" href="/models/${slug(m)}/"><b>${esc(nameOf(m))}</b><small>${esc(vendorName(m))}</small></a>
<div class="track">${ticks.slice(1, -1).map(t => `<span class="grid" style="left:${xPct(t)}"></span>`).join('')}<span class="band" style="width:${xPct(p.noise.ci[1])}" title="Noise: changes up to ${pct(p.noise.ci[1])} can't be told apart from it"></span><span class="dot" style="left:${xPct(d.flip_rate)}"></span><span class="hit" style="left:${xPct(d.flip_rate)}" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}"></span><span class="val${x > 0.82 ? ' flip' : ''}" style="left:${xPct(d.flip_rate)}">${pct(d.flip_rate)}</span></div>
<div class="nt">${notes(m).map(esc).join(' ')}</div></li>`;
}).join('')}</ol></div>`;

write('index.html', page({ path: '/', title: 'Most stable decision models', description: 'Daily ranking of decision models (Jev, Clef, Decider, Luna and more) by how often their answers change.', body: `
${rankSection}
${jev ? `<h2>Jev 1.14 vs 1.13</h2><p>Different top answer on ${pct(jev.overall.flip_rate)} of questions (95% CI ${ci(jev.overall.ci)}). Score answers: ${pct(jev.by_type.score.flip_rate)}. <code>~typesafe/jev-latest</code> serves 1.14. <a href="/findings/jev-1-13-vs-1-14/">Breakdown</a>.</p>` : ''}
${posts.length ? `<h2>Findings</h2><ul class="posts">${posts.slice(0, 3).map(p => `<li><a href="/posts/${p.slug}/">${esc(p.title)}</a><div class="when">${dateLong(p.date)}</div></li>`).join('')}</ul>` : ''}
` }));

write('changes/index.html', page({ path: '/changes/', title: 'Answers changed since Oct 20', description: 'How many of each decision model\'s answers changed since its first run, against its own noise.', body: `
<div class="rk-top"><h1>Answers changed since Oct 20</h1><span class="wm" aria-hidden="true">decisiondrift.dev</span></div>
<p class="dek">${compared.length} models, each against its own first run. A change inside the grey band can't be told apart from the model's own noise, so noisier models hide bigger changes.</p>
<div class="key"><span><i class="k-band"></i>Noise: same request sent twice</span><span><i class="k-dot"></i>Changed since Oct 20</span><span><i class="k-hot"></i>Change detected</span></div>
${chart}
${fresh.length ? `<p class="sub-list">New since Oct 20, no comparison yet: ${fresh.map(m => `<a href="/models/${slug(m)}/">${esc(nameOf(m))}</a>`).join(', ')}.</p>` : ''}
${logHtml}
${aliases.length ? `<p class="sub-list">Aliases: ${aliases.map(m => `<a href="/models/${slug(m)}/">${esc(m)}</a> serves ${esc(latest.perModel[m].served.join(', ').replace(/^[^/]+\//, ''))}`).join('; ')}.</p>` : ''}
<p class="foot">${lastRunLine()} Detected: the 95% interval for changed answers sits above the noise interval. Noise pools up to 7 days of repeats. <a href="/method/">Method</a>.</p>` }));

// models table
const modelRow = (m: string) => {
  const p = latest.perModel[m]; const d = drift(m, latest); const hot = verdict(m).key === 'changed';
  const rk = rankOf.get(m); const st = p.stability;
  return `<tr><td class="num-rank">${rk ?? ''}</td><td class="l"><a href="/models/${slug(m)}/">${esc(isAlias(m) ? m : nameOf(m))}</a><small>${esc(isAlias(m) ? 'serves ' + p.served.join(', ') : vendorName(m))}</small></td>
<td>${rk && st ? `<b>${st.index.toFixed(0)}</b>` : '—'}</td><td class="${hot ? 'hot' : ''}">${d?.n ? pct(d.flip_rate) : '—'}${hot ? '<small class="hot">detected</small>' : ''}</td><td>${pct(p.noise.flip_rate)}</td><td class="opt">${pct(p.shuffle.flip_rate)}</td><td class="opt">${pct(p.paraphrase.flip_rate)}</td>
<td>${pct(p.accuracy)}<small>${ci(p.accuracy_ci)}</small></td><td class="opt">${ms(p.latency_p50)}</td></tr>`;
};
const tableHead = `<thead><tr><th>#</th><th class="l">Model</th><th>Index</th><th>Changed<span class="long"> since Oct 20</span></th><th>Noise</th><th class="opt">Option shuffle</th><th class="opt">Paraphrase</th><th>Gold<span class="long"> accuracy</span></th><th class="opt">Median latency</th></tr></thead>`;
const byVendor = (a: string, b: string) => vendorName(a).localeCompare(vendorName(b)) || nameOf(a).localeCompare(nameOf(b));
write('models/index.html', page({ path: '/models/', title: 'Models', description: 'Drift, noise, robustness, accuracy and latency for every tracked decision model.', body: `
<h1>Models</h1><p class="dek">Latest run, ${shortDate(latest.date)}. Ranked by instability index, lower is better${provisional ? ' (provisional)' : ''}. Other columns are shares of top answers. Gold accuracy covers the clearer questions only.</p>
<table class="tbl-models">${tableHead}<tbody>${[...ranked, ...tracked.filter(m => !rankOf.has(m)).sort(byVendor)].map(modelRow).join('')}</tbody></table>
${aliases.length ? `<h2>Aliases</h2><table class="tbl-models">${tableHead}<tbody>${aliases.map(modelRow).join('')}</tbody></table>` : ''}
<h2>Not tracked</h2><ul>${Object.entries(excluded).map(([m, why]) => `<li><code>${esc(m)}</code>: ${esc(why)}</li>`).join('')}</ul>` }));

// per-model pages
const dayList = (() => {
  const start = new Date(BASELINE.date + 'T00:00:00Z').getTime(); const lastIdx = Math.round((new Date(latest.date + 'T00:00:00Z').getTime() - start) / 864e5);
  return Array.from({ length: Math.max(30, lastIdx + 1) }, (_, i) => new Date(start + i * 864e5).toISOString().slice(0, 10));
})();
for (const m of models) {
  const h = history(m); const last = h.at(-1)?.p; if (!last) continue;
  const byDate = new Map(h.map(x => [x.date, x.p]));
  const first = h[0].date;
  const squares = dayList.map(d => {
    const p = byDate.get(d);
    if (d < first) return `<span class="d-future" data-tip="${shortDate(d)}: not tracked yet" tabindex="-1"></span>`;
    if (!p) return d <= latest.date ? `<span class="d-miss" data-tip="${shortDate(d)}: no run"></span>` : `<span class="d-future"></span>`;
    const dr = d === BASELINE.date ? null : p.drift_vs_compare;
    if (!dr || !dr.n) return `<span class="d-base" data-tip="${shortDate(d)}: ${d === first && d !== BASELINE.date ? 'first run' : 'baseline'}"></span>`;
    const hot = dr.ci[0] > p.noise.ci[1];
    return `<span class="${hot ? 'd-hot' : 'd-ok'}" data-tip="${shortDate(d)}: ${pct(dr.flip_rate)} changed, noise ${pct(p.noise.flip_rate)}"></span>`;
  }).join('');
  const d = drift(m, latest); const hot = verdict(m).key === 'changed';
  const snaps = [...new Set(h.flatMap(x => x.p.served))];
  const rows = h.slice().reverse().map(({ date, p }) => {
    const dr = date === BASELINE.date ? null : p.drift_vs_compare; const rh = dr?.n && dr.ci[0] > p.noise.ci[1];
    return `<tr><td>${shortDate(date)}</td>${snaps.length > 1 ? `<td class="l opt">${esc(p.served.join(', '))}</td>` : ''}<td class="${rh ? 'hot' : ''}">${dr?.n ? pct(dr.flip_rate) : 'baseline'}</td><td class="opt">${dr?.n ? ci(dr.ci) : ''}</td><td>${pct(p.noise.flip_rate)}</td><td class="opt">${pct(p.shuffle.flip_rate)}</td><td class="opt">${pct(p.paraphrase.flip_rate)}</td><td>${pct(p.accuracy)}</td><td class="opt">${ms(p.latency_p50)}</td></tr>`;
  }).join('');
  const types = last.drift_by_type ? Object.entries<any>(last.drift_by_type).filter(([, v]) => v.n) : [];
  write(`models/${slug(m)}/index.html`, page({ path: `/models/${slug(m)}/`, title: m, description: `Daily drift, noise and robustness for ${m}.`, body: `
<p class="crumb"><a href="/models/">Models</a> / ${esc(isAlias(m) ? 'Aliases' : vendorName(m))}</p>
<h1>${esc(isAlias(m) ? m : nameOf(m))}</h1>
<p class="meta">${isAlias(m) ? `Alias. Serves ${esc(last.served.join(', '))}.` : `Snapshot ${esc(last.served.join(', '))}. Served by ${esc(last.providers.join(', '))}.`}</p>
<div class="stats"><div><b>${rankOf.has(m) ? `#${rankOf.get(m)} of ${ranked.length}` : '—'}</b><span>${rankOf.has(m) ? `stability, index ${last.stability.index.toFixed(0)}${provisional || runsOf(m) < MIN_RUNS ? ', provisional' : ''}` : 'not ranked yet'}</span></div><div><b class="${hot ? 'hot' : ''}">${d?.n ? pct(d.flip_rate) : '—'}</b><span>changed since Oct 20</span></div><div><b>${pct(last.noise.flip_rate)}</b><span>noise</span></div><div><b>${pct(last.accuracy)}</b><span>gold accuracy</span></div></div>
<h2>Daily runs</h2>
<div class="days" role="img" aria-label="One square per day since Oct 20">${squares}</div>
<div class="days-axis"><span>${shortDate(dayList[0])}</span><span>${shortDate(dayList.at(-1)!)}</span></div>
<div class="legend"><span><i class="d-base"></i>Baseline</span><span><i class="d-ok"></i>No change detected</span><span><i class="d-hot"></i>Change detected</span><span><i class="d-miss"></i>No run</span></div>
<h2>Run history</h2>
<table><thead><tr><th>Run</th>${snaps.length > 1 ? '<th class="l opt">Snapshot</th>' : ''}<th>Changed</th><th class="opt">95% CI</th><th>Noise</th><th class="opt">Shuffle</th><th class="opt">Paraphrase</th><th>Gold acc.</th><th class="opt">p50</th></tr></thead><tbody>${rows}</tbody></table>
${rankOf.has(m) ? `<h2>Instability index</h2><table class="narrow"><thead><tr><th>Source</th><th>Answers changed</th><th class="opt">Reference</th><th>Weight</th><th>Points</th></tr></thead><tbody>${COMP.map(([k, label]) => `<tr><td><i class="sw-inline s-${k}"></i>${label}</td><td>${pct(last.stability.components[k])}</td><td class="opt">${pct(last.stability.scales[k], 2)}</td><td>${Math.round(last.stability.weights[k] * 100)}%</td><td>${last.stability.parts[k].toFixed(1)}</td></tr>`).join('')}<tr><td><b>Index</b></td><td></td><td class="opt"></td><td></td><td><b>${last.stability.index.toFixed(1)}</b><small>${last.stability.ci[0].toFixed(0)}–${last.stability.ci[1].toFixed(0)}</small></td></tr></tbody></table><p class="note">Over time counts only change beyond this model's noise.</p>` : ''}
${types.length ? `<h2>Changed since Oct 20, by question type</h2><table class="narrow"><thead><tr><th>Type</th><th>Questions</th><th>Changed</th><th class="opt">95% CI</th></tr></thead><tbody>${types.map(([t, v]) => `<tr><td>${TYPE_NAME[t]}</td><td>${v.n}</td><td>${pct(v.flip_rate)}</td><td class="opt">${ci(v.ci)}</td></tr>`).join('')}</tbody></table>` : ''}
${last.providers.length > 1 && last.noise_cross_provider?.n ? `<h2>Providers</h2><p>Served by ${esc(last.providers.join(', '))}. Repeat requests that went to a different provider changed ${pct(last.noise_cross_provider.flip_rate)} of answers (${last.noise_cross_provider.n} questions); same provider: ${pct(last.noise_same_provider.flip_rate)} (${last.noise_same_provider.n}).</p>` : ''}
${last.errors ? `<h2>Errors, latest run</h2><p class="note">${last.errors} of ${last.requests} requests.</p><ul>${last.error_samples.map((s: string) => `<li><code>${esc(s)}</code></li>`).join('')}</ul>` : ''}
` }));
}

// Jev finding
if (jev) {
  const rows = (o: Record<string, any>, label: (k: string) => string) => Object.entries(o).sort((a, b) => b[1].flip_rate - a[1].flip_rate).map(([k, v]) => `<tr><td>${esc(label(k))}</td><td>${v.n}</td><td>${pct(v.flip_rate)}</td><td class="opt">${ci(v.ci)}</td></tr>`).join('');
  const head = '<thead><tr><th>Slice</th><th>Questions</th><th>Different answer</th><th class="opt">95% CI</th></tr></thead>';
  write('findings/jev-1-13-vs-1-14/index.html', page({ path: '/findings/jev-1-13-vs-1-14/', title: 'Jev 1.14 vs 1.13', description: 'How often TypeSafe Jev 1.14 gives a different answer than Jev 1.13 on the same questions.', body: `
<h1>Jev 1.14 vs 1.13</h1><p class="dek">Both versions, the same ${jev.overall.n.toLocaleString()} questions, every run. Latest: ${shortDate(latest.date)}.</p>
<div class="stats"><div><b>${pct(jev.overall.flip_rate)}</b><span>different top answer</span></div><div><b>${ci(jev.overall.ci)}</b><span>95% interval</span></div><div><b>${pct(latest.perModel['typesafe/jev-1.13']?.accuracy)} / ${pct(latest.perModel['typesafe/jev-1.14']?.accuracy)}</b><span>gold accuracy, 1.13 / 1.14</span></div><div><b>${pct(latest.perModel['typesafe/jev-1.13']?.noise.flip_rate)} / ${pct(latest.perModel['typesafe/jev-1.14']?.noise.flip_rate)}</b><span>noise, 1.13 / 1.14</span></div></div>
<h2>By question type</h2><table class="narrow">${head}<tbody>${rows(jev.by_type, k => TYPE_NAME[k])}</tbody></table>
<h2>By task family</h2><table>${head}<tbody>${rows(jev.by_family, k => k)}</tbody></table>
<p class="note">Families with few questions have wide intervals.</p>` }));
}

// posts
write('posts/index.html', page({ path: '/posts/', title: 'Findings', description: 'Write-ups from the Decision Drift tracker.', body: `<h1>Findings</h1>${posts.length ? `<ul class="posts">${posts.map(p => `<li><a href="/posts/${p.slug}/">${esc(p.title)}</a><div class="when">${dateLong(p.date)}</div><div>${esc(p.summary)}</div></li>`).join('')}</ul>` : '<p>None yet. The <a href="/">tracker</a> updates daily.</p>'}` }));
for (const p of posts) write(`posts/${p.slug}/index.html`, page({ path: `/posts/${p.slug}/`, title: p.title, description: p.summary, body: `<article><p class="crumb"><a href="/posts/">Findings</a> / ${dateLong(p.date)}</p><h1>${esc(p.title)}</h1>${p.html.replace(/<div class="table-wrap">/g, '<div class="tw">')}</article>` }));

// method
const cov = manifest.coverage;
const covList = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(', ');
write('method/index.html', page({ path: '/method/', title: 'Method', description: 'How Decision Drift measures drift, noise, robustness and calibration.', body: `<article>
<h1>Method</h1>
<p class="dek">Decision models answer typed questions (yes/no, pick one, score on a scale) with probabilities instead of text. This tracks whether those answers change.</p>
<p>Not a capability leaderboard. For which model is most capable, see Artificial Analysis's <a href="https://artificialanalysis.ai/articles/artificial-analysis-decision-index">Decision Index</a>. This tracks whether answers stay put.</p>
<h2>Suite</h2>
<p>Version 1: ${manifest.splits.public.states + manifest.splits.private.states} inputs, ${manifest.splits.public.questions + manifest.splits.private.questions} questions. Task families: ${covList(cov.family)}. Languages: ${covList(cov.language)}. Every model gets the identical request, and questions are never tuned against results.</p>
<p>Requests are immutable. A flawed item is retired and replaced; headline numbers use the original cohort. Reference labels can be corrected after human review; corrections are logged in the manifest and never change what is sent.</p>
<p>70% of the suite is public. 30% is private so no vendor can train on all of it; only its hash and aggregate scores are published. Public hash <code>${manifest.splits.public.sha256.slice(0, 16)}</code>, private hash <code>${manifest.splits.private.sha256.slice(0, 16)}</code>.</p>
<h2>Measures</h2>
<ul>
<li><strong>Changed since Oct 20:</strong> share of top answers that differ from the model's first run, on byte-identical requests.</li>
<li><strong>Noise:</strong> share that differs when 100 inputs are sent again minutes later, pooled over the last 7 days. A change is detected only when its 95% interval sits above the noise interval. A noisier model needs a bigger change to be detected; that cost shows up in its index through the repeat component.</li>
<li><strong>Option shuffle, paraphrase:</strong> share that changes when choice options are reordered, or instructions reworded with the same meaning.</li>
<li><strong>Gold accuracy:</strong> on questions where the reference label and two LLM labelers (GPT-6.1 Sol, Gemini 4 Argon) agree. A person reviewed a 50-item sample before launch and corrected 23 labels. These are the clearer cases, so this is a regression check, not a ranking.</li>
<li><strong>Latency, errors, cost:</strong> as measured by the runner, network included.</li>
</ul>
<h2 id="stability">Stability score</h2>
<p>Lower is better; 100 is an average model. Four change rates feed it: change since Oct 20 beyond the model's noise (40%), change on repeat (30%), change when options are reordered (15%), and change when instructions are reworded (15%). The rates sit on very different scales (rewording typically moves 8.6% of answers, drift beyond noise under 1%), so each is first divided by a fixed reference rate: the average across models on Oct 28, 2026 (0.75%, 1.75%, 2.6%, 8.6%). Without that step, rewording would decide most of the ranking whatever the weights. The references stay fixed, so a model's index moves only when its own behavior does. Over time and on repeat weigh most because users can't fix them on their side. The 95% interval comes from resampling questions 1,000 times. Lines on the ranking separate groups whose intervals don't overlap the group leader's. Rankings are provisional until a model has ${MIN_RUNS} daily runs. Aliases and models without an Oct 20 baseline aren't ranked.</p>
<h2>Schedule and limits</h2>
<p>Daily at 10:17 UTC through OpenRouter's decisions API, which is in alpha. Every response is stored raw. Intervals are 95% Wilson intervals. Models that can't answer Choice and Score questions are listed as not tracked.</p>
</article>` }));

// data + status
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'data/latest.json'), JSON.stringify(latest));
fs.writeFileSync(path.join(OUT, 'data/history.json'), JSON.stringify(Object.fromEntries(models.map(m => [m, history(m).map(({ date, p }) => ({ date, served: p.served, providers: p.providers, changed_since_baseline: date === BASELINE.date ? null : p.drift_vs_compare, changed_by_type: date === BASELINE.date ? null : p.drift_by_type ?? null, noise: p.noise, shuffle: p.shuffle, paraphrase: p.paraphrase, accuracy: p.accuracy, accuracy_ci: p.accuracy_ci, latency_p50: p.latency_p50, latency_p95: p.latency_p95, error_rate: p.error_rate }))]))));
fs.copyFileSync(path.join(ROOT, 'suite/manifest-v1.json'), path.join(OUT, 'data/manifest-v1.json'));
fs.copyFileSync(path.join(ROOT, 'suite/core-v1.public.jsonl'), path.join(OUT, 'data/core-v1.public.jsonl'));
write('data/index.html', page({ path: '/data/', title: 'Data', description: 'Download Decision Drift results, the public suite and the manifest.', body: `<h1>Data</h1><p class="dek">Regenerated after each daily run. CC BY 4.0: credit "Decision Drift (decisiondrift.dev)" with a link. CLINC150-derived items stay CC BY 3.0.</p>
<table><thead><tr><th>File</th><th class="l">Contents</th></tr></thead><tbody>
<tr><td><a href="/data/latest.json">latest.json</a></td><td class="l">Every metric, every model, latest run</td></tr>
<tr><td><a href="/data/history.json">history.json</a></td><td class="l">Per-model metrics for every run since Oct 20, 2026</td></tr>
<tr><td><a href="/data/core-v1.public.jsonl">core-v1.public.jsonl</a></td><td class="l">Public suite with gold labels</td></tr>
<tr><td><a href="/data/manifest-v1.json">manifest-v1.json</a></td><td class="l">Coverage, labeling, split hashes, label corrections</td></tr>
<tr><td><a href="${REPO}/tree/main/results">results/</a></td><td class="l">Raw responses for every public item, on GitHub</td></tr>
</tbody></table>` }));
fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(status ?? { last_run: { date: latest.date, status: 'ok' } }));
const s = status;
write('status/index.html', page({ path: '/status/', title: 'Run status', description: 'Status of the latest Decision Drift collection run.', body: `<h1>Run status</h1>
${s ? `<div class="stats"><div><b class="${s.last_run.status === 'ok' ? '' : 'hot'}">${s.last_run.status === 'ok' ? 'Completed' : 'Problems'}</b><span>${shortDate(s.last_run.date)}, ${utcTime(s.last_run.finished_at)}</span></div><div><b>${s.models}</b><span>models</span></div><div><b>${s.requests.toLocaleString()}</b><span>requests</span></div><div><b>${s.errors}</b><span>errors</span></div></div>
${s.models_with_errors.length ? `<p>More than 5% errors: ${s.models_with_errors.map((m: string) => `<code>${esc(m)}</code>`).join(', ')}.</p>` : ''}` : ''}
<p>Next run 10:17 UTC. A missing day means that run didn't complete; gaps are not backfilled.</p>` }));

// feeds and machine-readable files
const feedItems = [
  ...posts.map(p => ({ title: p.title, link: `${SITE}/posts/${p.slug}/`, date: p.date, desc: p.summary })),
  ...changeLog.map(e => ({ title: `${isAlias(e.m) ? e.m : nameOf(e.m)}: ${e.kind === 'change' ? 'change detected' : e.kind === 'serve' ? 'new snapshot' : 'now tracked'}`, link: `${SITE}/models/${slug(e.m)}/`, date: e.date, desc: e.text })),
].sort((a, b) => b.date.localeCompare(a.date));
fs.writeFileSync(path.join(OUT, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Decision Drift</title><link>${SITE}/</link><description>Daily measurements of whether decision models change their answers.</description>${feedItems.map(i => `<item><title>${esc(i.title)}</title><link>${i.link}</link><guid isPermaLink="false">${esc(i.link + '#' + i.date + '-' + i.title)}</guid><pubDate>${new Date(i.date + 'T12:00:00Z').toUTCString()}</pubDate><description>${esc(i.desc)}</description></item>`).join('')}</channel></rss>`);
const pages = ['/', '/changes/', '/models/', '/posts/', '/method/', '/data/', '/status/', ...models.map(m => `/models/${slug(m)}/`), ...(jev ? ['/findings/jev-1-13-vs-1-14/'] : []), ...posts.map(p => `/posts/${p.slug}/`)];
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
fs.writeFileSync(path.join(OUT, 'llms.txt'), `# Decision Drift

> An independent, daily tracker of decision models (typed-answer models such as TypeSafe Jev, Cloudflare Clef, Perplexity Decider, OpenAI Luna Decisions). Every compatible model on OpenRouter gets the same frozen probe suite every day; we report how many answers change versus the first run (Oct 20, 2026), each model's noise level, sensitivity to option order and paraphrase, gold-label accuracy and calibration, latency and errors.

Latest run: ${latest.date}, ${latest.models} models, ${latest.items} states.
Most stable${provisional ? ' (provisional)' : ''}, instability index (100 = average model, lower is better): ${ranked.slice(0, 5).map(m => `${nameOf(m)} ${stOf(m).index.toFixed(0)}`).join(', ')}. Least stable: ${ranked.slice(-2).map(m => `${nameOf(m)} ${stOf(m).index.toFixed(0)}`).join(', ')}.
${jev ? `Jev 1.13 vs 1.14: ${pct(jev.overall.flip_rate)} of top answers differ (95% CI ${ci(jev.overall.ci)}).` : ''}

## Pages
- [Ranking](${SITE}/): most stable decision models, by instability index
- [Changes](${SITE}/changes/): answers changed since Oct 20 per model, against each model's noise
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
