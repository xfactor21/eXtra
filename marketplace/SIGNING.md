# Marketplace index signing (Phase 1, audit C6)

The plugin directory index (`marketplace/index.json`) is signed with
**Ed25519**. Per-package SHA-256 fingerprints still apply; the signature
proves the *index itself* was published by xPin and not tampered with in
transit or at the host.

## Keys

| Key | Location | Committed? |
|---|---|---|
| Private (signing) | `~/workspace/xpin/marketplace-signing-key.pem` (outside the repo) | **Never** — mode `0600` |
| Public (verification) | `marketplace/public-key.json` | Yes — and embedded in `app.js` (`MARKETPLACE_PUBLIC_KEY_SPKI_B64`) |

Generate a fresh pair:

```sh
node marketplace/signing/generate-key.mjs
```

This writes a new private key outside the repo and a new public key into
`marketplace/public-key.json`. **After generating, re-sign the index**
(`node marketplace/build.mjs`) and update the embedded public key in
`app.js` to match, or the client will reject the index.

## Signing

`node marketplace/build.mjs` signs automatically when the private key is
present. The signature covers the canonical JSON of the index object
*without* the `signature` / `signatureKeyId` fields
(`JSON.stringify(index)` before those fields are added). The signed index
carries:

```json
{ "signature": "<base64 Ed25519>", "signatureKeyId": "xpin-marketplace-1", ... }
```

If the private key is missing, the build still writes the index but
**unsigned**, with a warning — and the in-app client fails closed on it
(the directory shows "unverified — showing installed plugins only" and
no installs are offered from it).

## Verification (in-app)

`app.js` → `verifyMarketplaceIndex(index)`: strips the signature fields,
re-stringifies, imports the embedded SPKI public key via WebCrypto, and
verifies the Ed25519 signature. A bad or missing signature fails closed.
Cached indexes are verified on every read, not just on fetch.

## Rotation procedure

1. Generate a new keypair (`generate-key.mjs`) — this overwrites the
   private key outside the repo and the public key in the repo.
2. Update the embedded public key in `app.js` (`MARKETPLACE_PUBLIC_KEY_SPKI_B64`)
   to the new public key's SPKI bytes (base64), and bump `signatureKeyId`
   in `marketplace/build.mjs` if the key id changed.
3. Rebuild + re-sign the index (`node marketplace/build.mjs`).
4. Ship the app update **before** (or together with) the newly signed
   index: old app builds carry the old public key and will reject an
   index signed with the new key.
5. Record the rotation here:

| Date | Key id | Reason |
|---|---|---|
| 2026-11-13 | xpin-marketplace-1 | Initial keypair (Phase 1) |
