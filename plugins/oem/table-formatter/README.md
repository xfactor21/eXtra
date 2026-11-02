# Table Formatter

One command-palette command: **Format markdown tables**.

Scans the body of the note currently open in the editor for GitHub-flavored
pipe tables (consecutive `|…|` lines with a `---` separator row) and
rewrites each with columns padded to equal widths so the raw markdown
lines up, e.g.:

```
| Name  | Age |
| ----- | --- |
| Ada   | 36  |
| Grace | 85  |
```

Alignment markers (`:---`, `---:`, `:---:`) are preserved. Blocks that
aren't valid tables (ragged columns, no separator row) are left untouched.
The toast reports how many tables were formatted, or "No tables found."

Permissions: `notes:read`, `notes:update`, `commands:register`, `ui:notify`.
