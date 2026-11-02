# Duplicate Titles

One command-palette command: **Find duplicate titles**.

Scans every note (up to 500 via `notes:list()`), groups by normalized
title (trimmed, case-insensitive — "Ideas" and "ideas" are duplicates),
and reports via toast, e.g.:

`3 duplicate titles: Ideas, Meeting notes, +1 more`

The title list is truncated so the whole message always fits the
200-character toast limit. Untitled notes are skipped.

Permissions: `notes:read`, `commands:register`, `ui:notify`.
