/* ============================================================================
 * xPin plugin template — NOTE PROCESSOR
 * ----------------------------------------------------------------------------
 * A working template for plugins that batch-process notes: read them all,
 * transform, write back. Copy this folder, change the `id` in manifest.json,
 * and implement your own transform.
 *
 * Pack it:   node plugins/pack.mjs plugins/templates/note-processor
 * Install:   xPin → Plugins → Choose package → Review → Approve and enable.
 *
 * THE PROCESSOR PATTERN
 * 1. `api.notes.list()` gives you every note (≤500, with bodies).
 * 2. Filter to the notes your transform applies to — NEVER touch notes
 *    blindly. This template only touches notes whose body has trailing
 *    whitespace on some line, and it tells the user exactly what changed.
 * 3. `api.notes.update(id, { body })` writes back. Each update bumps
 *    updatedAt and refreshes the UI automatically.
 * 4. Report: notify how many notes changed, and name the limit if you hit
 *    one. A processor that says nothing looks broken.
 *
 * SAFETY
 * - Processors are destructive by nature: keep transforms conservative and
 *   reversible (whitespace, casing, tag normalization — not deletion).
 * - Work on a copy of the body string; only call update() when the result
 *   actually differs, so untouched notes keep their updatedAt.
 * ========================================================================== */

xPinPlugin.register({
  activate(api) {
    // Example transform: strip trailing whitespace from every line.
    // Replace this function with your own — the scaffolding stays the same.
    function transform(body) {
      return body
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n");
    }

    api.commands.add({
      id: "run-processor",
      name: "Tidy trailing whitespace",
      description: "Remove trailing spaces/tabs from every line of every note.",
      run: async () => {
        try {
          const notes = await api.notes.list();
          let changed = 0;
          const failed = [];
          for (const note of notes) {
            const next = transform(note.body || "");
            if (next === note.body) continue; // untouched → skip the write
            try {
              await api.notes.update(note.id, { body: next });
              changed += 1;
            } catch (error) {
              failed.push(note.title);
            }
          }
          if (failed.length) {
            await api.ui.notify(
              `Tidied ${changed} notes; ${failed.length} failed.`
            );
          } else {
            await api.ui.notify(
              changed === 0
                ? "Every note is already tidy."
                : `Tidied trailing whitespace in ${changed} note${changed === 1 ? "" : "s"}.`
            );
          }
        } catch (error) {
          await api.ui.notify(`Processor failed: ${error.message}`);
        }
      },
    });
  },
});
