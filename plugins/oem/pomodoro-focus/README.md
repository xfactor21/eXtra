# Pomodoro Focus Timer

A Pomodoro timer in the xPin status bar.

**Commands:** `Start focus (25m)`, `Start break (5m)`, `Stop timer`, `Set focus length` (cycles 15/25/45/60 min), `Set break length` (cycles 5/10/15 min).

**How it works:** a 1-second worker-side interval updates the status bar (`Focus 24:59`); when the session ends you get a toast and the timer clears itself. Durations persist in plugin settings. Starting a new timer always replaces the running one. Disabling the plugin stops the interval.

Pack: `node plugins/pack.mjs plugins/oem/pomodoro-focus`
