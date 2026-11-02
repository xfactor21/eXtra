/* ============================================================================
 * xPin plugin template — STATUS BAR
 * ----------------------------------------------------------------------------
 * A working template for plugins that live in the editor status bar and stay
 * fresh while you type. Copy this folder, change the `id` in manifest.json,
 * and build your own live indicator.
 *
 * Pack it:   node plugins/pack.mjs plugins/templates/statusbar
 * Install:   xPin → Plugins → Choose package → Review → Approve and enable.
 *
 * THE POLLING PATTERN (the whole trick)
 * Plugins can't subscribe to editor events — but setInterval works in the
 * worker, and api.notes.current() is cheap. Poll at 2s or slower; the
 * sandbox allows 150 messages per 10 seconds, so 0.5 Hz is comfortably
 * inside the budget. Always clear the interval in the cleanup function that
 * activate() returns, and never let a poll throw (a throwing interval keeps
 * throwing forever — catch everything inside it).
 * ========================================================================== */

xPinPlugin.register({
  activate(api) {
    const STATUS_ID = "demo-status";

    // Refresh the indicator. Separate function so both the interval and the
    // manual command share one code path.
    async function refresh() {
      const note = await api.notes.current();
      if (!note) {
        await api.ui.clearStatus(STATUS_ID);
        return;
      }
      const text = note.body || "";
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const chars = text.length;
      // Status text must stay under 80 characters.
      await api.ui.setStatus({ id: STATUS_ID, text: `${words}w · ${chars}c` });
    }

    // Poll gently. 2000ms is the recommended floor for status plugins.
    const timer = setInterval(async () => {
      try {
        await refresh();
      } catch {
        /* status is best-effort — never crash the interval */
      }
    }, 2000);

    // Prime it immediately so the bar isn't empty for the first 2 seconds.
    refresh().catch(() => {});

    // A manual refresh command is good manners: it gives the user control
    // and a visible entry in the command palette.
    api.commands.add({
      id: "refresh-now",
      name: "Refresh status indicator",
      description: "Update the status bar reading right now.",
      run: async () => {
        try {
          await refresh();
        } catch (error) {
          await api.ui.notify(`Refresh failed: ${error.message}`);
        }
      },
    });

    // Cleanup: xPin calls this when the plugin is disabled or removed.
    return async () => {
      clearInterval(timer);
      try {
        await api.ui.clearStatus(STATUS_ID);
      } catch {
        /* already gone — fine */
      }
    };
  },
});
