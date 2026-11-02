# Template Inserter

Four markdown skeletons at the cursor.

**Commands:** `Insert meeting template`, `Insert daily log template`, `Insert decision record`, `Insert book notes template`.

**How it works:** each inserts a compact, dated skeleton via `editor:write`. If no note is open, the insert creates one. No notes are read and no settings are stored.

Pack: `node plugins/pack.mjs plugins/oem/template-inserter`
