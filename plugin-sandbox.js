(() => {
  "use strict";

  const MAX_SOURCE_LENGTH = 64_000;
  const MAX_PACKAGE_BYTES = 100_000;
  const MAX_COMMANDS = 20;
  const PERMISSIONS = Object.freeze({
    "notes:read": "Read note titles and content",
    "notes:select": "Open a note in the editor",
    "notes:create": "Create a note",
    "notes:update": "Edit a note's title or body",
    "notes:delete": "Move a note to Trash (or permanently delete it from Trash)",
    "editor:write": "Insert text into the open note",
    "commands:register": "Add actions to the command palette",
    "ui:notify": "Show xPin notifications",
    "ui:status": "Show a small item in the editor status bar",
    "settings:read": "Read this plugin's own settings",
    "settings:write": "Save this plugin's own settings",
    // Phase 1 (audit C2/C3): host API for folders, databases, canvas,
    // templates, and export — available to both tiers, gated like the rest.
    "folders:read": "List folders",
    "folders:write": "Create, rename, or delete folders",
    "databases:read": "List databases and read their rows",
    "databases:write": "Add or update database rows",
    "canvas:read": "List canvas boards",
    "templates:read": "List note templates",
    "export:note": "Export notes as Markdown or a Markdown .zip",
    // Connector tier only (manifest tier: "connector"). The sandboxed tier
    // never gets these: the worker's own fetch/XHR/WebSocket stay neutered
    // and every network call goes through a host-side gated RPC instead.
    "network:fetch": "Fetch from approved https origins (host performs the request)",
    "credentials:set": "Store a secret in the encrypted credential store",
    "credentials:get": "Read a stored secret back",
    "credentials:delete": "Delete a stored secret"
  });
  // Permissions only a connector-tier plugin may declare. A sandboxed
  // plugin asking for one is rejected at validation time.
  const CONNECTOR_PERMISSIONS = new Set(["network:fetch", "credentials:set", "credentials:get", "credentials:delete"]);
  const MAX_NETWORK_ORIGINS = 10;

  const WORKER_PRELUDE = `
    const __xPinState = { definition: null, commands: new Map(), pending: new Map(), sequence: 0 };
    const __xPinSend = (message) => self.postMessage(message);
    const __xPinRequest = (capability, payload) => new Promise((resolve, reject) => {
      const requestId = ++__xPinState.sequence;
      __xPinState.pending.set(requestId, { resolve, reject });
      __xPinSend({ type: "request", requestId, capability, payload });
    });
    const __xPinApi = Object.freeze({
      notes: Object.freeze({
        list: () => __xPinRequest("notes:read", { action: "list" }),
        current: () => __xPinRequest("notes:read", { action: "current" }),
        select: (id) => __xPinRequest("notes:select", { id }),
        create: (options) => __xPinRequest("notes:create", { options }),
        update: (id, patch) => __xPinRequest("notes:update", { id, patch }),
        delete: (id, options) => __xPinRequest("notes:delete", { id, permanent: options?.permanent === true })
      }),
      editor: Object.freeze({
        insertText: (text) => __xPinRequest("editor:write", { text })
      }),
      ui: Object.freeze({
        notify: (message) => __xPinRequest("ui:notify", { message }),
        setStatus: (item) => __xPinRequest("ui:status", { action: "set", item }),
        clearStatus: (id) => __xPinRequest("ui:status", { action: "clear", id })
      }),
      commands: Object.freeze({
        add(command) {
          if (!command || typeof command.id !== "string" ||
            typeof command.name !== "string" || typeof command.run !== "function") {
            throw new TypeError("Commands need an id, name, and run function.");
          }
          if (__xPinState.commands.has(command.id) || __xPinState.commands.size >= ${MAX_COMMANDS}) {
            throw new Error("Command id is already registered or the plugin command limit was reached.");
          }
          __xPinState.commands.set(command.id, command.run);
          return __xPinRequest("commands:register", {
            id: command.id,
            name: command.name,
            description: typeof command.description === "string" ? command.description : ""
          });
        }
      }),
      settings: Object.freeze({
        get: (key, fallback) => __xPinRequest("settings:read", { key, fallback }),
        set: (key, value) => __xPinRequest("settings:write", { key, value })
      }),
      // Phase 1 (audit C3): folders, databases, canvas, templates, export.
      folders: Object.freeze({
        list: () => __xPinRequest("folders:read", { action: "list" }),
        create: (name) => __xPinRequest("folders:write", { action: "create", name }),
        rename: (id, name) => __xPinRequest("folders:write", { action: "rename", id, name }),
        delete: (id) => __xPinRequest("folders:write", { action: "delete", id })
      }),
      databases: Object.freeze({
        list: () => __xPinRequest("databases:read", { action: "list" }),
        rows: (tableId) => __xPinRequest("databases:read", { action: "rows", tableId }),
        addRow: (tableId, values) => __xPinRequest("databases:write", { action: "add-row", tableId, values }),
        updateRow: (tableId, rowId, values) => __xPinRequest("databases:write", { action: "update-row", tableId, rowId, values })
      }),
      canvas: Object.freeze({
        list: () => __xPinRequest("canvas:read", { action: "list" })
      }),
      templates: Object.freeze({
        list: () => __xPinRequest("templates:read", { action: "list" })
      }),
      export: Object.freeze({
        noteMarkdown: (id) => __xPinRequest("export:note", { action: "note-markdown", id }),
        markdownZip: () => __xPinRequest("export:note", { action: "markdown-zip" })
      }),
      // Connector tier only. The worker never touches the network itself:
      // network:fetch asks the HOST to fetch (allowlist + timeout + size
      // cap enforced there), and credentials:* read/write the encrypted
      // store through the host. Sandboxed plugins are rejected by the host.
      network: Object.freeze({
        fetch: (url, options) => __xPinRequest("network:fetch", { url, options: options ?? {} })
      }),
      credentials: Object.freeze({
        set: (key, value) => __xPinRequest("credentials:set", { key, value }),
        get: (key) => __xPinRequest("credentials:get", { key }),
        delete: (key) => __xPinRequest("credentials:delete", { key })
      })
    });
    Object.defineProperty(self, "xPinPlugin", {
      configurable: false,
      writable: false,
      value: Object.freeze({
        register(definition) {
          if (__xPinState.definition || !definition || typeof definition.activate !== "function") {
            throw new TypeError("Register exactly one plugin with an activate(api) function.");
          }
          __xPinState.definition = definition;
        }
      })
    });
    for (const name of ["Worker", "SharedWorker", "BroadcastChannel", "indexedDB", "caches", "importScripts", "WebAssembly", "fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
      try {
        Object.defineProperty(self, name, { configurable: false, value: undefined });
      } catch (error) {
        throw new Error("Could not restrict plugin runtime capability " + name + ": " + String(error && error.message || error));
      }
    }
    if (self.navigator) {
      for (const name of ["sendBeacon", "storage"]) {
        try {
          Object.defineProperty(self.navigator, name, { configurable: false, value: undefined });
        } catch (error) {
          throw new Error("Could not restrict plugin runtime capability navigator." + name + ": " + String(error && error.message || error));
        }
      }
    }
  `;

  const WORKER_RUNTIME = `
    self.addEventListener("message", async (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "activate") {
        try {
          if (!__xPinState.definition) throw new Error("Package source did not register a plugin.");
          const cleanup = await __xPinState.definition.activate(__xPinApi);
          if (typeof cleanup === "function") __xPinState.cleanup = cleanup;
          __xPinSend({ type: "activated" });
        } catch (error) {
          __xPinSend({ type: "runtime-error", message: String(error && error.message || error).slice(0, 300) });
        }
      } else if (message.type === "rpc-response") {
        const pending = __xPinState.pending.get(message.requestId);
        if (!pending) return;
        __xPinState.pending.delete(message.requestId);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(String(message.error || "Permission request failed.").slice(0, 300)));
      } else if (message.type === "invoke") {
        const run = __xPinState.commands.get(message.commandId);
        try {
          if (!run) throw new Error("Command is no longer available.");
          await run();
          __xPinSend({ type: "command-result", invokeId: message.invokeId, ok: true });
        } catch (error) {
          __xPinSend({ type: "command-result", invokeId: message.invokeId, ok: false, error: String(error && error.message || error).slice(0, 300) });
        }
      }
    });
    // An async failure the plugin never handled is a bug in the plugin, not a
    // crash: report it to the host so the user sees it instead of silence.
    self.addEventListener("unhandledrejection", (event) => {
      event.preventDefault();
      __xPinSend({ type: "plugin-error", message: String((event.reason && event.reason.message) || event.reason || "Plugin error").slice(0, 300) });
    });
  `;

  const FRAME_DOCUMENT = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><script>
    const workerPrelude = ${JSON.stringify(WORKER_PRELUDE)};
    const workerRuntime = ${JSON.stringify(WORKER_RUNTIME)};
    let worker = null;
    const relay = (message) => parent.postMessage(message, "*");
    addEventListener("message", (event) => {
      if (event.source !== parent || !event.data || typeof event.data !== "object") return;
      const message = event.data;
      if (message.type === "xPin:boot" && !worker && typeof message.source === "string") {
        try {
          const blob = new Blob([workerPrelude, "\\n(function () {\\n", message.source, "\\n})();\\n", workerRuntime], { type: "text/javascript" });
          const url = URL.createObjectURL(blob);
          worker = new Worker(url);
          URL.revokeObjectURL(url);
          worker.onmessage = (reply) => relay(reply.data);
          worker.onerror = (error) => relay({ type: "runtime-error", message: String(error.message || "Sandbox worker failed.").slice(0, 300) });
          worker.postMessage({ type: "activate" });
        } catch (error) {
          relay({ type: "runtime-error", message: String(error && error.message || error).slice(0, 300) });
        }
      } else if (message.type === "xPin:stop") {
        worker?.terminate();
        worker = null;
      } else if (worker) {
        worker.postMessage(message);
      }
    });
  </script>`;

  function validatePackage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      !value.manifest || typeof value.manifest !== "object" || Array.isArray(value.manifest) ||
      typeof value.source !== "string") {
      throw new TypeError("Package must contain a manifest object and JavaScript source string.");
    }
    const manifest = value.manifest;
    const id = manifest.id;
    if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) {
      throw new TypeError("Plugin id must be 1–64 characters: lowercase letters, numbers, and hyphens only (example: \"my-plugin\").");
    }
    for (const key of ["name", "version", "description", "author"]) {
      const limit = key === "description" ? 240 : 80;
      if (typeof manifest[key] !== "string" || !manifest[key].trim() || manifest[key].length > limit) {
        throw new TypeError(`Plugin manifest field "${key}" must be non-empty text under ${limit} characters.`);
      }
    }
    if (!Array.isArray(manifest.permissions) ||
      manifest.permissions.length > Object.keys(PERMISSIONS).length ||
      new Set(manifest.permissions).size !== manifest.permissions.length) {
      throw new TypeError("Plugin permissions must be a list of unique capability names (see PLUGIN_GUIDE.md).");
    }
    const unknown = manifest.permissions.find((permission) => !Object.hasOwn(PERMISSIONS, permission));
    if (unknown !== undefined) {
      throw new TypeError(`Unknown plugin permission "${String(unknown).slice(0, 60)}". Supported: ${Object.keys(PERMISSIONS).join(", ")}.`);
    }
    // Connector tier (Phase 1, audit C1/C4): manifest declares
    // tier: "connector" plus an explicit networkOrigins allowlist. Any
    // other tier (or no tier) is the sandboxed tier and may NOT declare
    // connector permissions — the sandbox keeps its network neutering.
    const tier = manifest.tier === undefined || manifest.tier === "sandboxed" ? "sandboxed"
      : manifest.tier === "connector" ? "connector" : null;
    if (tier === null) {
      throw new TypeError('Plugin tier must be "sandboxed" or "connector".');
    }
    const connectorPermission = manifest.permissions.find((permission) => CONNECTOR_PERMISSIONS.has(permission));
    if (tier !== "connector" && connectorPermission !== undefined) {
      throw new TypeError(`Permission "${connectorPermission}" needs the connector tier (manifest tier: "connector"). Sandboxed plugins cannot reach the network or the credential store.`);
    }
    let networkOrigins = [];
    if (manifest.networkOrigins !== undefined && !(Array.isArray(manifest.networkOrigins) && manifest.networkOrigins.length === 0)) {
      if (tier !== "connector") {
        throw new TypeError("Only connector-tier plugins may declare networkOrigins.");
      }
      if (!Array.isArray(manifest.networkOrigins) || manifest.networkOrigins.length > MAX_NETWORK_ORIGINS) {
        throw new TypeError(`networkOrigins must be a list of at most ${MAX_NETWORK_ORIGINS} origins.`);
      }
      networkOrigins = manifest.networkOrigins.map((origin) => {
        if (typeof origin !== "string") throw new TypeError("networkOrigins entries must be origin strings.");
        let parsed;
        try {
          parsed = new URL(origin);
        } catch {
          throw new TypeError(`networkOrigins entry "${origin.slice(0, 80)}" is not a valid URL.`);
        }
        if (parsed.protocol !== "https:") throw new TypeError(`networkOrigins entry "${origin.slice(0, 80)}" must use https.`);
        if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
          throw new TypeError(`networkOrigins entry "${origin.slice(0, 80)}" must be a bare origin (no path, query, or credentials).`);
        }
        return parsed.origin;
      });
      if (new Set(networkOrigins).size !== networkOrigins.length) {
        throw new TypeError("networkOrigins must not repeat an origin.");
      }
    }
    if (tier === "connector" && manifest.permissions.includes("network:fetch") && !networkOrigins.length) {
      throw new TypeError('A connector plugin with "network:fetch" must declare at least one networkOrigins entry.');
    }
    if (!value.source.trim() || value.source.length > MAX_SOURCE_LENGTH) {
      throw new TypeError(`Plugin source must be 1–${MAX_SOURCE_LENGTH} characters of JavaScript calling xPinPlugin.register().`);
    }
    return {
      manifest: {
        id,
        name: manifest.name.trim(),
        version: manifest.version.trim(),
        description: manifest.description.trim(),
        author: manifest.author.trim(),
        permissions: [...manifest.permissions],
        tier,
        networkOrigins
      },
      source: value.source
    };
  }

  async function digestPackage(plugin) {
    if (!globalThis.crypto?.subtle) return null;
    // Digest covers only the fields that existed before the connector tier
    // (Phase 1): tier/networkOrigins are validated separately and must NOT
    // invalidate previously approved fingerprints — a plugin approved
    // before Phase 1 keeps its stored SHA-256.
    const stableManifest = {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      author: plugin.manifest.author,
      permissions: plugin.manifest.permissions
    };
    const bytes = new TextEncoder().encode(JSON.stringify({ manifest: stableManifest, source: plugin.source }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function create({ plugin, permissions, onRequest, onError, onStatus, onWarning }) {
    if (!plugin || !Array.isArray(permissions) || typeof onRequest !== "function" || typeof onError !== "function") {
      throw new TypeError("Sandbox requires a plugin, permissions, request, and error handlers.");
    }
    const normalized = validatePackage(plugin);
    const grants = new Set(permissions);
    const pendingInvocations = new Map();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.title = `Isolated runtime for ${normalized.manifest.name}`;
    frame.srcdoc = FRAME_DOCUMENT;
    frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10px;bottom:0;border:0;opacity:0;pointer-events:none";

    let disposed = false;
    let started = false;
    let messageCount = 0;
    let messageWindowStart = Date.now();
    let resolveStart;
    let rejectStart;
    let startupTimer;
    const ready = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    function stop(error) {
      if (disposed) return;
      disposed = true;
      clearTimeout(startupTimer);
      frame.contentWindow?.postMessage({ type: "xPin:stop" }, "*");
      window.removeEventListener("message", receive);
      frame.remove();
      pendingInvocations.forEach(({ reject }) => reject(new Error("Plugin sandbox was stopped.")));
      pendingInvocations.clear();
      if (error) {
        rejectStart(error);
        onError(error);
      }
      onStatus?.("stopped");
    }

    async function receive(event) {
      if (disposed || event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
      const now = Date.now();
      if (now - messageWindowStart > 10_000) {
        messageWindowStart = now;
        messageCount = 0;
      }
      messageCount += 1;
      if (messageCount > 150) {
        stop(new Error("Plugin exceeded the sandbox message limit and was stopped."));
        return;
      }
      const message = event.data;
      if (message.type === "activated") {
        clearTimeout(startupTimer);
        resolveStart();
        onStatus?.("active");
      } else if (message.type === "runtime-error") {
        stop(new Error(String(message.message || "Plugin runtime failed.").slice(0, 300)));
      } else if (message.type === "plugin-error") {
        try {
          onWarning?.(new Error(String(message.message || "Plugin error.").slice(0, 300)));
        } catch (error) {
          console.error("xPin plugin warning handler failed.", error);
        }
      } else if (message.type === "command-result") {
        const pending = pendingInvocations.get(message.invokeId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingInvocations.delete(message.invokeId);
        message.ok ? pending.resolve() : pending.reject(new Error(message.error || "Plugin command failed."));
      } else if (message.type === "request") {
        if (!Number.isSafeInteger(message.requestId) || typeof message.capability !== "string" ||
          !grants.has(message.capability) || !normalized.manifest.permissions.includes(message.capability)) {
          frame.contentWindow.postMessage({
            type: "rpc-response",
            requestId: message.requestId,
            ok: false,
            error: "This permission was not granted."
          }, "*");
          return;
        }
        if (message.capability === "settings:read" || message.capability === "settings:write") {
          const settingsKey = message.payload && message.payload.key;
          if (typeof settingsKey !== "string" || settingsKey === "__proto__" ||
            settingsKey === "constructor" || settingsKey === "prototype") {
            frame.contentWindow.postMessage({
              type: "rpc-response",
              requestId: message.requestId,
              ok: false,
              error: "Invalid settings key."
            }, "*");
            return;
          }
        }
        try {
          const result = await onRequest(message.capability, message.payload);
          frame.contentWindow.postMessage({ type: "rpc-response", requestId: message.requestId, ok: true, result }, "*");
        } catch (error) {
          frame.contentWindow.postMessage({
            type: "rpc-response",
            requestId: message.requestId,
            ok: false,
            error: String(error && error.message || error).slice(0, 300)
          }, "*");
        }
      }
    }

    window.addEventListener("message", receive);
    frame.addEventListener("load", () => {
      if (disposed || started) return;
      started = true;
      frame.contentWindow.postMessage({ type: "xPin:boot", source: normalized.source }, "*");
    }, { once: true });
    document.body.append(frame);
    startupTimer = setTimeout(() => stop(new Error("Plugin did not start within 8 seconds.")), 8000);

    function invoke(commandId, invokeId = `${Date.now()}-${Math.random()}`) {
      if (disposed) return Promise.reject(new Error("Plugin is not running."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error("Plugin command timed out and the sandbox was stopped.");
          pendingInvocations.delete(invokeId);
          reject(error);
          stop(error);
        }, 8000);
        pendingInvocations.set(invokeId, { resolve, reject, timer });
        frame.contentWindow?.postMessage({ type: "invoke", commandId, invokeId }, "*");
      });
    }

    return Object.freeze({
      start: () => ready,
      stop,
      invoke,
      permissions: [...grants],
      get active() { return !disposed; }
    });
  }

  window.xPinSandbox = Object.freeze({
    permissions: PERMISSIONS,
    maxPackageBytes: MAX_PACKAGE_BYTES,
    validatePackage,
    digestPackage,
    create
  });
})();
