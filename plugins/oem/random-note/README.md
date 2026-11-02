# Random Note

Jump to a **uniformly random note** from your whole collection with a single
command-palette action. A nice way to rediscover old ideas.

## Commands

- **Open random note** — picks one note at random and opens it in the editor,
  notifying you of its title. If you have no notes yet, you get a toast saying
  so instead.

## Permissions used

`commands:register`, `notes:read`, `notes:select`, `ui:notify`

## Notes for builders

- The draw uses `Math.random()` against the full list returned by
  `api.notes.list()` (up to 500 notes), so every note is equally likely.
- Every `run()` is wrapped in `try/catch` so failures surface as toasts.
