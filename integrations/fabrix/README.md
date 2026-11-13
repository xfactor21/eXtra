# xPin — fabriX adapter (`integrations/fabrix/`)

The product side of the planet.X fabriX Universal Integration Layer. Plain
JavaScript, no dependencies, loaded as classic `<script>` files before
`app.js`. **Disabled by default; xPin is fully functional without it.**

## Files

| File | What it is |
|---|---|
| `manifest.json` | Versioned manifest (identity + the seven capabilities), mapped to the Bridge's registration shape. Source of truth for registration. |
| `state.js` | Adapter state shape + sanitizer (`state.integrations.fabrix`). |
| `crypto.js` | Ed25519 keypairs + canonical-JSON signing (WebCrypto, feature-detected). Only needed for the Cloud Bridge pairing flow. |
| `permissions.js` | Deny-by-default grant model (read/write separately authorized). |
| `domain.js` | Input validation + pure helpers (credential-field check, snippets, links, provenance). No app state. |
| `transport.js` | Transport interface + Local Bridge (loopback) + Cloud Bridge (stub — not live). |
| `mock-transport.js` | In-memory mock Bridge (status/contract/register/request queue/receipts) for tests and offline demos. |
| `capabilities.js` | The seven handlers (`notes.search/read/create/update/export`, `projects.list`, `artifacts.publish`). |
| `adapter.js` | Orchestrator: `window.xPinFabrix` — attach, enable, connect, invoke, poll, receipts, idempotency. |
| `settings.js` | The integration settings panel (rendered inside Settings). |

## How to enable

Settings → fabriX integration → Enable → pick a transport → Connect →
grant Read and/or Write. Nothing runs before that. Disabling disconnects
immediately and stops all polling.

## Transports

- **Local Bridge (Windows loopback):** enter the port + token from
  `Documents\fabriX\Registry\` (`hub-port.txt`, `local-api-token.txt`).
  Calls `GET __fabrix/v1/bridge/status` and `__fabrix/v1/bridge/contract`
  first; a Bridge that does not answer, or answers with an incompatible
  protocol, leaves the integration disabled. The page CSP allows loopback
  fetch (`connect-src` includes `http://127.0.0.1:*`); the plugin iframe
  keeps `connect-src 'none'`.
- **Mock Bridge:** in-memory Bridge for tests and demos. Nothing leaves the
  app; every response is labeled mock.
- **Cloud Bridge:** stub. The reference relay is not production-deployed
  (Gates A–C unmet). Connecting reports `transport_unavailable`. No live
  Cloud Bridge connectivity is claimed anywhere.

## Capability invocation (proposed routes)

The observed Local Bridge contract defines status, contract, register, and
read-only section endpoints — it does **not** define a capability-invocation
route. The adapter therefore works like the Cloud Bridge long-poll pattern:
`pollOnce()` asks the transport for pending requests, executes each locally,
and posts a receipt. The poll/receipt paths
(`__fabrix/v1/capabilities/requests`, `__fabrix/v1/capabilities/receipts`)
are **proposed** (spec §9, P6); the transport reads the Bridge's contract
document first and reports `routing_not_advertised` if the Bridge does not
advertise them. Until routing is confirmed, handlers are invoked locally
from the settings panel / mock transport.

## Permissions

Deny by default. Read (`notes.search`, `notes.read`, `notes.export`,
`projects.list`) and write (`notes.create`, `notes.update`,
`artifacts.publish`) are separate grants, approved explicitly in Settings
and revocable at any time. Search returns snippets only; `projects.list`
returns metadata only. Every call — allowed or denied — records a receipt
(Settings → Receipts, downloadable as JSON).

## Reliability

- Version negotiation against the Bridge status/contract on connect; a
  mismatch fails closed.
- Idempotency: every request carries `requestId` + `idempotencyKey`; a
  repeated idempotency key returns the stored result instead of
  re-executing.
- Conflicts: `notes.update` accepts `expectedUpdatedAt`; a mismatch returns
  `conflict` with the current `updatedAt` and performs no write.
- Retries: bounded (2), idempotent calls only, never after a permission or
  validation failure.
- Offline: an unreachable transport fails fast with
  `transport_unavailable`; the app itself is unaffected.

## Security

- No hardcoded tokens, no embedded Bridge secrets. The loopback token is
  user-entered; the Cloud Bridge device token comes only from the pairing
  flow. Neither is ever placed in a request input (credential-shaped fields
  are rejected before execution, mirroring the Cloud Bridge protocol's
  `payloadContainsSecret` rule).
- No background sync without authorization: `connect()` alone starts no
  polling; polling starts only when the user clicks "Start listening".
- The plugin sandbox is untouched: plugins still cannot reach the network
  and cannot reach the adapter's transport.

## Tests

Phase 3 extends `npm run test:smoke` with a fabriX section (manifest,
disabled mode, permission boundaries, the seven handlers, idempotency,
mock round-trip, offline behavior, state sanitizer round-trip).

## Full specification

`~/workspace/xpin/fabrix-integration-spec.md` — the versioned manifest,
capability schemas, permission model, transports, reliability, security,
open protocol proposals (P1–P6), and what was verified vs. not verified.
