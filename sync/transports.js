/* xPin sync transports — Phase 1.
 *
 * One interface, two transports:
 *  - BundleTransport: export/import of encrypted sync bundles as files.
 *    Works today with no server (export bundle → hand to another device →
 *    import → merge). The host (app.js) owns the actual file download/
 *    picker; this transport only builds/parses the bundle text.
 *  - HttpRelayTransport: POST/GET against a relay URL from settings.
 *    Default: NO URL configured → the transport reports "not configured"
 *    and sync stays off. A connection is never attempted without an
 *    explicit URL. The production relay target is Neon + Vercel (see
 *    server/sync-relay/README.md — reference implementation, not
 *    deployed); server/sync-relay/local-relay/ is the dev-only harness
 *    for verifying sync locally with no server to deploy.
 *
 * Both transports move envelopes only — opaque encrypted bytes. They never
 * see note plaintext and never see the sync passphrase.
 */
(() => {
  "use strict";

  function notConfiguredError() {
    const error = new Error("No sync relay configured — bundles are the sync path today.");
    error.code = "not_configured";
    return error;
  }

  const BundleTransport = {
    name: "bundle",
    // Returns bundle text for the caller to download as a file.
    exportBundle(envelopes, deviceId) {
      return window.xPinSync.exportBundle(envelopes, deviceId);
    },
    // Parses bundle text (from a file the user picked) into envelopes.
    importBundle(text) {
      return window.xPinSync.importBundle(text).envelopes;
    }
  };

  function createHttpRelayTransport(relayUrl) {
    const url = typeof relayUrl === "string" ? relayUrl.trim().replace(/\/+$/, "") : "";
    return {
      name: "http-relay",
      url: url || null,
      get configured() { return Boolean(url); },
      async push(envelopes) {
        if (!url) throw notConfiguredError();
        if (!Array.isArray(envelopes)) throw new TypeError("Relay push needs an envelope array.");
        let response;
        try {
          response = await fetch(`${url}/v1/sync/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ envelopes })
          });
        } catch (error) {
          const err = new Error(`Sync relay is unreachable: ${error.message}`);
          err.code = "transport_unavailable";
          throw err;
        }
        if (!response.ok) {
          const err = new Error(`Sync relay push failed (HTTP ${response.status}).`);
          err.code = "transport_unavailable";
          throw err;
        }
        let body;
        try {
          body = await response.json();
        } catch {
          const err = new Error("Sync relay returned an unreadable response.");
          err.code = "transport_unavailable";
          throw err;
        }
        if (!body || body.ok !== true) {
          const err = new Error("Sync relay rejected the push.");
          err.code = "transport_unavailable";
          throw err;
        }
        return body;
      },
      async pull(since) {
        if (!url) throw notConfiguredError();
        const sinceValue = Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0;
        let response;
        try {
          response = await fetch(`${url}/v1/sync/pull?since=${sinceValue}`, {
            method: "GET",
            headers: { Accept: "application/json" }
          });
        } catch (error) {
          const err = new Error(`Sync relay is unreachable: ${error.message}`);
          err.code = "transport_unavailable";
          throw err;
        }
        if (!response.ok) {
          const err = new Error(`Sync relay pull failed (HTTP ${response.status}).`);
          err.code = "transport_unavailable";
          throw err;
        }
        let body;
        try {
          body = await response.json();
        } catch {
          const err = new Error("Sync relay returned an unreadable response.");
          err.code = "transport_unavailable";
          throw err;
        }
        if (!body || !Array.isArray(body.envelopes)) {
          const err = new Error("Sync relay returned an invalid pull response.");
          err.code = "transport_unavailable";
          throw err;
        }
        return body.envelopes;
      }
    };
  }

  window.xPinSyncTransports = Object.freeze({
    BundleTransport,
    createHttpRelayTransport,
    notConfiguredError
  });
})();
