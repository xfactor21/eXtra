# Word Tally

Live word + character count of the note currently open in the editor,
shown in the status bar and refreshed every 2 seconds.

- **Status item id:** `word-tally`
- **Format:** `12 words · 345 chars`
- The item is cleared automatically when no note is open.
- Poll failures are swallowed silently; the next tick retries.

Permissions: `notes:read`, `ui:status`.
