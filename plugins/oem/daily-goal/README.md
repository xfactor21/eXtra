# Daily Word Goal

A daily writing target across all your notes.

**Commands:** `Set daily word goal` (cycles 100/250/500/1000/2000), `Refresh goal progress`.

**How it works:** every 30s it sums the words in notes created or updated today and shows `312/500 words today` in the status bar. The first time the total reaches the goal each day, you get a celebration toast (tracked with a per-day flag, local time). Goal persists in plugin settings.

Pack: `node plugins/pack.mjs plugins/oem/daily-goal`
