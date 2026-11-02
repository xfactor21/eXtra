/* xPin OEM plugin: meeting-notes
 *
 * One command — "New meeting note" — that creates a dated meeting note
 * ("Meeting — 2026-11-01") with Attendees / Agenda / Notes / Action items
 * sections, opens it in the editor, and confirms with a toast. It is the
 * fastest path from "meeting starting" to "ready to take notes".
 *
 * Permissions are minimal on purpose: `commands:register` for the palette
 * entry, `notes:create` for the note, `ui:notify` for the confirmation.
 */

xPinPlugin.register({
  activate: async (api) => {
    // Local "YYYY-MM-DD" for the note title and body stamp.
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    };

    await api.commands.add({
      id: "new-meeting-note",
      name: "New meeting note",
      description: "Create and open a dated meeting note.",
      run: async () => {
        try {
          const date = today();
          const note = await api.notes.create({
            // Title is well under the 120-char limit.
            title: `Meeting — ${date}`,
            body: `# Meeting — ${date}

## Attendees
-

## Agenda
-

## Notes
-

## Action items
- [ ]
`,
          });
          await api.notes.select(note.id); // open it in the editor
          await api.ui.notify("Meeting note created.");
        } catch (err) {
          // Failures surface as a toast, never silently.
          await api.ui.notify(
            `Couldn't create the note: ${err && err.message ? err.message : err}`
          );
        }
      },
    });

    // No timers, no intervals — nothing to clean up.
  },
});
