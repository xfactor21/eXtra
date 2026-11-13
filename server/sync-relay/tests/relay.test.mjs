/* xPin sync relay tests — node:test, no live services.
 *
 * Run: npm test (node --test tests/) from server/sync-relay/.
 * Auth tests use a locally-generated RS256 keypair and a stubbed JWKS
 * fetch — no live Google calls, no real tokens. Store/handler tests use
 * an in-memory stub sql client — no Neon. The handlers' `deps` argument
 * ({sql, requireUser}) is the test seam; Vercel always calls handler(req, res).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { generateKeyPairSync, createSign } from "node:crypto";
import {
  verifyGoogleIdToken,
  requireRelayUser,
  clearJwksCache
} from "../api/_lib/auth.mjs";
import { validatePushBody, parseSince } from "../api/_lib/envelopes.mjs";
import { pushEnvelopes, pullEnvelopes } from "../api/_lib/store.mjs";
import pushHandler from "../api/v1/sync/push.js";
import pullHandler from "../api/v1/sync/pull.js";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

/* ---------- local RS256 keypair + JWKS stub ---------- */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "test-key-1";
jwk.alg = "RS256";
jwk.use = "sig";

let jwksFetchCalls = 0;
function makeJwksFetch(keys = [jwk]) {
  return async () => {
    jwksFetchCalls += 1;
    return { ok: true, json: async () => ({ keys }) };
  };
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signToken({ kid = "test-key-1", alg = "RS256", payload = {}, key = privateKey } = {}) {
  const header = { alg, kid, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-user-123",
    iat: now,
    exp: now + 3600,
    ...payload
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
  return `${unsigned}.${signature}`;
}

/* ---------- in-memory stub sql client ---------- */

function makeStubSql() {
  const rows = []; // {id, device_id, lamport, envelope, user_id}
  return {
    rows,
    async query(text, params) {
      if (text.includes("INSERT INTO sync_envelopes")) {
        const [id, deviceId, lamport, envelopeJson, userId] = params;
        if (rows.some((r) => r.id === id)) return [];
        rows.push({ id, device_id: deviceId, lamport, envelope: JSON.parse(envelopeJson), user_id: userId });
        return [{ id }];
      }
      if (text.includes("SELECT envelope FROM sync_envelopes")) {
        const [userId, since, limit] = params;
        return rows
          .filter((r) => r.user_id === userId && r.lamport > since)
          .sort((a, b) => a.lamport - b.lamport)
          .slice(0, limit)
          .map((r) => ({ envelope: r.envelope }));
      }
      if (text.includes("MAX(lamport)")) {
        const [userId] = params;
        const max = rows
          .filter((r) => r.user_id === userId)
          .reduce((m, r) => Math.max(m, r.lamport), 0);
        return [{ max_lamport: max }];
      }
      throw new Error(`stub sql: unexpected query: ${String(text).slice(0, 60)}`);
    }
  };
}

function makeEnvelope(id, lamport, noteId = "note-1") {
  return {
    envelopeVersion: 1,
    id,
    deviceId: "xpin-test",
    lamport,
    noteId,
    op: "upsert",
    payload: { iv: "x", data: "y" }
  };
}

function mockRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    status(code) { this._status = code; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end(body) { this._body = body; return this; }
  };
  return res;
}

function mockReq({ method = "POST", headers = {}, body = undefined, query = {} } = {}) {
  return { method, headers, body, query };
}

/* ---------- auth: verifyGoogleIdToken ---------- */

describe("auth: verifyGoogleIdToken", () => {
  beforeEach(() => {
    clearJwksCache();
    jwksFetchCalls = 0;
  });

  it("accepts a valid token and returns the sub", async () => {
    const sub = await verifyGoogleIdToken(signToken(), {
      clientId: CLIENT_ID,
      fetchImpl: makeJwksFetch()
    });
    assert.equal(sub, "google-user-123");
  });

  it("rejects a token issued for a different app", async () => {
    await assert.rejects(
      verifyGoogleIdToken(signToken({ payload: { aud: "other-app.apps.googleusercontent.com" } }), {
        clientId: CLIENT_ID,
        fetchImpl: makeJwksFetch()
      }),
      /different app/
    );
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(
      verifyGoogleIdToken(signToken({ payload: { exp: now - 10 } }), {
        clientId: CLIENT_ID,
        fetchImpl: makeJwksFetch()
      }),
      /expired/
    );
  });

  it("rejects a bad signature", async () => {
    await assert.rejects(
      verifyGoogleIdToken(signToken({ key: otherPrivateKey }), {
        clientId: CLIENT_ID,
        fetchImpl: makeJwksFetch()
      }),
      /signature is invalid/
    );
  });

  it("rejects an unknown kid after one JWKS refetch", async () => {
    await assert.rejects(
      verifyGoogleIdToken(signToken({ kid: "rotated-key-9" }), {
        clientId: CLIENT_ID,
        fetchImpl: makeJwksFetch()
      }),
      /unknown key/
    );
    assert.equal(jwksFetchCalls, 2, "unknown kid refetches the JWKS exactly once");
  });

  it("rejects a non-RS256 token", async () => {
    await assert.rejects(
      verifyGoogleIdToken(signToken({ alg: "HS256" }), {
        clientId: CLIENT_ID,
        fetchImpl: makeJwksFetch()
      }),
      /unsupported algorithm/
    );
  });

  it("rejects a token from another issuer", async () => {
    await assert.rejects(
      verifyGoogleIdToken(signToken({ payload: { iss: "https://evil.example.com" } }), {
        clientId: CLIENT_ID,
        fetchImpl: makeJwksFetch()
      }),
      /issuer is invalid/
    );
  });

  it("rejects malformed and missing tokens", async () => {
    await assert.rejects(
      verifyGoogleIdToken("not-a-jwt", { clientId: CLIENT_ID, fetchImpl: makeJwksFetch() }),
      /malformed/
    );
    await assert.rejects(
      verifyGoogleIdToken("", { clientId: CLIENT_ID, fetchImpl: makeJwksFetch() }),
      /Missing/
    );
  });

  it("throws when no client id is configured", async () => {
    await assert.rejects(
      verifyGoogleIdToken(signToken(), { clientId: "", fetchImpl: makeJwksFetch() }),
      /not configured/
    );
  });
});

/* ---------- auth: requireRelayUser ---------- */

describe("auth: requireRelayUser", () => {
  let savedClientId;
  beforeEach(() => {
    clearJwksCache();
    savedClientId = process.env.GOOGLE_CLIENT_ID;
  });
  afterEach(() => {
    if (savedClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = savedClientId;
  });

  it("open mode (no GOOGLE_CLIENT_ID) returns '' without fetching keys", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    let fetched = false;
    const userId = await requireRelayUser(
      { headers: {} },
      { fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); } }
    );
    assert.equal(userId, "");
    assert.equal(fetched, false);
  });

  it("auth on + no token is a 401", async () => {
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    const error = await requireRelayUser({ headers: {} }, { fetchImpl: makeJwksFetch() })
      .then(() => null, (e) => e);
    assert.equal(error?.status, 401);
  });

  it("auth on + valid Bearer token returns the sub", async () => {
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    const userId = await requireRelayUser(
      { headers: { authorization: `Bearer ${signToken()}` } },
      { fetchImpl: makeJwksFetch() }
    );
    assert.equal(userId, "google-user-123");
  });

  it("auth on + bad token is a 401", async () => {
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    const error = await requireRelayUser(
      { headers: { authorization: "Bearer garbage.token.here" } },
      { fetchImpl: makeJwksFetch() }
    ).then(() => null, (e) => e);
    assert.equal(error?.status, 401);
  });
});

/* ---------- store: per-user scoping ---------- */

describe("store: per-user scoping", () => {
  it("push stamps the server-side user id; re-push is a duplicate", async () => {
    const sql = makeStubSql();
    const env = makeEnvelope("env-1", 1);
    const first = await pushEnvelopes(sql, [env], "user-a");
    assert.deepEqual(first, { accepted: 1, duplicates: 0 });
    assert.equal(sql.rows[0].user_id, "user-a");
    const second = await pushEnvelopes(sql, [env], "user-a");
    assert.deepEqual(second, { accepted: 0, duplicates: 1 });
  });

  it("pull only returns the requesting user's envelopes, with a per-user lamport", async () => {
    const sql = makeStubSql();
    await pushEnvelopes(sql, [makeEnvelope("env-a1", 1), makeEnvelope("env-a2", 2)], "user-a");
    await pushEnvelopes(sql, [makeEnvelope("env-b1", 3)], "user-b");
    const a = await pullEnvelopes(sql, 0, "user-a");
    assert.deepEqual(a.envelopes.map((e) => e.id), ["env-a1", "env-a2"]);
    assert.equal(a.maxLamport, 2);
    const b = await pullEnvelopes(sql, 0, "user-b");
    assert.deepEqual(b.envelopes.map((e) => e.id), ["env-b1"]);
    assert.equal(b.maxLamport, 3);
    const aSince2 = await pullEnvelopes(sql, 2, "user-a");
    assert.deepEqual(aSince2.envelopes, []);
    assert.equal(aSince2.maxLamport, 2);
  });

  it("open mode (user '') keeps working and matches pre-auth rows", async () => {
    const sql = makeStubSql();
    await pushEnvelopes(sql, [makeEnvelope("env-open", 5)]);
    const pulled = await pullEnvelopes(sql, 0);
    assert.deepEqual(pulled.envelopes.map((e) => e.id), ["env-open"]);
    assert.equal(pulled.maxLamport, 5);
  });
});

/* ---------- validation (relay-lib, unchanged behavior) ---------- */

describe("envelopes: validation", () => {
  it("accepts a well-formed push body", () => {
    const out = validatePushBody({ envelopes: [makeEnvelope("env-v", 1)] });
    assert.equal(out.length, 1);
  });

  it("rejects an empty batch and an oversized batch", () => {
    assert.throws(() => validatePushBody({ envelopes: [] }), /empty/);
    assert.throws(
      () => validatePushBody({ envelopes: Array.from({ length: 501 }, (_, i) => makeEnvelope(`e${i}`, i)) }),
      /limited to 500/
    );
  });

  it("parseSince defaults to 0 and rejects garbage", () => {
    assert.equal(parseSince({}), 0);
    assert.equal(parseSince({ since: "12" }), 12);
    assert.throws(() => parseSince({ since: "-1" }), /non-negative integer/);
    assert.throws(() => parseSince({ since: "1.5" }), /non-negative integer/);
  });
});

/* ---------- handlers ---------- */

describe("handlers: auth gating + scoping", () => {
  it("push: 401 without a token when auth is on (real requireRelayUser)", async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    try {
      const res = mockRes();
      await pushHandler(mockReq({ body: { envelopes: [makeEnvelope("env-401", 1)] } }), res);
      assert.equal(res._status, 401);
      assert.equal(JSON.parse(res._body).ok, false);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = saved;
    }
  });

  it("push: 200 + scoped rows for an authed user (stubbed auth + sql)", async () => {
    const sql = makeStubSql();
    const res = mockRes();
    await pushHandler(
      mockReq({ body: { envelopes: [makeEnvelope("env-h1", 1)] } }),
      res,
      { sql, requireUser: async () => "user-a" }
    );
    assert.equal(res._status, 200);
    assert.deepEqual(JSON.parse(res._body), { ok: true, accepted: 1, duplicates: 0 });
    assert.equal(sql.rows[0].user_id, "user-a");
  });

  it("push: open mode (requireUser returns '') keeps working", async () => {
    const sql = makeStubSql();
    const res = mockRes();
    await pushHandler(
      mockReq({ body: { envelopes: [makeEnvelope("env-h2", 1)] } }),
      res,
      { sql, requireUser: async () => "" }
    );
    assert.equal(res._status, 200);
    assert.equal(sql.rows[0].user_id, "");
  });

  it("push: 400 on a bad body, before any auth-gated database work", async () => {
    const sql = makeStubSql();
    const res = mockRes();
    await pushHandler(
      mockReq({ body: { envelopes: [] } }),
      res,
      { sql, requireUser: async () => "user-a" }
    );
    assert.equal(res._status, 400);
    assert.equal(sql.rows.length, 0);
  });

  it("pull: only the requesting user's envelopes, per-user serverLamport", async () => {
    const sql = makeStubSql();
    await pushEnvelopes(sql, [makeEnvelope("env-p1", 1), makeEnvelope("env-p2", 2)], "user-a");
    await pushEnvelopes(sql, [makeEnvelope("env-p3", 9)], "user-b");
    const res = mockRes();
    await pullHandler(
      mockReq({ method: "GET", query: { since: "0" } }),
      res,
      { sql, requireUser: async () => "user-a" }
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.envelopes.map((e) => e.id), ["env-p1", "env-p2"]);
    assert.equal(body.serverLamport, 2);
  });

  it("pull: 401 without a token when auth is on (real requireRelayUser)", async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    try {
      const res = mockRes();
      await pullHandler(mockReq({ method: "GET", query: {} }), res);
      assert.equal(res._status, 401);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = saved;
    }
  });

  it("handlers: real auth wiring — a valid token reaches the store", async () => {
    clearJwksCache();
    const savedClientId = process.env.GOOGLE_CLIENT_ID;
    const savedFetch = globalThis.fetch;
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    globalThis.fetch = makeJwksFetch();
    try {
      const sql = makeStubSql();
      const res = mockRes();
      await pushHandler(
        mockReq({
          headers: { authorization: `Bearer ${signToken()}` },
          body: { envelopes: [makeEnvelope("env-w1", 1)] }
        }),
        res,
        { sql }
      );
      assert.equal(res._status, 200);
      assert.equal(sql.rows[0].user_id, "google-user-123");
    } finally {
      if (savedClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = savedClientId;
      globalThis.fetch = savedFetch;
    }
  });
});
