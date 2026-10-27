// Normalizes raw decision answers so metrics can compare models and runs.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJsonl } from './lib.ts';

export interface Norm {
  req?: string;                   // hash of the exact request that produced it
  provider?: string | null;       // upstream provider that served it
  type: 'noul' | 'choice' | 'score';
  top: string;                    // argmax: 'true'/'false', option key, or level index as string
  dist: Record<string, number>;   // full distribution (noul -> {true:p,false:1-p})
  p?: number;                     // noul probability of yes
  conf?: number;                  // reported confidence when present
  expected?: number;              // score: probability-weighted level
}

export function normalize(a: any): Norm | null {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'noul' && typeof a.noul === 'number') {
    const p = Math.min(1, Math.max(0, a.noul));
    return { type: 'noul', top: p >= 0.5 ? 'true' : 'false', dist: { true: p, false: 1 - p }, p };
  }
  if ((a.type === 'choice' || a.type === 'score') && a.probabilities && typeof a.probabilities === 'object') {
    const dist: Record<string, number> = {};
    let total = 0;
    for (const [k, v] of Object.entries(a.probabilities)) { const x = Number(v); if (Number.isFinite(x) && x >= 0) { dist[k] = x; total += x; } }
    if (total <= 0) return null;
    for (const k of Object.keys(dist)) dist[k] /= total;
    const top = Object.entries(dist).sort((x, y) => y[1] - x[1])[0][0];
    const n: Norm = { type: a.type, top, dist, conf: typeof a.confidence === 'number' ? a.confidence : undefined };
    if (a.type === 'score') n.expected = Object.entries(dist).reduce((s, [k, v]) => s + Number(k) * v, 0);
    return n;
  }
  return null;
}

// Total variation distance between two distributions (0..1).
export function tv(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0; for (const k of keys) s += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return s / 2;
}

export function goldMatches(n: Norm, gold: unknown): boolean {
  if (n.type === 'noul') return n.top === String(Boolean(gold));
  return n.top === String(gold);
}

export interface Rec {
  item_id: string; variant: string; model_requested: string; model_served: string | null; provider: string | null;
  ok: boolean; status: number; latency_ms: number; answers: Record<string, any> | null; usage: any; error: string | null; req_hash?: string;
}

// Loads all records of a run (public + private dirs) keyed by model.
export function loadRun(date: string, run: string): Map<string, Rec[]> {
  const out = new Map<string, Rec[]>();
  for (const base of [path.join(ROOT, 'results', date, run), path.join(ROOT, 'private', 'results', date, run)]) {
    if (!fs.existsSync(base)) continue;
    for (const f of fs.readdirSync(base).filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))) {
      for (const r of readJsonl<Rec>(path.join(base, f))) {
        if (!out.has(r.model_requested)) out.set(r.model_requested, []);
        out.get(r.model_requested)!.push(r);
      }
    }
  }
  return out;
}

export const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b); const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};
export const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
// Wilson 95% interval for a proportion.
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
