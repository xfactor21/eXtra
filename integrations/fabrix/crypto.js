/* xPin fabriX adapter — crypto helpers.
 *
 * Ed25519 keypairs + canonical-JSON signing, mirroring the Cloud Bridge
 * protocol (cloudprotocol/types.go): signatures are Ed25519 over canonical
 * JSON (object keys sorted recursively), keys are base64url, key ids are the
 * first 8 bytes of SHA-256 hex.
 *
 * WebCrypto does not expose Ed25519 in every browser yet, so every function
 * here feature-detects. `supported()` reports WebCrypto presence only — it
 * does NOT prove Ed25519 availability; use the async `probeEd25519()` for
 * that (it actually generates a keypair). There is no silent fallback
 * algorithm: if Ed25519 is unavailable, pairing fails closed with
 * `crypto_unavailable` (spec §10). The local loopback transport does not
 * need signing (Bearer token); signing is only needed for the Cloud Bridge
 * pairing / presence / receipt flow, which is not live and not implemented
 * (spec §7.3 — deferred to the Cloud Bridge phase, with device identity and
 * credential-block encryption).
 */
(function () {
  "use strict";

  function subtle() {
    var cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    return cryptoObj && cryptoObj.subtle ? cryptoObj.subtle : null;
  }

  function supported() {
    return !!subtle();
  }

  // Actually proves Ed25519 availability by generating a keypair (cached).
  // supported() alone only proves WebCrypto exists.
  var ed25519Probe = null;
  async function probeEd25519() {
    if (ed25519Probe !== null) return ed25519Probe;
    var cryptoSubtle = subtle();
    if (!cryptoSubtle) {
      ed25519Probe = false;
      return false;
    }
    try {
      await cryptoSubtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      ed25519Probe = true;
    } catch (error) {
      ed25519Probe = false;
    }
    return ed25519Probe;
  }

  function cryptoUnavailableError() {
    var error = new Error("Ed25519 is not available in this browser (WebCrypto missing or Ed25519 unsupported).");
    error.code = "crypto_unavailable";
    return error;
  }

  // Canonical JSON: object keys sorted recursively; arrays keep order.
  // Matches Go's Marshal -> Unmarshal -> Marshal normalization for the
  // string/number/bool/null payloads this protocol carries. (Go normalizes
  // numbers through float64; our payloads only carry integers, so the
  // encodings agree.)
  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(canonical).join(",") + "]";
    }
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (value[key] === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonical(value[key]));
    }
    return "{" + parts.join(",") + "}";
  }

  function base64UrlEncode(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlDecode(value) {
    if (typeof value !== "string") throw new TypeError("Public key must be base64url text.");
    var normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    var binary = atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function textBytes(value) {
    return new TextEncoder().encode(value);
  }

  async function sha256Hex(bytes) {
    var digest = await subtle().digest("SHA-256", bytes);
    var view = new Uint8Array(digest);
    var hex = "";
    for (var i = 0; i < view.length; i++) {
      hex += view[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  async function publicKeyId(publicKeyBytes) {
    var hex = await sha256Hex(publicKeyBytes);
    return hex.slice(0, 16);
  }

  async function generateKeyPair() {
    var cryptoSubtle = subtle();
    if (!cryptoSubtle) throw cryptoUnavailableError();
    var pair;
    try {
      pair = await cryptoSubtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    } catch (error) {
      throw cryptoUnavailableError();
    }
    var publicRaw = new Uint8Array(await cryptoSubtle.exportKey("raw", pair.publicKey));
    var privatePkcs8 = new Uint8Array(await cryptoSubtle.exportKey("pkcs8", pair.privateKey));
    return {
      publicKey: base64UrlEncode(publicRaw),
      publicKeyBytes: publicRaw,
      // PKCS#8 is stored only in memory for the session; it is never
      // persisted in plaintext. No pairing flow exists yet to consume it
      // (spec §7.3 — deferred to the Cloud Bridge phase).
      privateKey: pair.privateKey,
      privateKeyPkcs8: base64UrlEncode(privatePkcs8)
    };
  }

  async function importPrivateKey(pkcs8Base64Url) {
    var cryptoSubtle = subtle();
    if (!cryptoSubtle) throw new Error("Ed25519 is not available in this browser (WebCrypto missing).");
    var bytes = base64UrlDecode(pkcs8Base64Url);
    return cryptoSubtle.importKey("pkcs8", bytes, { name: "Ed25519" }, true, ["sign"]);
  }

  async function importPublicKey(publicKeyBase64Url) {
    var cryptoSubtle = subtle();
    if (!cryptoSubtle) throw new Error("Ed25519 is not available in this browser (WebCrypto missing).");
    var bytes = base64UrlDecode(publicKeyBase64Url);
    if (bytes.length !== 32) throw new Error("Invalid Ed25519 public key.");
    return cryptoSubtle.importKey("raw", bytes, { name: "Ed25519" }, true, ["verify"]);
  }

  async function sign(privateKey, value) {
    var cryptoSubtle = subtle();
    if (!cryptoSubtle) throw new Error("Ed25519 is not available in this browser (WebCrypto missing).");
    var signature = await cryptoSubtle.sign({ name: "Ed25519" }, privateKey, textBytes(canonical(value)));
    return base64UrlEncode(new Uint8Array(signature));
  }

  async function verify(publicKey, value, signatureBase64Url) {
    var cryptoSubtle = subtle();
    if (!cryptoSubtle) return false;
    try {
      var signature = base64UrlDecode(signatureBase64Url);
      return await cryptoSubtle.verify({ name: "Ed25519" }, publicKey, signature, textBytes(canonical(value)));
    } catch (error) {
      return false;
    }
  }

  // Signs a copy of `value` with its `signature` field blanked, exactly as
  // the Go helpers do (signature field cleared before canonicalizing).
  async function signEnvelope(privateKey, envelope) {
    var copy = {};
    Object.keys(envelope).forEach(function (key) { copy[key] = envelope[key]; });
    copy.signature = "";
    var signature = await sign(privateKey, copy);
    copy.signature = signature;
    return copy;
  }

  async function verifyEnvelope(publicKey, envelope) {
    if (!envelope || typeof envelope.signature !== "string" || !envelope.signature) return false;
    var copy = {};
    Object.keys(envelope).forEach(function (key) { copy[key] = envelope[key]; });
    var signature = copy.signature;
    copy.signature = "";
    return verify(publicKey, copy, signature);
  }

  window.xPinFabrixCrypto = Object.freeze({
    supported: supported,
    probeEd25519: probeEd25519,
    canonical: canonical,
    base64UrlEncode: base64UrlEncode,
    base64UrlDecode: base64UrlDecode,
    publicKeyId: publicKeyId,
    generateKeyPair: generateKeyPair,
    importPrivateKey: importPrivateKey,
    importPublicKey: importPublicKey,
    sign: sign,
    verify: verify,
    signEnvelope: signEnvelope,
    verifyEnvelope: verifyEnvelope
  });
})();
