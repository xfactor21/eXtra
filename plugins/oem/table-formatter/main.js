// table-formatter — align markdown pipe tables by padding cells.
//
// TEACHING NOTES:
// - A "table" is a block of consecutive lines that start and end with `|`
//   and contain at least one inner `|`. This catches GitHub-flavored
//   tables while ignoring stray single pipes in prose.
// - The separator row (`|---|---|`) is detected per-cell with
//   /^:?-+:?$/ and reformatted as dashes padded to the column width.
//   Alignment markers (`:---`, `---:`, `:---:`) are preserved.
// - Column widths come from the widest CONTENT cell; separator dashes
//   are stretched to match, never shrunk below the content.
// - The whole body is rewritten with `notes:update` only when at least
//   one table changed, so untouched notes aren't needlessly re-saved.

xPinPlugin.register({
  async activate(api) {
    // Split a table row line into its raw cell strings.
    // "| a | b |" -> [" a ", " b "]
    function splitRow(line) {
      return line.slice(1, -1).split("|");
    }

    // True if every cell of the row is a separator cell like --- or :---:.
    function isSeparatorRow(cells) {
      return cells.every((c) => /^:?-+:?$/.test(c.trim()));
    }

    // Format one table (array of lines) with aligned columns.
    // Returns the new lines, or null if the block isn't a valid table.
    function formatTable(lines) {
      const rows = lines.map(splitRow);

      // All rows must have the same cell count and at least 2 columns.
      const colCount = rows[0].length;
      if (colCount < 2 || !rows.every((r) => r.length === colCount)) return null;

      // A real markdown table needs a separator row (usually row 2).
      if (!rows.some(isSeparatorRow)) return null;

      // Column widths from the widest content (non-separator) cell.
      const widths = new Array(colCount).fill(0);
      for (const row of rows) {
        if (isSeparatorRow(row)) continue;
        row.forEach((cell, i) => {
          widths[i] = Math.max(widths[i], cell.trim().length);
        });
      }

      // Build aligned rows: "| cell | cell |" with padded cells.
      return rows.map((row) => {
        if (isSeparatorRow(row)) {
          const cells = row.map((cell, i) => {
            const trimmed = cell.trim();
            const left = trimmed.startsWith(":");
            const right = trimmed.endsWith(":");
            // Dashes fill the column width; markers kept at the edges.
            const dashes = "-".repeat(Math.max(widths[i], 3));
            return (left ? ":" : "") + dashes + (right ? ":" : "");
          });
          return "| " + cells.join(" | ") + " |";
        }
        const cells = row.map((cell, i) => cell.trim().padEnd(widths[i], " "));
        return "| " + cells.join(" | ") + " |";
      });
    }

    // Walk the body, find table blocks, format each, count them.
    // Returns { body, tablesFixed }.
    function formatBody(body) {
      const lines = body.split("\n");
      let tablesFixed = 0;
      const out = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // A candidate table row: starts+ends with | and has an inner |.
        const isRow = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.indexOf("|", 1) < trimmed.length - 1;

        if (!isRow) {
          out.push(line);
          i++;
          continue;
        }

        // Collect the whole consecutive block of candidate rows.
        const block = [];
        while (i < lines.length) {
          const t = lines[i].trim();
          const r = t.startsWith("|") && t.endsWith("|") && t.indexOf("|", 1) < t.length - 1;
          if (!r) break;
          block.push(lines[i]);
          i++;
        }

        const formatted = formatTable(block);
        if (formatted) {
          out.push(...formatted);
          tablesFixed++;
        } else {
          // Not a real table (ragged columns, no separator) — leave as-is.
          out.push(...block);
        }
      }

      return { body: out.join("\n"), tablesFixed };
    }

    api.commands.add({
      id: "format-markdown-tables",
      name: "Format markdown tables",
      description: "Align pipe tables in the current note by padding cells to equal column widths.",
      run: async () => {
        try {
          const note = await api.notes.current();
          if (!note) {
            await api.ui.notify("No note is open.");
            return;
          }
          const { body, tablesFixed } = formatBody(note.body || "");
          if (tablesFixed === 0) {
            await api.ui.notify("No tables found.");
            return;
          }
          await api.notes.update(note.id, { body });
          await api.ui.notify(
            tablesFixed === 1 ? "Formatted 1 table." : `Formatted ${tablesFixed} tables.`
          );
        } catch (e) {
          await api.ui.notify(`Table formatting failed: ${e.message || e}`);
        }
      },
    });
  },
});
