#!/usr/bin/env node
// hermes-intake — small upload sink for crew files (zips, manifests).
// PUT /upload?name=leo-foo.zip  +  header x-link-key: <LINK_SECRET>  + body bytes
// → saved under Leo-inbox/uploads/<name>, 200 {ok,path,bytes}. Nothing else.
// Auth = same shared secret as hermes-link; name sanitized; 25MB cap.
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const DEST = process.env.INTAKE_DIR || join(process.env.HOME || process.env.USERPROFILE, 'leo-inbox', 'uploads');
const secret = process.env.LINK_SECRET || '';
if (!secret) {
  console.error('set LINK_SECRET');
  process.exit(3);
}
mkdirSync(DEST, { recursive: true });

createServer((req, res) => {
  const done = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/ping') return done(200, { ok: true, service: 'hermes-intake' });
  if (req.headers['x-link-key'] !== secret) return done(401, { ok: false, error: 'bad key' });
  if (req.method !== 'PUT') return done(405, { ok: false, error: 'PUT only' });

  const u = new URL(req.url, 'http://intake');
  if (u.pathname !== '/upload') return done(404, { ok: false, error: 'no route' });
  const name = basename(String(u.searchParams.get('name') || 'upload.bin')).replace(/[^\w.\-]/g, '_').slice(0, 100);
  if (!/^leo-[\w.\-]+$/i.test(name) || !/\.(zip|tgz|tar|txt|md|json)$/i.test(name)) {
    return done(400, { ok: false, error: 'name must look like leo-<...>.(zip|tgz|txt|md|json)' });
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 25 * 1024 * 1024) {
      req.destroy();
      return done(413, { ok: false, error: 'too big (>25MB)' });
    }
    chunks.push(c);
  });
  req.on('end', () => {
    let out = join(DEST, name);
    let n = 1;
    while (existsSync(out)) out = join(DEST, name.replace(/(\.\w+)$/, '-' + n + '$1')), n++;
    writeFileSync(out, Buffer.concat(chunks));
    appendFileSync(join(DEST, 'intake.log'), new Date().toISOString() + ' ' + name + ' ' + size + 'B\n');
    done(200, { ok: true, path: out, bytes: size });
  });
}).listen(8080, '0.0.0.0', () => console.log('hermes-intake on :8080 → ' + DEST));
