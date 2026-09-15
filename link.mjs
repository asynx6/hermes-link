#!/usr/bin/env node
// hermes-link — tiny agent-to-agent mailbox over plain HTTP. Zero dependency.
// Each side runs `serve` (an inbox server); messages are signed with a shared
// secret (x-link-key header) and appended to line-delimited JSON inboxes.
//
//   node link.mjs serve  --name vinz --port 8485
//   node link.mjs hello  http://IP:8485 --from vinz --role "windows vinz" --text "hi!"
//   node link.mjs send   http://IP:8485 --from vinz --text "msg for their inbox"
//   node link.mjs inbox  http://IP:8485 --name vinz          # unread since last check
//
// Secret comes from env LINK_SECRET. State dir: env LINK_STATE or ./link-state.
// Honest limits: shared-secret auth, plain HTTP — trusted peers only, run
// behind TLS or inside a private net for anything serious.

import { createServer } from 'node:http';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STATE = process.env.LINK_STATE || join(process.cwd(), 'link-state');
const secret = () => process.env.LINK_SECRET || '';

// ---------------- server ----------------
function inboxOf(name) {
  mkdirSync(STATE, { recursive: true });
  return join(STATE, 'inbox-' + name.replace(/[^\w-]/g, '_') + '.jsonl');
}
function readInbox(name) {
  const f = inboxOf(name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function append(name, msg) {
  appendFileSync(inboxOf(name), JSON.stringify(msg) + '\n');
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((res, rej) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > 1_000_000) rej(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        res(s ? JSON.parse(s) : {});
      } catch {
        rej(new Error('bad json'));
      }
    });
    req.on('error', rej);
  });
}

export function createLinkServer({ name }) {
  const started = Date.now();
  return createServer(async (req, res) => {
    const u = new URL(req.url, 'http://link');
    const key = req.headers['x-link-key'] || '';
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/ping')) {
        return send(res, 200, { ok: true, name, uptime_s: ((Date.now() - started) / 1000) | 0 });
      }
      if (key !== secret()) return send(res, 401, { ok: false, error: 'bad key' });

      if (req.method === 'POST' && (u.pathname === '/msg' || u.pathname === '/hello')) {
        const b = await readBody(req);
        if (!b.from || !b.text) return send(res, 400, { ok: false, error: 'from + text required' });
        const msg = {
          id: b.id || randomUUID().slice(0, 8),
          ts: new Date().toISOString(),
          kind: u.pathname === '/hello' ? 'hello' : 'msg',
          from: String(b.from).slice(0, 64),
          role: String(b.role || '').slice(0, 120),
          text: String(b.text).slice(0, 8000),
          reply_to: b.reply_to || null,
        };
        append(name, msg); // into MY inbox; the peer drains it
        return send(res, 202, { ok: true, id: msg.id });
      }

      if (req.method === 'GET' && u.pathname.startsWith('/inbox/')) {
        const who = u.pathname.slice('/inbox/'.length);
        if (who !== name) return send(res, 403, { ok: false, error: 'not your inbox' });
        return send(res, 200, { ok: true, name, messages: readInbox(name) });
      }

      send(res, 404, { ok: false, error: 'no route ' + u.pathname });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  });
}

// ---------------- client ----------------
const base = () => {
  const b = argv.find((a) => /^https?:\/\//.test(a));
  if (!b) throw new Error('give a base URL, e.g. http://127.0.0.1:8485');
  return b.replace(/\/+$/, '');
};
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i > -1 && argv[i + 1] ? argv[i + 1] : d;
};
async function api(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-link-key': secret() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function seenFile(name) {
  mkdirSync(STATE, { recursive: true });
  return join(STATE, 'seen-' + name.replace(/[^\w-]/g, '_') + '.json');
}

async function cmdInbox() {
  const me = opt('name', process.env.LINK_NAME || 'me');
  const r = await api(base() + '/inbox/' + me, 'GET');
  if (r.status !== 200) {
    console.error('inbox failed:', r.status, JSON.stringify(r.json));
    process.exitCode = 1;
    return;
  }
  const seen = existsSync(seenFile(me)) ? new Set(JSON.parse(readFileSync(seenFile(me), 'utf8'))) : new Set();
  const fresh = r.json.messages.filter((m) => !seen.has(m.id));
  for (const m of fresh) {
    const t = m.kind === 'hello' ? `HELLO from ${m.from}${m.role ? ' (' + m.role + ')' : ''}` : `${m.from}:`;
    console.log(`[${m.ts.slice(11, 19)}] ${t} ${m.text.slice(0, 500)}`);
  }
  writeFileSync(seenFile(me), JSON.stringify([...fresh, ...r.json.messages].map((m) => m.id)));
  console.log(`${fresh.length} unread / ${r.json.messages.length} total in ${me}'s inbox`);
}

async function cmdSend(kind) {
  const from = opt('from', process.env.LINK_NAME || 'anonymous');
  const r = await api(base() + (kind === 'hello' ? '/hello' : '/msg'), 'POST', {
    from,
    role: opt('role', ''),
    text: opt('text', argv.join(' ')),
    reply_to: opt('reply-to', null),
  });
  console.log(r.status === 202 ? `delivered → ${base()} (id ${r.json.id})` : `FAILED ${r.status}: ${JSON.stringify(r.json)}`);
  process.exitCode = r.status === 202 ? 0 : 1;
}

// ---------------- entry ----------------
const argv = process.argv.slice(3); // after `link.mjs <cmd>`
const cmd = process.argv[2];
const isMain = process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href;
if (isMain) {
if (cmd === 'serve') {
  const name = opt('name', process.env.LINK_NAME || 'link');
  const port = Number(opt('port', process.env.LINK_PORT || 8485));
  if (!secret()) {
    console.error('set LINK_SECRET first (shared with your peer)');
    process.exit(3);
  }
  createLinkServer({ name }).listen(port, () => {
    console.log(`hermes-link "${name}" on :${port} (state ${STATE})`);
  });
} else if (cmd === 'hello') {
  await cmdSend('hello');
} else if (cmd === 'send') {
  await cmdSend('msg');
} else if (cmd === 'inbox') {
  await cmdInbox();
} else if (cmd === 'ping') {
  const r = await fetch(base() + '/ping', { signal: AbortSignal.timeout(8000) }).then((x) => x.json());
  console.log(JSON.stringify(r));
} else {
  console.log('usage: link.mjs serve|hello|send|inbox|ping [--name N] [--port P] [--from F] [--text T] [--role R]');
}
}
