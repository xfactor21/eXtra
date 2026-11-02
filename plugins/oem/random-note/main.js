/* random-note — xPin OEM plugin
 *
 * One command: pick a note uniformly at random from the whole collection and
 * open it in the editor, telling you its title in a toast.
 *
 * Everything happens through the sandboxed `api` object; every api call is
 * async and must be awaited because it crosses the worker boundary.
 */

xPinPlugin.register({
  activate(api) {
    // "Open random note" — needs "commands:register".
    api.commands.add({
      id: "open-random-note",
      name: "Open random note",
      description: "Open a uniformly random note from your collection.",
      run: async () => {
        // Never fail silently: report problems to the user instead.
        try {
          // Needs "notes:read". Returns up to 500 notes.
          const notes = await api.notes.list();

          if (notes.length === 0) {
            // Needs "ui:notify". Messages are capped at 200 chars — keep short.
            await api.ui.notify("No notes yet — create one first.");
            return;
          }

          // Uniform draw: every index in [0, notes.length) is equally likely.
          const pick = notes[Math.floor(Math.random() * notes.length)];

          // Needs "notes:select". Opens the note in the editor.
          await api.notes.select(pick.id);

          // The title is the most useful thing to announce.
          await api.ui.notify(`🎲 ${pick.title}`);
        } catch (err) {
          await api.ui.notify(`Random note failed: ${err.message || err}`);
        }
      },
    });
  },
});
