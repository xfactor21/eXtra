(() => {
  "use strict";

  const MAX_SOURCE_LENGTH = 64_000;
  const MAX_PACKAGE_BYTES = 100_000;
  const MAX_COMMANDS = 20;
  const PERMISSIONS = Object.freeze({
    "notes:read": "Read note titles and content",
    "notes:select": "Open a note in the editor",
    "notes:create": "Create a note",
    "editor:write": "Insert text into the open note",
    "commands:register": "Add actions to the command palette",
    "ui:notify": "Show Pinboard notifications",
    "settings:read": "Read this plugin's own settings",
    "settings:write": "Save this plugin's own settings"
  });

  const WORKER_PRELUDE = `
    const __pinboardState = { definition: null, commands: new Map(), pending: new Map(), sequence: 0 };
    const __pinboardSend = (message) => self.postMessage(message);
    const __pinboardRequest = (capability, payload) => new Promise((resolve, reject) => {
      const requestId = ++__pinboardState.sequence;
      __pinboardState.pending.set(requestId, { resolve, reject });
      __pinboardSend({ type: "request", requestId, capability, payload });
    });
    const __pinboardApi = Object.freeze({
      notes: Object.freeze({
        list: () => __pinboardRequest("notes:read", { action: "list" }),
        current: () => __pinboardRequest("notes:read", { action: "current" }),
        select: (id) => __pinboardRequest("notes:select", { id }),
        create: (options) => __pinboardRequest("notes:create", { options })
      }),
      editor: Object.freeze({
        insertText: (text) => __pinboardRequest("editor:write", { text })
      }),
      ui: Object.freeze({
        notify: (message) => __pinboardRequest("ui:notify", { message })
      }),
      commands: Object.freeze({
        add(command) {
          if (!command || typeof command.id !== "string" ||
            typeof command.name !== "string" || typeof command.run !== "function") {
            throw new TypeError("Commands need an id, name, and run function.");
          }
          if (__pinboardState.commands.has(command.id) || __pinboardState.commands.size >= ${MAX_COMMANDS}) {
            throw new Error("Command id is already registered or the plugin command limit was reached.");
          }
          __pinboardState.commands.set(command.id, command.run);
          return __pinboardRequest("commands:register", {
            id: command.id,
            name: command.name,
            description: typeof command.description === "string" ? command.description : ""
          });
        }
      }),
      settings: Object.freeze({
        get: (key, fallback) => __pinboardRequest("settings:read", { key, fallback }),
        set: (key, value) => __pinboardRequest("settings:write", { key, value })
      })
    });
    Object.defineProperty(self, "PinboardPlugin", {
      configurable: false,
      writable: false,
      value: Object.freeze({
        register(definition) {
          if (__pinboardState.definition || !definition || typeof definition.activate !== "function") {
            throw new TypeError("Register exactly one plugin with an activate(api) function.");
          }
          __pinboardState.definition = definition;
        }
      })
    });
    for (const name of ["Worker", "SharedWorker", "BroadcastChannel", "indexedDB", "caches", "importScripts", "WebAssembly"]) {
      try {
        Object.defineProperty(self, name, { configurable: false, value: undefined });
      } catch (error) {
        throw new Error("Could not restrict plugin runtime capability " + name + ": " + String(error && error.message || error));
      }
    }
  `;

  const WORKER_RUNTIME = `
    self.addEventListener("message", async (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "activate") {
        try {
          if (!__pinboardState.definition) throw new Error("Package source did not register a plugin.");
          const cleanup = await __pinboardState.definition.activate(__pinboardApi);
          if (typeof cleanup === "function") __pinboardState.cleanup = cleanup;
          __pinboardSend({ type: "activated" });
        } catch (error) {
          __pinboardSend({ type: "runtime-error", message: String(error && error.message || error).slice(0, 300) });
        }
      } else if (message.type === "rpc-response") {
        const pending = __pinboardState.pending.get(message.requestId);
        if (!pending) return;
        __pinboardState.pending.delete(message.requestId);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(String(message.error || "Permission request failed.").slice(0, 300)));
      } else if (message.type === "invoke") {
        const run = __pinboardState.commands.get(message.commandId);
        try {
          if (!run) throw new Error("Command is no longer available.");
          await run();
          __pinboardSend({ type: "command-result", invokeId: message.invokeId, ok: true });
        } catch (error) {
          __pinboardSend({ type: "command-result", invokeId: message.invokeId, ok: false, error: String(error && error.message || error).slice(0, 300) });
        }
      }
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
      if (message.type === "pinboard:boot" && !worker && typeof message.source === "string") {
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
      } else if (message.type === "pinboard:stop") {
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
      throw new TypeError("Plugin id must use lowercase letters, numbers, and hyphens.");
    }
    for (const key of ["name", "version", "description", "author"]) {
      if (typeof manifest[key] !== "string" || !manifest[key].trim() || manifest[key].length > (key === "description" ? 240 : 80)) {
        throw new TypeError(`Plugin manifest has an invalid ${key}.`);
      }
    }
    if (!Array.isArray(manifest.permissions) || manifest.permissions.length > Object.keys(PERMISSIONS).length ||
      manifest.permissions.some((permission) => !Object.hasOwn(PERMISSIONS, permission)) ||
      new Set(manifest.permissions).size !== manifest.permissions.length) {
      throw new TypeError("Plugin permissions must be a unique list of supported capabilities.");
    }
    if (!value.source.trim() || value.source.length > MAX_SOURCE_LENGTH) {
      throw new TypeError(`Plugin source must contain 1–${MAX_SOURCE_LENGTH} characters.`);
    }
    return {
      manifest: {
        id,
        name: manifest.name.trim(),
        version: manifest.version.trim(),
        description: manifest.description.trim(),
        author: manifest.author.trim(),
        permissions: [...manifest.permissions]
      },
      source: value.source
    };
  }

  async function digestPackage(plugin) {
    if (!globalThis.crypto?.subtle) return null;
    const bytes = new TextEncoder().encode(JSON.stringify({ manifest: plugin.manifest, source: plugin.source }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function create({ plugin, permissions, onRequest, onError, onStatus }) {
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
      frame.contentWindow?.postMessage({ type: "pinboard:stop" }, "*");
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
      frame.contentWindow.postMessage({ type: "pinboard:boot", source: normalized.source }, "*");
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

  window.PinboardSandbox = Object.freeze({
    permissions: PERMISSIONS,
    maxPackageBytes: MAX_PACKAGE_BYTES,
    validatePackage,
    digestPackage,
    create
  });
})();
