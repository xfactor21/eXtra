/* xPin connector credential store — Phase 1 (audit C4).
 *
 * Per-plugin secrets, encrypted with the workspace passphrase envelope
 * (same AES-256-GCM + PBKDF2-SHA-256/310k construction as the encrypted
 * backup). Rules:
 * - Secrets NEVER appear in the plaintext workspace blob: only the
 *   ciphertext envelope {salt, iv, ciphertext} is persisted, under
 *   state.connectorCredentials[pluginId][key].
 * - Secrets are NEVER logged and are NEVER returned to non-connector
 *   plugins (the host RPC rejects credentials:* for sandboxed plugins).
 * - The passphrase is never stored. The derived key lives in memory only,
 *   for this session, after unlock(passphrase). If no passphrase is set
 *   (no salt + key-check in state), credential storage is unavailable with
 *   an honest error — plaintext is never stored silently as a fallback.
 * - The store is session-scoped: lock() drops the key; a page reload
 *   requires the passphrase again (entered in Sync settings, which shares
 *   the same passphrase as sync).
 *
 * The module is state-light: it holds the session key; app.js owns the
 * persisted envelopes (state.connectorCredentials) and passes them in.
 */
(() => {
  "use strict";

  const KDF_ITERATIONS = 310_000;
  const KEY_CHECK_LABEL = "xpin-credential-key-check-v1";
  const MAX_SECRET_BYTES = 8_000;
  const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/;

  let sessionKey = null;

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  function requireSubtle() {
    if (!globalThis.crypto?.subtle) {
      throw new Error("This browser does not support Web Crypto. Open xPin from localhost or a secure origin.");
    }
    return globalThis.crypto.subtle;
  }

  async function deriveCredentialKey(passphrase, saltBytes) {
    if (typeof passphrase !== "string" || passphrase.length < 12) {
      throw new TypeError("Credential passphrase needs at least 12 characters.");
    }
    if (!(saltBytes instanceof Uint8Array) || saltBytes.length !== 16) {
      throw new TypeError("Credential key salt must be 16 bytes.");
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

  async function keyCheckValue(key) {
    const subtle = requireSubtle();
    const raw = new Uint8Array(await subtle.exportKey("raw", key));
    const labelled = new Uint8Array(raw.length + KEY_CHECK_LABEL.length);
    labelled.set(raw, 0);
    labelled.set(new TextEncoder().encode(KEY_CHECK_LABEL), raw.length);
    const digest = await subtle.digest("SHA-256", labelled);
    return bytesToBase64(new Uint8Array(digest));
  }

  // Unlock the session key from a passphrase + the persisted salt. Throws
  // (and stays locked) when the passphrase is wrong — the caller compares
  // the computed key-check against the stored one.
  async function unlock(passphrase, saltBase64, expectedKeyCheck) {
    if (typeof saltBase64 !== "string" || !saltBase64) {
      throw new Error("Credential storage is not set up yet — set a sync passphrase in Workspace tools first.");
    }
    const salt = base64ToBytes(saltBase64);
    const key = await deriveCredentialKey(passphrase, salt);
    const check = await keyCheckValue(key);
    if (typeof expectedKeyCheck === "string" && expectedKeyCheck && check !== expectedKeyCheck) {
      throw new Error("That passphrase does not match the one credential storage was set up with.");
    }
    sessionKey = key;
    return true;
  }

  function lock() {
    sessionKey = null;
  }

  function isUnlocked() {
    return sessionKey !== null;
  }

  function requireUnlocked() {
    if (!sessionKey) {
      throw new Error("Credential storage is locked — enter your passphrase in Sync settings to unlock it.");
    }
    return sessionKey;
  }

  function validateSecretKey(key) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new TypeError("Credential names start with a letter and use letters, digits, spaces, _ or - (max 80).");
    }
  }

  async function encryptSecret(plaintext) {
    const key = requireUnlocked();
    if (typeof plaintext !== "string") throw new TypeError("Credential values must be text.");
    const bytes = new TextEncoder().encode(plaintext);
    if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) {
      throw new TypeError("Credential values must be 1–8,000 bytes of text.");
    }
    const subtle = requireSubtle();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cipher = await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return {
      salt: null, // salt lives once per workspace in state.sync.credentialSalt
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(cipher))
    };
  }

  async function decryptSecret(envelope) {
    const key = requireUnlocked();
    if (!envelope || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
      throw new TypeError("Stored credential is malformed.");
    }
    const subtle = requireSubtle();
    const clear = await subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    return new TextDecoder().decode(clear);
  }

  // Sanitize persisted credential envelopes on load: opaque strings only,
  // no plaintext ever survives here by construction.
  function sanitizeCredentialStore(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const clean = {};
    for (const [pluginId, entries] of Object.entries(value)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId) || !entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      const kept = {};
      for (const [name, envelope] of Object.entries(entries)) {
        if (!KEY_PATTERN.test(name) || !envelope || typeof envelope !== "object") continue;
        if (typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") continue;
        if (envelope.iv.length > 64 || envelope.ciphertext.length > 12_000) continue;
        kept[name] = { iv: envelope.iv, ciphertext: envelope.ciphertext };
      }
      if (Object.keys(kept).length) clean[pluginId] = kept;
    }
    return clean;
  }

  window.xPinCredentials = Object.freeze({
    KDF_ITERATIONS,
    unlock,
    lock,
    isUnlocked,
    deriveCredentialKey,
    keyCheckValue,
    encryptSecret,
    decryptSecret,
    sanitizeCredentialStore,
    validateSecretKey
  });
})();
