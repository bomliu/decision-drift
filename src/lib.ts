// Shared helpers: env, OpenRouter calls, budget guard, hashing, concurrency.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ROOT = path.resolve(import.meta.dirname, '..');
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type QuestionType = 'noul' | 'choice' | 'score';
export interface Question {
  type: QuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[] | { true: string; false: string };
}
export interface Item {
  id: string;
  added_in: string;
  family: string;
  shape: string;
  language: string;
  difficulty?: 'clear' | 'boundary' | 'edge';
  split?: 'public' | 'private';
  source: string;
  state: string;
  questions: Record<string, Question>;
  gold?: Record<string, string | number | boolean>;
  notes?: string;
}

export function loadEnv(): Record<string, string> {
  const file = path.join(ROOT, '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const KEY = process.env.OPENROUTER_API_KEY || loadEnv().OPENROUTER_API_KEY;
function authHeaders() {
  if (!KEY) throw new Error('OPENROUTER_API_KEY missing (.env or environment)');
  return { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
}

// Stable JSON with sorted keys, used for hashing.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort().map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface CatalogModel { id: string; canonical_slug: string; prompt_price: number; context_length: number; }
export async function fetchCatalog(): Promise<CatalogModel[]> {
  const r = await fetch(MODELS_URL);
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  const d = (await r.json()) as any;
  return d.data
    .filter((m: any) => !m.id.endsWith(':free'))
    .map((m: any) => ({ id: m.id, canonical_slug: m.canonical_slug, prompt_price: Number(m.pricing?.prompt ?? 0), context_length: m.context_length }));
}

// Budget guard: OpenRouter reports cumulative spend on the key itself.
export async function keyUsage(): Promise<{ usage: number; limit: number | null }> {
  try {
    const r = await fetch(KEY_URL, { headers: authHeaders() });
    const d = (await r.json()) as any;
    const x = d.data ?? d;
    return { usage: Number(x.usage), limit: x.limit ?? null };
  } catch { return { usage: NaN, limit: null }; }
}
export const BUDGET_STOP = Number(process.env.BUDGET_STOP ?? 22); // dollars of total key usage

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface DecideResult {
  ok: boolean; status: number; latency_ms: number; attempts: number;
  response?: any; error?: string;
}
// extra: optional request fields, e.g. { provider: { only: [...], allow_fallbacks: false } }
export async function decide(model: string, state: string, questions: Record<string, Question>, extra: Record<string, unknown> = {}): Promise<DecideResult> {
  const body = JSON.stringify({ model, state, questions, ...extra });
  let attempts = 0;
  let last: DecideResult = { ok: false, status: 0, latency_ms: 0, attempts: 0 };
  while (attempts < 4) {
    attempts++;
    const t0 = performance.now();
    try {
      const r = await fetch(DECISIONS_URL, { method: 'POST', headers: authHeaders(), body, signal: AbortSignal.timeout(60_000) });
      const latency_ms = Math.round(performance.now() - t0);
      const text = await r.text();
      if (r.ok) return { ok: true, status: r.status, latency_ms, attempts, response: JSON.parse(text) };
      last = { ok: false, status: r.status, latency_ms, attempts, error: text.slice(0, 500) };
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempts); continue; }
      return last; // 4xx other than 429: not retryable
    } catch (e: any) {
      last = { ok: false, status: 0, latency_ms: Math.round(performance.now() - t0), attempts, error: String(e?.message ?? e) };
      await sleep(1000 * 2 ** attempts);
    }
  }
  return last;
}

export async function chat(model: string, messages: { role: string; content: string }[], extra: Record<string, unknown> = {}) {
  let attempts = 0;
  while (true) {
    attempts++;
    const r = await fetch(CHAT_URL, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model, messages, ...extra }), signal: AbortSignal.timeout(180_000) }).catch(e => e);
    if (r instanceof Response && r.ok) return (await r.json()) as any;
    if (attempts >= 4) throw new Error(`chat ${model} failed: ${r instanceof Response ? r.status + ' ' + (await r.text()).slice(0, 300) : r}`);
    await sleep(2000 * 2 ** attempts);
  }
}

export async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Reads JSONL, transparently handling a gzipped `.jsonl.gz` file or sibling.
export function readJsonl<T = any>(file: string): T[] {
  const gz = file.endsWith('.gz') ? file : file + '.gz';
  let text: string;
  if (!file.endsWith('.gz') && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  else if (fs.existsSync(gz)) text = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8');
  else return [];
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
export function loadItems(...files: string[]): Item[] {
  return files.flatMap(f => readJsonl<Item>(path.resolve(ROOT, f)));
}

// Deterministic PRNG for variants.
export function rng(seed: string) {
  let h = parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 2 ** 32; };
}
export function shuffled<T>(arr: T[], seed: string): T[] {
  const a = arr.slice(); const r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
