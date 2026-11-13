# Local sync relay — dev harness ONLY

A minimal file-backed Node relay (`server.mjs`, plain `node:http`,
dependency-free) that serves the same `/v1/sync/*` paths as the Vercel
functions, so sync can be verified end-to-end locally with nothing to
deploy and no database.

## Run it

```sh
node server/sync-relay/local-relay/server.mjs --port 8787 --store ./server/sync-relay/data
```

Then in xPin: Workspace tools → Sync → relay URL
`http://127.0.0.1:8787` → Sync now.

## Endpoints

- `GET /health` → `{ok, envelopes, serverLamport}`
- `POST /v1/sync/push` `{envelopes: [...]}` → `{ok, accepted, serverLamport}`
  (re-pushing the same envelope id is a no-op — idempotent)
- `GET /v1/sync/pull?since=<lamport>` → `{envelopes, serverLamport}`

Store file: `<store>/envelopes.json` (created on first push).
10,000-envelope cap, 5 MB body cap.

## NOT production

No auth, no TLS, loopback only (`127.0.0.1`), one shared store, no
per-account isolation. The production target is Neon + Vercel — see
`server/sync-relay/README.md`. Never expose this to the internet.
