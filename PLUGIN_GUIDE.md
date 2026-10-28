# Pinboard extensions

Pinboard is an original notes experiment informed by static analysis of another notes app. It does not reuse that app's code, UI, assets, branding, or plugin packages. The prior REA analysis found lifecycle-based plugins, editor extensions, and a community catalogue in the selected bundled JavaScript (`ev_adf159697835b00b79b5dda4b4bf4c28e40e154a96056f1da9fff6bf9cf60497`). That analysis covered one selected app bundle and was partial; it did not execute the app.

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
  "source": "PinboardPlugin.register({ activate(api) { api.commands.add({ id: 'greet', name: 'Say hello', description: 'Show a greeting.', run: () => api.ui.notify('Hello from a plugin.') }); } });"
}
```

An imported package stays disabled until you inspect its source and explicitly consent to running it. Requested permissions start unchecked and are granted individually. The supported capabilities are:

| Permission | Capability |
|---|---|
| `notes:read` | Read note titles and content |
| `notes:select` | Open an existing note |
| `notes:create` | Create a note |
| `editor:write` | Insert text into the open note |
| `commands:register` | Add a command-palette action |
| `ui:notify` | Show a Pinboard notification |
| `settings:read` / `settings:write` | Read or save this plugin's own settings |

Plugins have no filesystem or network API. They execute outside the main app in a sandboxed, opaque-origin frame and a dedicated worker. The frame uses a restrictive Content Security Policy; the worker has no DOM or `localStorage`, and the host validates every message, checks grants for every capability, limits package size and command count, rate-limits messages, and stops a worker that does not start or whose command exceeds its time limit. No package is fetched from a URL.

The package filename and SHA-256 fingerprint are shown during review and in the plugin list. The fingerprint is calculated from Pinboard's normalized manifest and source payload; it is not a publisher signature, and the manifest author is self-reported. Browser workers do not expose a hard memory quota, so this prototype is not a substitute for OS-level process isolation. Only run code you trust. Imported packages are stored locally in the browser workspace; uninstalling removes the package and its plugin settings.

## Writing a plugin

Register one plugin and add commands from its `activate(api)` callback:

```js
PinboardPlugin.register({
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

Built-in definitions use the richer first-party API documented in `plugin-system.js`; do not copy that API into uploaded packages. Pinboard currently provides a local built-in catalogue and local package import, not a remote marketplace feed.

## Canvas and code

Canvas boards import and export JSON Canvas 1.0 `.canvas` files with text, file-reference, web-link, and group nodes, plus labeled connections. New imports and board edits are limited to 30 boards per workspace, 200 cards per board, and 500 connections per board; imports over those limits are rejected rather than silently truncated. Existing saved cards and connections are retained when loading. Connection endpoint sides and arrowheads are rendered. Standard group background metadata is preserved on round-trip; external background assets are not fetched or rendered. Canvas data and note content remain in the local workspace. Note references carry a Pinboard-specific note id alongside the standard file path so they can navigate to the corresponding note in this prototype. Focus a card and use arrow keys to move it, Shift plus arrow keys for larger steps, and Alt plus arrow keys to resize it.

The Markdown editor includes preview for headings, paragraphs, inline emphasis/strike/code, HTTP(S) links, unordered and ordered lists, task lists, blockquotes, tables, horizontal rules, and fenced code blocks. Raw HTML is not interpreted, image syntax is shown as text, and URL schemes other than HTTP(S) remain plain text. Preview output is built from DOM elements and escaped code; it never runs note content. Code-block copy and language labels, bracket pairing, and indentation helpers inside fenced blocks are also supported.
