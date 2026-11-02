# Status bar template

A working starting point for plugins that show a live indicator in xPin's
editor status bar.

**Pattern:** poll `api.notes.current()` every 2 seconds and push the result
with `api.ui.setStatus()`. There is no editor-change event API, so polling is
the approved approach — 0.5 Hz is well inside the sandbox message budget.

**Files:** `manifest.json` (id, permissions) + `main.js` (the `refresh()`
function, the interval, and the cleanup `activate()` returns).

**Try it:** `node plugins/pack.mjs plugins/templates/statusbar`, then import
the `.xpin.json` in xPin → Plugins → Choose package → Review → Approve.
