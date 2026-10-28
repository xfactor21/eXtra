(() => {
  "use strict";

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function create({ definitions, savedState, host, onChange }) {
    if (!Array.isArray(definitions) || !host || typeof onChange !== "function") {
      throw new TypeError("Plugin manager requires definitions, a host API, and an onChange callback.");
    }

    const registry = new Map();
    const active = new Map();
    const commands = new Map();
    const listeners = new Map();
    const panels = new Map();
    const statusItems = new Map();
    const saved = savedState && typeof savedState === "object" ? savedState : {};
    const preferences = {
      enabled: saved.enabled && typeof saved.enabled === "object" ? { ...saved.enabled } : {},
      settings: saved.settings && typeof saved.settings === "object" ? clone(saved.settings) : {}
    };

    definitions.forEach((definition) => {
      if (!definition || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id) ||
        typeof definition.name !== "string" || typeof definition.description !== "string" ||
        typeof definition.activate !== "function") {
        throw new TypeError("Each plugin needs a valid id, name, description, and activate function.");
      }
      if (registry.has(definition.id)) throw new Error(`Duplicate plugin id: ${definition.id}`);
      registry.set(definition.id, Object.freeze({ ...definition }));
    });

    function report(error, context) {
      console.error(`Pinboard plugin ${context} failed.`, error);
      host.notify(`${context} failed. See the browser console for details.`);
    }

    function createApi(pluginId, scope) {
      function addDisposer(disposer) {
        if (typeof disposer !== "function") throw new TypeError("Plugin cleanup must be a function.");
        if (scope.closed) {
          disposer();
          return disposer;
        }
        scope.disposers.push(disposer);
        return disposer;
      }

      return Object.freeze({
        manifest: registry.get(pluginId),
        notes: host.notes,
        editor: host.editor,
        tags: host.tags,
        ui: Object.freeze({
          notify: host.notify,
          openPluginManager: host.openPluginManager,
          registerPanel(panel) {
            if (!panel || typeof panel.id !== "string" || typeof panel.title !== "string" || typeof panel.render !== "function") {
              throw new TypeError("A plugin panel needs an id, title, and render function.");
            }
            const key = `${pluginId}:${panel.id}`;
            if (panels.has(key)) throw new Error(`Plugin panel already registered: ${key}`);
            panels.set(key, { ...panel, pluginId, key });
            return addDisposer(() => panels.delete(key));
          },
          registerStatusItem(item) {
            if (!item || typeof item.id !== "string" || typeof item.render !== "function") {
              throw new TypeError("A status item needs an id and render function.");
            }
            const key = `${pluginId}:${item.id}`;
            if (statusItems.has(key)) throw new Error(`Plugin status item already registered: ${key}`);
            statusItems.set(key, { ...item, pluginId, key });
            return addDisposer(() => statusItems.delete(key));
          }
        }),
        commands: Object.freeze({
          add(command) {
            if (!command || typeof command.id !== "string" || typeof command.name !== "string" || typeof command.run !== "function") {
              throw new TypeError("A command needs an id, name, and run function.");
            }
            const key = `${pluginId}:${command.id}`;
            if (commands.has(key)) throw new Error(`Plugin command already registered: ${key}`);
            commands.set(key, { ...command, pluginId, key });
            return addDisposer(() => commands.delete(key));
          }
        }),
        events: Object.freeze({
          on(name, callback) {
            if (typeof name !== "string" || typeof callback !== "function") {
              throw new TypeError("An event listener needs a name and callback.");
            }
            const handlers = listeners.get(name) ?? new Set();
            handlers.add(callback);
            listeners.set(name, handlers);
            return addDisposer(() => {
              handlers.delete(callback);
              if (handlers.size === 0) listeners.delete(name);
            });
          }
        }),
        settings: Object.freeze({
          get(key, fallback) {
            const pluginSettings = preferences.settings[pluginId];
            return pluginSettings && Object.hasOwn(pluginSettings, key) ? clone(pluginSettings[key]) : fallback;
          },
          set(key, value) {
            if (typeof key !== "string" || !key) throw new TypeError("A plugin setting needs a key.");
            const pluginSettings = preferences.settings[pluginId] ?? (preferences.settings[pluginId] = {});
            pluginSettings[key] = clone(value);
            onChange();
          }
        }),
        register: addDisposer
      });
    }

    async function disposeScope(scope, definition, api) {
      scope.closed = true;
      const failures = [];
      while (scope.disposers.length) {
        try {
          await scope.disposers.pop()();
        } catch (error) {
          failures.push(error);
        }
      }
      if (typeof definition.deactivate === "function") {
        try {
          await definition.deactivate(api);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) report(new AggregateError(failures, `${definition.name} cleanup had errors`), "unloading");
    }

    async function activate(definition) {
      if (active.has(definition.id)) return;
      const scope = { disposers: [], closed: false };
      const api = createApi(definition.id, scope);
      active.set(definition.id, { scope, api });
      try {
        const cleanup = await definition.activate(api);
        if (typeof cleanup === "function") scope.disposers.push(cleanup);
      } catch (error) {
        active.delete(definition.id);
        await disposeScope(scope, definition, api);
        throw error;
      }
    }

    async function deactivate(definition) {
      const entry = active.get(definition.id);
      if (!entry) return;
      active.delete(definition.id);
      await disposeScope(entry.scope, definition, entry.api);
    }

    async function start() {
      for (const definition of registry.values()) {
        if (typeof preferences.enabled[definition.id] !== "boolean") {
          preferences.enabled[definition.id] = definition.defaultEnabled !== false;
        }
        if (!preferences.enabled[definition.id]) continue;
        try {
          await activate(definition);
        } catch (error) {
          preferences.enabled[definition.id] = false;
          report(error, `loading ${definition.name}`);
        }
      }
      onChange();
    }

    async function setEnabled(pluginId, enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("Plugin enabled state must be a boolean.");
      const definition = registry.get(pluginId);
      if (!definition) throw new Error(`Unknown Pinboard plugin: ${pluginId}`);
      if (Boolean(preferences.enabled[pluginId]) === enabled && active.has(pluginId) === enabled) return;
      if (enabled) {
        await activate(definition);
        preferences.enabled[pluginId] = true;
      } else {
        await deactivate(definition);
        preferences.enabled[pluginId] = false;
      }
      onChange();
    }

    function emit(name, detail) {
      for (const callback of [...(listeners.get(name) ?? [])]) {
        try {
          callback(detail);
        } catch (error) {
          report(error, `handling ${name}`);
        }
      }
    }

    return Object.freeze({
      start,
      setEnabled,
      isEnabled: (pluginId) => active.has(pluginId),
      plugins: () => [...registry.values()].map((definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        category: definition.category ?? "Utilities",
        version: definition.version ?? "1.0.0",
        enabled: Boolean(preferences.enabled[definition.id]),
        active: active.has(definition.id)
      })),
      commands: () => [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
      panels: () => [...panels.values()],
      statusItems: () => [...statusItems.values()],
      emit,
      serialize: () => clone(preferences)
    });
  }

  window.PinboardPluginSystem = Object.freeze({ create });
})();
