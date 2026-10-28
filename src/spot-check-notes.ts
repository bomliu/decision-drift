// Reads notes exported from private/spot-check.html, keeps a copy in the private repo, and summarizes them.
// Usage: node src/spot-check-notes.ts ~/Downloads/spot-check-notes.json
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.ts';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Pass the path to spot-check-notes.json'); process.exit(1); }
const notes = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.writeFileSync(path.join(ROOT, 'private/spot-check-notes.json'), JSON.stringify(notes, null, 1) + '\n');
const items = Object.entries<any>(notes.items);
const by = (v: string) => items.filter(([, s]) => s?.verdict === v);
console.log(`Reviewed ${notes.reviewed} of ${notes.total} (exported ${notes.exported_at})`);
console.log(`OK ${by('ok').length}, fix ${by('fix').length}, retire ${by('retire').length}, unreviewed ${items.filter(([, s]) => !s?.verdict).length}`);
for (const v of ['retire', 'fix']) for (const [id, s] of by(v))
  console.log(`- ${v.toUpperCase()} ${id}${s.wrong?.length ? ` (reference wrong: ${s.wrong.join(', ')})` : ''}${s.note ? `: ${s.note}` : ''}`);
const wrongOnly = items.filter(([, s]) => s?.verdict === 'ok' && s.wrong?.length);
for (const [id, s] of wrongOnly) console.log(`- OK but reference wrong ${id}: ${s.wrong.join(', ')}${s.note ? `: ${s.note}` : ''}`);
