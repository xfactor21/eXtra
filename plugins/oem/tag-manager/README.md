# Tag Manager

Audit your `#hashtag` usage across all notes.

## Commands

- **Tag census** — counts distinct `#tags` across all notes and toasts the
  total plus the top 5 by usage, e.g. `12 tags · top: #work(8), #ideas(5), …`.
- **Create tag index note** — writes a "Tag index" note listing every tag
  with its note count, most-used first, and opens it.

## Permissions used

`commands:register`, `notes:create`, `notes:read`, `ui:notify`

## Notes for builders

- xPin has no `note.tags` field: tags are `#hashtags` in the title/body text,
  extracted with the host's own pattern `/(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi`
  and lowercased, so the census agrees with xPin's tag filter.
- Renaming a tag would need a prompt API (which doesn't exist), so this
  plugin reports and indexes instead of renaming.
- Toast text is kept under the 200-char limit by truncating the top-5 list.
