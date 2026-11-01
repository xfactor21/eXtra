# xPin plugin starter

A blank plugin you can copy and make yours. No build step, no dependencies.

## Make your plugin

1. Copy this folder: `plugins/starter` → `plugins/my-plugin`.
2. Edit `manifest.json` — pick a unique `id` (lowercase letters, numbers,
   hyphens), a name, and **only the capabilities your plugin needs**.
3. Write your code in `main.js`. The commented skeleton shows every API.
4. Pack it: `node plugins/pack.mjs plugins/my-plugin`
   → produces `my-plugin.xpin.json`, validated against the same rules xPin
   enforces on import.

## Try it in xPin

1. Open xPin → **Plugins → Choose package** → pick your `.xpin.json`.
2. It lands in **Pending review** — nothing runs yet.
3. Click **Review**: read the source, uncheck any capability it shouldn't have,
   check the trust box, then **Approve and enable** (or **Reject** with a reason).
4. Your commands appear in the command palette (`Ctrl/⌘ P`).

Tip: keep the plugin console-clean — open your browser's devtools console
while testing. Any error your plugin throws is reported there and, if it
happens during startup, disables the plugin with the reason shown.

## Approval expectations

xPin has no remote marketplace. "Uploading" means importing a local file, and
approval is the workspace owner's review on their own device: the package stays
inert until someone with access to that xPin workspace reviews and approves it.
A rejected package never runs and can be removed. If you share a plugin with
someone, share the `.xpin.json` file plus your contact details so they know who
wrote it — the manifest author field is self-reported, not a signature.
