/* xPin fabriX adapter — transports.
 *
 * A transport delivers one request envelope and returns one response
 * envelope. It knows nothing about notes. All transports implement:
 *
 *   { name, connect() -> Promise<status>, disconnect(), status() -> Promise<object>,
 *     invoke(envelope) -> Promise<envelope>, pollRequests() -> Promise<array>,
 *     postReceipt(receipt) -> Promise<object>, isConnected() }
 *
 * Honesty note: the Local Bridge's observed contract (BridgeClient.cs)
 * defines status, contract, register, and the read-only section endpoints.
 * It does NOT define a capability-invocation route. The poll/receipt paths
 * used here (`__fabrix/v1/capabilities/requests`, `__fabrix/v1/capabilities/receipts`)
 * are PROPOSED (spec §9, P6) and mirror the Cloud Bridge long-poll pattern
 * (GET requests?wait=1, POST receipts). The transport reads the Bridge's
 * contract document first: if the contract does not advertise capability
 * routing, `pollRequests()` reports `routing_not_advertised` and the adapter
 * stays in local-only mode (handlers still work from the settings panel and
 * the mock transport). Nothing is ever sent to a route the Bridge did not
 * advertise.
 *
 * The page CSP must allow loopback fetch for the local transport
 * (`connect-src` includes `http://127.0.0.1:*` — see index.html). The plugin
 * iframe keeps its own `connect-src 'none'`; this change does not open a
 * network path for plugins.
 */
(function () {
  "use strict";

  var CALL_TIMEOUT_MS = 3000; // matches the Hub client's 3 s timeout
  var MAX_RETRIES = 2;

  function FabrixError(code, message) {
    var error = new Error(message);
    error.name = "FabrixError";
    error.code = code;
    return error;
  }

  function randomToken(bytes) {
    var buffer = new Uint8Array(bytes || 18);
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(buffer);
    } else {
      for (var i = 0; i < buffer.length; i++) buffer[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < buffer.length; j++) {
      out += buffer[j].toString(16).padStart(2, "0");
    }
    return out;
  }

  function newRequestId() {
    // Local format: request_ + 24 random url-safe chars. The cloud server
    // generates request_ + 16 chars; do not assume parity (spec §7.1).
    return "request_" + randomToken(12);
  }

  async function fetchJson(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || CALL_TIMEOUT_MS);
    try {
      var response = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
      var text = await response.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (parseError) { data = null; }
      if (!response.ok) {
        var message = (data && (data.error || data.message)) || ("Bridge answered HTTP " + response.status);
        throw FabrixError("transport_unavailable", String(message).slice(0, 300));
      }
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw FabrixError("timeout", "The Bridge did not answer within " + (timeoutMs || CALL_TIMEOUT_MS) + " ms.");
      }
      if (error && error.code) throw error;
      throw FabrixError("transport_unavailable", "Could not reach the Bridge: " + String(error && error.message ? error.message : error).slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  }

  function withRetries(fn, isIdempotent) {
    // Bounded retries, idempotent calls only. Never retry a permission or
    // validation failure.
    var attempt = 0;
    function run() {
      return fn().catch(function (error) {
        var retryable = error && (error.code === "transport_unavailable" || error.code === "timeout");
        if (!isIdempotent || !retryable || attempt >= MAX_RETRIES) throw error;
        attempt += 1;
        var delay = attempt === 1 ? 1000 : 2000;
        return new Promise(function (resolve) { setTimeout(resolve, delay); }).then(run);
      });
    }
    return run();
  }

  // ---- Local Bridge (loopback) -------------------------------------------
  function LocalBridgeTransport(config) {
    var port = String(config && config.port ? config.port : "").trim();
    var token = String(config && config.token ? config.token : "").trim();
    var connected = false;
    var contract = null;

    function base() {
      return "http://127.0.0.1:" + port + "/";
    }

    function authHeaders() {
      return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    }

    function requireConfig() {
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        throw FabrixError("transport_unavailable", "No valid Local Bridge port is configured. Enter it in Settings → fabriX integration.");
      }
      if (token.length < 20) {
        throw FabrixError("transport_unavailable", "No Local Bridge token is configured. Paste it from the Hub (Documents\\fabriX\\Registry\\local-api-token.txt).");
      }
    }

    // Version negotiation (spec §7.1): the contract document is fetched and
    // must be compatible, or connect() fails closed with protocol_mismatch.
    // A failed contract fetch is NOT swallowed — the adapter must not report
    // "Connected" to a Bridge whose contract it could not read.
    function checkContract(doc) {
      if (!doc || typeof doc !== "object") {
        throw FabrixError("protocol_mismatch", "The Bridge did not return a contract document.");
      }
      var schema = doc.manifest_schema;
      if (typeof schema !== "string" || !schema) {
        throw FabrixError("protocol_mismatch", "The Bridge contract does not declare a manifest_schema.");
      }
      if (majorVersion(schema) !== 1) {
        throw FabrixError("protocol_mismatch", "The Bridge manifest schema is not version 1: " + schema.slice(0, 80));
      }
      if (typeof doc.schemaVersion === "string" && doc.schemaVersion && majorVersion(doc.schemaVersion) !== 1) {
        throw FabrixError("protocol_mismatch", "The Bridge contract schemaVersion is not version 1: " + doc.schemaVersion.slice(0, 80));
      }
    }

    // Tolerant major-version parse: "1.0" -> 1, "fabrix.manifest/1" -> 1,
    // "v1" -> 1, "2.0" -> 2. Unparseable -> null (fail closed).
    function majorVersion(value) {
      var match = String(value).match(/(\d+)/);
      if (!match) return null;
      return Number(match[1]);
    }

    return {
      name: "local",
      isConnected: function () { return connected; },
      getContract: function () { return contract; },

      connect: function () {
        requireConfig();
        return withRetries(function () {
          return fetchJson(base() + "__fabrix/v1/bridge/status", { headers: authHeaders() }, CALL_TIMEOUT_MS)
            .then(function (status) {
              if (!status || status.ok !== true || !status.build_id) {
                throw FabrixError("transport_unavailable", "The Bridge answered but the status document is invalid.");
              }
              if (!status.protocol_1_2) {
                throw FabrixError("protocol_mismatch", "The Bridge did not report protocol compatibility (protocol_1_2 missing).");
              }
              return fetchJson(base() + "__fabrix/v1/bridge/contract", { headers: authHeaders() }, CALL_TIMEOUT_MS)
                .then(function (doc) {
                  checkContract(doc);
                  contract = doc;
                  connected = true;
                  return status;
                });
            });
        }, true);
      },

      disconnect: function () {
        connected = false;
        contract = null;
        return Promise.resolve();
      },

      status: function () {
        requireConfig();
        return withRetries(function () {
          return fetchJson(base() + "__fabrix/v1/bridge/status", { headers: authHeaders() }, CALL_TIMEOUT_MS);
        }, true);
      },

      section: function (name) {
        var allowed = {
          library: "__fabrix/v1/products",
          projects: "__fabrix/v1/projects",
          assets: "__fabrix/v1/artifacts",
          artifacts: "__fabrix/v1/artifacts",
          connections: "__fabrix/v1/capabilities",
          workflows: "__fabrix/v1/workflows",
          licenses: "__fabrix/v1/licenses",
          mcp: "__fabrix/v1/mcp/projection",
          cloud: "__fabrix/v1/cloud/status"
        };
        if (!Object.prototype.hasOwnProperty.call(allowed, name)) {
          return Promise.reject(FabrixError("validation_error", "Unknown Bridge section: " + String(name)));
        }
        requireConfig();
        return withRetries(function () {
          return fetchJson(base() + allowed[name], { headers: authHeaders() }, CALL_TIMEOUT_MS);
        }, true);
      },

      register: function (manifest) {
        // Owner-initiated registration (BridgeClient.RegisterNativeAppAsync).
        // The Bridge validates the manifest; registration grants nothing.
        // NOTE: the current Bridge shape expects a Windows .exe
        // (native_path); xPin registers with type "web" and no native_path
        // (spec §9, P1) and treats a rejection as "registration unavailable".
        requireConfig();
        return fetchJson(base() + "__fabrix/register", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ manifest: manifest })
        }, CALL_TIMEOUT_MS);
      },

      // Capability invocation is PROPOSED (see header). The contract
      // document is authoritative: without an advertised route, this
      // reports routing_not_advertised instead of guessing a path.
      pollRequests: function () {
        requireConfig();
        if (!contract || !contract.capability_routes || contract.capability_routes.requests !== true) {
          return Promise.resolve({ routing: "not_advertised", requests: [] });
        }
        return withRetries(function () {
          return fetchJson(base() + "__fabrix/v1/capabilities/requests?product=xpin", { headers: authHeaders() }, CALL_TIMEOUT_MS);
        }, true);
      },

      postReceipt: function (receipt) {
        requireConfig();
        if (!contract || !contract.capability_routes || contract.capability_routes.receipts !== true) {
          return Promise.reject(FabrixError("transport_unavailable", "This Bridge build does not advertise a capability receipt route."));
        }
        return fetchJson(base() + "__fabrix/v1/capabilities/receipts", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(receipt)
        }, CALL_TIMEOUT_MS);
      },

      // Direct invocation is only attempted when the contract advertises it.
      // NOTE: the adapter never calls invoke() — it executes handlers
      // locally and answers Bridge requests via pollRequests/postReceipt.
      // invoke() exists for completeness of the transport interface and
      // for tests; do not present it as an exercised path.
      invoke: function (envelope) {
        requireConfig();
        if (!contract || !contract.capability_routes || contract.capability_routes.invoke !== true) {
          return Promise.reject(FabrixError("transport_unavailable", "This Bridge build does not advertise direct capability invocation. Requests are handled locally by the adapter."));
        }
        return fetchJson(base() + "__fabrix/v1/capabilities/invoke", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(envelope)
        }, CALL_TIMEOUT_MS);
      }
    };
  }

  // ---- Cloud Bridge (stub — not live) ------------------------------------
  // The reference relay is not production-deployed (spec §1.1, Gates A–C).
  // This transport exists so the interface is complete and the adapter can
  // be wired to it later without changing callers. It never claims a live
  // connection.
  function CloudBridgeTransport(config) {
    var url = String(config && config.url ? config.url : "").trim();
    return {
      name: "cloud",
      isConnected: function () { return false; },
      getContract: function () { return null; },
      connect: function () {
        return Promise.reject(FabrixError(
          "transport_unavailable",
          "Cloud Bridge is not live. The reference relay is not production-deployed (Gates A–C unmet); " +
          "no Cloud Bridge URL is configured" + (url ? " (configured URL is ignored until the owner enables it)." : ".")
        ));
      },
      disconnect: function () { return Promise.resolve(); },
      status: function () {
        return Promise.reject(FabrixError("transport_unavailable", "Cloud Bridge is not live."));
      },
      section: function () {
        return Promise.reject(FabrixError("transport_unavailable", "Cloud Bridge is not live."));
      },
      register: function () {
        return Promise.reject(FabrixError("transport_unavailable", "Cloud Bridge is not live."));
      },
      pollRequests: function () {
        return Promise.resolve({ routing: "not_advertised", requests: [] });
      },
      postReceipt: function () {
        return Promise.reject(FabrixError("transport_unavailable", "Cloud Bridge is not live."));
      },
      invoke: function () {
        return Promise.reject(FabrixError("transport_unavailable", "Cloud Bridge is not live."));
      }
    };
  }

  function createTransport(kind, config) {
    if (kind === "local") return LocalBridgeTransport(config);
    if (kind === "cloud") return CloudBridgeTransport(config);
    if (kind === "mock") {
      if (!window.xPinFabrixMock) throw FabrixError("transport_unavailable", "The mock transport is not loaded.");
      return window.xPinFabrixMock.createMockBridge(config || {});
    }
    throw FabrixError("validation_error", "Unknown transport: " + String(kind));
  }

  window.xPinFabrixTransport = Object.freeze({
    FabrixError: FabrixError,
    CALL_TIMEOUT_MS: CALL_TIMEOUT_MS,
    newRequestId: newRequestId,
    randomToken: randomToken,
    LocalBridgeTransport: LocalBridgeTransport,
    CloudBridgeTransport: CloudBridgeTransport,
    createTransport: createTransport
  });
})();
