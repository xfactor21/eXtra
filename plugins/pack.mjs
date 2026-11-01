// xPin plugin packer — assembles an importable .xpin.json package from a
// plugin folder containing manifest.json + main.js.
// Usage: node plugins/pack.mjs plugins/examples/template-pack
// Output: <folder>/<folder-name>.xpin.json (validated against the same rules
// the xPin app enforces on import).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PERMISSIONS = [
  "notes:read", "notes:select", "notes:create", "notes:update",
  "editor:write", "commands:register", "ui:notify", "ui:status",
  "settings:read", "settings:write",
];

function fail(message) {
  console.error(`pack: ${message}`);
  process.exit(1);
}

const dir = process.argv[2];
if (!dir) fail("pass a plugin folder, e.g. node plugins/pack.mjs plugins/starter");
const folder = path.resolve(dir);

let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
} catch {
  fail(`could not read manifest.json in ${folder}`);
}
let source;
try {
  source = await readFile(path.join(folder, "main.js"), "utf8");
} catch {
  fail(`could not read main.js in ${folder}`);
}

// Same rules the app enforces in plugin-sandbox.js validatePackage().
if (typeof manifest.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id) || manifest.id.length > 64) {
  fail('manifest.id must be 1-64 chars: lowercase letters, numbers, hyphens (e.g. "my-plugin").');
}
for (const key of ["name", "version", "description", "author"]) {
  const limit = key === "description" ? 240 : 80;
  if (typeof manifest[key] !== "string" || !manifest[key].trim() || manifest[key].length > limit) {
    fail(`manifest.${key} must be non-empty text under ${limit} characters.`);
  }
}
if (!Array.isArray(manifest.permissions) || new Set(manifest.permissions).size !== manifest.permissions.length) {
  fail("manifest.permissions must be a list of unique capability names.");
}
for (const permission of manifest.permissions) {
  if (!PERMISSIONS.includes(permission)) fail(`unknown permission "${permission}". Supported: ${PERMISSIONS.join(", ")}.`);
}
if (!source.trim() || source.length > 64000) fail("main.js must be 1-64000 characters.");

const out = {
  manifest: {
    id: manifest.id,
    name: manifest.name.trim(),
    version: manifest.version.trim(),
    description: manifest.description.trim(),
    author: manifest.author.trim(),
    permissions: [...manifest.permissions],
  },
  source,
};
const outName = `${manifest.id}.xpin.json`;
const outPath = path.join(folder, outName);
const outText = JSON.stringify(out, null, 2) + "\n";
await writeFile(outPath, outText);
console.log(`pack: wrote ${outPath} (${outText.length} bytes)`);
