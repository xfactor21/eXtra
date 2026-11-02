# Link Checker

Find dead `[[wiki-links]]` in your notes.

## Commands

- **Find broken links** — scans every note body for `[[Some Title]]`
  references whose target doesn't match any existing note's exact title,
  then toasts the count plus the first 2–3 broken targets so you can fix them.

## Permissions used

`commands:register`, `notes:read`, `ui:notify`

## Notes for builders

- Wikilinks are extracted with a simple regex (`/\[\[([^\][]+)\]\]/g`);
  targets are trimmed and matched exactly (case-sensitive) against titles.
- Dedupe targets so each broken link is counted once, and sort them for a
  stable, readable report.
