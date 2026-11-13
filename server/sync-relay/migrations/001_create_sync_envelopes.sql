-- 001_create_sync_envelopes.sql
-- xPin sync relay (Neon / Postgres). One table, opaque blobs only.
--
-- The relay stores whole sync envelopes as JSONB. The note payload inside
-- each envelope is AES-256-GCM ciphertext produced on the device; the relay
-- holds no keys and can never read note content. device_id / lamport are
-- stored as plain columns only so pull can filter and order; they identify
-- a device, not a note. There is no per-account isolation in this reference
-- implementation — see README.md before deploying.
--
-- Run in the Neon SQL Editor, or:
--   psql "$DATABASE_URL" -f migrations/001_create_sync_envelopes.sql

CREATE TABLE IF NOT EXISTS sync_envelopes (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  lamport    BIGINT NOT NULL,
  envelope   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pull orders by lamport, so it needs an index.
CREATE INDEX IF NOT EXISTS sync_envelopes_lamport_idx
  ON sync_envelopes (lamport);

-- Per-device history / debugging.
CREATE INDEX IF NOT EXISTS sync_envelopes_device_lamport_idx
  ON sync_envelopes (device_id, lamport);
