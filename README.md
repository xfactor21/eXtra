# Pinboard

Pinboard is a local-first notes experiment with sortable notes, autosaving, folder management, Markdown-oriented editing, JSON Canvas boards, and a searchable built-in feature catalogue. It is an original prototype; it does not include a remote plugin marketplace or synchronize data between devices.

## Run locally

Serve this directory over HTTP from the project root, then open the printed local address in a current desktop browser. For example:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

The page can also be opened directly as a file, but browser clipboard and sandbox behavior may differ. The app has no package manifest or build step. Its interface requests fonts from Google Fonts when online and falls back to system fonts if those requests are unavailable.

## Data and backups

Notes, folders, boards, plugin preferences, and imported plugin packages are stored in the browser's `localStorage` under `pinboard.workspace.v1`. Data is local to the browser profile and origin; clearing site data or changing the origin can make it unavailable. Export Canvas boards individually from the Canvas toolbar. There is no workspace-wide backup or sync feature yet.

Autosave is debounced while editing. Browser `localStorage` writes are synchronous, so very large workspaces may affect responsiveness or exceed the browser quota. If storage reports an error, the editor displays a save failure; keep independent backups of important content.

## Plugins

First-party features are registered in `plugins.js` through `plugin-system.js`; the local catalogue can be searched and filtered by category. Imported JSON packages are disabled until reviewed and explicitly allowed, and receive only selected capabilities. The worker sandbox restricts browser APIs and network access, but browser workers do not provide a hard memory quota or OS-level isolation. Only enable code you trust. Pinboard currently supports local package import, not a remote marketplace.

Folders can be renamed, collapsed, and deleted; deleting a folder moves its notes to Uncategorized rather than deleting them. Markdown preview supports headings, paragraphs, inline emphasis/code/links, lists and task lists, blockquotes, tables, horizontal rules, and fenced code. Preview does not render raw HTML or remote images; only HTTP(S) links become clickable.

See [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md) for the package schema, capability list, and Canvas/code feature notes.

## Checks

There is no automated test suite configured. Basic JavaScript syntax checks can be run with:

```powershell
node --check app.js
node --check plugin-sandbox.js
node --check plugin-system.js
node --check plugins.js
```
