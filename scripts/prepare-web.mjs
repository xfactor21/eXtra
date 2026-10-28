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
  "favicon.svg"
];

await mkdir(webDirectory, { recursive: true });
await Promise.all(webFiles.map((file) => copyFile(path.join(root, "..", file), path.join(webDirectory, file))));
console.log(`Prepared ${webFiles.length} Pinboard web assets for Android.`);
