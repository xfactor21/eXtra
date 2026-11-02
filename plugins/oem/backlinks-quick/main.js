/* backlinks-quick — xPin OEM plugin
 *
 * Two commands that work on the note you have open right now:
 *   1. "Count backlinks" — toast "N notes link here".
 *   2. "Jump to next backlink" — open the next note whose body contains
 *      [[<current title>]], cycling through them and wrapping around.
 *
 * The cycle position is stored in the plugin's settings (per note id) so it
 * persists across sessions. Settings values must be JSON under 16 KB.
 */

xPinPlugin.register({
  activate(api) {
    // Find every note whose body contains [[title]] — literal substring
    // match, not a regex. Excludes the note itself.
    const findBacklinks = async (note) => {
      const all = await api.notes.list();
      const marker = `[[${note.title}]]`;
      return all
        .filter((n) => n.id !== note.id && typeof n.body === "string" && n.body.includes(marker))
        // Sort by updatedAt for a stable, sensible cycle order.
        .sort((a, b) => b.updatedAt - a.updatedAt);
    };

    // --- "Count backlinks"
    api.commands.add({
      id: "count-backlinks",
      name: "Count backlinks",
      description: "Show how many notes link to the current note.",
      run: async () => {
        try {
          const current = await api.notes.current();
          if (!current) {
            await api.ui.notify("Open a note first.");
            return;
          }
          const backlinks = await findBacklinks(current);
          const word = backlinks.length === 1 ? "note" : "notes";
          await api.ui.notify(`${backlinks.length} ${word} link here.`);
        } catch (err) {
          await api.ui.notify(`Backlink count failed: ${err.message || err}`);
        }
      },
    });

    // --- "Jump to next backlink"
    api.commands.add({
      id: "jump-next-backlink",
      name: "Jump to next backlink",
      description: "Open the next note that links to the current note.",
      run: async () => {
        try {
          const current = await api.notes.current();
          if (!current) {
            await api.ui.notify("Open a note first.");
            return;
          }
          const backlinks = await findBacklinks(current);
          if (backlinks.length === 0) {
            await api.ui.notify("No notes link here.");
            return;
          }

          // Read the persisted cycle position for this note.
          const key = `backlinkIndex:${current.id}`;
          const stored = await api.settings.get(key, 0);
          // Guard against stale/invalid values (e.g. notes were deleted).
          const index = Number.isInteger(stored) && stored >= 0 ? stored % backlinks.length : 0;

          const target = backlinks[index];
          await api.notes.select(target.id);
          await api.ui.notify(`🔗 ${index + 1}/${backlinks.length}: ${target.title}`);

          // Persist the NEXT position so repeated runs keep cycling.
          await api.settings.set(key, (index + 1) % backlinks.length);
        } catch (err) {
          await api.ui.notify(`Backlink jump failed: ${err.message || err}`);
        }
      },
    });
  },
});
