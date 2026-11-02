// text-stats — statistics commands for the current note.
//
// TEACHING NOTES:
// - Every command `run` is wrapped in try/catch and reports failures via
//   `api.ui.notify` — the sandbox has no console the user sees, and a
//   rejected promise would otherwise fail silently.
// - Toasts are limited to 200 chars; the summary is built to stay far
//   under that by using compact numbers instead of labels per value.
// - `editor:write` inserts at the cursor; if no note is open the host
//   creates one, so `insertText` always has a target.

xPinPlugin.register({
  async activate(api) {
    // Shared counting helpers so both commands agree on the numbers.
    function analyze(text) {
      const chars = text.length;
      const charsNoSpaces = text.replace(/\s/g, "").length;
      const trimmed = text.trim();
      const words = trimmed ? trimmed.split(/\s+/).length : 0;
      // Sentences: split on sentence-ending punctuation followed by space
      // or end of string. Imperfect, but fine for a quick stat.
      const sentences = trimmed ? trimmed.split(/[.!?]+(?:\s|$)/).filter(Boolean).length : 0;
      // Paragraphs: blocks separated by blank lines.
      const paragraphs = trimmed ? trimmed.split(/\n\s*\n/).filter(Boolean).length : 0;
      const lines = text ? text.split("\n").length : 0;
      return { words, chars, charsNoSpaces, sentences, paragraphs, lines };
    }

    api.commands.add({
      id: "show-text-statistics",
      name: "Show text statistics",
      description: "Show a one-line summary of the current note's stats as a toast.",
      run: async () => {
        try {
          const note = await api.notes.current();
          if (!note) {
            await api.ui.notify("No note is open.");
            return;
          }
          const s = analyze(note.body || "");
          // One compact line, well under the 200-char toast limit.
          await api.ui.notify(
            `${s.words} words · ${s.chars} chars · ${s.sentences} sentences · ${s.paragraphs} paragraphs`
          );
        } catch (e) {
          await api.ui.notify(`Could not compute statistics: ${e.message || e}`);
        }
      },
    });

    api.commands.add({
      id: "insert-statistics-report",
      name: "Insert statistics report",
      description: "Insert a markdown statistics report for the current note at the cursor.",
      run: async () => {
        try {
          const note = await api.notes.current();
          if (!note) {
            await api.ui.notify("No note is open.");
            return;
          }
          const s = analyze(note.body || "");
          // A markdown table report — small (≪ 5KB insert limit) and
          // human-readable when rendered or viewed as plain text.
          const report =
            `\n## Text statistics — ${note.title}\n\n` +
            `| Metric | Value |\n` +
            `|---|---|\n` +
            `| Words | ${s.words} |\n` +
            `| Characters | ${s.chars} |\n` +
            `| Characters (no spaces) | ${s.charsNoSpaces} |\n` +
            `| Sentences | ${s.sentences} |\n` +
            `| Paragraphs | ${s.paragraphs} |\n` +
            `| Lines | ${s.lines} |\n`;
          await api.editor.insertText(report);
          await api.ui.notify("Statistics report inserted.");
        } catch (e) {
          await api.ui.notify(`Could not insert report: ${e.message || e}`);
        }
      },
    });
  },
});
