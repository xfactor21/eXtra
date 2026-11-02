# Text Statistics

Two command-palette commands for the note currently open in the editor:

1. **Show text statistics** — a compact one-line toast:
   `123 words · 456 chars · 7 sentences · 3 paragraphs`
2. **Insert statistics report** — writes a fuller markdown table report
   (words, characters with/without spaces, sentences, paragraphs, lines)
   at the cursor position.

Both commands are fully automatic (no dialogs exist in the sandbox) and
report failures as toasts instead of failing silently.

Permissions: `notes:read`, `commands:register`, `ui:notify`, `editor:write`.
