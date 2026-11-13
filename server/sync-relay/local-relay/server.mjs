// xPin sync relay — LOCAL DEV HARNESS ONLY (Phase 1).
// Dependency-free Node (plain node:http). Stores envelopes as opaque
// encrypted bytes; it cannot read note content and never sees a passphrase.
// Endpoints:
//   POST /v1/sync/push  {envelopes: [...]} -> {ok:true, accepted:n}
//   GET  /v1/sync/pull?since=<lamport> -> {envelopes: [...], serverLamport}
//   GET  /health -> {ok:true, envelopes:n}
//
// DEV ONLY: no auth, no TLS, loopback use only. The production relay
// target is Neon + Vercel (see server/sync-relay/README.md) — this file
// exists so sync can be verified end-to-end locally with no server to
// deploy. Do not expose it to the internet as-is.
//
// Usage: node server/sync-relay/local-relay/server.mjs [--port 8787] [--store ./data]
//   Store file: <store>/envelopes.json (created on first push).
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number.parseInt(argValue("--port", process.env.XPIN_RELAY_PORT || "8787"), 10) || 8787;
const STORE_DIR = argValue("--store", process.env.XPIN_RELAY_STORE || path.join(process.cwd(), "data"));
const STORE_FILE = path.join(STORE_DIR, "envelopes.json");
const MAX_ENVELOPES = 10_000;
const MAX_BODY_BYTES = 5_000_000;

let envelopes = [];
let serverLamport = 0;

function isValidEnvelope(e) {
  return e && typeof e === "object" && !Array.isArray(e) &&
    e.envelopeVersion === 1 &&
    typeof e.id === "string" && e.id &&
    typeof e.deviceId === "string" && e.deviceId &&
    Number.isFinite(e.lamport) &&
    typeof e.noteId === "string" && e.noteId &&
    (e.op === "upsert" || e.op === "tombstone") &&
    e.payload && typeof e.payload === "object";
}

async function loadStore() {
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, "utf8"));
    if (raw && Array.isArray(raw.envelopes) && raw.envelopes.every(isValidEnvelope)) {
      envelopes = raw.envelopes;
      serverLamport = raw.envelopes.reduce((max, e) => Math.max(max, e.lamport), 0);
    }
  } catch {
    envelopes = [];
  }
}

async function saveStore() {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify({ envelopes, savedAt: new Date().toISOString() }, null, 2));
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, envelopes: envelopes.length, serverLamport });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/sync/push") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        send(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      if (!body || !Array.isArray(body.envelopes) || body.envelopes.length > 1000 ||
        !body.envelopes.every(isValidEnvelope)) {
        send(res, 400, { ok: false, error: "invalid envelopes" });
        return;
      }
      const seen = new Set(envelopes.map((e) => e.id));
      let accepted = 0;
      for (const envelope of body.envelopes) {
        if (seen.has(envelope.id)) continue; // idempotent: re-push is a no-op
        seen.add(envelope.id);
        envelopes.push(envelope);
        serverLamport = Math.max(serverLamport, envelope.lamport);
        accepted += 1;
      }
      while (envelopes.length > MAX_ENVELOPES) envelopes.shift();
      await saveStore();
      send(res, 200, { ok: true, accepted, serverLamport });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/sync/pull") {
      const since = Number.parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const out = envelopes.filter((e) => e.lamport > since);
      send(res, 200, { envelopes: out, serverLamport });
      return;
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    console.error("relay error:", error);
    send(res, 500, { ok: false, error: "internal error" });
  }
});

await loadStore();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`xPin sync relay (REFERENCE ONLY — no auth, no TLS, local use) on http://127.0.0.1:${PORT}`);
  console.log(`Store: ${STORE_FILE} (${envelopes.length} envelopes)`);
});
