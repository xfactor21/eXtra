// reading-time — live "N min read" estimate in the status bar.
//
// Same live-update pattern as the word-count plugin: poll every 2s,
// update a status-bar item, clear it when no note is open, and return
// a cleanup function that clears the interval.

xPinPlugin.register({
  async activate(api) {
    const WORDS_PER_MINUTE = 200; // standard "medium" reading speed

    function countWords(text) {
      const trimmed = text.trim();
      if (!trimmed) return 0;
      return trimmed.split(/\s+/).length;
    }

    const timer = setInterval(async () => {
      try {
        const note = await api.notes.current();

        if (!note) {
          await api.ui.clearStatus("reading-time");
          return;
        }

        const words = countWords(note.body || "");

        // Always show at least "1 min read" for a non-empty note so a
        // short note never reads as "0 min". Under a minute rounds up.
        const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));

        await api.ui.setStatus({
          id: "reading-time",
          text: minutes === 1 ? "1 min read" : `${minutes} min read`,
        });
      } catch (e) {
        // Transient failure: stay silent, retry on the next tick.
      }
    }, 2000);

    return () => clearInterval(timer);
  },
});
