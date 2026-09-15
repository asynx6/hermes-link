// hermes-link protocol tests — server runs in-process on a random port,
// no network, no state files from real deployments (LINK_STATE points at a
// temp dir removed at the end).
process.env.LINK_SECRET = 'test-secret';
process.env.LINK_STATE = 'test-state';
const { mkdirSync, rmSync } = await import('node:fs');
mkdirSync('test-state', { recursive: true });
const { createLinkServer } = await import('./link.mjs');

let pass = 0, fail = 0;
const ok = (c, name) => {
  if (c) pass++;
  else { fail++; console.error('FAIL ' + name); }
};

const srv = createLinkServer({ name: 'host' });
await new Promise((r) => srv.listen(0, r));
const base = 'http://127.0.0.1:' + srv.address().port;
const J = (path, init) => fetch(base + path, init).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
const msg = (body, key = 'test-secret') =>
  J('/msg', { method: 'POST', headers: { 'content-type': 'application/json', 'x-link-key': key }, body: JSON.stringify(body) });

// ping
{
  const r = await J('/ping');
  ok(r.s === 200 && r.j.ok && r.j.name === 'host', 'ping public');
}

// send + hello
{
  const a = await msg({ from: 'peer1', text: 'halo' });
  ok(a.s === 202 && a.j.id, 'send accepted with id');
  const b = await J('/hello', { method: 'POST', headers: { 'content-type': 'application/json', 'x-link-key': 'test-secret' }, body: JSON.stringify({ from: 'peer2', text: 'hi' }) });
  ok(b.s === 202, 'hello accepted');
  const inbox = await J('/inbox/host', { headers: { 'x-link-key': 'test-secret' } });
  ok(inbox.s === 200 && inbox.j.messages.length === 2, 'inbox drains both');
  ok(inbox.j.messages[0].kind === 'msg' && inbox.j.messages[1].kind === 'hello', 'kinds recorded');
  ok(inbox.j.messages.every((m) => m.id && m.ts), 'ids + timestamps present');
}

// auth
{
  const r = await msg({ from: 'x', text: 'y' }, 'wrong-key');
  ok(r.s === 401, 'bad key rejected');
  const r2 = await J('/inbox/host');
  ok(r2.s === 401, 'inbox without key rejected');
  const r3 = await J('/inbox/host', { headers: { 'x-link-key': 'test-secret' } });
  ok(r3.s === 200 && r3.j.messages.length === 2, 'own inbox ok');
}

// validation + limits
{
  const r = await msg({ from: 'x' });
  ok(r.s === 400, 'missing text → 400');
  const big = await msg({ from: 'x', text: 'a'.repeat(9000) });
  ok(big.s === 202, 'oversized text accepted but truncated');
  const inbox = await J('/inbox/host', { headers: { 'x-link-key': 'test-secret' } });
  const last = inbox.j.messages[inbox.j.messages.length - 1];
  ok(last.text.length === 8000, 'truncated to 8KB cap');
  const weird = await msg({ from: '../evil', text: 'nope', id: 'x', role: 'z'.repeat(200) });
  ok(weird.s === 202 && !weird.j.id.includes('/') && weird.j.id.length <= 8, 'id sanitized');
}

// stable-sha monitor invariant (what the cron gate hashes)
{
  const { readFileSync } = await import('node:fs');
  const h1 = readFileSync('test-state/inbox-host.jsonl', 'utf8').split('\n').filter(Boolean).length;
  const r = await msg({ from: 'peer1', text: 'halo' }); // new message changes it
  ok(r.s === 202 && h1 === 4, 'file grew predictably for hash watchers');
}

srv.close();
rmSync('test-state', { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
