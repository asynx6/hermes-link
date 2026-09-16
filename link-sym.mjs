#!/usr/bin/env node
// hermes-link — agent-to-agent chat over plain HTTP. Zero dependency.
// Each side runs `serve` (an inbox server); messages are signed with a shared
// secret (x-link-key header) and appended to line-delimited JSON inboxes.
//
//   node link.mjs serve  --name vinz --port 8485
//   node link.mjs hello  http://IP:8485 --from vinz --role "windows vinz" --text "hi!"
//   node link.mjs send   http://IP:8485 --from vinz --text "msg for their inbox"
//   node link.mjs inbox  http://IP:8485 --name vinz          # unread since last check
//   node link.mjs group  http://IP:8485 --post --from vinz --text "to everyone"
//   node link.mjs group  http://IP:8485                      # read last 50
//   node link.mjs register http://IP:8485 --name leo --url https://abc.lhr.life
//   node link.mjs peers  http://IP:8485
//
// Secret comes from env LINK_SECRET. State dir: env LINK_STATE or ./link-state.
// Honest limits: shared-secret auth, plain HTTP — trusted peers only.

import { createServer } from 'node:http';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const STATE = process.env.LINK_STATE || join(process.cwd(), 'link-state');
const secret = () => process.env.LINK_SECRET || '';
const safe = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 64);

// ---------------- state helpers ----------------
function inboxOf(name) {
  mkdirSync(STATE, { recursive: true });
  return join(STATE, 'inbox-' + safe(name) + '.jsonl');
}
function readInbox(name) {
  const f = inboxOf(name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function append(name, msg) {
  appendFileSync(inboxOf(name), JSON.stringify(msg) + '\n');
}
// peer registry: name → { url, at } updated by /register heartbeats. Rotating
// tunnels (Leo) stay reachable: they ping every few min, we track the latest.
function registryFile() {
  mkdirSync(STATE, { recursive: true });
  return join(STATE, 'peer-registry.json');
}
function loadRegistry() {
  try { return JSON.parse(readFileSync(registryFile(), 'utf8')); } catch { return {}; }
}
function groupFile() {
  mkdirSync(STATE, { recursive: true });
  return join(STATE, 'group-crew.jsonl');
}
function readGroup(limit = 50) {
  if (!existsSync(groupFile())) return [];
  return readFileSync(groupFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-limit);
}

// ---------------- server ----------------
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

      // ---- crew group (shared timeline hosted by each peer; read from one, post to all) ----
      if (req.method === 'GET' && u.pathname === '/group') {
        return send(res, 200, { ok: true, name, messages: readGroup() });
      }
      if (req.method === 'POST' && u.pathname === '/group') {
        const b = await readBody(req);
        if (!b.from || !b.text) return send(res, 400, { ok: false, error: 'from + text required' });
        const id = b.id || randomUUID().slice(0, 8);
        // idempotent append: forwarded copies must not duplicate on re-fan-out
        const existing = readGroup(1000);
        if (existing.some((m) => m.id === id)) return send(res, 200, { ok: true, id, deduped: true });
        const msg = {
          id,
          ts: new Date().toISOString(),
          kind: 'group',
          from: String(b.from).slice(0, 64),
          text: String(b.text).slice(0, 4000),
        };
        appendFileSync(groupFile(), JSON.stringify(msg) + '\n');
        // fan-out to every registered peer that runs the group route (best effort)
        const reg = loadRegistry();
        const me = (reg[name] || {}).url;
        for (const [peer, info] of Object.entries(reg)) {
          if (peer === name || !info.url || info.url === me) continue;
          fetch(info.url.replace(/\/+$/, '') + '/group', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-link-key': secret() },
            body: JSON.stringify(msg),
            signal: AbortSignal.timeout(8000),
          }).catch(() => { /* peer offline — group stays on those who are home */ });
        }
        return send(res, 202, { ok: true, id: msg.id });
      }

      // ---- peer registry (heartbeats for rotating tunnels) ----
      if (req.method === 'POST' && u.pathname === '/register') {
        const b = await readBody(req);
        if (!b.name || !/^https?:\/\//.test(b.url || '')) return send(res, 400, { ok: false, error: 'name + url required' });
        const reg = loadRegistry();
        reg[String(b.name).slice(0, 64)] = { url: String(b.url).slice(0, 200), at: new Date().toISOString(), role: String(b.role || '').slice(0, 120) };
        writeFileSync(registryFile(), JSON.stringify(reg, null, 1));
        return send(res, 202, { ok: true, known: Object.keys(reg) });
      }
      if (req.method === 'GET' && u.pathname === '/peers') {
        return send(res, 200, { ok: true, registry: loadRegistry() });
      }

      send(res, 404, { ok: false, error: 'no route ' + u.pathname });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  });
}

// ---------------- client ----------------
const base = (argv) => {
  const b = argv.find((a) => /^https?:\/\//.test(a));
  if (!b) throw new Error('give a base URL, e.g. http://127.0.0.1:8485');
  return b.replace(/\/+$/, '');
};
const opt = (argv, n, d) => {
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

function seenFile(me) {
  mkdirSync(STATE, { recursive: true });
  return join(STATE, 'seen-' + safe(me) + '.json');
}

async function cmdInbox(argv) {
  const me = opt(argv, 'name', process.env.LINK_NAME || 'me');
  const r = await api(base(argv) + '/inbox/' + me, 'GET');
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
  writeFileSync(seenFile(me), JSON.stringify(r.json.messages.map((m) => m.id)));
  console.log(`${fresh.length} unread / ${r.json.messages.length} total in ${me}'s inbox`);
}

async function cmdSend(argv, kind) {
  const from = opt(argv, 'from', process.env.LINK_NAME || 'anonymous');
  const path = kind === 'hello' ? '/hello' : kind === 'group' ? '/group' : '/msg';
  const r = await api(base(argv) + path, 'POST', {
    from,
    id: opt(argv, 'id', null),
    role: opt(argv, 'role', ''),
    text: opt(argv, 'text', argv.filter((a) => !a.startsWith('--') && !/^https?:\/\//.test(a)).join(' ')),
    reply_to: opt(argv, 'reply-to', null),
  });
  console.log(r.status === 202 || (r.status === 200 && r.json.ok) ? `delivered → ${base(argv)} (id ${r.json.id}${r.json.deduped ? ', deduped' : ''})` : `FAILED ${r.status}: ${JSON.stringify(r.json)}`);
  process.exitCode = r.status === 202 || (r.status === 200 && r.json.ok) ? 0 : 1;
}

async function cmdGroup(argv) {
  if (argv.includes('--post')) return cmdSend(argv, 'group');
  const r = await api(base(argv) + '/group', 'GET');
  if (r.status !== 200) { console.error('group failed:', r.status, JSON.stringify(r.json)); process.exitCode = 1; return; }
  for (const m of r.json.messages) console.log(`[${m.ts.slice(11, 16)}] ${m.from}: ${m.text.slice(0, 300)}`);
}

async function cmdRegister(argv) {
  const me = opt(argv, 'name', process.env.LINK_NAME || 'anon');
  const myUrl = opt(argv, 'url', process.env.LINK_URL || '');
  if (!myUrl) { console.error('give --url <your reachable endpoint>'); process.exitCode = 1; return; }
  const r = await api(base(argv) + '/register', 'POST', { name: me, url: myUrl, role: opt(argv, 'role', '') });
  console.log(r.status === 202 ? `registered at ${base(argv)}: known=${(r.json.known || []).join(',')}` : `FAILED ${r.status}`);
  process.exitCode = r.status === 202 ? 0 : 1;
}

async function cmdPeers(argv) {
  const r = await api(base(argv) + '/peers', 'GET');
  console.log(JSON.stringify(r.json.registry || {}, null, 1));
}

// ---------------- entry ----------------
const argv = process.argv.slice(3); // after `link.mjs <cmd>`
const cmd = process.argv[2];
// realpath both sides so symlinked/pm2 invocations still count as main
// (v0.2.1 fix: naive URL compare failed under symlinks → serve exited silently)
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
try {
  if (cmd === 'serve') {
    const name = opt(argv, 'name', process.env.LINK_NAME || 'link');
    const port = Number(opt(argv, 'port', process.env.LINK_PORT || 8485));
    if (!secret()) {
      console.error('set LINK_SECRET first (shared with your peer)');
      process.exit(3);
    }
    createLinkServer({ name }).listen(port, () => {
      console.log(`hermes-link "${name}" on :${port} (state ${STATE})`);
    });
  } else if (cmd === 'hello') await cmdSend(argv, 'hello');
  else if (cmd === 'send') await cmdSend(argv, 'msg');
  else if (cmd === 'group') await cmdGroup(argv);
  else if (cmd === 'inbox') await cmdInbox(argv);
  else if (cmd === 'register') await cmdRegister(argv);
  else if (cmd === 'peers') await cmdPeers(argv);
  else if (cmd === 'ping') {
    const r = await fetch(base(argv) + '/ping', { signal: AbortSignal.timeout(8000) }).then((x) => x.json());
    console.log(JSON.stringify(r));
  } else {
    console.log('usage: link.mjs serve|hello|send|group|inbox|register|peers|ping [--name N] [--port P] [--from F] [--text T] [--url U]');
  }
} catch (e) {
  console.error('error:', e.message);
  process.exitCode = 1;
}
}
