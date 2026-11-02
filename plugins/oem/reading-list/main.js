/* reading-list — xPin OEM plugin
 *
 * A read-later queue kept in the plugin's settings (array of note ids):
 *   1. "Add current note to reading list" — queues the open note, skipping
 *      duplicates.
 *   2. "Open next in reading list" — opens the queue head, then rotates it
 *      to the back for round-robin reading. Ids whose notes were deleted
 *      are dropped first.
 *   3. "Reading list size" — toast how many notes are queued.
 *
 * Settings values must be JSON under 16 KB — plenty for a list of ids.
 */

xPinPlugin.register({
  activate(api) {
    const SETTING_KEY = "queue";

    // Load the queue, always returning a clean array of string ids.
    const loadQueue = async () => {
      const raw = await api.settings.get(SETTING_KEY, []);
      return Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && id) : [];
    };

    // Drop queue ids whose notes no longer exist; returns the cleaned
    // queue plus a lookup of id -> note for the survivors.
    const pruneQueue = async (queue) => {
      const all = await api.notes.list();
      const byId = new Map(all.map((n) => [n.id, n]));
      const kept = queue.filter((id) => byId.has(id));
      return { kept, byId };
    };

    // --- "Add current note to reading list"
    api.commands.add({
      id: "add-to-reading-list",
      name: "Add current note to reading list",
      description: "Queue the open note for reading later.",
      run: async () => {
        try {
          const current = await api.notes.current();
          if (!current) {
            await api.ui.notify("Open a note first.");
            return;
          }
          const queue = await loadQueue();
          if (queue.includes(current.id)) {
            await api.ui.notify("Already in your reading list.");
            return;
          }
          queue.push(current.id);
          await api.settings.set(SETTING_KEY, queue);
          await api.ui.notify(`📚 Queued: ${current.title} (${queue.length} total)`);
        } catch (err) {
          await api.ui.notify(`Add to reading list failed: ${err.message || err}`);
        }
      },
    });

    // --- "Open next in reading list"
    api.commands.add({
      id: "open-next-reading-list",
      name: "Open next in reading list",
      description: "Open the next queued note, round-robin.",
      run: async () => {
        try {
          const queue = await loadQueue();
          const { kept, byId } = await pruneQueue(queue);

          if (kept.length === 0) {
            // Persist the cleaned queue so dead ids stay gone.
            await api.settings.set(SETTING_KEY, kept);
            await api.ui.notify("Reading list is empty.");
            return;
          }

          // Take the head, rotate it to the back, persist the new order.
          const [head, ...rest] = kept;
          const next = [...rest, head];
          await api.settings.set(SETTING_KEY, next);

          const note = byId.get(head);
          await api.notes.select(head);
          await api.ui.notify(`📖 ${note.title}`);
        } catch (err) {
          await api.ui.notify(`Reading list failed: ${err.message || err}`);
        }
      },
    });

    // --- "Reading list size"
    api.commands.add({
      id: "reading-list-size",
      name: "Reading list size",
      description: "Show how many notes are queued for reading.",
      run: async () => {
        try {
          const queue = await loadQueue();
          const { kept } = await pruneQueue(queue);
          // Persist the pruned queue so stale ids don't linger.
          if (kept.length !== queue.length) {
            await api.settings.set(SETTING_KEY, kept);
          }
          const word = kept.length === 1 ? "note" : "notes";
          await api.ui.notify(`📚 ${kept.length} ${word} in your reading list.`);
        } catch (err) {
          await api.ui.notify(`Reading list size failed: ${err.message || err}`);
        }
      },
    });
  },
});
