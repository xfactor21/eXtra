# Note Streak

Your consecutive-days writing streak in the status bar.

**Commands:** `Show streak details` (current streak, longest streak, total notes).

**How it works:** refreshes every 60s — a day counts when at least one note was created on it (local time). If today has no notes yet, the streak counts back from yesterday so you aren't reset mid-morning. All date math is DST-safe.

Pack: `node plugins/pack.mjs plugins/oem/note-streak`
