/* xPin sync relay — GET /v1/sync/pull?since=<lamport> (Vercel serverless).
 *
 * Deployed as api/v1/sync/pull.js, so with the relay base URL
 * https://<project>.vercel.app/api the app's HttpRelayTransport calls
 * <base>/v1/sync/pull?since=... — the same path the local dev harness
 * serves. Returns every envelope newer than `since`, oldest first, for
 * the signed-in user only (when GOOGLE_CLIENT_ID is set; see _lib/auth.mjs).
 */

import { getSql } from "../../_lib/db.mjs";
import { parseSince } from "../../_lib/envelopes.mjs";
import { pullEnvelopes } from "../../_lib/store.mjs";
import { requireRelayUser } from "../../_lib/auth.mjs";

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res, deps = {}) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  }
  // Auth first: in open mode (GOOGLE_CLIENT_ID unset) this returns "" and
  // nothing changes; once the env var is set, a missing/invalid Google
  // ID token is a 401 and the request never reaches the database.
  // `deps` is a test seam only — Vercel always calls handler(req, res).
  let userId;
  try {
    userId = deps.requireUser
      ? await deps.requireUser(req)
      : await requireRelayUser(req);
  } catch (error) {
    if (error?.status === 401) {
      return send(res, 401, { ok: false, error: error.message });
    }
    console.error("sync pull auth failed:", error);
    return send(res, 500, { ok: false, error: "Sync relay pull failed." });
  }
  let since;
  try {
    since = parseSince(req.query ?? {});
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message });
  }
  try {
    const sql = deps.sql ?? getSql();
    const { envelopes, maxLamport } = await pullEnvelopes(sql, since, userId);
    return send(res, 200, { ok: true, envelopes, serverLamport: maxLamport });
  } catch (error) {
    console.error("sync pull failed:", error);
    return send(res, 500, { ok: false, error: "Sync relay pull failed." });
  }
}
