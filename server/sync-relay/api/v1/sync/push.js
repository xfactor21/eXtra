/* xPin sync relay — POST /v1/sync/push (Vercel serverless function).
 *
 * Deployed as api/v1/sync/push.js, so with the relay base URL
 * https://<project>.vercel.app/api the app's HttpRelayTransport calls
 * <base>/v1/sync/push — the same path the local dev harness serves.
 * Accepts {envelopes: [...]}; re-pushes are idempotent (same envelope id
 * is a no-op). Body cap 5 MB is enforced by Vercel's default limits;
 * batches are capped at 500 envelopes by validatePushBody. Auth: when
 * GOOGLE_CLIENT_ID is set, the request needs a Google ID token
 * (Authorization: Bearer ...) and envelopes are stamped with the
 * token's user id; when it is unset, the relay stays open (see _lib/auth.mjs).
 */

import { getSql } from "../../_lib/db.mjs";
import { validatePushBody } from "../../_lib/envelopes.mjs";
import { pushEnvelopes } from "../../_lib/store.mjs";
import { requireRelayUser } from "../../_lib/auth.mjs";

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  // Vercel parses JSON bodies for application/json automatically.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body;
  }
  return {};
}

export default async function handler(req, res, deps = {}) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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
    console.error("sync push auth failed:", error);
    return send(res, 500, { ok: false, error: "Sync relay push failed." });
  }
  let body;
  try {
    body = readBody(req);
  } catch {
    return send(res, 400, { ok: false, error: "Push body is not valid JSON." });
  }
  let envelopes;
  try {
    envelopes = validatePushBody(body);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message });
  }
  try {
    const sql = deps.sql ?? getSql();
    const { accepted, duplicates } = await pushEnvelopes(sql, envelopes, userId);
    return send(res, 200, { ok: true, accepted, duplicates });
  } catch (error) {
    console.error("sync push failed:", error);
    return send(res, 500, { ok: false, error: "Sync relay push failed." });
  }
}
