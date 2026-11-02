// case-converter — UPPERCASE / lowercase / Title Case for the current note.
//
// TEACHING NOTES:
// - The plugin reads the current note with `notes:read` (via current())
//   and writes the transformed title+body back with `notes:update`.
//   Both permissions must be declared because we touch the note store.
// - `notes:update` requires at least one of {title, body}; we always
//   send both since the transform applies to both.
// - Each `run` is wrapped in try/catch and the user is told what happened
//   with a short toast — no silent failures.

xPinPlugin.register({
  async activate(api) {
    // Title Case: capitalize the first letter of every word, lowercase
    // the rest. Simple heuristic — fine for note titles and prose.
    function toTitleCase(text) {
      return text
        .toLowerCase()
        .replace(/(^|\s|[("'\-–—])(\p{L})/gu, (m, boundary, letter) =>
          boundary + letter.toUpperCase()
        );
    }

    const transforms = [
      {
        id: "uppercase-note",
        name: "UPPERCASE note",
        description: "Convert the current note's title and body to UPPERCASE.",
        fn: (t) => t.toUpperCase(),
        label: "UPPERCASE",
      },
      {
        id: "lowercase-note",
        name: "lowercase note",
        description: "Convert the current note's title and body to lowercase.",
        fn: (t) => t.toLowerCase(),
        label: "lowercase",
      },
      {
        id: "title-case-note",
        name: "Title Case note",
        description: "Convert the current note's title and body to Title Case.",
        fn: toTitleCase,
        label: "Title Case",
      },
    ];

    for (const t of transforms) {
      api.commands.add({
        id: t.id,
        name: t.name,
        description: t.description,
        run: async () => {
          try {
            const note = await api.notes.current();
            if (!note) {
              await api.ui.notify("No note is open.");
              return;
            }
            const newTitle = t.fn(note.title || "");
            const newBody = t.fn(note.body || "");
            await api.notes.update(note.id, { title: newTitle, body: newBody });
            await api.ui.notify(`Converted to ${t.label}.`);
          } catch (e) {
            await api.ui.notify(`Case conversion failed: ${e.message || e}`);
          }
        },
      });
    }
  },
});
