/* tag-manager — xPin OEM plugin
 *
 * Two commands for tag hygiene:
 *   1. "Tag census" — toast the number of distinct tags plus the top 5 by
 *      usage, all inside the 200-char toast limit.
 *   2. "Create tag index note" — write a "Tag index" note listing every tag
 *      with its note count, most-used first. A handy reference you can keep
 *      pinned.
 *
 * HOW TAGS WORK IN xPin (read this before touching this file):
 * Notes have NO tags field. Tags are `#hashtags` written inline in the note
 * title or body, matched by the pattern below — the same one the host app
 * uses, so the census agrees with xPin's own tag filter. That means "merging"
 * or "renaming" a tag is a text rewrite of note bodies (via notes:update),
 * and there is no prompt API to ask for a new name — so this plugin reports
 * and indexes rather than renames.
 */

xPinPlugin.register({
  activate(api) {
    // Same extraction rule as the host app: a #tag starts at a word
    // boundary, is lowercase-normalized, and may contain letters, digits,
    // slashes, underscores, and hyphens.
    function extractTags(note) {
      const text = `${note.title || ""}\n${note.body || ""}`;
      const tags = new Set();
      for (const match of text.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi)) {
        tags.add(`#${match[1].toLowerCase()}`);
      }
      return [...tags];
    }

    // Map: tag -> { count, noteIds }. Counts each tag once per note.
    function tallyTags(notes) {
      const tally = new Map();
      for (const note of notes) {
        for (const tag of extractTags(note)) {
          let entry = tally.get(tag);
          if (!entry) {
            entry = { count: 0, noteIds: [] };
            tally.set(tag, entry);
          }
          entry.count += 1;
          entry.noteIds.push(note.id);
        }
      }
      return tally;
    }

    function sortedEntries(tally) {
      return [...tally.entries()].sort(
        (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])
      );
    }

    // --- "Tag census" — needs "commands:register", "notes:read", "ui:notify"
    api.commands.add({
      id: "tag-census",
      name: "Tag census",
      description: "Report distinct tags and the top 5 by usage.",
      run: async () => {
        try {
          const notes = await api.notes.list();
          const tally = tallyTags(notes);

          if (tally.size === 0) {
            await api.ui.notify("No tags found on any note.");
            return;
          }

          const top5 = sortedEntries(tally)
            .slice(0, 5)
            .map(([tag, entry]) => `${tag}(${entry.count})`)
            .join(", ");

          // Keep the toast comfortably under 200 chars.
          const message = `${tally.size} tags · top: ${top5}`.slice(0, 190);
          await api.ui.notify(message);
        } catch (err) {
          await api.ui.notify(`Tag census failed: ${err.message || err}`);
        }
      },
    });

    // --- "Create tag index note" — needs "notes:create" as well
    api.commands.add({
      id: "create-tag-index",
      name: "Create tag index note",
      description: "Write a note listing every tag with its note count.",
      run: async () => {
        try {
          const notes = await api.notes.list();
          const tally = tallyTags(notes);

          if (tally.size === 0) {
            await api.ui.notify("No tags found on any note.");
            return;
          }

          const lines = sortedEntries(tally).map(
            ([tag, entry]) =>
              `- ${tag} — ${entry.count} note${entry.count === 1 ? "" : "s"}`
          );
          const body =
            `# Tag index\n\n${tally.size} distinct tags across ${notes.length} notes.\n\n` +
            lines.join("\n") +
            `\n\n_Generated ${new Date().toLocaleString()}_`;
          const note = await api.notes.create({ title: "Tag index", body });
          await api.notes.select(note.id);
          await api.ui.notify(`Tag index created (${tally.size} tags).`);
        } catch (err) {
          await api.ui.notify(`Tag index failed: ${err.message || err}`);
        }
      },
    });
  },
});
