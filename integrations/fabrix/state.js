/* xPin fabriX adapter — state shape + sanitizer.
 *
 * The adapter's persisted state lives at `state.integrations.fabrix` in the
 * xPin workspace (see app.js loadWorkspace/initialWorkspace). The workspace
 * loader drops any top-level key it does not know about, so this module owns
 * the shape and the sanitizer: app.js calls `sanitize()` on load and
 * `defaultState()` for a fresh workspace.
 *
 * Nothing here touches the network. Nothing here runs unless the adapter is
 * enabled (see adapter.js). No credentials are ever placed in a capability
 * request input (see domain.js hasCredentialField).
 */
(function () {
  "use strict";

  var MAX_RECEIPTS = 200;
  var MAX_IDEMPOTENCY_ENTRIES = 100;
  var MAX_ARTIFACTS = 50;
  var MAX_STRING = 500;

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function cleanString(value, max) {
    if (typeof value !== "string") return "";
    return value.slice(0, max == null ? MAX_STRING : max);
  }

  function cleanBool(value) {
    return value === true;
  }

  function defaultState() {
    return {
      enabled: false,
      transport: "local", // "local" | "cloud" | "mock"
      local: { port: "", token: "" },
      cloud: { url: "", deviceId: "", deviceToken: "", pairedAt: "" },
      grants: { read: false, write: false, grantedAt: "", scope: { folderIds: [] } },
      receipts: [],
      idempotency: {},
      artifacts: []
    };
  }

  function sanitizeReceipt(value) {
    if (!isPlainObject(value)) return null;
    var receiptId = cleanString(value.receiptId, 80);
    var requestId = cleanString(value.requestId, 80);
    var capability = cleanString(value.capability, 80);
    if (!receiptId || !requestId || !capability) return null;
    var status = value.status === "ok" || value.status === "denied" || value.status === "error"
      ? value.status
      : "error";
    return {
      receiptId: receiptId,
      requestId: requestId,
      capability: capability,
      status: status,
      startedAt: cleanString(value.startedAt, 40),
      completedAt: cleanString(value.completedAt, 40),
      error: cleanString(value.error, 300)
    };
  }

  function sanitizeArtifact(value) {
    if (!isPlainObject(value)) return null;
    var id = cleanString(value.id, 120);
    var noteId = cleanString(value.noteId, 120);
    if (!id || !noteId) return null;
    return {
      id: id,
      noteId: noteId,
      title: cleanString(value.title, 120),
      format: value.format === "html" ? "html" : "markdown",
      publishedAt: cleanString(value.publishedAt, 40),
      // The HTML body is stored only for local artifacts; it is never sent
      // to the Bridge unless a publish target is configured (none today).
      html: typeof value.html === "string" ? value.html.slice(0, 500000) : ""
    };
  }

  function sanitize(value) {
    var next = defaultState();
    if (!isPlainObject(value)) return next;
    next.enabled = cleanBool(value.enabled);
    if (value.transport === "local" || value.transport === "cloud" || value.transport === "mock") {
      next.transport = value.transport;
    }
    if (isPlainObject(value.local)) {
      next.local.port = cleanString(value.local.port, 10);
      next.local.token = cleanString(value.local.token, 500);
    }
    if (isPlainObject(value.cloud)) {
      next.cloud.url = cleanString(value.cloud.url, 500);
      next.cloud.deviceId = cleanString(value.cloud.deviceId, 120);
      next.cloud.deviceToken = cleanString(value.cloud.deviceToken, 500);
      next.cloud.pairedAt = cleanString(value.cloud.pairedAt, 40);
    }
    if (isPlainObject(value.grants)) {
      next.grants.read = cleanBool(value.grants.read);
      next.grants.write = cleanBool(value.grants.write);
      next.grants.grantedAt = cleanString(value.grants.grantedAt, 40);
      if (isPlainObject(value.grants.scope) && Array.isArray(value.grants.scope.folderIds)) {
        next.grants.scope.folderIds = value.grants.scope.folderIds
          .filter(function (id) { return typeof id === "string" && id.length > 0; })
          .slice(0, 50)
          .map(function (id) { return id.slice(0, 120); });
      }
    }
    if (Array.isArray(value.receipts)) {
      next.receipts = value.receipts
        .map(sanitizeReceipt)
        .filter(function (receipt) { return receipt !== null; })
        .slice(-MAX_RECEIPTS);
    }
    if (isPlainObject(value.idempotency)) {
      var keys = Object.keys(value.idempotency).slice(-MAX_IDEMPOTENCY_ENTRIES);
      keys.forEach(function (key) {
        var entry = value.idempotency[key];
        if (isPlainObject(entry) && typeof entry.result !== "undefined") {
          next.idempotency[key.slice(0, 80)] = {
            result: entry.result,
            at: cleanString(entry.at, 40)
          };
        }
      });
    }
    if (Array.isArray(value.artifacts)) {
      next.artifacts = value.artifacts
        .map(sanitizeArtifact)
        .filter(function (artifact) { return artifact !== null; })
        .slice(-MAX_ARTIFACTS);
    }
    return next;
  }

  window.xPinFabrixState = Object.freeze({
    defaultState: defaultState,
    sanitize: sanitize,
    limits: Object.freeze({
      maxReceipts: MAX_RECEIPTS,
      maxIdempotencyEntries: MAX_IDEMPOTENCY_ENTRIES,
      maxArtifacts: MAX_ARTIFACTS
    })
  });
})();
