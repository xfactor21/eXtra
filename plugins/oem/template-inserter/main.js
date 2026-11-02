/* xPin OEM plugin: template-inserter
 *
 * Four markdown skeletons, one command each, inserted at the cursor with
 * `api.editor.insertText`. If no note is open, insertText creates one, so
 * these commands always work. Each template is small (well under the 5 KB
 * insert limit) and uses checkbox bullets and headings so the result is
 * immediately usable without editing.
 *
 * This plugin needs only two permissions: `commands:register` for the
 * palette entries and `editor:write` for the insertion. It reads no notes
 * and stores no settings.
 */

xPinPlugin.register({
  activate: async (api) => {
    // Local "YYYY-MM-DD" for stamping templates.
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    };

    // The templates themselves. Kept as functions so the date stamp is
    // computed fresh on every insertion.
    const templates = {
      meeting: () => `## Meeting —

**Date:** ${today()}
**Attendees:**

### Agenda
-

### Notes
-

### Action items
- [ ]
`,
      dailyLog: () => `## Daily log — ${today()}

### Focus today
-

### Tasks
- [ ]

### Notes
-

### Wins
-
`,
      decisionRecord: () => `## Decision —

**Date:** ${today()}
**Status:** Proposed

### Context

### Decision

### Consequences
-
`,
      bookNotes: () => `## Book notes —

**Author:**
**Started:** ${today()}

### Key ideas
1.

### Favorite quotes
>

### Takeaways
-
`,
    };

    // Insert a template; report failures as a toast, never silently.
    async function insert(kind) {
      try {
        await api.editor.insertText(templates[kind]());
      } catch (err) {
        await api.ui.notify(
          `Couldn't insert template: ${err && err.message ? err.message : err}`
        );
      }
    }

    await api.commands.add({
      id: "insert-meeting",
      name: "Insert meeting template",
      description: "Agenda, notes and action items skeleton.",
      run: () => insert("meeting"),
    });
    await api.commands.add({
      id: "insert-daily-log",
      name: "Insert daily log template",
      description: "Focus, tasks, notes and wins for today.",
      run: () => insert("dailyLog"),
    });
    await api.commands.add({
      id: "insert-decision",
      name: "Insert decision record",
      description: "Lightweight ADR: context, decision, consequences.",
      run: () => insert("decisionRecord"),
    });
    await api.commands.add({
      id: "insert-book-notes",
      name: "Insert book notes template",
      description: "Key ideas, quotes and takeaways skeleton.",
      run: () => insert("bookNotes"),
    });

    // No timers, no intervals — nothing to clean up.
  },
});
