# Pinboard

Pinboard is a local-first notes experiment with sortable notes, autosaving, nested pages, Markdown editing, JSON Canvas boards, a notes graph, shared text blocks, safe embeds, and relational databases with multiple views. Workspace tools include constrained note queries, theme tokens, static HTML export, and passphrase-encrypted backup import/export. It is an original prototype, not a clone of another notes product.

## Run locally

Serve this directory over HTTP from the project root, then open the printed local address in a current desktop browser. For example:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

The page can also be opened directly as a file, but browser clipboard and sandbox behavior may differ. Running the web app itself requires no package installation or build step. Its interface requests fonts from Google Fonts when online and falls back to system fonts if those requests are unavailable.

## Build the Android APK

The Android wrapper uses Capacitor and packages the same local web app; it does not require a hosted server. Install Node.js 20 or newer, Android Studio with Android SDK Platform 36 and platform tools, and JDK 21 (set Android Studio's Gradle JDK to JDK 21 if its bundled JDK is newer). In PowerShell, set the SDK path if it is not already configured:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
```

From the repository root, build the debug APK:

```powershell
npm install
npm run android:debug
```

The debug APK is written to `android\app\build\outputs\apk\debug\app-debug.apk`. Gradle signs it with a debug key for local installation/testing. For a Play Store or public release, configure a private release signing key and build a signed release APK or Android App Bundle; never commit signing keys. The Android app keeps notes in its own WebView storage, separate from the desktop browser, so export/backup support should be used before uninstalling.

## Data and backups

Notes, folders, boards, database records, shared blocks, plugin preferences, and imported plugin packages are stored in the browser's `localStorage` under `pinboard.workspace.v1`. Data is local to the browser profile and origin; clearing site data or changing the origin can make it unavailable. Use **Workspace tools → Export encrypted backup** for a portable AES-GCM encrypted workspace file. The passphrase is not stored and cannot be recovered. Import replaces the current local workspace after confirmation.

Autosave is debounced while editing. Browser `localStorage` writes are synchronous, so very large workspaces may affect responsiveness or exceed the browser quota. If storage reports an error, the editor displays a save failure; keep independent backups of important content.

## Workspace tools

- **Nested pages and graph:** Choose a parent page in the editor or create a sub-page. The graph derives links from `[[exact note titles]]` and parent relationships.
- **Synced blocks:** Create or edit shared text in Workspace tools and insert `{{sync:block-id}}` references into notes. Preview resolves references and stops recursive loops.
- **Databases:** Projects and Tasks are local tables. Relations may point to another database or a note; rollup fields count incoming database relations. Table, board, calendar, gallery, list, and timeline views use the same records.
- **Note queries:** The database view includes a read-only query grammar such as `LIST FROM notes WHERE tag = #ideas` and `TABLE title,folder,pinned FROM notes`. Supported fields/operators are intentionally limited; queries never execute code.
- **Embeds:** Markdown preview accepts `@[youtube](https://...)`, `@[figma](https://...)`, `@[drive](https://...)`, `@[typeform](https://...)`, and explicit HTTPS image/audio/video URLs with matching media extensions. Each embed requires a click to load; raw HTML and ordinary Markdown images are still not rendered.
- **Static page export:** Workspace tools can download the selected note as a standalone HTML file. The user must host it; Pinboard does not publish to a public service or provide custom domains or SEO.
- **Themes:** Select from validated accent and density tokens. Arbitrary CSS snippets are not enabled.
- **Backup versus sync:** The encrypted backup is a manual file handoff, not live cross-device synchronization. No account, server, merge/conflict resolution, or encryption-key recovery service is included.

## Plugins

First-party features are registered in `plugins.js` through `plugin-system.js`; the local catalogue can be searched and filtered by category. Imported JSON packages are disabled until reviewed and explicitly allowed, and receive only selected capabilities. The worker sandbox restricts browser APIs and network access, but browser workers do not provide a hard memory quota or OS-level isolation. Only enable code you trust. Pinboard currently supports local package import, not a remote marketplace.

Folders can be renamed, collapsed, and deleted; deleting a folder moves its notes to Uncategorized rather than deleting them. Markdown preview supports headings, paragraphs, inline emphasis/code/links, lists and task lists, blockquotes, tables, horizontal rules, and fenced code. Preview does not render raw HTML or remote images; only HTTP(S) links become clickable.

See [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md) for the package schema, capability list, and Canvas/code feature notes. See [FEATURE_STUDY.md](FEATURE_STUDY.md) for the evidence log, references, implementation choices, and boundaries of the Notion/Obsidian feature study.

## Checks

There is no automated test suite configured. Basic JavaScript syntax checks can be run with:

```powershell
node --check app.js
node --check plugin-sandbox.js
node --check plugin-system.js
node --check plugins.js
node --check feature-suite.js
```
