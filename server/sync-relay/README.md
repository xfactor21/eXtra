# xPin sync relay — Neon + Vercel (deployed at https://xpin-sync-relay.vercel.app/ — the app's default relay)

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
- `migrations/002_add_user_id.sql` — adds `user_id` + a
  (`user_id`, `lamport`) index, so envelopes are scoped per Google account.
- `api/v1/sync/push.js` — `POST /v1/sync/push`, idempotent insert.
- `api/v1/sync/pull.js` — `GET /v1/sync/pull?since=<lamport>`.
- `api/_lib/` — Neon client (`db.mjs`), envelope validation
  (`envelopes.mjs`, dependency-free), store queries (`store.mjs`),
  Google ID token verification (`auth.mjs`, dependency-free).
- `local-relay/` — the minimal file-backed Node relay, **dev harness
  only**, for verifying sync end-to-end locally with nothing to deploy.
- `package.json` — one dependency: `@neondatabase/serverless`, the
  HTTP-based Neon driver built for serverless (no connection pooling to
  manage). Everything else is plain Node.

## Deploy (self-hosting — the xPin relay above is already deployed and is the app default; these steps are only for running your own)

1. **Neon:** create a project (or reuse the existing one), then run the
   migrations — paste `migrations/001_create_sync_envelopes.sql` and
   `migrations/002_add_user_id.sql` into the Neon SQL Editor (in order),
   or run `npm run db:migrate` with `DATABASE_URL` set (needs `psql`
   installed).
2. **Vercel:** create a project from this directory
   (`server/sync-relay/` as the project root, or import the repo and set
   the root directory to it). No build step; the `api/` directory is
   deployed as serverless functions automatically.
3. **Env vars:** in the Vercel project, set `DATABASE_URL` to the Neon
   connection string — use the **pooled** (`-pooler`) host with
   `?sslmode=require` — and set `GOOGLE_CLIENT_ID` to the Google OAuth
   client id (see "Google sign-in" below). **Until `GOOGLE_CLIENT_ID`
   is set, the relay stays open (no auth) exactly as before; setting it
   is the only switch that turns enforcement on.**
4. **Deploy** (Vercel dashboard or `vercel deploy`).
5. **In xPin:** Workspace tools → Sync → relay URL
   `https://<your-project>.vercel.app/api` → Sync now. The app appends
   `/v1/sync/push` and `/v1/sync/pull`, so the base URL ends at `/api`.

## Endpoints

- `POST /v1/sync/push` `{envelopes: [...]}` → `{ok, accepted, duplicates}`
  (re-pushing the same envelope id is a no-op — idempotent; batches
  capped at 500 envelopes)
- `GET /v1/sync/pull?since=<lamport>` → `{ok, envelopes, serverLamport}`

## Google sign-in (interim auth before Cloud Bridge)

Push and pull require a Google ID token (`Authorization: Bearer
<id_token>`) once `GOOGLE_CLIENT_ID` is set on the relay. The app gets
the token from Google Identity Services ("Sign in with Google" in Sync
settings) and sends it with every relay request. The relay verifies the
token against Google's public keys (JWKS, `api/_lib/auth.mjs`) and
scopes every row to the token's `sub` — one user can never pull
another's envelopes, not even the encrypted blobs. The passphrase still
does the actual encryption, so Google never sees note content; the relay
holds no keys and no client secret is needed anywhere (verification uses
public keys only).

- **The token is the "who", the passphrase is the "what".** A signed-in
  device that cannot decrypt an envelope skips it; a device with the
  passphrase but no sign-in gets a 401.
- **Rollout:** the relay code can ship before the OAuth client exists —
  with `GOOGLE_CLIENT_ID` unset it behaves exactly as before (open).
  Enforcement starts the moment the env var is set, and the app only
  shows the sign-in button once its own `GOOGLE_CLIENT_ID` is set.
- **Bundles still work with no account at all** (export/import files in
  Sync settings), and local notes never need one.

### OAuth client setup (owner step)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
→ APIs & Services → Credentials → Create Credentials → OAuth client ID →
application type **Web application**. Authorized JavaScript origins:

- `https://xpin.planet-x.co`
- `https://xpin-kappa.vercel.app`
- `http://localhost:8000` (local dev)

Copy the **Client ID** (the secret is never needed) into two places:
the relay's `GOOGLE_CLIENT_ID` env var (Vercel) and the app's
`GOOGLE_CLIENT_ID` constant in `app.js` (or the pre-boot
`window.xPinGoogleClientIdOverride` for self-hosters). Add more origins
later any time the app moves — the client id stays the same.

## What this is NOT (yet)

- **No per-account isolation beyond Google sign-in.** Envelopes are
  scoped per Google account (`user_id`), but there is no xPin account
  system, no device management, and no way to revoke one device
  without signing the whole account out. Real accounts + revocation
  are the Cloud Bridge job.
- **No rate limiting or retention policy** beyond the pull limit (1,000
  envelopes per pull). A production relay needs both, plus a tombstone /
  retention decision.
- TLS is handled by Vercel automatically; Neon connections require SSL.

Sync stays off until you set a sync passphrase and press Sync now — the
relay URL being set does not sync anything by itself. Encrypted sync
**bundles** (export/import files, in the app's Sync settings) remain the
offline path that works with no server at all.

## Local dev harness

```sh
node server/sync-relay/local-relay/server.mjs --port 8787 --store ./server/sync-relay/data
```

Then in xPin: relay URL `http://127.0.0.1:8787` → Sync now. Same
`/v1/sync/*` paths as the Vercel functions. Loopback only, no auth —
never expose it to the internet.
