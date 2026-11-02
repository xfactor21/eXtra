# Backlinks Quick

Backlink helpers for the note you have open. A "backlink" is any note whose
body contains `[[<your note's title>]]`.

## Commands

- **Count backlinks** — toasts how many notes link to the current note.
- **Jump to next backlink** — opens the next note that links here, cycling
  through all of them and wrapping around. The position in the cycle is kept
  in the plugin's settings, so it survives restarts and switching notes
  (each note gets its own cycle position).

## Permissions used

`commands:register`, `notes:read`, `notes:select`, `ui:notify`,
`settings:read`, `settings:write`

## Notes for builders

- `[[Title]]` matching is an exact, case-sensitive substring match on the
  note body, using a literal (non-regex) search.
- The cycle key is `backlinkIndex:<noteId>` so positions don't collide.
