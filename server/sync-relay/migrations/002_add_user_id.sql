-- 002_add_user_id.sql
-- xPin sync relay (Neon / Postgres). Scopes envelopes to the Google
-- account that pushed them (the token's `sub` claim).
--
-- Rows pushed before auth have user_id '' (open mode, the pre-auth
-- default). Once GOOGLE_CLIENT_ID is set on the relay, push/pull only
-- serve rows for the signed-in user, so '' rows become unreachable.
-- The live table is empty, so this migration moves no data.
--
-- Run in the Neon SQL Editor, or:
--   psql "$DATABASE_URL" -f migrations/002_add_user_id.sql

ALTER TABLE sync_envelopes ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';

-- Pull filters by user_id first, then lamport, so it needs this index.
CREATE INDEX IF NOT EXISTS sync_envelopes_user_lamport_idx
  ON sync_envelopes (user_id, lamport);
