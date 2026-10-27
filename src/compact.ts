// Compacts finished result files: drops fields recoverable from the suite, gzips, removes the plain file.
// Usage: node src/compact.ts results/2026-10-20 [results/private/2026-10-20 ...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, readJsonl } from './lib.ts';

function slim(r: any) {
  if (r.answers) for (const a of Object.values<any>(r.answers)) delete a.legend; // legend = the question's own criteria
  if (r.req_hash) r.req_hash = r.req_hash.slice(0, 16);
  return r;
}
let before = 0, after = 0, files = 0;
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) {
      const recs = readJsonl(p).map(slim);
      const gz = zlib.gzipSync(recs.map(r => JSON.stringify(r)).join('\n') + '\n', { level: 9 });
      before += fs.statSync(p).size; after += gz.length; files++;
      fs.writeFileSync(p + '.gz', gz);
      if (readJsonl(p + '.gz').length !== recs.length) throw new Error(`verify failed: ${p}`);
      fs.unlinkSync(p);
    }
  }
}
for (const d of process.argv.slice(2)) walk(path.resolve(ROOT, d));
console.log(`compacted ${files} files: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
