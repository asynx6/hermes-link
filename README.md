# hermes-link

Agent-to-agent chat over plain HTTP. One file, zero dependencies.

You run two (or twenty) AI agents on different boxes and they have no way to
talk. hermes-link gives each of them a signed inbox: `serve` on one side,
`send`/`hello` from the other, `inbox` to drain unread messages. That's the
whole product.

```
node link.mjs serve --name vinz --port 8485
node link.mjs hello http://other-box:8485 --from leonars --text "vinz, ini gw. bisa baca?"
node link.mjs inbox http://other-box:8485 --name leonars
node link.mjs ping  http://other-box:8485
```

## Why

- **Zero dependency** — single ESM file, Node ≥ 18. No npm install, no build,
  no telemetry. Read the source in five minutes.
- **Agents, not humans** — the protocol is designed for cron-style watchers:
  messages carry ids (dedupe), inboxes are append-only JSONL (trivially
  diff-able), a sha256 of the inbox file is a stable "anything new?" signal
  (we pair it with a 1-minute cron + hash-gate so an idle watcher wakes zero
  times and costs zero tokens).
- **Self-host, trusted peers only** — shared secret (`LINK_SECRET`, sent as
  `x-link-key`), plain HTTP, 401/403 everywhere it matters. Put TLS or a
  private network in front before anything but your own boxes connects.

## API

| route | auth | body / returns |
|---|---|---|
| `GET /ping` | none | `{ok:true,name,uptime_s}` |
| `POST /hello` \| `POST /msg` | `x-link-key` | `{from,role?,text,reply_to?}` → `202 {ok,id}` |
| `GET /inbox/<name>` | `x-link-key` | only the server's own name; 403 otherwise |

Limits: 1 MB request bodies, 8 KB message text, 64 chars sender. Bad JSON or
missing fields → 4xx, never a crash.

## Suggested watcher (the pattern that works)

```bash
# cron every minute, cheap gate:
sha256sum state-*/inbox-vinz.jsonl | cut -c1-16
# unchanged from last run → agent does not wake at all.
# changed → agent drains ids not in cron-seen.txt, replies, appends ids.
```

Deterministic monitor output (no timestamps, stable order) is what keeps the
wakeup count near zero when idle.

## Tests

```bash
node test.js   # roundtrip, dedupe, 401/403, limits — in-process, no network
```

## Not on the roadmap

E2E encryption, relay/multi-hop rooms, human UI. Those exist elsewhere and
each one is a dependency or a server farm. This stays a mailbox.

## License

MIT
