// Generate the Ed25519 keypair that signs marketplace/index.json.
// Usage: node marketplace/signing/generate-key.mjs
//
// The PRIVATE key is written OUTSIDE the repo to
//   ~/workspace/xpin/marketplace-signing-key.pem   (mode 0600)
// and must NEVER be committed or pushed. The PUBLIC key is written to
//   marketplace/public-key.json  (committed; also embedded in app.js)
// and is what the in-app marketplace client verifies against.
// Re-run to rotate: keep the old public key in SIGNING.md's rotation log
// until every published index is re-signed with the new key.
import { generateKeyPairSync } from "node:crypto";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(root);
const home = process.env.HOME || process.env.USERPROFILE;
const privatePath = path.join(home, "workspace", "xpin", "marketplace-signing-key.pem");
const publicPath = path.join(root, "..", "public-key.json");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicSpki = publicKey.export({ type: "spki", format: "pem" });
const privatePkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });

await mkdir(path.dirname(privatePath), { recursive: true });
await writeFile(privatePath, privatePkcs8, { mode: 0o600 });
await chmod(privatePath, 0o600);
await writeFile(publicPath, JSON.stringify({
  algorithm: "Ed25519",
  keyId: "xpin-marketplace-1",
  created: new Date().toISOString(),
  publicKeySpkiPem: publicSpki
}, null, 2) + "\n");

console.log(`marketplace signing key generated.`);
console.log(`  private (OUTSIDE repo, never commit): ${privatePath}`);
console.log(`  public (committed): ${publicPath}`);
console.log(`Re-sign the index with: node marketplace/build.mjs`);
