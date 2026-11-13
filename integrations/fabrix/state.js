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
  var MAX_IDEMPOTENCY_RESULT_BYTES = 4096;
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

  function defaultGrant() {
    return { granted: false, grantedAt: "", grantedBy: "", reason: "", scope: { folderIds: [] } };
  }

  function defaultState() {
    return {
      enabled: false,
      transport: "local", // "local" | "cloud" | "mock"
      local: { port: "", token: "" },
      cloud: { url: "", deviceId: "", deviceToken: "", pairedAt: "" },
      // Grants are per group (read/write separately authorized, spec §6).
      // Each group records who granted it, when, why, and its folder scope.
      grants: { read: defaultGrant(), write: defaultGrant() },
      receipts: [],
      idempotency: {},
      artifacts: []
    };
  }

  // Redacts a handler result for the idempotency log: note bodies (and any
  // nested `body` key), search snippets, and export file contents are
  // stripped; long strings are truncated; and the whole value is capped at
  // MAX_IDEMPOTENCY_RESULT_BYTES. A replay returns this redacted summary —
  // never a stored note body (spec §6: receipts and the idempotency log
  // never contain note bodies or credentials). It also bounds the persisted
  // workspace blob (the ~5 MB localStorage ceiling). Redacting only `body`
  // is not enough: export results carry the full body under `files[].content`
  // and search results under `notes[].snippet` — both are body text too.
  function redactResult(value) {
    var cleaned;
    try {
      cleaned = JSON.parse(JSON.stringify(value));
    } catch (error) {
      return { redacted: true };
    }
    function strip(node) {
      if (node !== null && typeof node === "object") {
        if (Array.isArray(node)) {
          node.forEach(strip);
          return;
        }
        Object.keys(node).forEach(function (key) {
          if (key === "body" || key === "snippet" || key === "content") {
            node[key] = "[redacted]";
          } else if (typeof node[key] === "string" && node[key].length > 256) {
            node[key] = node[key].slice(0, 256) + "…";
          } else {
            strip(node[key]);
          }
        });
      }
    }
    strip(cleaned);
    var json = "";
    try { json = JSON.stringify(cleaned); } catch (error) { json = ""; }
    if (json.length > MAX_IDEMPOTENCY_RESULT_BYTES) {
      var keys = cleaned !== null && typeof cleaned === "object" ? Object.keys(cleaned) : [];
      return { redacted: true, keys: keys };
    }
    return cleaned;
  }

  function sanitizeGrant(value) {
    var next = defaultGrant();
    // Migration: the Phase 2 shape stored plain booleans
    // (grants: {read: bool, write: bool}). A boolean true becomes a granted
    // record with no provenance; false stays ungranted.
    if (typeof value === "boolean") {
      next.granted = value;
      return next;
    }
    if (!isPlainObject(value)) return next;
    next.granted = cleanBool(value.granted);
    next.grantedAt = cleanString(value.grantedAt, 40);
    next.grantedBy = cleanString(value.grantedBy, 40);
    next.reason = cleanString(value.reason, 300);
    if (isPlainObject(value.scope) && Array.isArray(value.scope.folderIds)) {
      next.scope.folderIds = value.scope.folderIds
        .filter(function (id) { return typeof id === "string" && id.length > 0; })
        .slice(0, 50)
        .map(function (id) { return id.slice(0, 120); });
    }
    return next;
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
      action: cleanString(value.action, 40) || "invoke",
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
      // Artifact HTML is NOT persisted: it is regenerable from the note on
      // demand (noteToHtml), and storing up to 500 KB × 50 artifacts would
      // risk the ~5 MB localStorage ceiling. Old entries have their html
      // stripped to "" on load.
      html: ""
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
      // Migration: the Phase 2 shape was flat
      // ({read, write, grantedAt, scope}). A flat grantedAt/scope carries
      // onto both groups when the group itself has no provenance yet.
      var flatGrantedAt = cleanString(value.grants.grantedAt, 40);
      var flatScope = isPlainObject(value.grants.scope) && Array.isArray(value.grants.scope.folderIds)
        ? value.grants.scope.folderIds
          .filter(function (id) { return typeof id === "string" && id.length > 0; })
          .slice(0, 50)
          .map(function (id) { return id.slice(0, 120); })
        : [];
      ["read", "write"].forEach(function (group) {
        var grant = sanitizeGrant(value.grants[group]);
        if (!grant.grantedAt && flatGrantedAt && grant.granted) grant.grantedAt = flatGrantedAt;
        if (grant.scope.folderIds.length === 0 && flatScope.length > 0) grant.scope.folderIds = flatScope.slice();
        next.grants[group] = grant;
      });
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
            result: redactResult(entry.result),
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
    redactResult: redactResult,
    limits: Object.freeze({
      maxReceipts: MAX_RECEIPTS,
      maxIdempotencyEntries: MAX_IDEMPOTENCY_ENTRIES,
      maxIdempotencyResultBytes: MAX_IDEMPOTENCY_RESULT_BYTES,
      maxArtifacts: MAX_ARTIFACTS
    })
  });
})();
