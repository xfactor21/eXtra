// duplicate-titles — find notes that share the same title.
//
// TEACHING NOTES:
// - `api.notes.list()` returns up to 500 notes with {id, title, ...}.
//   Titles are normalized (trimmed + lowercased) before grouping so
//   "Ideas", " ideas " and "IDEAS" count as the same title.
// - The notification must fit in 200 chars. The message is built as
//   "N duplicate titles: a, b, c" and the title list is truncated so the
//   whole toast never exceeds the limit — truncation favors showing at
//   least one title over showing none.
// - The command is fully automatic: no prompt/dialog APIs exist in the
//   sandbox, so everything needed comes from notes:list().

xPinPlugin.register({
  async activate(api) {
    api.commands.add({
      id: "find-duplicate-titles",
      name: "Find duplicate titles",
      description: "Scan all notes and report titles that are used more than once.",
      run: async () => {
        try {
          const notes = await api.notes.list();
          if (!notes || notes.length === 0) {
            await api.ui.notify("No notes to scan.");
            return;
          }

          // Group note ids by normalized title, remembering the first
          // original-cased title seen for display purposes.
          const groups = new Map(); // normalized -> { display, count }
          for (const note of notes) {
            const key = (note.title || "").trim().toLowerCase();
            if (!key) continue; // skip untitled notes — they aren't "titles"
            if (!groups.has(key)) {
              groups.set(key, { display: note.title.trim(), count: 0 });
            }
            groups.get(key).count++;
          }

          const dupes = [...groups.values()].filter((g) => g.count > 1);

          if (dupes.length === 0) {
            await api.ui.notify("No duplicate titles found.");
            return;
          }

          // Build the toast within the 200-char limit:
          // "3 duplicate titles: Ideas, Meeting notes, …"
          const head = `${dupes.length} duplicate title${dupes.length === 1 ? "" : "s"}: `;
          const budget = 200 - head.length; // chars left for the title list

          const shown = [];
          let used = 0;
          for (const g of dupes) {
            const piece = shown.length === 0 ? g.display : `, ${g.display}`;
            if (used + piece.length > budget - 1) break; // leave room for "…"
            shown.push(g.display);
            used += piece.length;
          }
          const more = dupes.length - shown.length;
          const list = shown.join(", ") + (more > 0 ? `, +${more} more` : "");

          await api.ui.notify(head + list);
        } catch (e) {
          await api.ui.notify(`Duplicate scan failed: ${e.message || e}`);
        }
      },
    });
  },
});
