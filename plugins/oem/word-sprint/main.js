/* xPin OEM plugin: word-sprint
 *
 * Timed writing sprints. "Start word sprint" snapshots the word count of the
 * currently open note, then counts down in the status bar as "123/300 ·
 * 12:34 left". Finish the target early and you get a congratulations toast;
 * run out of time and you get your final tally. Settings-driven
 * (`targetWords` default 300, `minutes` default 15) with preset-cycling
 * commands since the worker has no text-input API.
 *
 * Implementation notes for the curious:
 *  - The baseline is captured from the note that is open when the sprint
 *    starts; if you switch to another note mid-sprint the status bar says
 *    so instead of comparing against the wrong note.
 *  - Word counting is plain whitespace splitting — fast, predictable, and
 *    identical every tick, so the "words since start" delta is stable.
 *  - All sandbox crossings are awaited; the one-second interval only does
 *    cheap local math between pushes.
 */

xPinPlugin.register({
  activate: async (api) => {
    const STATUS_ID = "word-sprint";
    const WORD_PRESETS = [100, 300, 500, 750, 1000];
    const MINUTE_PRESETS = [5, 10, 15, 25, 30];

    // Active sprint state. Null when no sprint is running.
    let sprint = null; // { noteId, baseline, target, endsAt, handle }

    // Count words as runs of non-whitespace. Empty text -> 0.
    const countWords = (text) => {
      if (!text) return 0;
      return text.trim().split(/\s+/).filter(Boolean).length;
    };

    // "m:ss" countdown, e.g. 15*60_000 -> "15:00".
    const formatRemaining = (ms) => {
      const total = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    };

    // Stop the interval and remove the status item. Idempotent.
    async function stopSprint() {
      if (sprint) {
        clearInterval(sprint.handle);
        sprint = null;
      }
      await api.ui.clearStatus(STATUS_ID);
    }

    // One tick: re-read the open note, compute progress vs. baseline, and
    // decide whether the sprint is won, lost, or still running.
    async function tick() {
      if (!sprint) return;

      const target = sprint.target;
      const endsAt = sprint.endsAt;
      const noteId = sprint.noteId;
      const baseline = sprint.baseline;

      // The sprint tracks the note that was open at start; if the user
      // switched away (or closed it), say so instead of counting wrong text.
      const current = await api.notes.current();
      if (!current || current.id !== noteId) {
        const left = Math.max(0, endsAt - Date.now());
        await api.ui.setStatus({
          id: STATUS_ID,
          text: `Sprint paused — reopen the note · ${formatRemaining(left)}`,
        });
        return;
      }

      // Words added since the sprint began (never negative — deletions in
      // the first tick would otherwise look like negative progress).
      const words = Math.max(0, countWords(current.body) - baseline);
      const left = endsAt - Date.now();

      if (words >= target) {
        await stopSprint();
        await api.ui.notify(`Target hit — ${target} words!`);
        return;
      }
      if (left <= 0) {
        await stopSprint();
        await api.ui.notify(`Time's up — ${words}/${target} words.`);
        return;
      }
      await api.ui.setStatus({
        id: STATUS_ID,
        text: `${words}/${target} · ${formatRemaining(left)} left`,
      });
    }

    // Begin a sprint on the currently open note. Requires an open note so
    // there is something to measure.
    async function startSprint() {
      const current = await api.notes.current();
      if (!current) {
        await api.ui.notify("Open a note first, then start the sprint.");
        return;
      }
      const target = await api.settings.get("targetWords", 300);
      const minutes = await api.settings.get("minutes", 15);

      await stopSprint(); // a new sprint replaces any running one
      sprint = {
        noteId: current.id,
        baseline: countWords(current.body),
        target,
        endsAt: Date.now() + minutes * 60_000,
        handle: setInterval(() => {
          tick().catch((err) =>
            api.ui.notify(`Sprint error: ${err && err.message ? err.message : err}`)
          );
        }, 1000),
      };
      await tick();
      await api.ui.notify(`Sprint: ${target} words in ${minutes} min. Go!`);
    }

    // Cycle a numeric setting through its preset list.
    async function cycleSetting(key, presets, label) {
      const current = await api.settings.get(key, presets[1]);
      const next = presets[(presets.indexOf(current) + 1) % presets.length];
      await api.settings.set(key, next);
      await api.ui.notify(`${label}: ${next}.`);
    }

    // Every command is wrapped so failures surface as a toast, never silence.
    const safe = (fn) => async () => {
      try {
        await fn();
      } catch (err) {
        await api.ui.notify(`Sprint error: ${err && err.message ? err.message : err}`);
      }
    };

    await api.commands.add({
      id: "start-sprint",
      name: "Start word sprint",
      description: "Timed writing sprint on the open note.",
      run: safe(startSprint),
    });
    await api.commands.add({
      id: "stop-sprint",
      name: "Stop word sprint",
      description: "Cancel the running sprint without scoring it.",
      run: safe(stopSprint),
    });
    await api.commands.add({
      id: "set-target-words",
      name: "Set sprint word target",
      description: "Cycle targets: 100, 300, 500, 750, 1000 words.",
      run: safe(() => cycleSetting("targetWords", WORD_PRESETS, "Sprint target")),
    });
    await api.commands.add({
      id: "set-sprint-minutes",
      name: "Set sprint length",
      description: "Cycle durations: 5, 10, 15, 25, 30 minutes.",
      run: safe(() => cycleSetting("minutes", MINUTE_PRESETS, "Sprint length")),
    });

    // Cleanup: stop the interval when the plugin is disabled or reloaded.
    return async () => {
      await stopSprint();
    };
  },
});
