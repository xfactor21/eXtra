# Untagged Finder

Hunt down notes that have no `#hashtags`.

## Commands

- **Count untagged notes** — toasts how many notes contain no `#tag`.
- **Open next untagged note** — opens the next untagged note, cycling through
  all of them and wrapping around, so you can tag them one by one. The cycle
  position is stored in settings and survives restarts.

## Permissions used

`commands:register`, `notes:read`, `notes:select`, `ui:notify`,
`settings:read`, `settings:write`

## Notes for builders

- A note is "untagged" when its title+body contain no `#hashtag` matching the
  host's tag pattern `/(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi` (xPin has no
  `note.tags` field — tags are inline in the text).
- The cycle order is by `updatedAt` (newest first) and the stored index is
  normalized with modulo, so deleted/retagged notes can't break it.
