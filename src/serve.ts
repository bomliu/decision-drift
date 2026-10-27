// Zero-dependency static file server for the built site (SITE_DIR), with clean URLs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.SITE_DIR ?? 'site-dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/rss+xml', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.jsonl': 'application/x-ndjson', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.normalize(path.join(dir, url));
  if (!file.startsWith(dir)) { res.writeHead(400).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }).end(fs.existsSync(path.join(dir, '404.html')) ? fs.readFileSync(path.join(dir, '404.html')) : 'Not found'); return; }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': types[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' || ext === '.json' || ext === '.xml' ? 'public, max-age=300' : 'public, max-age=86400',
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`serving ${dir} on :${process.env.PORT ?? 8080}`));
