/* xPin sync relay — Neon client (Vercel serverless).
 *
 * Single dependency for the whole relay: @neondatabase/serverless, the
 * HTTP-based Neon driver built for serverless (no persistent connections,
 * no connection pooling to manage). Everything else is plain Node.
 *
 * Env: DATABASE_URL — the Neon connection string. Use the pooled
 * (-pooler) host with ?sslmode=require. The client is created lazily per
 * request so a missing DATABASE_URL fails with a clear error at request
 * time instead of crashing the function at import.
 */

import { neon } from "@neondatabase/serverless";

let cached = null;

export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Sync relay is not configured: set DATABASE_URL (Neon connection string) in the Vercel project."
    );
  }
  if (!cached) cached = neon(url);
  return cached;
}
