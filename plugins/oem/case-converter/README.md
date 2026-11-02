# Case Converter

Three command-palette commands that transform the **title and body** of the
note currently open in the editor, in place:

- **UPPERCASE note** — everything to upper case
- **lowercase note** — everything to lower case
- **Title Case note** — first letter of each word capitalized

Each command confirms with a short toast (or reports the error). The
transformation is applied via `notes:update`, so it respects the app's
normal note-update path (history, sync, re-render).

Permissions: `notes:read`, `notes:update`, `commands:register`, `ui:notify`.
