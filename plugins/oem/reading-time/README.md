# Reading Time

Live reading-time estimate for the note currently open in the editor,
shown in the status bar and refreshed every 2 seconds.

- **Status item id:** `reading-time`
- **Rate:** 200 words per minute; rounds up, minimum "1 min read"
  for any non-empty note.
- Cleared automatically when no note is open.

Permissions: `notes:read`, `ui:status`.
