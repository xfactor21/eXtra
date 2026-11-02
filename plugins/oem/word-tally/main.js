// word-tally — live word + character count in the status bar.
//
// TEACHING NOTE: this is the canonical "live-update" plugin. Because the
// worker has no event subscription API, plugins poll on a timer. A 2-second
// interval (0.5 Hz) is inside the sandbox message budget, and `activate`
// returns a cleanup function so the host can stop the timer when the
// plugin is disabled or the workspace closes.

xPinPlugin.register({
  // activate runs once when the plugin is loaded. It may be async.
  async activate(api) {
    // Count "words" the way a writer would: split on any whitespace run.
    // Returns 0 for empty/blank text instead of counting a phantom word.
    function countWords(text) {
      const trimmed = text.trim();
      if (!trimmed) return 0;
      return trimmed.split(/\s+/).length;
    }

    // Poll every 2 seconds: read the current note, then update the
    // status-bar item. The try/catch keeps one transient failure from
    // killing the interval (uncaught rejections in timers are silent).
    const timer = setInterval(async () => {
      try {
        const note = await api.notes.current();

        // No note open (or note closed while polling): clear our item so
        // stale counts don't linger in the status bar.
        if (!note) {
          await api.ui.clearStatus("word-tally");
          return;
        }

        const body = note.body || "";
        const words = countWords(body);
        const chars = body.length;

        // status text must be ≤ 80 chars; this is far under.
        await api.ui.setStatus({
          id: "word-tally",
          text: `${words} words · ${chars} chars`,
        });
      } catch (e) {
        // Swallow poll errors deliberately — a busy host shouldn't
        // spam toasts every 2 seconds. Next tick retries.
      }
    }, 2000);

    // Returning a function registers it as the plugin's cleanup hook.
    // The host calls it on disable/unload — always clear your intervals.
    return () => clearInterval(timer);
  },
});
