/* xPin fabriX adapter — mock Bridge transport.
 *
 * An in-memory implementation of the Local Bridge contract (spec §1.2) used
 * for tests and for offline demos in the settings panel. It is NOT a live
 * Bridge: every response is labeled mock, and it never touches the network.
 *
 * Implements the same interface as the transports in transport.js:
 * connect / disconnect / status / section / register / pollRequests /
 * postReceipt / invoke. The request queue models the Cloud Bridge long-poll
 * pattern (enqueue -> poll -> execute locally -> receipt) so the adapter's
 * full loop can be exercised without a Windows machine.
 */
(function () {
  "use strict";

  function FabrixError(code, message) {
    var error = new Error(message);
    error.name = "FabrixError";
    error.code = code;
    return error;
  }

  function createMockBridge(config) {
    var buildId = (config && config.buildId) || "mock-rc19.8";
    var connected = false;
    var registered = {};
    var requests = [];
    var receipts = [];
    var products = [
      { product_id: "xpin", name: "xPin", provides: ["notes.search", "notes.read", "notes.create", "notes.update", "notes.export", "projects.list", "artifacts.publish"], accepts: [] }
    ];

    var contract = {
      mock: true,
      schemaVersion: "1.0",
      protocolVersion: "1.0",
      manifest_schema: "fabrix.manifest/1",
      capability_routes: { requests: true, receipts: true, invoke: true },
      sections: ["products", "projects", "artifacts", "capabilities", "workflows", "licenses", "mcp", "cloud"],
      note: "Mock contract for tests and offline demos. Not a live Bridge."
    };

    function statusDoc() {
      return {
        ok: true,
        mock: true,
        build_id: buildId,
        engine_version: "mock-1.0",
        protocol_1_2: "1.0",
        manifest_schema: "fabrix.manifest/1",
        mcp_bootstrap: "disabled",
        adapter_protocol: "1.0",
        adapter_sessions: connected ? 1 : 0,
        project_records: 0,
        artifact_records: 0,
        consumption_receipts: receipts.length,
        device_id: "mock-device",
        cloud_bridge_protocol: "1.0",
        cloud_configured: false,
        cloud_enabled: false,
        products: Object.keys(registered).length + 1,
        capability_routes: 7
      };
    }

    return {
      name: "mock",
      isConnected: function () { return connected; },
      getContract: function () { return contract; },

      connect: function () {
        connected = true;
        return Promise.resolve(statusDoc());
      },

      disconnect: function () {
        connected = false;
        return Promise.resolve();
      },

      status: function () {
        return Promise.resolve(statusDoc());
      },

      section: function (name) {
        var sections = {
          library: { products: products },
          projects: { projects: [] },
          assets: { artifacts: [] },
          artifacts: { artifacts: [] },
          connections: { capabilities: products[0].provides },
          workflows: { workflows: [] },
          licenses: { licenses: [] },
          mcp: { projection: { enabled: false } },
          cloud: { status: { configured: false, enabled: false } }
        };
        if (!Object.prototype.hasOwnProperty.call(sections, name)) {
          return Promise.reject(FabrixError("validation_error", "Unknown Bridge section: " + String(name)));
        }
        return Promise.resolve(sections[name]);
      },

      register: function (manifest) {
        if (!manifest || typeof manifest.id !== "string" || !manifest.id) {
          return Promise.reject(FabrixError("validation_error", "Registration requires a manifest with an id."));
        }
        registered[manifest.id] = manifest;
        return Promise.resolve({ ok: true, mock: true, registered: manifest.id });
      },

      // Test helper: enqueue a capability request for the adapter to poll.
      enqueueRequest: function (envelope) {
        var request = {
          requestId: envelope.requestId || ("request_mock_" + requests.length),
          capability: envelope.capability,
          action: envelope.action || "invoke",
          inputs: envelope.inputs || {},
          idempotencyKey: envelope.idempotencyKey || envelope.requestId || ("mock_" + requests.length),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        };
        requests.push(request);
        return request;
      },

      pollRequests: function () {
        var pending = requests.slice();
        requests = [];
        return Promise.resolve({ routing: "advertised", requests: pending });
      },

      postReceipt: function (receipt) {
        if (!receipt || typeof receipt.requestId !== "string") {
          return Promise.reject(FabrixError("validation_error", "Receipt requires a requestId."));
        }
        var duplicate = receipts.some(function (item) { return item.requestId === receipt.requestId; });
        if (duplicate) return Promise.resolve({ ok: true, mock: true, duplicate: true });
        receipts.push(receipt);
        return Promise.resolve({ ok: true, mock: true });
      },

      invoke: function (envelope) {
        // The mock does not execute capabilities itself; it echoes the
        // envelope back so the adapter's local execution path is exercised
        // by the caller. Real execution happens in capabilities.js.
        return Promise.resolve({ ok: true, mock: true, echoed: envelope });
      },

      // Test introspection (not part of the transport interface).
      _internals: function () {
        return {
          registered: Object.keys(registered),
          queuedRequests: requests.length,
          receipts: receipts.slice()
        };
      }
    };
  }

  window.xPinFabrixMock = Object.freeze({
    createMockBridge: createMockBridge
  });
})();
