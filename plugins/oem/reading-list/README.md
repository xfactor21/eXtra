# Reading List

A simple **read-later queue** stored in the plugin's settings.

## Commands

- **Add current note to reading list** — queues the open note. Duplicates
  are skipped, so adding the same note twice won't pile up.
- **Open next in reading list** — opens the head of the queue, then rotates
  it to the back (round-robin). Notes that were deleted in the meantime are
  dropped automatically.
- **Reading list size** — toasts how many notes are queued (after cleaning
  out any that no longer exist).

## Permissions used

`commands:register`, `notes:read`, `notes:select`, `ui:notify`,
`settings:read`, `settings:write`

## Notes for builders

- The queue is an array of note ids under the `queue` settings key.
- `notes:select` on the head of the queue is only ever done after verifying
  the id still exists in `notes:list()`.
