# xPin plugins

Everything a third-party developer needs to build for xPin.

- **`starter/`** — blank template: `manifest.json` + commented `main.js` + README
  with the full local workflow. Copy the folder, write your plugin, pack it.
- **`pack.mjs`** — assembles an importable `.xpin.json` from a plugin folder and
  validates it against the same rules the xPin app enforces on import:
  `node plugins/pack.mjs plugins/starter`
- **`examples/template-pack/`** — a real, working plugin built against the
  starter (meeting / decision / reading templates). Pack it and import the
  resulting `template-pack.xpin.json` to see the whole loop work.

Full capability reference and the review/approval model are in
[`PLUGIN_GUIDE.md`](../PLUGIN_GUIDE.md).
