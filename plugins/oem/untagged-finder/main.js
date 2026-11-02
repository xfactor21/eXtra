/* untagged-finder — xPin OEM plugin
 *
 * Two commands to help you tag the notes that slipped through:
 *   1. "Count untagged notes" — toast how many notes have no #hashtags.
 *   2. "Open next untagged note" — open the next untagged note, cycling
 *      through them and wrapping around, so you can tag them one at a time.
 *
 * xPin tags are inline #hashtags in the title/body text (there is no tags
 * field), so "untagged" means the text contains no #tag. The cycle position
 * lives in settings so it persists across sessions.
 */

xPinPlugin.register({
  activate(api) {
    const SETTING_KEY = "untaggedIndex";

    // A note is untagged when its title+body contain no #hashtags.
    // (xPin tags are inline #tags in the text — there is no tags field.)
    const extractTags = (note) => {
      const text = `${note.title || ""}\n${note.body || ""}`;
      const tags = new Set();
      for (const match of text.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi)) {
        tags.add(`#${match[1].toLowerCase()}`);
      }
      return [...tags];
    };
    const findUntagged = async () => {
      const all = await api.notes.list();
      return all
        .filter((n) => extractTags(n).length === 0)
        // newest first; Date.parse because updatedAt is an ISO string
        // (string subtraction would be NaN and silently not sort)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    };

    // --- "Count untagged notes"
    api.commands.add({
      id: "count-untagged-notes",
      name: "Count untagged notes",
      description: "Show how many notes have no tags.",
      run: async () => {
        try {
          const untagged = await findUntagged();
          const word = untagged.length === 1 ? "note" : "notes";
          await api.ui.notify(`${untagged.length} untagged ${word}.`);
        } catch (err) {
          await api.ui.notify(`Untagged count failed: ${err.message || err}`);
        }
      },
    });

    // --- "Open next untagged note"
    api.commands.add({
      id: "open-next-untagged-note",
      name: "Open next untagged note",
      description: "Cycle through notes that have no tags.",
      run: async () => {
        try {
          const untagged = await findUntagged();
          if (untagged.length === 0) {
            await api.ui.notify("🎉 Every note is tagged.");
            return;
          }

          // Read the persisted index; modulo keeps stale values safe
          // when notes are tagged or deleted between runs.
          const stored = await api.settings.get(SETTING_KEY, 0);
          const index = Number.isInteger(stored) && stored >= 0 ? stored % untagged.length : 0;

          const target = untagged[index];
          await api.notes.select(target.id);
          await api.ui.notify(`🏷️ ${index + 1}/${untagged.length}: ${target.title}`);

          await api.settings.set(SETTING_KEY, (index + 1) % untagged.length);
        } catch (err) {
          await api.ui.notify(`Untagged cycle failed: ${err.message || err}`);
        }
      },
    });
  },
});
