// Custom weights for the Overall ranking. Runs in the browser; inlined into the home page by site.ts.
// Recomputes each model's index from its four component rates, re-sorts, and redraws the Overall panel and table.
// Intervals and group lines need per-question data, so custom views leave them out.
(() => {
  const D = JSON.parse(document.getElementById('rk-data').textContent);
  const W = D.weights; // { models, scales, defaults, comps: [[key, label]] }
  const box = document.getElementById('rk-weights');
  const btn = document.getElementById('rk-wbtn');
  const panel = document.querySelector('#panel-overall .rk');
  const sub = document.querySelector('#panel-overall .rk-sub');
  const tbody = document.querySelector('#rk-table tbody');
  const orig = { panel: panel.innerHTML, sub: sub.textContent, tbody: tbody.innerHTML };
  const inputs = [...box.querySelectorAll('input[type=range]')];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keys = W.comps.map(c => c[0]);
  const isDefault = w => keys.every(k => Math.abs(w[k] - W.defaults[k]) < 1e-9);

  function niceStep(x) { const raw = x / 4; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(f => f * p).find(s => s >= raw); }
  function axis(vals) {
    const s = vals.slice().sort((a, b) => b - a); const top = Math.max(1, s[0] > 1.5 * s[1] ? s[1] : s[0]);
    const step = niceStep(top * 4 / 5), max = top * 1.04;
    return { max, ticks: Array.from({ length: Math.floor(max / step + 1e-9) + 1 }, (_, i) => +(i * step).toFixed(6)) };
  }
  const label = w => keys.map(k => Math.round(w[k] * 100)).join('/');

  function compute(raw) {
    const total = keys.reduce((a, k) => a + raw[k], 0) || 1;
    const w = Object.fromEntries(keys.map(k => [k, raw[k] / total]));
    const rows = W.models.map(m => {
      const parts = Object.fromEntries(keys.map(k => [k, 100 * w[k] * m.c[k] / W.scales[k]]));
      return { m, parts, index: keys.reduce((a, k) => a + parts[k], 0) };
    }).sort((a, b) => a.index - b.index);
    return { w, rows };
  }

  const cikey = document.getElementById('rk-cikey');
  function render(raw) {
    const { w, rows } = compute(raw);
    if (cikey) cikey.hidden = !isDefault(w);
    inputs.forEach(i => { i.nextElementSibling.textContent = Math.round(w[i.dataset.k] * 100) + '%'; });
    document.querySelectorAll('#panel-overall [data-wk] .wpct').forEach(n => { n.textContent = Math.round(w[n.parentElement.dataset.wk] * 100); });
    if (isDefault(w)) { // back to the official ranking, with intervals and groups
      panel.innerHTML = orig.panel; sub.textContent = orig.sub; tbody.innerHTML = orig.tbody; window.rkCustom = null;
      const u = new URL(location.href); u.searchParams.delete('w'); history.replaceState(null, '', u); return;
    }
    const ax = axis(rows.map(r => r.index));
    const X = v => (100 * Math.min(v, ax.max) / ax.max).toFixed(2) + '%';
    const head = '<div class="rk-head" role="row"><span role="columnheader">Rank</span><span role="columnheader">Model</span><span role="columnheader" class="rk-axis">' +
      ax.ticks.map(t => '<i style="left:' + X(t) + '">' + t + '</i>').join('') + '</span><span role="columnheader">Index</span></div>';
    const body = rows.map((r, i) => {
      let used = 0;
      const segs = keys.filter(k => r.parts[k] > 0.05).map(k => { const room = Math.max(0, ax.max - used); const v = Math.min(r.parts[k], room); used += r.parts[k]; return v > 0 ? '<span class="seg s-' + k + '" style="width:' + X(v) + '"></span>' : ''; }).join('');
      const tip = r.m.name + ': ' + r.index.toFixed(0) + '. ' + W.comps.map(c => c[1] + ' ' + r.parts[c[0]].toFixed(0)).join(', ');
      return '<div class="rk-row" role="row"><span class="rk-n" role="cell">' + (i + 1) + '</span><a class="rk-nm" role="cell" href="' + r.m.href + '"><b>' + esc(r.m.name) + '</b><small>' + esc(r.m.vendor) + '</small>' +
        (r.m.flag ? '<em class="flag">▲ change detected</em>' : '') + '</a><span class="rk-bar" role="cell"><span class="stack' + (r.index > ax.max ? ' over' : '') + '" tabindex="0" data-tip="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
        (segs || '<span class="seg zero"></span>') + '</span></span><span class="rk-v" role="cell">' + r.index.toFixed(0) + '</span></div>';
    }).join('');
    panel.innerHTML = head + body;
    sub.textContent = 'Custom weights ' + label(w) + '. Instability index, lower is better. 100 = an average model. Intervals and group lines are shown for the default weights only.';
    tbody.innerHTML = rows.map((r, i) => '<tr><td>' + (i + 1) + '</td><td class="l"><a href="' + r.m.href + '">' + esc(r.m.name) + '</a></td><td><b>' + r.index.toFixed(0) + '</b></td><td class="opt">—</td>' +
      keys.map(k => '<td>' + (r.m.c[k] * 100).toFixed(1) + '%</td>').join('') + '</tr>').join('');
    window.rkCustom = { id: 'overall', title: 'Most stable decision models', sub: 'Custom weights ' + label(w) + '. Instability index, lower is better.', unit: '', max: ax.max, ticks: ax.ticks,
      rows: rows.map((r, i) => ({ rank: i + 1, name: r.m.name, vendor: r.m.vendor, segs: keys.map(k => ({ k, v: r.parts[k] })), value: r.index, label: r.index.toFixed(0), ci: null, sep: false, flag: r.m.flag })) };
    const u = new URL(location.href); u.searchParams.set('w', keys.map(k => Math.round(w[k] * 100)).join('-')); history.replaceState(null, '', u);
  }

  const current = () => Object.fromEntries(inputs.map(i => [i.dataset.k, +i.value]));
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  // Split `total` across sliders in proportion to their current values (equally if all are 0), as whole numbers.
  function share(vals, total) {
    const t = sum(vals); const raw = vals.map(v => (t ? v / t : 1 / vals.length) * total);
    const out = raw.map(Math.floor); let left = total - sum(out);
    raw.map((r, j) => [r - out[j], j]).sort((a, b) => b[0] - a[0]).forEach(([, j]) => { if (left > 0) { out[j]++; left--; } });
    return out;
  }
  // Sliders always add up to 100. Moving one leaves the sliders before it alone and splits what is left across
  // the sliders after it. The last slider has none after it, so it trades with the one just before it.
  function rebalance(changed) {
    const vals = inputs.map(x => +x.value); const i = inputs.indexOf(changed);
    if (i === inputs.length - 1) {
      const fixed = sum(vals.slice(0, i - 1)); vals[i] = Math.min(vals[i], 100 - fixed); vals[i - 1] = 100 - fixed - vals[i];
    } else {
      const fixed = sum(vals.slice(0, i)); vals[i] = Math.min(vals[i], 100 - fixed);
      share(vals.slice(i + 1), 100 - fixed - vals[i]).forEach((v, j) => { vals[i + 1 + j] = v; });
    }
    inputs.forEach((x, j) => { x.value = vals[j]; });
  }
  const set = w => { const v = share(keys.map(k => w[k]), 100); inputs.forEach((x, j) => { x.value = v[j]; }); render(current()); };
  inputs.forEach(i => i.addEventListener('input', () => { rebalance(i); render(current()); }));
  box.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => set(b.dataset.preset === 'equal' ? Object.fromEntries(keys.map(k => [k, 0.25])) : W.defaults)));
  btn.addEventListener('click', () => { box.hidden = !box.hidden; btn.setAttribute('aria-expanded', !box.hidden); });

  // weights from a shared link: ?w=50-20-10-20
  const q = new URLSearchParams(location.search).get('w');
  if (q && /^\d{1,3}(-\d{1,3}){3}$/.test(q)) {
    const v = q.split('-').map(Number);
    if (v.every(x => x <= 100) && v.some(x => x > 0)) { box.hidden = false; btn.setAttribute('aria-expanded', 'true'); set(Object.fromEntries(keys.map((k, i) => [k, v[i] / 100]))); }
  }
})();
