// xPin marketplace builder — packs every OEM plugin, then generates the
// static directory: marketplace/index.json + marketplace/index.html +
// marketplace/packages/*.xpin.json
// Usage: node marketplace/build.mjs
// The output is a static site: deploy marketplace/ to Vercel, GitHub Pages,
// or any static host as-is.
import { readdir, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { createHash as createHashSync, sign as ed25519Sign, createPrivateKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(root);
const oemDir = path.join(repo, "plugins", "oem");
const outDir = root;
const packagesDir = path.join(outDir, "packages");
// Private signing key lives OUTSIDE the repo (never committed):
// ~/workspace/xpin/marketplace-signing-key.pem (see marketplace/SIGNING.md).
// Env override: XPIN_MARKETPLACE_SIGNING_KEY=/path/to/key.pem
const SIGNING_KEY_PATH = process.env.XPIN_MARKETPLACE_SIGNING_KEY ||
  path.join(process.env.HOME || process.env.USERPROFILE || "", "workspace", "xpin", "marketplace-signing-key.pem");
const SIGNING_KEY_ID = "xpin-marketplace-1";

const entries = (await readdir(oemDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

if (!entries.length) {
  console.error("marketplace: no OEM plugins found in plugins/oem/");
  process.exit(1);
}

await mkdir(packagesDir, { recursive: true });

const plugins = [];
for (const id of entries) {
  const dir = path.join(oemDir, id);
  // Pack + validate with the same rules xPin enforces on import.
  await execFile(process.execPath, [path.join(repo, "plugins", "pack.mjs"), dir]);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const pkgFile = path.join(dir, `${id}.xpin.json`);
  const pkgBytes = await readFile(pkgFile);
  const version = manifest.version;
  const outName = `${id}-${version}.xpin.json`;
  await copyFile(pkgFile, path.join(packagesDir, outName));
  const sha256 = createHashSync("sha256").update(pkgBytes).digest("hex");
  let readme = "";
  try { readme = await readFile(path.join(dir, "README.md"), "utf8"); } catch { /* optional */ }
  plugins.push({
    id,
    name: manifest.name,
    version,
    description: manifest.description,
    author: manifest.author,
    capabilities: manifest.permissions,
    changelog: typeof manifest.changelog === "string" ? manifest.changelog.slice(0, 500) : "",
    downloadUrl: `packages/${outName}`,
    sha256,
    updated: new Date().toISOString().slice(0, 10),
    readme: readme.slice(0, 2000),
  });
  console.log(`marketplace: packed ${id} v${version} (${(pkgBytes.length / 1024).toFixed(1)} KB)`);
}

const index = {
  name: "xPin Plugin Directory",
  version: 1,
  updated: new Date().toISOString(),
  installNote: "Packages install through xPin's review queue: Plugins → Marketplace → Install → Review → Approve. Nothing runs before you approve it.",
  plugins,
};
// Phase 1 (audit C6): Ed25519-sign the index. The signature covers the
// canonical JSON of the index object WITHOUT the signature fields, so the
// in-app client can verify it by deleting them and re-stringifying.
// Without the private key the index is still written, but UNSIGNED — the
// client fails closed on it (see app.js verifyMarketplaceIndex).
try {
  const privatePem = await readFile(SIGNING_KEY_PATH, "utf8");
  const privateKey = createPrivateKey(privatePem);
  const signature = ed25519Sign(null, Buffer.from(JSON.stringify(index), "utf8"), privateKey);
  index.signature = signature.toString("base64");
  index.signatureKeyId = SIGNING_KEY_ID;
  console.log(`marketplace: index signed with ${SIGNING_KEY_ID}`);
} catch (error) {
  console.warn(`marketplace: WARNING — index is UNSIGNED (signing key not found at ${SIGNING_KEY_PATH}). The in-app client will refuse it.`);
}
await writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
await writeFile(path.join(outDir, "index.html"), directoryPage(plugins));
console.log(`marketplace: wrote index.json + index.html (${plugins.length} plugins)`);

function directoryPage(plugins) {
  const data = JSON.stringify(plugins).replace(/</g, "\\u003c");
  const cards = plugins.map((p) => `
      <article class="card" data-search="${escapeAttr(`${p.name} ${p.description} ${p.id} ${p.capabilities.join(" ")}`)}">
        <div class="card-head"><h2>${escapeHtml(p.name)}</h2><span class="ver">v${escapeHtml(p.version)}</span></div>
        <p class="desc">${escapeHtml(p.description)}</p>
        <div class="meta">${escapeHtml(p.author)} · updated ${escapeHtml(p.updated)}</div>
        <div class="caps">${p.capabilities.map((c) => `<span class="cap">${escapeHtml(c)}</span>`).join("")}</div>
        <div class="actions"><a class="dl" href="${escapeAttr(p.downloadUrl)}" download>Download .xpin.json</a><span class="sha" title="${p.sha256}">sha ${p.sha256.slice(0, 12)}…</span></div>
      </article>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>xPin Plugin Directory</title>
<style>
:root { --pink: #ff3d9a; --violet: #8b5cf6; --cyan: #22d3ee; --bg: #06060b; --panel: #0d0d16; --line: #23232f; --text: #e8e8f0; --dim: #9a9ab0; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 56px 24px 28px; text-align: center; background: radial-gradient(600px 220px at 50% -40px, rgba(255,61,154,.18), transparent), radial-gradient(500px 200px at 80% 0, rgba(139,92,246,.14), transparent); }
h1 { margin: 0; font-size: 34px; letter-spacing: -0.5px; }
h1 .x { background: linear-gradient(90deg, var(--pink), var(--violet), var(--cyan)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.sub { color: var(--dim); margin: 10px 0 0; font-size: 14px; }
.search-wrap { max-width: 560px; margin: 0 auto; padding: 0 24px; }
#search { width: 100%; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font-size: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; max-width: 1080px; margin: 28px auto 60px; padding: 0 24px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.card-head h2 { margin: 0; font-size: 17px; }
.ver { color: var(--dim); font-size: 11px; font-family: ui-monospace, monospace; }
.desc { margin: 0; color: var(--dim); font-size: 13px; line-height: 1.5; flex: 1; }
.meta { color: var(--dim); font-size: 11px; }
.caps { display: flex; flex-wrap: wrap; gap: 6px; }
.cap { font-size: 10px; font-family: ui-monospace, monospace; color: var(--cyan); border: 1px solid rgba(34,211,238,.35); border-radius: 20px; padding: 2px 9px; }
.actions { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.dl { display: inline-block; padding: 9px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; color: #06060b; text-decoration: none; background: linear-gradient(90deg, var(--pink), var(--violet)); }
.sha { font-size: 10px; color: var(--dim); font-family: ui-monospace, monospace; }
footer { text-align: center; color: var(--dim); font-size: 12px; padding: 0 24px 48px; }
footer a { color: var(--cyan); }
.empty { grid-column: 1 / -1; text-align: center; color: var(--dim); padding: 40px; }
</style>
</head>
<body>
<header><h1><span class="x">xPin</span> Plugin Directory</h1><p class="sub">First-party extensions. Every package installs through xPin's review queue — nothing runs before you approve it.</p></header>
<div class="search-wrap"><input id="search" type="search" placeholder="Search plugins…" autocomplete="off"></div>
<main class="grid" id="grid">${cards}</main>
<footer>Built from <a href="https://github.com/xfactor21/eXtra">github.com/xfactor21/eXtra</a> · machine-readable <a href="index.json">index.json</a> · a planet.X experiment</footer>
<script>
const input = document.getElementById('search');
const cards = Array.from(document.querySelectorAll('.card'));
const grid = document.getElementById('grid');
input.addEventListener('input', () => {
  const q = input.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cards) {
    const show = !q || card.dataset.search.toLowerCase().includes(q);
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  let empty = document.getElementById('empty');
  if (!visible && !empty) { empty = document.createElement('div'); empty.id = 'empty'; empty.className = 'empty'; empty.textContent = 'No plugins match.'; grid.append(empty); }
  else if (visible && empty) empty.remove();
});
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
