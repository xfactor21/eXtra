/* xPin sync relay — envelope store (Neon).
 *
 * Thin layer over the Neon serverless client. `sql` is the client query
 * function (sql.query(text, params) works on the real driver); taking it
 * as a parameter keeps this module testable with a stubbed client and no
 * database. The relay stores envelopes opaquely — it never decrypts and
 * never inspects note content.
 */

import { MAX_PULL } from "./envelopes.mjs";

// Insert envelopes, idempotently: re-pushing an envelope with the same id
// is a no-op (ON CONFLICT DO NOTHING), so a retried sync never duplicates.
// `userId` is stamped server-side from the verified Google token ("" in
// open mode, when auth is off) — never trust a client-supplied user id.
// Returns {accepted, duplicates}.
export async function pushEnvelopes(sql, envelopes, userId = "") {
  let accepted = 0;
  for (const envelope of envelopes) {
    const rows = await sql.query(
      `INSERT INTO sync_envelopes (id, device_id, lamport, envelope, user_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [envelope.id, envelope.deviceId, envelope.lamport, JSON.stringify(envelope), userId]
    );
    if (rows.length > 0) accepted += 1;
  }
  return { accepted, duplicates: envelopes.length - accepted };
}

// All of one user's envelopes newer than `since`, oldest first. Returns
// {envelopes, maxLamport} where maxLamport is that user's highest lamport
// (0 when the user has none). In open mode userId is "" and the query
// matches the pre-auth rows, which all carry user_id ''.
export async function pullEnvelopes(sql, since, userId = "") {
  const rows = await sql.query(
    `SELECT envelope FROM sync_envelopes
     WHERE user_id = $1 AND lamport > $2
     ORDER BY lamport ASC
     LIMIT $3`,
    [userId, since, MAX_PULL]
  );
  const maxRows = await sql.query(
    `SELECT COALESCE(MAX(lamport), 0) AS max_lamport FROM sync_envelopes
     WHERE user_id = $1`,
    [userId]
  );
  return {
    envelopes: rows.map((row) => row.envelope),
    maxLamport: Number(maxRows[0]?.max_lamport ?? 0)
  };
}
