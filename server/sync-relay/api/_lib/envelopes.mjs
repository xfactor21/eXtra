/* xPin sync relay — shared envelope validation (dependency-free).
 *
 * Used by the Vercel API functions. Kept free of the database client so
 * the validation can be unit-tested without Neon. The envelope shape
 * mirrors sync/sync.js in the app (envelopeVersion 1, op upsert/tombstone,
 * payload = AES-GCM ciphertext object). The relay never decrypts — it only
 * checks the envelope is well-formed enough to store.
 */

export const MAX_PUSH_BATCH = 500;
export const MAX_PULL = 1000;

export function validateEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("Sync envelope must be an object.");
  }
  if (envelope.envelopeVersion !== 1) {
    throw new TypeError("Unsupported sync envelope version.");
  }
  if (typeof envelope.id !== "string" || !envelope.id) {
    throw new TypeError("Sync envelope needs an id.");
  }
  if (typeof envelope.deviceId !== "string" || !envelope.deviceId) {
    throw new TypeError("Sync envelope needs a device id.");
  }
  if (!Number.isFinite(envelope.lamport)) {
    throw new TypeError("Sync envelope needs a lamport value.");
  }
  if (typeof envelope.noteId !== "string" || !envelope.noteId) {
    throw new TypeError("Sync envelope needs a note id.");
  }
  if (envelope.op !== "upsert" && envelope.op !== "tombstone") {
    throw new TypeError("Sync envelope op is invalid.");
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    throw new TypeError("Sync envelope needs a payload.");
  }
  return envelope;
}

// Validate a POST /v1/sync/push body. Returns the envelope array.
export function validatePushBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Push body must be a JSON object with an envelopes array.");
  }
  if (!Array.isArray(body.envelopes)) {
    throw new TypeError("Push body needs an envelopes array.");
  }
  if (body.envelopes.length === 0) {
    throw new TypeError("Push body envelopes array is empty.");
  }
  if (body.envelopes.length > MAX_PUSH_BATCH) {
    throw new TypeError(`Push batch is limited to ${MAX_PUSH_BATCH} envelopes.`);
  }
  return body.envelopes.map(validateEnvelopeShape);
}

// Parse ?since=<lamport> for pull. Defaults to 0; garbage fails loudly.
export function parseSince(query) {
  const raw = query?.since;
  if (raw === undefined || raw === null || raw === "") return 0;
  const since = Number(raw);
  if (!Number.isFinite(since) || since < 0 || Math.floor(since) !== since) {
    throw new TypeError("pull ?since must be a non-negative integer lamport.");
  }
  return since;
}
