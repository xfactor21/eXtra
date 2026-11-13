/* xPin sync core — Phase 1 (local-first E2EE sync).
 *
 * Design (see ~/workspace/xpin/NEXT-LEVEL-PLAN.md Phase 1):
 * - The device store is authoritative. Sync exchanges encrypted envelopes,
 *   never plaintext. A relay stores only opaque bytes and cannot read data.
 * - Envelope: {envelopeVersion:1, id, deviceId, lamport, noteId,
 *   op:"upsert"|"tombstone"|"comment"|"space", payload:<AES-GCM ciphertext>,
 *   updatedAt, baseVersion}. Payload plaintext is the note record
 *   (title/body/folder/parent/pinned/metadata/createdAt/updatedAt) for
 *   upserts, or a comment/space record for the Phase 3 collaboration ops.
 * - Per-note version is {lamport, deviceId}; last-writer-wins per note.
 *   A losing version is NOT discarded: it is appended to the note's version
 *   history (Phase 0) so conflicts never destroy data.
 * - Idempotent apply: a bounded seen-log of envelope ids (last 200);
 *   re-applying the same envelope is a no-op.
 * - Crypto reuses the existing backup construction (PBKDF2-SHA-256/310k +
 *   AES-256-GCM). The sync passphrase is NEVER stored — only a key-check
 *   value (SHA-256 of the derived key + a fixed label) is persisted, so the
 *   app can tell whether an entered passphrase is the right one.
 *
 * This module is pure: it operates on plain {notes, trash} state objects
 * and never touches the DOM or app.js globals, so the smoke suite can drive
 * it directly. It is loaded as a classic script before app.js and exposes
 * window.xPinSync. In Node (smoke/relay tests) it runs under vm with
 * globalThis.crypto = webcrypto.
 */
(() => {
  "use strict";

  const ENVELOPE_VERSION = 1;
  const MAX_SEEN_ENVELOPES = 200;
  const MAX_NOTE_VERSIONS = 20;
  const KDF_ITERATIONS = 310_000;
  const KEY_CHECK_LABEL = "xpin-sync-key-check-v1";
  const BUNDLE_FORMAT = "xpin-sync-bundle";
  const BUNDLE_VERSION = 1;

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  function randomId(prefix) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function makeDeviceId() {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return `xpin-${String(random).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase() || "device"}`;
  }

  function requireSubtle() {
    if (!globalThis.crypto?.subtle) {
      throw new Error("This browser does not support Web Crypto. Open xPin from localhost or a secure origin.");
    }
    return globalThis.crypto.subtle;
  }

  async function deriveSyncKey(passphrase, saltBytes) {
    if (typeof passphrase !== "string" || passphrase.length < 12) {
      throw new TypeError("Sync passphrase needs at least 12 characters.");
    }
    if (!(saltBytes instanceof Uint8Array) || saltBytes.length !== 16) {
      throw new TypeError("Sync key salt must be 16 bytes.");
    }
    const subtle = requireSubtle();
    const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: KDF_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  // Key-check value: SHA-256(raw key bytes + label). Stored in workspace
  // state; it proves an entered passphrase is correct without storing the
  // passphrase or the key itself.
  async function keyCheckValue(key) {
    const subtle = requireSubtle();
    const raw = new Uint8Array(await subtle.exportKey("raw", key));
    const labelled = new Uint8Array(raw.length + KEY_CHECK_LABEL.length);
    labelled.set(raw, 0);
    labelled.set(new TextEncoder().encode(KEY_CHECK_LABEL), raw.length);
    const digest = await subtle.digest("SHA-256", labelled);
    return bytesToBase64(new Uint8Array(digest));
  }

  function newSalt() {
    return globalThis.crypto.getRandomValues(new Uint8Array(16));
  }

  function compareVersions(a, b) {
    // Returns >0 when a is newer, <0 when b is newer, 0 when identical.
    // Lamport first; deviceId breaks ties deterministically.
    const la = Number.isFinite(a?.lamport) ? a.lamport : 0;
    const lb = Number.isFinite(b?.lamport) ? b.lamport : 0;
    if (la !== lb) return la - lb;
    return String(a?.deviceId ?? "").localeCompare(String(b?.deviceId ?? ""));
  }

  function noteSyncVersion(note) {
    const v = note?.syncVersion;
    if (v && Number.isFinite(v.lamport) && typeof v.deviceId === "string") {
      return { lamport: v.lamport, deviceId: v.deviceId };
    }
    return { lamport: 0, deviceId: "" };
  }

  function sanitizeSyncVersion(value) {
    if (!value || typeof value !== "object") return { lamport: 0, deviceId: "" };
    return {
      lamport: Number.isFinite(value.lamport) ? Math.max(0, Math.floor(value.lamport)) : 0,
      deviceId: typeof value.deviceId === "string" ? value.deviceId.slice(0, 80) : ""
    };
  }

  function encryptNotePayload(key, note) {
    const subtle = requireSubtle();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = {
      id: note.id,
      title: note.title,
      body: note.body,
      folderId: note.folderId ?? null,
      parentNoteId: note.parentNoteId ?? null,
      pinned: note.pinned === true,
      metadata: note.metadata ?? {},
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    };
    return subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(plain)))
      .then((cipher) => ({
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(cipher))
      }));
  }

  // Raw AES-GCM decrypt of a sync payload into parsed JSON (no shape
  // check). Used by decryptNotePayload and by the tombstone-marker path —
  // a tombstone marker {id, deleted:true} is NOT a note, so it must not
  // go through the note-shape validation.
  async function decryptJsonPayload(key, payload) {
    if (!payload || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
      throw new TypeError("Sync envelope payload is malformed.");
    }
    const subtle = requireSubtle();
    const clear = await subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
      key,
      base64ToBytes(payload.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(clear));
  }

  async function decryptNotePayload(key, payload) {
    const note = await decryptJsonPayload(key, payload);
    if (!note || typeof note.id !== "string" || typeof note.title !== "string" || typeof note.body !== "string") {
      throw new TypeError("Decrypted sync payload is not a note.");
    }
    return note;
  }

  // Build an envelope for one local note (upsert) or a delete (tombstone).
  // For a tombstone the payload is an encrypted empty marker, not the note.
  async function makeEnvelope({ key, deviceId, lamport, note, op }) {
    if (typeof deviceId !== "string" || !deviceId) throw new TypeError("Sync needs a device id.");
    if (!Number.isFinite(lamport) || lamport < 1) throw new TypeError("Sync envelope needs a lamport clock value.");
    if (op !== "upsert" && op !== "tombstone") throw new TypeError("Sync op must be upsert or tombstone.");
    if (!note || typeof note.id !== "string") throw new TypeError("Sync envelope needs a note.");
    const payload = op === "upsert"
      ? await encryptNotePayload(key, note)
      : await (async () => {
        const subtle = requireSubtle();
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const cipher = await subtle.encrypt({ name: "AES-GCM", iv }, key,
          new TextEncoder().encode(JSON.stringify({ id: note.id, deleted: true })));
        return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
      })();
    return {
      envelopeVersion: ENVELOPE_VERSION,
      id: `${deviceId}:${lamport}:${note.id}`,
      deviceId,
      lamport,
      noteId: note.id,
      op,
      payload,
      updatedAt: note.updatedAt ?? new Date().toISOString(),
      baseVersion: noteSyncVersion(note)
    };
  }

  // Phase 3 (Item 8) — collaboration records ride the same envelopes.
  // op "comment" carries an encrypted comment record {kind:"comment",
  // id, noteId, deviceId, author, body, createdAt}; op "space" carries a
  // space membership record {kind:"space", id, name, memberDeviceIds,
  // noteIds}. Same AES-GCM + PBKDF2 construction, same idempotency via
  // the seen-log, same relay (which still sees only opaque bytes).
  // Comments are append-only and deduped by id; a space record replaces
  // the local copy with the same id (last-writer-wins per space).
  async function makeRecordEnvelope({ key, deviceId, lamport, record, op }) {
    if (typeof deviceId !== "string" || !deviceId) throw new TypeError("Sync needs a device id.");
    if (!Number.isFinite(lamport) || lamport < 1) throw new TypeError("Sync envelope needs a lamport clock value.");
    if (op !== "comment" && op !== "space") throw new TypeError('Record envelope op must be "comment" or "space".');
    if (!record || typeof record.id !== "string" || !record.id) throw new TypeError("Sync record envelope needs a record with an id.");
    const subtle = requireSubtle();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = { kind: op, ...record };
    const cipher = await subtle.encrypt({ name: "AES-GCM", iv }, key,
      new TextEncoder().encode(JSON.stringify(plain)));
    const payload = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
    return {
      envelopeVersion: ENVELOPE_VERSION,
      id: `${deviceId}:${lamport}:${op}:${record.id}`,
      deviceId,
      lamport,
      noteId: op === "comment" ? String(record.noteId ?? record.id) : String(record.id),
      op,
      payload,
      updatedAt: record.createdAt ?? new Date().toISOString(),
      baseVersion: { lamport: 0, deviceId: "" }
    };
  }

  function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new TypeError("Sync envelope must be an object.");
    }
    if (envelope.envelopeVersion !== ENVELOPE_VERSION) throw new TypeError("Unsupported sync envelope version.");
    if (typeof envelope.id !== "string" || !envelope.id) throw new TypeError("Sync envelope needs an id.");
    if (typeof envelope.deviceId !== "string" || !envelope.deviceId) throw new TypeError("Sync envelope needs a device id.");
    if (!Number.isFinite(envelope.lamport)) throw new TypeError("Sync envelope needs a lamport value.");
    if (typeof envelope.noteId !== "string" || !envelope.noteId) throw new TypeError("Sync envelope needs a note id.");
    if (!["upsert", "tombstone", "comment", "space"].includes(envelope.op)) throw new TypeError("Sync envelope op is invalid.");
    if (!envelope.payload || typeof envelope.payload !== "object") throw new TypeError("Sync envelope needs a payload.");
    return envelope;
  }

  function seenHas(seen, id) {
    return Array.isArray(seen) && seen.includes(id);
  }

  function seenAdd(seen, id) {
    const next = Array.isArray(seen) ? [...seen] : [];
    if (!next.includes(id)) next.push(id);
    while (next.length > MAX_SEEN_ENVELOPES) next.shift();
    return next;
  }

  function appendLosingVersion(note, losing) {
    // The losing version's title/body join the note's version history so a
    // conflict never destroys data. `losing` is a decrypted note record.
    note.versions = Array.isArray(note.versions) ? note.versions : [];
    note.versions.push({
      title: String(losing.title ?? "").slice(0, 120),
      body: String(losing.body ?? "").slice(0, 100_000),
      updatedAt: typeof losing.updatedAt === "string" ? losing.updatedAt : new Date(0).toISOString()
    });
    while (note.versions.length > MAX_NOTE_VERSIONS) note.versions.shift();
  }

  // Apply one envelope to local state. Returns a structured result; never
  // throws for a losing/conflict/duplicate envelope — those are outcomes,
  // not failures. Only malformed envelopes and decryption failures throw.
  // `local` is {notes: [], trash: [], comments: [], spaces: []}; `seen` is
  // the caller's seen-log array (mutated in place via return value — see
  // applyEnvelopes).
  async function applyEnvelope(envelope, local, key, seen) {
    validateEnvelope(envelope);
    if (seenHas(seen, envelope.id)) {
      return { applied: false, outcome: "duplicate", noteId: envelope.noteId };
    }
    // Phase 3 (Item 8) — comment / space records. Decryption proves the
    // sender holds the sync key; records are validated and deduped by id.
    if (envelope.op === "comment" || envelope.op === "space") {
      const record = await decryptJsonPayload(key, envelope.payload).catch((error) => {
        throw new Error(`Sync ${envelope.op} record could not be decrypted: ${error.message}`);
      });
      if (!record || record.kind !== envelope.op || typeof record.id !== "string" || !record.id) {
        throw new TypeError(`Sync ${envelope.op} record is invalid.`);
      }
      if (envelope.op === "comment") {
        if (typeof record.noteId !== "string" || typeof record.body !== "string") {
          throw new TypeError("Sync comment record needs a note id and body.");
        }
        if (!Array.isArray(local.comments)) local.comments = [];
        if (local.comments.some((c) => c.id === record.id)) {
          return { applied: false, outcome: "duplicate", noteId: envelope.noteId };
        }
        local.comments.push({
          id: record.id,
          noteId: record.noteId,
          deviceId: typeof record.deviceId === "string" ? record.deviceId : "",
          author: typeof record.author === "string" ? record.author : "Someone",
          body: String(record.body).slice(0, 2000),
          createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString()
        });
        return { applied: true, outcome: "comment", noteId: envelope.noteId };
      }
      if (!Array.isArray(local.spaces)) local.spaces = [];
      const clean = {
        id: record.id,
        name: typeof record.name === "string" ? record.name.slice(0, 80) : "Untitled space",
        memberDeviceIds: Array.isArray(record.memberDeviceIds) ? record.memberDeviceIds.filter((d) => typeof d === "string").slice(0, 50) : [],
        noteIds: Array.isArray(record.noteIds) ? record.noteIds.filter((d) => typeof d === "string").slice(0, 500) : []
      };
      const existing = local.spaces.findIndex((s) => s.id === record.id);
      if (existing >= 0) local.spaces[existing] = clean;
      else local.spaces.push(clean);
      return { applied: true, outcome: "space", noteId: envelope.noteId };
    }
    const incomingVersion = { lamport: envelope.lamport, deviceId: envelope.deviceId };
    const localNote = local.notes.find((n) => n.id === envelope.noteId) ?? null;
    const trashedNote = local.trash.find((n) => n.id === envelope.noteId) ?? null;

    if (envelope.op === "tombstone") {
      // Decrypt the marker to prove the sender holds the sync key; a
      // tombstone that cannot be decrypted is rejected, not applied.
      // The marker is {id, deleted:true} — not a note — so it is
      // decrypted with the raw JSON path, not the note-shape check.
      const marker = await decryptJsonPayload(key, envelope.payload).catch((error) => {
        throw new Error(`Sync tombstone could not be decrypted: ${error.message}`);
      });
      if (!marker || marker.id !== envelope.noteId || marker.deleted !== true) {
        throw new TypeError("Sync tombstone marker is invalid.");
      }
      if (!localNote && !trashedNote) {
        return { applied: false, outcome: "already-gone", noteId: envelope.noteId };
      }
      const target = localNote ?? trashedNote;
      if (compareVersions(incomingVersion, noteSyncVersion(target)) <= 0) {
        return { applied: false, outcome: "ignored-newer", noteId: envelope.noteId };
      }
      local.notes = local.notes.filter((n) => n.id !== envelope.noteId);
      local.trash = local.trash.filter((n) => n.id !== envelope.noteId);
      return { applied: true, outcome: "tombstoned", noteId: envelope.noteId };
    }

    const incoming = await decryptNotePayload(key, envelope.payload);
    if (incoming.id !== envelope.noteId) {
      throw new TypeError("Sync envelope payload note id does not match the envelope.");
    }
    if (!localNote) {
      // New note from another device. A trashed copy with the same id loses
      // to the live incoming version only if the incoming version is newer.
      if (trashedNote && compareVersions(incomingVersion, noteSyncVersion(trashedNote)) <= 0) {
        return { applied: false, outcome: "ignored-newer", noteId: envelope.noteId };
      }
      local.trash = local.trash.filter((n) => n.id !== envelope.noteId);
      const restored = {
        ...incoming,
        metadata: incoming.metadata ?? {},
        versions: [],
        syncVersion: incomingVersion
      };
      local.notes.push(restored);
      return { applied: true, outcome: "inserted", noteId: envelope.noteId };
    }
    const localVersion = noteSyncVersion(localNote);
    const cmp = compareVersions(incomingVersion, localVersion);
    const sameContent = incoming.title === localNote.title && incoming.body === localNote.body;
    if (cmp > 0) {
      // Incoming wins. The local version joins the history first — but only
      // when it actually differs, so a routine re-push of identical content
      // does not pollute the history.
      if (!sameContent) {
        appendLosingVersion(localNote, {
          title: localNote.title, body: localNote.body, updatedAt: localNote.updatedAt
        });
      }
      Object.assign(localNote, {
        title: incoming.title,
        body: incoming.body,
        folderId: incoming.folderId ?? null,
        parentNoteId: incoming.parentNoteId ?? null,
        pinned: incoming.pinned === true,
        metadata: incoming.metadata ?? {},
        createdAt: incoming.createdAt ?? localNote.createdAt,
        updatedAt: incoming.updatedAt ?? localNote.updatedAt,
        syncVersion: incomingVersion
      });
      return { applied: true, outcome: "updated", noteId: envelope.noteId };
    }
    if (cmp < 0) {
      // Local wins. The incoming version is preserved in history — again
      // only when it actually differs from what is kept.
      if (!sameContent) appendLosingVersion(localNote, incoming);
      return { applied: false, outcome: "ignored-newer", noteId: envelope.noteId };
    }
    return { applied: false, outcome: "duplicate-version", noteId: envelope.noteId };
  }

  // Apply many envelopes in lamport order; returns {results, seen} where
  // `seen` is the updated seen-log (caller persists it).
  async function applyEnvelopes(envelopes, local, key, seen) {
    if (!Array.isArray(envelopes)) throw new TypeError("Sync envelopes must be an array.");
    let nextSeen = Array.isArray(seen) ? [...seen] : [];
    const results = [];
    const ordered = [...envelopes].sort((a, b) =>
      (a?.lamport ?? 0) - (b?.lamport ?? 0) ||
      String(a?.deviceId ?? "").localeCompare(String(b?.deviceId ?? "")));
    for (const envelope of ordered) {
      try {
        const result = await applyEnvelope(envelope, local, key, nextSeen);
        nextSeen = seenAdd(nextSeen, envelope.id);
        results.push(result);
      } catch (error) {
        results.push({ applied: false, outcome: "error", noteId: envelope?.noteId ?? null, error: String(error.message || error).slice(0, 300) });
      }
    }
    return { results, seen: nextSeen };
  }

  function exportBundle(envelopes, deviceId) {
    if (!Array.isArray(envelopes)) throw new TypeError("Sync bundle needs an envelope array.");
    return JSON.stringify({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      deviceId: deviceId ?? null,
      exportedAt: new Date().toISOString(),
      envelopes
    }, null, 2);
  }

  function importBundle(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text ?? ""));
    } catch {
      throw new TypeError("Sync bundle is not valid JSON.");
    }
    if (!parsed || parsed.format !== BUNDLE_FORMAT || parsed.version !== BUNDLE_VERSION ||
      !Array.isArray(parsed.envelopes)) {
      throw new TypeError("This file is not a supported xPin sync bundle.");
    }
    if (parsed.envelopes.length > 5000) throw new TypeError("Sync bundle has too many envelopes (5,000 max).");
    for (const envelope of parsed.envelopes) validateEnvelope(envelope);
    return parsed;
  }

  window.xPinSync = Object.freeze({
    ENVELOPE_VERSION,
    MAX_SEEN_ENVELOPES,
    KDF_ITERATIONS,
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    makeDeviceId,
    randomId,
    deriveSyncKey,
    keyCheckValue,
    newSalt,
    bytesToBase64,
    base64ToBytes,
    compareVersions,
    noteSyncVersion,
    sanitizeSyncVersion,
    makeEnvelope,
    makeRecordEnvelope,
    validateEnvelope,
    applyEnvelope,
    applyEnvelopes,
    seenHas,
    seenAdd,
    exportBundle,
    importBundle
  });
})();
