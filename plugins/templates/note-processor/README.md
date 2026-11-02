# Note processor template

A working starting point for plugins that batch-process notes.

**Pattern:** `api.notes.list()` → filter → transform the body string →
`api.notes.update(id, { body })` only when the result differs → notify what
changed. Untouched notes are skipped so their `updatedAt` stays honest.

**Safety rules (in the code comments):** keep transforms conservative and
reversible; never delete; always report counts.

**Try it:** `node plugins/pack.mjs plugins/templates/note-processor`, then
import the `.xpin.json` in xPin → Plugins → Choose package → Review →
Approve. The example transform strips trailing whitespace.
