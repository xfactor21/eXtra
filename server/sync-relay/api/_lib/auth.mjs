/* xPin sync relay — Google ID token verification (dependency-free).
 *
 * Interim auth before Cloud Bridge. The relay accepts Google ID tokens
 * (from Google Identity Services in the app) and trusts only their `sub`
 * claim as the user id. The token proves WHO is syncing; the passphrase
 * still encrypts every envelope, so Google — and this relay — never see
 * note content.
 *
 * Verification is done locally with Google's public keys (JWKS), so no
 * Google API call happens per request and no client secret is needed
 * anywhere. The only config is GOOGLE_CLIENT_ID: the OAuth client id the
 * token must have been issued for. When it is NOT set, auth is off and
 * the relay behaves as before (open mode) — that is the safe rollout:
 * this code can ship before the OAuth client exists, and enforcement
 * starts the moment the env var is set.
 *
 * Node built-ins only (node:crypto + global fetch). No new dependencies.
 */

import { createPublicKey, createVerify } from "node:crypto";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h; Google rotates keys, so never cache longer

let jwksCache = null; // { keys: Map<kid, KeyObject>, fetchedAt: number }
let jwksInFlight = null; // in-flight fetch promise (dedupes concurrent requests)

// Tests only: drop the cached JWKS so a test can swap key material.
export function clearJwksCache() {
  jwksCache = null;
  jwksInFlight = null;
}

function defaultFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Google sign-in verification needs a fetch implementation.");
  }
  return fetch;
}

async function loadJwks(fetchImpl) {
  if (jwksInFlight) return jwksInFlight;
  jwksInFlight = (async () => {
    const res = await fetchImpl(JWKS_URL, { headers: { Accept: "application/json" } });
    if (!res || res.ok !== true) {
      throw new Error(`Could not load Google signing keys (HTTP ${res?.status ?? "?"}).`);
    }
    const data = await res.json();
    const keys = new Map();
    for (const jwk of data?.keys ?? []) {
      if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // Unusable key entry — skip it; other keys may still verify.
      }
    }
    jwksCache = { keys, fetchedAt: Date.now() };
    return jwksCache;
  })();
  try {
    return await jwksInFlight;
  } finally {
    jwksInFlight = null;
  }
}

async function getSigningKey(kid, fetchImpl) {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS && jwksCache.keys.has(kid)) {
    return jwksCache.keys.get(kid);
  }
  const fresh = await loadJwks(fetchImpl);
  if (fresh.keys.has(kid)) return fresh.keys.get(kid);
  // Unknown kid: keys may have rotated since the last fetch — refetch
  // once, then give up. Never accept a token we cannot verify.
  jwksCache = null;
  const refetched = await loadJwks(fetchImpl);
  if (refetched.keys.has(kid)) return refetched.keys.get(kid);
  throw new Error("Google sign-in token was signed with an unknown key.");
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error("Google sign-in token is malformed.");
  }
}

// Verify a Google ID token. Returns the token's `sub` (the user id).
// Throws on any problem; messages are safe to log, never forwarded to
// clients verbatim (handlers return a generic 401).
export async function verifyGoogleIdToken(token, options = {}) {
  const clientId = options.clientId;
  if (!clientId) {
    throw new Error("Google sign-in is not configured on this relay.");
  }
  if (typeof token !== "string" || !token) {
    throw new Error("Missing Google sign-in token.");
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Google sign-in token is malformed.");
  }
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== "RS256") {
    throw new Error("Google sign-in token uses an unsupported algorithm.");
  }
  if (typeof header.kid !== "string" || !header.kid) {
    throw new Error("Google sign-in token is missing a key id.");
  }
  const key = await getSigningKey(header.kid, fetchImpl);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`, "utf8");
  if (!verifier.verify(key, parts[2], "base64url")) {
    throw new Error("Google sign-in token signature is invalid.");
  }
  if (!ISSUERS.has(payload.iss)) {
    throw new Error("Google sign-in token issuer is invalid.");
  }
  const audOk = payload.aud === clientId ||
    (Array.isArray(payload.aud) && payload.aud.includes(clientId));
  if (!audOk) {
    throw new Error("Google sign-in token was issued for a different app.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    throw new Error("Google sign-in token has expired.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Google sign-in token has no user id.");
  }
  return payload.sub;
}

// True once GOOGLE_CLIENT_ID is set — that is the only switch for
// enforcement. Unset = open mode (today's behavior), set = auth required.
export function authEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

// Resolve the caller for a relay request. Returns "" in open mode (no
// auth configured — everything behaves as before) or the verified user id.
// Throws an error with .status = 401 when auth is on and the request
// carries no usable token. `req` is a Vercel request (headers lowercased).
export async function requireRelayUser(req, options = {}) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return "";
  const headers = req?.headers ?? {};
  const auth = headers.authorization ?? headers.Authorization ?? "";
  const match = typeof auth === "string" ? /^Bearer\s+(.+?)\s*$/.exec(auth) : null;
  if (!match) {
    const error = new Error("Sign in with Google to sync.");
    error.status = 401;
    throw error;
  }
  try {
    return await verifyGoogleIdToken(match[1], {
      clientId,
      fetchImpl: options.fetchImpl
    });
  } catch {
    const error = new Error("Google sign-in could not be verified. Sign in again.");
    error.status = 401;
    throw error;
  }
}
