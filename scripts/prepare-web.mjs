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
  "integrations/fabrix/state.js",
  "integrations/fabrix/crypto.js",
  "integrations/fabrix/permissions.js",
  "integrations/fabrix/transport.js",
  "integrations/fabrix/mock-transport.js",
  "integrations/fabrix/domain.js",
  "integrations/fabrix/capabilities.js",
  "integrations/fabrix/adapter.js",
  "integrations/fabrix/settings.js",
  "favicon.svg"
];

await mkdir(webDirectory, { recursive: true });
await Promise.all(webFiles.map(async (file) => {
  const dest = path.join(webDirectory, file);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(root, "..", file), dest);
}));
console.log(`Prepared ${webFiles.length} xPin web assets for Android.`);
