/* xPin sync relay — GET /v1/sync/pull?since=<lamport> (Vercel serverless).
 *
 * Deployed as api/v1/sync/pull.js, so with the relay base URL
 * https://<project>.vercel.app/api the app's HttpRelayTransport calls
 * <base>/v1/sync/pull?since=... — the same path the local dev harness
 * serves. Returns every envelope newer than `since`, oldest first.
 */

import { getSql } from "../../_lib/db.mjs";
import { parseSince } from "../../_lib/envelopes.mjs";
import { pullEnvelopes } from "../../_lib/store.mjs";

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  }
  let since;
  try {
    since = parseSince(req.query ?? {});
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message });
  }
  try {
    const { envelopes, maxLamport } = await pullEnvelopes(getSql(), since);
    return send(res, 200, { ok: true, envelopes, serverLamport: maxLamport });
  } catch (error) {
    console.error("sync pull failed:", error);
    return send(res, 500, { ok: false, error: "Sync relay pull failed." });
  }
}
