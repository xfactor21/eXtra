/* xPin fabriX adapter — orchestrator.
 *
 * `window.xPinFabrix` is the single entry point. Lifecycle:
 *
 *   1. app.js boots and calls `attachDomain(domain, savedState)` with the
 *      FabrixDomain object and the persisted `state.integrations.fabrix`.
 *   2. Nothing happens until the user enables the integration in Settings
 *      (flag defaults to OFF) and grants read and/or write.
 *   3. `connect()` opens the configured transport (local loopback, mock, or
 *      the Cloud Bridge stub). `invoke()` executes one capability call
 *      locally through capabilities.js and records a receipt.
 *   4. Bridge-routed requests are handled by `pollOnce()`: the adapter asks
 *      the transport for pending requests, executes each locally, and posts
 *      a receipt. Polling only runs while the user has explicitly started
 *      it (`startPolling()`); `connect()` alone never starts background work.
 *
 * The adapter never touches xPin's `state` directly. All persistence goes
 * through `domain.persistFabrixState(next)` (app.js writes
 * `state.integrations.fabrix` and calls `persistWorkspace()`).
 */
(function () {
  "use strict";

  var P = window.xPinFabrixPermissions;
  var T = window.xPinFabrixTransport;

  var POLL_INTERVAL_MS = 10000; // matches the Cloud Bridge long-poll window

  var domain = null;
  var fabrixState = null;
  var transport = null;
  var transportKind = null;
  var lastBridgeStatus = null;
  var pollTimer = null;
  var manifestCache = null;

  function FabrixError(code, message) {
    var error = new Error(message);
    error.name = "FabrixError";
    error.code = code;
    return error;
  }

  function requireAttached() {
    if (!domain || !fabrixState) {
      throw FabrixError("internal_error", "The fabriX adapter is not attached to xPin yet.");
    }
  }

  function persist() {
    if (domain && fabrixState) {
      // persistFabrixState returns the merged state (app-side artifact
      // pushes included); adopt it so the adapter's copy stays in sync.
      // Only adopt a well-shaped state — never the {enabled:false}
      // fallback used when the state module failed to load.
      var merged = domain.persistFabrixState(fabrixState);
      if (merged && typeof merged === "object" && merged.grants && typeof merged.enabled === "boolean") {
        fabrixState = merged;
      }
    }
  }

  function recordReceipt(requestId, capability, action, status, errorMessage) {
    if (!fabrixState) return null;
    var now = new Date().toISOString();
    var receipt = {
      receiptId: "receipt_" + T.randomToken(8),
      requestId: requestId,
      capability: capability,
      action: action || "invoke",
      status: status,
      startedAt: now,
      completedAt: now,
      error: errorMessage ? String(errorMessage).slice(0, 300) : ""
    };
    fabrixState.receipts = (fabrixState.receipts || []).concat([receipt]);
    if (fabrixState.receipts.length > window.xPinFabrixState.limits.maxReceipts) {
      fabrixState.receipts = fabrixState.receipts.slice(-window.xPinFabrixState.limits.maxReceipts);
    }
    return receipt;
  }

  function checkIdempotency(requestId) {
    if (!fabrixState || !fabrixState.idempotency) return null;
    var entry = fabrixState.idempotency[requestId];
    return entry ? entry.result : null;
  }

  function storeIdempotency(requestId, result) {
    if (!fabrixState) return;
    // The log stores a redacted summary only (state.js redactResult): no
    // note bodies, ≤ 4 KB per entry. A replay returns that summary.
    fabrixState.idempotency[requestId] = {
      result: window.xPinFabrixState.redactResult(result),
      at: new Date().toISOString()
    };
    var keys = Object.keys(fabrixState.idempotency);
    var max = window.xPinFabrixState.limits.maxIdempotencyEntries;
    if (keys.length > max) {
      keys.slice(0, keys.length - max).forEach(function (key) { delete fabrixState.idempotency[key]; });
    }
  }

  function attachDomain(injectedDomain, savedState) {
    if (!injectedDomain) throw new Error("attachDomain requires a FabrixDomain object.");
    domain = injectedDomain;
    fabrixState = window.xPinFabrixState.sanitize(savedState);
  }

  function getState() {
    requireAttached();
    return JSON.parse(JSON.stringify(fabrixState));
  }

  function getStatus() {
    requireAttached();
    return {
      attached: true,
      enabled: fabrixState.enabled === true,
      connected: !!(transport && transport.isConnected()),
      transport: fabrixState.transport,
      grants: {
        read: !!(fabrixState.grants.read && fabrixState.grants.read.granted),
        write: !!(fabrixState.grants.write && fabrixState.grants.write.granted)
      },
      scopes: {
        read: (fabrixState.grants.read && fabrixState.grants.read.scope && fabrixState.grants.read.scope.folderIds) || [],
        write: (fabrixState.grants.write && fabrixState.grants.write.scope && fabrixState.grants.write.scope.folderIds) || []
      },
      receipts: fabrixState.receipts.length,
      polling: pollTimer !== null,
      bridge: lastBridgeStatus,
      crypto: window.xPinFabrixCrypto.supported()
    };
  }

  function setEnabled(enabled) {
    requireAttached();
    fabrixState.enabled = enabled === true;
    if (!fabrixState.enabled) {
      stopPolling();
      if (transport) {
        var old = transport;
        transport = null;
        transportKind = null;
        old.disconnect();
      }
      lastBridgeStatus = null;
    }
    persist();
    return getStatus();
  }

  function grant(group, options) {
    requireAttached();
    fabrixState = P.grant(fabrixState, group, options || {});
    persist();
    return getStatus();
  }

  function setScope(group, folderIds) {
    requireAttached();
    fabrixState = P.setScope(fabrixState, group, folderIds);
    persist();
    return getStatus();
  }

  function setReason(group, reason) {
    requireAttached();
    fabrixState = P.setReason(fabrixState, group, reason);
    persist();
    return getStatus();
  }

  function getFolders() {
    requireAttached();
    return domain.listFolders ? domain.listFolders() : [];
  }

  // Diagnostics / test hook: the live transport instance (or null). Used by
  // the smoke suite to enqueue mock Bridge requests for pollOnce().
  function getTransport() {
    return transport;
  }

  function revoke(group) {
    requireAttached();
    fabrixState = P.revoke(fabrixState, group);
    persist();
    return getStatus();
  }

  function setTransport(kind, config) {
    requireAttached();
    if (kind !== "local" && kind !== "cloud" && kind !== "mock") {
      throw FabrixError("validation_error", "Unknown transport: " + String(kind));
    }
    stopPolling();
    if (transport) {
      var old = transport;
      transport = null;
      transportKind = null;
      old.disconnect();
    }
    lastBridgeStatus = null;
    fabrixState.transport = kind;
    if (config && typeof config === "object") {
      if (kind === "local") {
        if (config.port !== undefined) fabrixState.local.port = String(config.port).slice(0, 10);
        if (config.token !== undefined) fabrixState.local.token = String(config.token).slice(0, 500);
      }
      if (kind === "cloud") {
        if (config.url !== undefined) fabrixState.cloud.url = String(config.url).slice(0, 500);
      }
    }
    fabrixState = window.xPinFabrixState.sanitize(fabrixState);
    persist();
    return getStatus();
  }

  function transportConfig() {
    if (fabrixState.transport === "local") return { port: fabrixState.local.port, token: fabrixState.local.token };
    if (fabrixState.transport === "cloud") return { url: fabrixState.cloud.url };
    return {};
  }

  function connect() {
    requireAttached();
    if (fabrixState.enabled !== true) {
      return Promise.reject(FabrixError("permission_denied", "The fabriX integration is disabled. Enable it in Settings first."));
    }
    if (transport && transport.isConnected()) return Promise.resolve(lastBridgeStatus);
    var kind = fabrixState.transport;
    try {
      transport = T.createTransport(kind, transportConfig());
    } catch (error) {
      return Promise.reject(error);
    }
    transportKind = kind;
    return transport.connect().then(function (status) {
      lastBridgeStatus = status;
      return status;
    }).catch(function (error) {
      transport = null;
      transportKind = null;
      throw error;
    });
  }

  function disconnect() {
    stopPolling();
    if (!transport) return Promise.resolve();
    var old = transport;
    transport = null;
    transportKind = null;
    lastBridgeStatus = null;
    return old.disconnect();
  }

  function invoke(capability, inputs, options) {
    requireAttached();
    var opts = options || {};
    var requestId = typeof opts.requestId === "string" && opts.requestId
      ? opts.requestId
      : T.newRequestId();
    var idempotencyKey = typeof opts.idempotencyKey === "string" && opts.idempotencyKey
      ? opts.idempotencyKey
      : requestId;
    var startedAt = new Date().toISOString();

    // Validate BEFORE the replay check: a stored result must never be
    // served to a caller who no longer holds the grant, after the
    // integration was disabled, or with credential-shaped inputs. The
    // checks are re-run inside execute() as well; these are the gate.
    if (fabrixState.enabled !== true) {
      var disabledError = FabrixError("permission_denied", "The fabriX integration is disabled.");
      recordReceipt(requestId, capability, "invoke", "denied", disabledError.message);
      persist();
      return Promise.reject(disabledError);
    }
    try {
      P.requireGrant(fabrixState, capability);
      window.xPinFabrixDomain.requireNoCredentialField(inputs || {});
    } catch (error) {
      var code = (error && error.code) || "internal_error";
      var message = error && error.message ? error.message : "Unknown error.";
      recordReceipt(requestId, capability, "invoke", code === "permission_denied" ? "denied" : "error", message);
      persist();
      return Promise.reject(error);
    }

    var replayed = checkIdempotency(idempotencyKey);
    if (replayed !== null) {
      // A replay is still a served call: record a receipt for it.
      var replayReceipt = recordReceipt(requestId, capability, "invoke", "ok", "");
      replayReceipt.startedAt = startedAt;
      persist();
      return Promise.resolve({ requestId: requestId, status: "ok", result: replayed, replayed: true });
    }

    var result;
    try {
      result = window.xPinFabrixCapabilities.execute(domain, fabrixState, capability, inputs || {}, { requestId: requestId });
    } catch (error) {
      var execCode = (error && error.code) || "internal_error";
      var execMessage = error && error.message ? error.message : "Unknown error.";
      recordReceipt(requestId, capability, "invoke", execCode === "permission_denied" ? "denied" : "error", execMessage);
      persist();
      return Promise.reject(error);
    }
    storeIdempotency(idempotencyKey, result);
    var receipt = recordReceipt(requestId, capability, "invoke", "ok", "");
    receipt.startedAt = startedAt;
    persist();
    return Promise.resolve({ requestId: requestId, status: "ok", result: result });
  }

  // One poll cycle: ask the transport for pending Bridge requests, execute
  // each locally, and post a receipt. Returns a summary; never throws for
  // per-request failures (each failure gets its own error receipt).
  function pollOnce() {
    requireAttached();
    if (!transport || !transport.isConnected()) {
      return Promise.reject(FabrixError("transport_unavailable", "Not connected to a Bridge. Connect first."));
    }
    return transport.pollRequests().then(function (poll) {
      var pending = (poll && Array.isArray(poll.requests)) ? poll.requests : [];
      var outcomes = [];
      var chain = Promise.resolve();
      pending.forEach(function (request) {
        chain = chain.then(function () {
          // Malformed Bridge requests are skipped, never executed: a
          // request without an id or a capability cannot be receipted
          // without an undefined request_id.
          if (!request || typeof request.requestId !== "string" || !request.requestId ||
              typeof request.capability !== "string" || !request.capability) {
            outcomes.push({ requestId: null, status: "skipped", error: "Malformed Bridge request (missing requestId or capability)." });
            return null;
          }
          return invoke(request.capability, request.inputs || {}, {
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey
          }).then(function (response) {
            outcomes.push({ requestId: request.requestId, status: "ok" });
            return postReceiptFor(request, "ok", "");
          }).catch(function (error) {
            outcomes.push({ requestId: request.requestId, status: "error", error: error && error.message });
            return postReceiptFor(request, "error", error && error.message ? error.message : "Unknown error.");
          });
        });
      });
      return chain.then(function () {
        return { routing: poll.routing || "advertised", handled: outcomes.length, outcomes: outcomes };
      });
    });
  }

  // Bridge receipts carry NO result and NO note bodies (spec §6). Only the
  // outcome is reported: request, capability, action, status, error.
  function postReceiptFor(request, status, errorMessage) {
    if (!transport || typeof transport.postReceipt !== "function") return Promise.resolve(null);
    var receipt = {
      receipt_id: "receipt_" + T.randomToken(8),
      request_id: request.requestId,
      account_id: "",
      device_id: fabrixState.cloud.deviceId || "xpin",
      capability: request.capability,
      action: "invoke",
      status: status,
      error: errorMessage || undefined,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      nonce: T.randomToken(12),
      device_key_id: ""
    };
    return transport.postReceipt(receipt).catch(function () { return null; });
  }

  function startPolling() {
    requireAttached();
    if (pollTimer !== null) return getStatus();
    if (!transport || !transport.isConnected()) {
      throw FabrixError("transport_unavailable", "Connect to a Bridge before starting polling.");
    }
    pollTimer = setInterval(function () {
      pollOnce().catch(function () { /* per-cycle errors are receipts, not crashes */ });
    }, POLL_INTERVAL_MS);
    return getStatus();
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return pollTimer === null;
  }

  function getManifest() {
    if (manifestCache) return Promise.resolve(manifestCache);
    return fetch("integrations/fabrix/manifest.json")
      .then(function (response) {
        if (!response.ok) throw new Error("Manifest fetch failed: HTTP " + response.status);
        return response.json();
      })
      .then(function (manifest) {
        manifestCache = manifest;
        return manifest;
      })
      .catch(function () {
        // Offline/file:// fallback: the embedded copy. manifest.json is the
        // source of truth; the Phase 3 tests assert the two match.
        manifestCache = embeddedManifest();
        return manifestCache;
      });
  }

  function embeddedManifest() {
    // Descriptions match manifest.json exactly (the file is the source of
    // truth; the Phase 3 tests assert the two match).
    var descriptions = {
      "notes.search": "Search notes by text, tag, folder. Returns snippets only.",
      "notes.read": "Read one note by stable id, with tags, links, and provenance.",
      "notes.create": "Create a note (title, body, folder, parent, tags).",
      "notes.update": "Update title/body/folder/tags of one note. Supports expectedUpdatedAt conflict checks.",
      "notes.export": "Export one or more notes as Markdown or rendered HTML.",
      "projects.list": "List xPin databases (projects) — metadata only, no row values.",
      "artifacts.publish": "Publish a note as a static page artifact (local record; no upload target configured)."
    };
    return {
      id: "xpin",
      name: "xPin",
      schemaVersion: "1.0",
      version: "1.0.0",
      type: "web",
      category: "notes",
      description: "xPin — local-first notes. Integration adapter (disabled by default).",
      mcp: { enabled: false, exposure: "disabled" },
      licensing: { authority: "product", required: false },
      fabrix: {
        adapterVersion: "1.0.0",
        protocolVersion: "1.0",
        capabilities: window.xPinFabrixCapabilities.capabilityNames.map(function (name) {
          return { name: name, risk: P.groupOf(name), description: descriptions[name] || "" };
        })
      }
    };
  }

  function register() {
    requireAttached();
    if (!transport || !transport.isConnected()) {
      return Promise.reject(FabrixError("transport_unavailable", "Connect to a Bridge before registering."));
    }
    return getManifest().then(function (manifest) {
      return transport.register(manifest);
    });
  }

  function exportReceipts() {
    requireAttached();
    return JSON.stringify({ exportedAt: new Date().toISOString(), receipts: fabrixState.receipts }, null, 2);
  }

  window.xPinFabrix = Object.freeze({
    attachDomain: attachDomain,
    getState: getState,
    getStatus: getStatus,
    setEnabled: setEnabled,
    grant: grant,
    setScope: setScope,
    setReason: setReason,
    getFolders: getFolders,
    getTransport: getTransport,
    revoke: revoke,
    setTransport: setTransport,
    connect: connect,
    disconnect: disconnect,
    invoke: invoke,
    pollOnce: pollOnce,
    startPolling: startPolling,
    stopPolling: stopPolling,
    getManifest: getManifest,
    register: register,
    exportReceipts: exportReceipts,
    renderSettingsSection: function (documentRef) {
      return window.xPinFabrixSettings.renderSettingsSection(documentRef || document);
    }
  });
})();
