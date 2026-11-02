/* xPin OEM plugin: pomodoro-focus
 *
 * A Pomodoro timer that lives in the xPin status bar. It runs entirely on
 * worker-side timers: `setInterval` ticks once a second, does plain
 * Date.now() arithmetic locally, and only crosses the sandbox boundary to
 * push the `mm:ss` countdown into the status bar (well inside the 0.5 Hz
 * message budget, since each setStatus is tiny and local math costs
 * nothing). When a session finishes it fires a toast, then the timer
 * clears itself so nothing keeps ticking in the background.
 *
 * Durations are stored per-plugin settings (`focusMinutes`, `breakMinutes`).
 * Because the worker has no text-input API, the two "Set … length" commands
 * cycle through sensible presets instead of asking for a number.
 */

xPinPlugin.register({
  activate: async (api) => {
    const STATUS_ID = "pomodoro"; // lowercase-hyphen, shown in the status bar
    const FOCUS_PRESETS = [15, 25, 45, 60];
    const BREAK_PRESETS = [5, 10, 15];

    // Live timer state. In-memory only: if the plugin reloads, the running
    // session simply ends (the cleanup function below makes that explicit).
    let timer = null; // { phase: "focus"|"break", endsAt: number, handle: number }

    // Format a millisecond remainder as "m:ss", e.g. 25*60_000 -> "25:00".
    const formatRemaining = (ms) => {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    // Stop the ticking interval and remove the status item. Safe to call
    // when no timer is running.
    async function stopTimer() {
      if (timer) {
        clearInterval(timer.handle);
        timer = null;
      }
      await api.ui.clearStatus(STATUS_ID);
    }

    // One tick: read the clock, update the status bar, or finish the session.
    async function tick() {
      if (!timer) return;
      const remaining = timer.endsAt - Date.now();

      if (remaining <= 0) {
        const finished = timer.phase;
        await stopTimer();
        await api.ui.notify(
          finished === "focus"
            ? "Focus session done. Take a break."
            : "Break over. Back to focus."
        );
        return;
      }

      const label = timer.phase === "focus" ? "Focus" : "Break";
      await api.ui.setStatus({
        id: STATUS_ID,
        text: `${label} ${formatRemaining(remaining)}`,
      });
    }

    // Start a session of the given phase using the stored duration.
    async function startTimer(phase) {
      const key = phase === "focus" ? "focusMinutes" : "breakMinutes";
      const fallback = phase === "focus" ? 25 : 5;
      const minutes = await api.settings.get(key, fallback);

      await stopTimer(); // starting a new timer always replaces the old one
      timer = {
        phase,
        endsAt: Date.now() + minutes * 60_000,
        handle: setInterval(() => {
          // Never let a tick failure kill the timer or go unreported.
          tick().catch((err) =>
            api.ui.notify(`Timer error: ${err && err.message ? err.message : err}`)
          );
        }, 1000),
      };
      await tick();
      await api.ui.notify(
        `${phase === "focus" ? "Focus" : "Break"} timer: ${minutes} min.`
      );
    }

    // Advance a duration setting to the next preset in its list.
    async function cycleLength(kind) {
      const isFocus = kind === "focus";
      const presets = isFocus ? FOCUS_PRESETS : BREAK_PRESETS;
      const key = isFocus ? "focusMinutes" : "breakMinutes";
      const current = await api.settings.get(key, presets[1]);
      const next = presets[(presets.indexOf(current) + 1) % presets.length];
      await api.settings.set(key, next);
      await api.ui.notify(`${isFocus ? "Focus" : "Break"} length: ${next} min.`);
    }

    // Every command is wrapped so failures surface as a toast, never silence.
    const safe = (fn) => async () => {
      try {
        await fn();
      } catch (err) {
        await api.ui.notify(`Timer error: ${err && err.message ? err.message : err}`);
      }
    };

    await api.commands.add({
      id: "start-focus",
      name: "Start focus (25m)",
      description: "Start a Pomodoro focus session.",
      run: safe(() => startTimer("focus")),
    });
    await api.commands.add({
      id: "start-break",
      name: "Start break (5m)",
      description: "Start a short break timer.",
      run: safe(() => startTimer("break")),
    });
    await api.commands.add({
      id: "stop-timer",
      name: "Stop timer",
      description: "Stop the running Pomodoro timer.",
      run: safe(stopTimer),
    });
    await api.commands.add({
      id: "set-focus-length",
      name: "Set focus length",
      description: "Cycle focus presets: 15, 25, 45, 60 minutes.",
      run: safe(() => cycleLength("focus")),
    });
    await api.commands.add({
      id: "set-break-length",
      name: "Set break length",
      description: "Cycle break presets: 5, 10, 15 minutes.",
      run: safe(() => cycleLength("break")),
    });

    // Cleanup: the host calls this when the plugin is disabled or reloaded.
    // Always clear the interval so the worker stops waking up.
    return async () => {
      await stopTimer();
    };
  },
});
