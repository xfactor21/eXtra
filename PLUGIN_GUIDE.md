# xPin extensions

xPin is an original notes experiment informed by static analysis of another notes app. It does not reuse that app's code, UI, assets, branding, or plugin packages. The prior REA analysis found lifecycle-based plugins, editor extensions, and a community catalogue in the selected bundled JavaScript (`ev_adf159697835b00b79b5dda4b4bf4c28e40e154a96056f1da9fff6bf9cf60497`). That analysis covered one selected app bundle and was partial; it did not execute the app.

## Built-in features

The built-in plugin host lives in `plugin-system.js` and `plugins.js`. A feature can register commands, note panels, status items, events, and local settings through a scoped API. Registrations return cleanup functions and are removed when the feature is disabled. The local feature catalogue supports text search and category filters; imported local packages appear under Imported. It does not retrieve a remote catalogue.

## Local JavaScript packages

Use **Plugins → Choose package** to import one local JSON file. The package shape is:

```json
{
  "manifest": {
    "id": "hello-board",
    "name": "Hello board",
    "version": "1.0.0",
    "description": "Adds a small greeting action.",
    "author": "Example author",
    "permissions": ["commands:register", "ui:notify"]
  },
  "source": "xPinPlugin.register({ activate(api) { api.commands.add({ id: 'greet', name: 'Say hello', description: 'Show a greeting.', run: () => api.ui.notify('Hello from a plugin.') }); } });"
}
```

An imported package lands in a **Pending review** queue — nothing runs yet. Open
**Plugins**, click **Review** on the pending package, read its source, uncheck any
capability it should not have (requested capabilities start selected), check the
trust box, then **Approve and enable** — or **Reject** it with a short reason.
Rejected packages stay inert and can be removed or re-reviewed. Approved packages
activate immediately and again on every launch; if a package changes after
approval (its fingerprint no longer matches), it goes back to pending review.

The supported capabilities are:

| Permission | Capability |
|---|---|
| `notes:read` | Read note titles and content |
| `notes:select` | Open an existing note |
| `notes:create` | Create a note |
| `notes:update` | Edit a note's title, body, folder, parent, pinned flag, or properties |
| `notes:delete` | Move a note to Trash (or permanently delete it from Trash, with a confirm) |
| `folders:read` | List folders |
| `folders:write` | Create, rename, or delete folders |
| `databases:read` | List databases and read their rows |
| `databases:write` | Add or update database rows |
| `canvas:read` | List canvas boards |
| `templates:read` | List note templates |
| `export:note` | Export notes as Markdown or a Markdown .zip |
| `editor:write` | Insert text into the open note |
| `commands:register` | Add a command-palette action |
| `ui:notify` | Show a xPin notification |
| `ui:status` | Show a small item in the editor status bar |
| `settings:read` / `settings:write` | Read or save this plugin's own settings |
| `network:fetch` *(connector only)* | Fetch from approved https origins (host-side) |
| `credentials:set` / `credentials:get` / `credentials:delete` *(connector only)* | Store, read, or delete a secret in the encrypted credential store |

Plugins have no filesystem API. The sandboxed tier has no network API at
all. They execute outside the main app in a sandboxed, opaque-origin frame
and a dedicated worker. The frame uses a restrictive Content Security
Policy; the worker has no DOM or `localStorage`, and the host validates
every message, checks grants for every capability, limits package size and
command count, rate-limits messages, and stops a worker that does not start
or whose command exceeds its time limit. No package is fetched from a URL.

## Connector tier (Phase 1)

Most plugins stay sandboxed. A plugin that needs to talk to an outside
service (calendar, email, tasks, AI) declares the **connector tier**:

```json
{
  "manifest": {
    "id": "calendar-link",
    "name": "Calendar Link",
    "version": "1.0.0",
    "description": "Reads today's events from your calendar.",
    "author": "Example author",
    "tier": "connector",
    "networkOrigins": ["https://calendar.example.com"],
    "permissions": ["network:fetch", "credentials:get", "commands:register", "ui:notify"]
  },
  "source": "…"
}
```

Rules:

- `tier` is `"sandboxed"` (default) or `"connector"`. Only connector
  plugins may declare `network:fetch` or `credentials:*`, and only
  connector plugins may declare `networkOrigins`. A sandboxed plugin
  asking for any of those is rejected at import.
- `networkOrigins` is a list of at most 10 bare `https:` origins (no path,
  query, or credentials). A connector plugin with `network:fetch` must
  declare at least one origin.
- **Each origin is approved individually** in the review dialog (origins
  start pre-checked, like capabilities — uncheck any origin the plugin
  should not reach). Approved origins are listed in the plugin catalogue
  with a per-origin **Revoke** button; revocation takes effect
  immediately, including for a running plugin.
- **The worker never touches the network.** `api.network.fetch(url,
  options)` asks the *host* to fetch. The host enforces: exact origin
  match against approved origins, `https:` only, 10 s timeout, 1 MB
  response cap. The sandboxed tier keeps every network API neutered and
  the iframe CSP keeps `connect-src 'none'`.
- **Credential store.** `api.credentials.set(key, value)` /
  `get(key)` / `delete(key)` are connector-only. Secrets are encrypted
  with the workspace passphrase envelope (AES-256-GCM + PBKDF2-SHA-256,
  310k iterations — the same construction as the encrypted backup) and
  stored as ciphertext only; they never appear in the plaintext workspace
  blob, are never logged, and are never returned to non-connector
  plugins. If no passphrase is set, credential storage is unavailable
  with an honest error — secrets are never stored as plaintext. The
  passphrase unlocks the store for the session only (set it in Workspace
  tools → Sync); a page reload locks it again. Intended use: the user's
  own cloud AI keys (BYOK — Claude is the natural default, plus
  OpenAI/Gemini), stored on-device; there is no hosted AI and no key
  ever leaves the device except to the provider the plugin calls.
- **Events.** Plugins can subscribe to more than note CRUD now:
  `folder:created/updated/deleted`, `database:created/updated/deleted`,
  `database:row:changed`, `canvas:created/updated/deleted`,
  `template:created/updated/deleted`, `tag:changed`,
  `settings:changed`, `save:completed`, `sync:completed` — alongside the
  existing `note:created/updated/deleted/opened`.
- **Host API.** Built-in plugins get `api.folders` (list/create/rename/
  delete), `api.databases` (list tables, read rows, add/update row),
  `api.canvas` (list/open), `api.templates` (list), and
  `api.importExport` (exportNoteMarkdown, exportMarkdownZip). Imported
  plugins use the same surface through `api.folders`, `api.databases`,
  `api.canvas`, `api.templates`, and `api.export`.

The package filename and SHA-256 fingerprint are shown during review and in the plugin list. The fingerprint is calculated from xPin's normalized manifest and source payload; it is not a publisher signature, and the manifest author is self-reported. Browser workers do not expose a hard memory quota, so this prototype is not a substitute for OS-level process isolation. Only run code you trust. Imported packages are stored locally in the browser workspace; uninstalling removes the package and its plugin settings.

## Writing a plugin

Register one plugin and add commands from its `activate(api)` callback:

```js
xPinPlugin.register({
  activate(api) {
    api.commands.add({
      id: "greet",
      name: "Say hello",
      description: "Show a greeting.",
      run: () => api.ui.notify("Hello from a plugin.")
    });
  }
});
```

Each API call returns a promise when it needs to cross the sandbox boundary. Treat note data as private and request only the permissions the feature needs. A command id must be unique within its package.

Built-in definitions use the richer first-party API documented in `plugin-system.js`; do not copy that API into uploaded packages. xPin currently provides a local built-in catalogue and local package import, not a remote marketplace feed.

## Developing plugins

Everything you need lives in the repo's `plugins/` folder:

- `plugins/starter/` — a blank template (`manifest.json` + commented `main.js`).
  Copy the folder, write your plugin, then pack it:
  `node plugins/pack.mjs plugins/my-plugin` → `my-plugin.xpin.json`.
- `plugins/examples/template-pack/` — a real plugin built against the starter.
  Pack and import it to see the whole loop work.

### Manifest schema

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does, in one sentence.",
  "author": "Your name",
  "permissions": ["commands:register", "ui:notify"]
}
```

Rules (enforced by `pack.mjs` and again by xPin on import, with a plain-English
error naming the exact problem):

- `id`: 1–64 characters, lowercase letters, numbers, hyphens only. Must not
  clash with a built-in feature id or an already-installed plugin.
- `name`, `version`, `author`: non-empty text, max 80 characters.
- `description`: non-empty text, max 240 characters.
- `permissions`: unique list of capability names from the table above.
  Connector permissions (`network:fetch`, `credentials:*`) need
  `"tier": "connector"` in the manifest.
- `tier`: `"sandboxed"` (default) or `"connector"`.
- `networkOrigins`: connector only — up to 10 bare `https:` origins.
- `source`: 1–64,000 characters of JavaScript that calls
  `xPinPlugin.register({ activate(api) { … } })` exactly once. Whole package
  (JSON file) must stay under 100 KB.

### Local dev workflow

1. Edit `main.js` in your plugin folder.
2. `node plugins/pack.mjs plugins/my-plugin` to rebuild the `.xpin.json`.
3. In xPin: **Plugins → Choose package** → import the file → it lands in
   **Pending review**.
4. **Review** it: read the source in the review dialog, adjust the granted
   capabilities, approve, and exercise it. The browser devtools console shows
   anything your plugin throws; a startup failure disables the plugin and names
   the reason.
5. Iterate: remove the old package from the catalogue (or bump the version),
   re-pack, re-import.

Keep plugins small and single-purpose. Request only the capabilities the
feature needs — reviewers see the full list, and anything ungranted fails
loudly at runtime instead of silently.

### Approval expectations

Approval is the workspace owner's review on their own device: a package is
inert until reviewed, and rejecting it (with a reason) keeps it inert. The
SHA-256 fingerprint shown during review proves the package hasn't changed
since you looked at it — any change sends it back to pending. The manifest
author is self-reported; if you share a plugin, distribute the `.xpin.json`
alongside your name and contact so reviewers know who wrote it.

### Plugin templates

Three working templates ship with the repo — copy the folder, change the
`id` in `manifest.json`, pack it, and you have a real starting point:

- `plugins/starter/` — **command-palette plugin.** Three working commands
  demonstrating `ui:notify`, `notes:read`/`notes:create`, error handling,
  and the optional status-bar pattern.
- `plugins/templates/statusbar/` — **status-bar plugin.** The approved
  polling pattern: `setInterval` at 2 s, read `api.notes.current()`, push
  with `api.ui.setStatus()`, return a cleanup function. (Plugins can't
  subscribe to editor events; 0.5 Hz is comfortably inside the sandbox
  message budget.)
- `plugins/templates/note-processor/` — **batch processor.** Read all notes
  with `api.notes.list()`, transform, and `api.notes.update()` only what
  changed — with the safety rules (conservative, reversible, always report
  counts) baked in as comments.

### Marketplace

The plugin directory is a static site generated from the OEM sources:

- Source of truth: `plugins/oem/<id>/` in this repo.
- Build it: `node marketplace/build.mjs` — packs every OEM plugin,
  verifies each with `pack.mjs`, copies the `.xpin.json` packages into
  `marketplace/packages/`, and generates `marketplace/index.json` (the
  machine-readable catalogue) and `marketplace/index.html` (the browsable,
  planet.X-branded directory with search and download buttons).
- Deploy `marketplace/` to any static host (Vercel, GitHub Pages) as-is.

**In-app browser:** xPin's Plugins dialog has a **Marketplace** tab. It
fetches `index.json` from a configurable list of directory URLs (default:
the hosted directory's raw `index.json`; add your own directories, any
`https://` URL serving the same schema). Plugins list with an **Install**
button; one click downloads the package and drops it into the existing
**Pending** review queue — nothing runs before you approve it.

**`index.json` schema:**
`{ name, version, updated, signature, signatureKeyId, plugins: [{ id, name, version, description,
author, capabilities[], changelog, downloadUrl, sha256, updated }] }`.
`downloadUrl` may be relative (resolved against the directory URL).

**Offline/unreachable:** the last successfully fetched index is cached in
the workspace, so previously listed plugins remain browsable offline;
a refresh failure shows a friendly message instead of a stack trace.

**Signed index:** `index.json` carries an Ed25519 signature (see
`marketplace/SIGNING.md`). The in-app client verifies the signature
against the bundled public key before trusting an index — fetched or
cached. A bad or missing signature fails closed: the directory shows
"unverified — showing installed plugins only" and no installs are offered
from it. Per-package SHA-256 checks still apply on install.

**Update checks:** the client compares installed plugin versions against
the index. An available update shows "Update available" with the version
and changelog line; updating routes through the review queue (the changed
package is re-reviewed before it can run again).

**Security note:** fetching a directory only downloads JSON, which is
schema-validated before display — the actual plugin code still travels
the exact same import → review → approve path as a local file, sandboxed
in the Worker with only the capabilities you grant.

## Canvas and code

Canvas boards import and export JSON Canvas 1.0 `.canvas` files with text, file-reference, web-link, and group nodes, plus labeled connections. New imports and board edits are limited to 30 boards per workspace, 200 cards per board, and 500 connections per board; imports over those limits are rejected rather than silently truncated. Existing saved cards and connections are retained when loading. Connection endpoint sides and arrowheads are rendered. Standard group background metadata is preserved on round-trip; external background assets are not fetched or rendered. Canvas data and note content remain in the local workspace. Note references carry a xPin-specific note id alongside the standard file path so they can navigate to the corresponding note in this prototype. Focus a card and use arrow keys to move it, Shift plus arrow keys for larger steps, and Alt plus arrow keys to resize it.

The Markdown editor includes preview for headings, paragraphs, inline emphasis/strike/code, HTTP(S) links, unordered and ordered lists, task lists, blockquotes, tables, horizontal rules, and fenced code blocks. Raw HTML is not interpreted, image syntax is shown as text, and URL schemes other than HTTP(S) remain plain text. Preview output is built from DOM elements and escaped code; it never runs note content. Code-block copy and language labels, bracket pairing, and indentation helpers inside fenced blocks are also supported.
