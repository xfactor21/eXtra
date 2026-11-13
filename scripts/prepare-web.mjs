import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.join(root, "..", "www");
const webFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "plugin-sandbox.js",
  "plugin-system.js",
  "plugins.js",
  "feature-suite.js",
  "phase2.js",
  "sync/sync.js",
  "sync/transports.js",
  "sync/credentials.js",
  "sync/publish.js",
  "favicon.svg"
];

await mkdir(webDirectory, { recursive: true });
await Promise.all(webFiles.map(async (file) => {
  const target = path.join(webDirectory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, "..", file), target);
}));
console.log(`Prepared ${webFiles.length} xPin web assets for Android.`);
