# xPin sync relay — Neon + Vercel (reference implementation, NOT deployed)

The production sync target, per the owner's locked decision: **Neon +
Vercel** (the existing stack). The relay stores only opaque encrypted
blobs — one table + a tiny API. Cloud Bridge is the later home for the
relay; the app's transport abstraction (`sync/transports.js`,
`HttpRelayTransport`) is kept so the relay can move there without
changing the app. **Cloudflare Durable Objects was deliberately not
picked.**

The relay can never read note content: every envelope's payload is
AES-256-GCM ciphertext produced on the device, and the relay holds no
keys and never sees a passphrase.

## Layout

- `migrations/001_create_sync_envelopes.sql` — the one table (`id`,
  `device_id`, `lamport`, `envelope` JSONB, `created_at`) + indexes.
- `api/v1/sync/push.js` — `POST /v1/sync/push`, idempotent insert.
- `api/v1/sync/pull.js` — `GET /v1/sync/pull?since=<lamport>`.
- `api/_lib/` — Neon client (`db.mjs`), envelope validation
  (`envelopes.mjs`, dependency-free), store queries (`store.mjs`).
- `local-relay/` — the minimal file-backed Node relay, **dev harness
  only**, for verifying sync end-to-end locally with nothing to deploy.
- `package.json` — one dependency: `@neondatabase/serverless`, the
  HTTP-based Neon driver built for serverless (no connection pooling to
  manage). Everything else is plain Node.

## Deploy (owner step — nothing here is deployed)

1. **Neon:** create a project (or reuse the existing one), then run the
   migration — paste `migrations/001_create_sync_envelopes.sql` into the
   Neon SQL Editor, or run `npm run db:migrate` with `DATABASE_URL` set
   (needs `psql` installed).
2. **Vercel:** create a project from this directory
   (`server/sync-relay/` as the project root, or import the repo and set
   the root directory to it). No build step; the `api/` directory is
   deployed as serverless functions automatically.
3. **Env var:** in the Vercel project, set `DATABASE_URL` to the Neon
   connection string — use the **pooled** (`-pooler`) host with
   `?sslmode=require`.
4. **Deploy** (Vercel dashboard or `vercel deploy`).
5. **In xPin:** Workspace tools → Sync → relay URL
   `https://<your-project>.vercel.app/api` → Sync now. The app appends
   `/v1/sync/push` and `/v1/sync/pull`, so the base URL ends at `/api`.

## Endpoints

- `POST /v1/sync/push` `{envelopes: [...]}` → `{ok, accepted, duplicates}`
  (re-pushing the same envelope id is a no-op — idempotent; batches
  capped at 500 envelopes)
- `GET /v1/sync/pull?since=<lamport>` → `{ok, envelopes, serverLamport}`

## Reference only — what this is NOT

- **No auth.** Anyone who knows the URL can push/pull envelopes. Before
  this serves real users it needs authentication (the natural next step
  is a per-device bearer token — the capture token in the app's sync
  settings is built for exactly this — plus per-account isolation).
  Until then, treat the deployed URL as private.
- **No rate limiting or retention policy** beyond the pull limit (1,000
  envelopes per pull). A production relay needs both, plus a tombstone /
  retention decision.
- **No per-account isolation** — one shared envelope store.
- TLS is handled by Vercel automatically; Neon connections require SSL.

Until a relay is deployed, encrypted sync **bundles** (export/import
files, in the app's Sync settings) are the sync path that works with no
server at all, and sync stays off by default when no relay URL is set.

## Local dev harness

```sh
node server/sync-relay/local-relay/server.mjs --port 8787 --store ./server/sync-relay/data
```

Then in xPin: relay URL `http://127.0.0.1:8787` → Sync now. Same
`/v1/sync/*` paths as the Vercel functions. Loopback only, no auth —
never expose it to the internet.
