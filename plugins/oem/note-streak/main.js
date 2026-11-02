/* xPin OEM plugin: note-streak
 *
 * A writing streak tracker. The status bar shows "🔥 4-day streak": the
 * number of consecutive calendar days (up to today) with at least one note
 * created. It refreshes every 60 seconds, plus once at startup. The
 * "Show streak details" command reports the current streak, the longest
 * streak ever, and the total note count.
 *
 * Rules of the streak:
 *  - A day counts if at least one note has a createdAt on that local day.
 *  - If today has no notes yet, the streak is counted back from yesterday,
 *    so a midday check doesn't reset you to zero unfairly.
 *  - The "best" streak is the longest unbroken run of note-creating days.
 *
 * Date arithmetic is done on (year, month, day) tuples via the local Date
 * object so daylight-saving transitions can't split or merge a day.
 */

xPinPlugin.register({
  activate: async (api) => {
    const STATUS_ID = "note-streak";

    // Local "YYYY-MM-DD" for a Date.
    const dateKey = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;

    // Key of the calendar day after the given key (DST-safe).
    const nextKey = (key) => {
      const [y, m, d] = key.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      date.setDate(date.getDate() + 1);
      return dateKey(date);
    };

    // Build the streak stats from the note list.
    async function compute() {
      const notes = await api.notes.list();
      const daysWithNotes = new Set();
      for (const note of notes) {
        daysWithNotes.add(dateKey(new Date(note.createdAt)));
      }

      // Current streak: walk backwards from today (or yesterday if today
      // has no notes yet) while each day has at least one created note.
      let streak = 0;
      const cursor = new Date();
      cursor.setHours(0, 0, 0, 0);
      if (!daysWithNotes.has(dateKey(cursor))) {
        cursor.setDate(cursor.getDate() - 1); // today doesn't count yet — don't reset
      }
      while (daysWithNotes.has(dateKey(cursor))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
      }

      // Best streak: longest run of consecutive keys, sorted chronologically
      // (the zero-padded keys sort correctly as strings).
      let best = 0;
      let run = 0;
      let previous = null;
      for (const key of [...daysWithNotes].sort()) {
        run = previous !== null && nextKey(previous) === key ? run + 1 : 1;
        if (run > best) best = run;
        previous = key;
      }

      return { streak, best, total: notes.length };
    }

    // Update the status bar with the current streak.
    async function refresh() {
      const { streak } = await compute();
      await api.ui.setStatus({
        id: STATUS_ID,
        text: streak > 0 ? `🔥 ${streak}-day streak` : "No streak yet",
      });
    }

    // Every command is wrapped so failures surface as a toast, never silence.
    const safe = (fn) => async () => {
      try {
        await fn();
      } catch (err) {
        await api.ui.notify(`Streak error: ${err && err.message ? err.message : err}`);
      }
    };

    await api.commands.add({
      id: "show-streak",
      name: "Show streak details",
      description: "Current streak, longest streak, and total notes.",
      run: safe(async () => {
        const { streak, best, total } = await compute();
        const noun = streak === 1 ? "day" : "days";
        await api.ui.notify(
          `🔥 ${streak}-${noun} streak · best ${best} · ${total} notes.`
        );
      }),
    });

    // Refresh every 60s — a streak only changes once a day, so this is
    // deliberately lazy (one bounded list() + one setStatus per minute).
    const handle = setInterval(() => {
      refresh().catch((err) =>
        api.ui.notify(`Streak error: ${err && err.message ? err.message : err}`)
      );
    }, 60_000);
    await refresh(); // show a value immediately on load

    // Cleanup: stop polling when the plugin is disabled or reloaded.
    return async () => {
      clearInterval(handle);
      await api.ui.clearStatus(STATUS_ID);
    };
  },
});
