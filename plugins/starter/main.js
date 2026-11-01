/* xPin plugin starter — copy this folder, rename the id in manifest.json,
 * and make it yours. There is no build step: run
 *   node plugins/pack.mjs plugins/starter
 * to produce the importable my-first-plugin.xpin.json, then import it in xPin
 * via Plugins → Choose package.
 *
 * Your code runs in an isolated worker: no DOM, no localStorage, no network.
 * Everything below goes through the `api` object xPin hands your activate().
 * Every api call that crosses the sandbox boundary returns a promise.
 */

xPinPlugin.register({
  // activate runs once when the plugin is approved and enabled.
  // Return an async cleanup function if you need one (optional).
  activate(api) {
    // --- commands: actions in the command palette (needs "commands:register")
    api.commands.add({
      id: "greet",                       // unique within your plugin, lowercase-hyphens
      name: "Say hello",                 // shown in the palette
      description: "Show a greeting.",   // optional
      run: async () => {
        // --- ui.notify (needs "ui:notify")
        await api.ui.notify("Hello from my first plugin.");
      },
    });

    // --- notes (needs "notes:read" / "notes:create" / "notes:update")
    //
    // const notes = await api.notes.list();          // [{ id, title, body, ... }] (max 500)
    // const current = await api.notes.current();     // the open note, or null
    // await api.notes.select(noteId);                // open a note in the editor
    // const note = await api.notes.create({          // create a note
    //   title: "Shopping", body: "- milk", folderId: null,
    // });
    // await api.notes.update(noteId, {                // edit title and/or body
    //   title: "Shopping (Friday)",
    // });

    // --- editor (needs "editor:write")
    //
    // await api.editor.insertText("## Notes\n\n");   // insert at the caret

    // --- status bar (needs "ui:status")
    //
    // await api.ui.setStatus({ id: "mood", text: "☀ focused" });
    // await api.ui.clearStatus("mood");

    // --- settings: your plugin's own private key/value store
    // (needs "settings:read" / "settings:write"; values must be JSON under 16 KB)
    //
    // const name = await api.settings.get("name", "friend");
    // await api.settings.set("name", "Ada");
  },
});
