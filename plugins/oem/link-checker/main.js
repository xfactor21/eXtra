/* link-checker — xPin OEM plugin
 *
 * One command: "Find broken links". Scans every note's body for [[wiki-link]]
 * targets and reports any target that does not exactly match the title of an
 * existing note. The toast shows the count plus the first 2–3 broken
 * targets, all within the 200-char toast limit.
 */

xPinPlugin.register({
  activate(api) {
    // Extract all [[...]] link targets from a body. Simple regex — wiki-link
    // targets never contain brackets or newlines in xPin.
    const extractTargets = (body) => {
      const targets = [];
      const re = /\[\[([^\][]+)\]\]/g;
      let match;
      while ((match = re.exec(body)) !== null) {
        const target = match[1].trim();
        if (target) targets.push(target);
      }
      return targets;
    };

    api.commands.add({
      id: "find-broken-links",
      name: "Find broken links",
      description: "Report [[wiki-links]] with no matching note title.",
      run: async () => {
        try {
          const notes = await api.notes.list();

          // Exact, case-sensitive title match, as xPin resolves links.
          const titles = new Set(notes.map((n) => n.title));

          // Collect each broken target once, in first-seen order.
          const seen = new Set();
          const broken = [];
          for (const note of notes) {
            if (typeof note.body !== "string") continue;
            for (const target of extractTargets(note.body)) {
              if (!titles.has(target) && !seen.has(target)) {
                seen.add(target);
                broken.push(target);
              }
            }
          }

          if (broken.length === 0) {
            await api.ui.notify("✅ No broken links found.");
            return;
          }

          const word = broken.length === 1 ? "link" : "links";
          // Show the first 3 targets; keep the toast under 200 chars.
          let message = `🔗 ${broken.length} broken ${word}: ${broken.slice(0, 3).join(", ")}`;
          if (broken.length > 3) message += ", …";
          await api.ui.notify(message.slice(0, 195));
        } catch (err) {
          await api.ui.notify(`Link check failed: ${err.message || err}`);
        }
      },
    });
  },
});
