// Writes status.json (served by the site) summarizing the latest collection run.
// Usage: node src/status.ts --date 2026-10-27 --run daily --status ok|failed
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, keyUsage } from './lib.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] ?? 'true']); return acc;
}, []));
const reportFile = path.join(ROOT, 'reports', `${args.date}-${args.run}.json`);
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
const per = report?.perModel ?? {};
const u = await keyUsage();
const status = {
  last_run: { date: args.date, run: args.run, status: args.status, finished_at: new Date().toISOString() },
  schedule: 'daily at 10:17 UTC',
  models: Object.keys(per).length,
  requests: Object.values<any>(per).reduce((s, p) => s + p.requests, 0),
  errors: Object.values<any>(per).reduce((s, p) => s + p.errors, 0),
  models_with_errors: Object.entries<any>(per).filter(([, p]) => p.error_rate > 0.05).map(([m]) => m),
  run_cost_usd: Object.values<any>(per).reduce((s, p) => s + p.cost_run, 0),
  key_usage_usd: Number.isFinite(u.usage) ? u.usage : null,
};
fs.writeFileSync(path.join(ROOT, 'status.json'), JSON.stringify(status, null, 1) + '\n');
console.log(JSON.stringify(status));
