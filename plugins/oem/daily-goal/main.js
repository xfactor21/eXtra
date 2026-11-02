/* xPin OEM plugin: daily-goal
 *
 * A daily writing target. The status bar shows "312/500 words today",
 * refreshed every 30 seconds. A "word written today" is any word in a note
 * that was created or updated today — so drafting, editing, and new pages
 * all count. When the running total first reaches the goal on a given day,
 * you get one congratulations toast; the per-day flag resets at midnight
 * (local time) so tomorrow's race starts clean.
 *
 * The goal itself is stored in the plugin settings (`dailyGoal`) and the
 * "Set daily word goal" command cycles presets (100/250/500/1000/2000)
 * because the worker has no text-input API.
 */

xPinPlugin.register({
  activate: async (api) => {
    const STATUS_ID = "daily-goal";
    const GOAL_PRESETS = [100, 250, 500, 1000, 2000];

    // Count words as runs of non-whitespace. Empty text -> 0.
    const countWords = (text) => {
      if (!text) return 0;
      return text.trim().split(/\s+/).filter(Boolean).length;
    };

    // Local "YYYY-MM-DD" key, e.g. for the once-per-day notification flag.
    const dayKey = (d = new Date()) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;

    // Midnight today in local time; notes at/after this count as "today".
    const todayStart = () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };

    // Recompute the totals and update the status bar. Also handles the
    // once-a-day "goal reached" notification.
    async function refresh() {
      const notes = await api.notes.list(); // up to 500 — fine for a 30s cadence
      const start = todayStart();
      let words = 0;
      for (const note of notes) {
        // Count the whole note if it was created OR touched today.
        const created = new Date(note.createdAt).getTime();
        const updated = new Date(note.updatedAt).getTime();
        if (created >= start || updated >= start) {
          words += countWords(note.body);
        }
      }

      const goal = await api.settings.get("dailyGoal", 500);
      await api.ui.setStatus({
        id: STATUS_ID,
        text: `${words}/${goal} words today`,
      });

      // Celebrate once per day, the first time the goal is reached.
      const today = dayKey();
      const notifiedDay = await api.settings.get("notifiedDay", "");
      if (goal > 0 && words >= goal && notifiedDay !== today) {
        await api.settings.set("notifiedDay", today);
        await api.ui.notify(`Daily goal reached — ${goal} words!`);
      }
    }

    // Cycle the daily goal through the presets.
    async function cycleGoal() {
      const current = await api.settings.get("dailyGoal", 500);
      const next = GOAL_PRESETS[(GOAL_PRESETS.indexOf(current) + 1) % GOAL_PRESETS.length];
      await api.settings.set("dailyGoal", next);
      await refresh();
      await api.ui.notify(`Daily word goal: ${next}.`);
    }

    // Every command is wrapped so failures surface as a toast, never silence.
    const safe = (fn) => async () => {
      try {
        await fn();
      } catch (err) {
        await api.ui.notify(`Goal error: ${err && err.message ? err.message : err}`);
      }
    };

    await api.commands.add({
      id: "set-goal",
      name: "Set daily word goal",
      description: "Cycle presets: 100, 250, 500, 1000, 2000 words.",
      run: safe(cycleGoal),
    });
    await api.commands.add({
      id: "refresh-goal",
      name: "Refresh goal progress",
      description: "Update the status bar word count right now.",
      run: safe(refresh),
    });

    // Refresh on a 30s cadence (0.033 Hz — cheap, and each refresh is one
    // bounded list() call plus one setStatus).
    const handle = setInterval(() => {
      refresh().catch((err) =>
        api.ui.notify(`Goal error: ${err && err.message ? err.message : err}`)
      );
    }, 30_000);
    await refresh(); // show a value immediately on load

    // Cleanup: stop polling when the plugin is disabled or reloaded.
    return async () => {
      clearInterval(handle);
      await api.ui.clearStatus(STATUS_ID);
    };
  },
});
