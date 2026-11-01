# xPin — Audit & Repair Log

> **Spelling correction (2026-11-01):** the app is now **xPin** (lowercase x, uppercase P) throughout — UI, docs, configs, storage key `xPin.workspace.v1` (migrates from `xpin.workspace.v1` and `pinboard.workspace.v1`). Lowercase-only identifiers unchanged: Android package `com.xfactor21.xpin`, npm name `xpin-android`.

**Project:** xpin (formerly "Pinboard") — local-first notes app, vanilla JS + Capacitor Android
**Repo:** `/home/hatch/workspace/xpin/extra` (cloned from `github.com/xfactor21/eXtra`)
**Takeover:** 2026-11-01 · **Coordinator:** Luna (subagent session `9eb1df77`)
**Method:** AUDIT → REPORT → REPAIR → BUILD-OUT → VERIFY → RE-AUDIT → FIX → VERIFY

---

## Executive summary

The takeover is **complete**. One CRITICAL, nine HIGH, and sixteen MEDIUM defects were found and repaired; seven owner-requested features were built out; a 58-assertion headless test suite (`npm run test:smoke`) passes 58/58 with zero console errors; an adversarial re-audit found 1 medium + 4 low issues, all fixed and regression-tested (including a mutation test proving the data-loss regression test is real). **No known material actionable defects remain.**

---

## Phase 0 — Rename: Pinboard → xpin (complete, verified)

- Bulk rename `Pinboard→xpin`, `pinboard→xpin`, `PINBOARD→XPIN` across all files (UI, README/docs, package.json, capacitor config).
- Android: `com.xfactor21.pinboard` → `com.xfactor21.xpin` (build.gradle, strings.xml, MainActivity moved to `java/com/xfactor21/xpin/`).
- Storage: `xpin.workspace.v1` with one-time first-run migration from `pinboard.workspace.v1` (legacy key preserved as backup); canvas field `pinboardNoteId` → `xpinNoteId`.
- Verified: grep shows only 3 intentional `pinboard` references (migration constant, field mapping, comment); smoke test T2 proves migration of notes + canvas nodes with no leak.

## Phase 1 — Forensic audit (5 parallel workers, read-only)

Full report: `AUDIT_REPORT.md`. Detail reports: `/tmp/xpin-audit/*.md` (feature-suite, ui-ux, core-functionality, security, perf-build).
19 subsystems verified genuinely working (notes CRUD, nested pages, autosave, JSON Canvas, safe embeds, AES-GCM backup, plugin sandbox, …).
Findings: **1 CRITICAL · 9 HIGH · 16 MEDIUM · ~14 LOW.** No critical/high security issues — crypto and sandbox verified sound by code trace.

## Phase 2 — Repairs

### app.js (12 fixes — changelog `/tmp/xpin-repairs/r1.md`)
- Canvas boards: delete (confirm, refuses last board) + rename added — the 30-board cap was a dead end.
- Confirmations added: canvas node delete (× button + Delete key), synced-block delete (capture-phase intercept), edge delete.
- Deleting a note now nulls `xpinNoteId` on referencing canvas file-nodes (annotated "deleted note") instead of leaving dead buttons.
- Post-delete selection follows current sort/filter (`visibleNotes()[0]`).
- Slash menu: ArrowUp/Down + Enter/Escape keyboard support.
- `@drive()` embeds rewritten: docs.google document/sheet → `/preview`, slides → `/embed`, drive.google `/open?id=`, `/uc?id=`, folder embed forms (11 URL cases tested in node, all pass).
- Stale feature-view state validated on boot; page subtitle no longer clobbered by `renderList()` while a feature view is active.
- "☀ Today" sidebar button → `openDailyNote()`; "?" shortcuts dialog (+ `?` hotkey) listing real bindings.
- Canvas edge editing: clickable edges, floating panel (label, from/to sides, arrowheads, color).
- Perf: `updateSelectedNote()` now does in-place row replace + 600 ms-debounced full `renderList()` (was: full rebuild per keystroke).

### feature-suite.js (12 fixes — worker handoff 2026-11-01 13:59 UTC)
- `WHERE tag=` now accepts values with/without `#` (F-H1); `TABLE` field names case-insensitive (F-H2).
- Database delete/rename + column delete/rename (confirms; deleting a table drops targeting relation columns; can't delete last column).
- Row delete confirmation; theme accent/density applied in `setup()` on boot (was only in `render()`).
- Rollups now carry optional `sourceColumnId` — scoped counts instead of always count-all-inbound.
- Board lanes derived from actual status values; query grammar "?" cheat-sheet panel; "Relation to notes" → "Relation".
- **Database list view removed** (owner-flagged redundancy); `"list"` views sanitize to `"table"`.
- Date-format helpers consolidated; calendar/gallery entries with note links are clickable; timeline deliberately read-only (documented).
- Dead `--timeline-index` removed (coordinator).

### Shell / config / CSS / HTML / Android (13 fixes — changelog `/tmp/xpin-repairs/r3.md`)
- **CRITICAL:** `scripts/prepare-web.mjs` now includes `feature-suite.js` (Android booted broken without it — verified by executing the script: 8 assets, byte-identical).
- `npm run android:debug` cross-platform (`./gradlew`); `android:debug:win` preserves `gradlew.bat`; `chmod +x android/gradlew`.
- Mobile a11y: `aria-label`s on icon-only nav buttons; 44px touch targets (nav + mobile breakpoint; toggle switch + inline chips documented residual).
- Security: worker prelude now neuters 13 APIs (fetch, XHR, WebSocket, EventSource, sendBeacon, storage… — runtime-tested, fail-closed); sandbox rejects `__proto__`/`constructor`/`prototype` settings keys; CSP `<meta>` added to index.html (researched against actual code: keeps `'unsafe-inline'`+`blob:` for srcdoc plugin frames, `frame-src` allowlists the 4 embed providers, `connect-src 'self'`).
- Redundancy: duplicate feature-tabs row removed; one "New folder" button hidden via CSS (removal would break `byId` refs in app.js — documented); "Workspace tools" naming unified; "Recently edited" → "Recent notes" (incl. app.js breadcrumb strings).
- Stale `com.getcapacitor.myapp` test files deleted; `*.jks`/`*.keystore` uncommented in `.gitignore`; README documents the `www/`-generated + `android:sync` footgun.

## Phase 3 — Build-out (7 features, all local-only)

Changelog: `/tmp/xpin-buildout/b1.md`. Function-level checks: `/tmp/xpin-buildout/verify.cjs` 45/45.

1. **Quick capture → daily inbox** — `Ctrl/Cmd+Shift+C` + palette command; modal dialog; appends `- [HH:MM] text` under `## Inbox` in today's note without changing selection; focus restored afterward.
2. **Backlinks panel** — "LINKED HERE" section in the editor: `[[title]]` references (case-insensitive, regex-escaped) + child pages; click navigates.
3. **`[[` autocomplete** — mirror-div caret measurement, ArrowUp/Down + Enter/Tab + Esc + click, consumes auto-paired `]]`, defers to slash menu.
4. **Tag search** — `#`-prefixed search queries filter via `extractTags()` with nested-prefix matching (`#parent` matches `#parent/child`).
5. **Templates** — persisted `state.templates`, seeded "Daily note" (`{{date}}`) + "Meeting notes"; `{{date}}`/`{{time}}`/`{{title}}` placeholders; palette picker; Workspace-tools manager (add/delete/"save current as"); daily note applies template on creation.
6. **Markdown import** — multi-file `.md` import in Workspace tools (real FileReader; 5 MB/file pre-check; honest skip counts).
7. **Palette + shortcuts** — 4 core commands registered in the command palette; new hotkeys in the shortcuts reference.

## Phase 4 — Adversarial re-audit → fixes (2026-11-01)

Re-auditor report: `/tmp/xpin-reaudit/report.md`. All 9 claimed repairs verified **HOLD**. Found **1 medium + 4 low**, all fixed by the coordinator:

- **M1 (data loss):** `appendToDailyNote` didn't sync the editor textarea when focused → next keystroke overwrote `note.body`, silently discarding the capture. Fixed: textarea always synced with caret preservation. **Mutation-tested:** reverting the fix makes the new T16 regression test fail with "entry lost"; re-applying passes.
- L1: `[[` autocomplete `IndexSizeError` when caret moved before completion → re-scan from current caret.
- L2: `modal-open` body class could strand/drop with two dialogs open → centralized `anyModalOpen()`/`syncModalOpenClass()`; all 5 close paths converted.
- L3: unsaved template-form draft wiped on settings re-render → draft stashed and restored.
- L4: Markdown import read files of any size into memory → 5 MB/file pre-check with honest skip reporting.

## UI/UX notes

- Visual identity preserved — polish only, no redesign. Empty states were already complete; focus management excellent.
- Redundancy removals per owner: db list view, feature-tabs row, duplicate New-folder button, naming unification.
- Mobile: 44px targets at ≤760px, icon-button accessible names; layout already survived 390px.
- Remaining minor: `.plugin-toggle` switch + inline chips still sub-44px (design pass, not a CSS bump); timeline view read-only by design.

## Security notes

- AES-256-GCM + PBKDF2-SHA256(310k) backup verified by code trace; passphrase never stored; round-trip export produces a real encrypted payload (smoke T11).
- Plugin sandbox: 13 network/storage APIs neutered in the worker prelude (fail-closed) + iframe CSP `connect-src 'none'`; no eval; postMessage spoofing checks; `__proto__` rejected sandbox-side.
- CSP meta on main page; `android/.gitignore` covers signing keys; no secrets anywhere in the tree (grep-verified).
- Not done: live-browser CSP click-through (no browser available to agents — flagged for owner); passphrase still via `window.prompt` (functional, ugly — future polish).

## Performance notes

- Keystroke path: in-place row replace + 600 ms-debounced full list render (was full rebuild incl. full-body regex per row per keystroke). Notes still uncapped (graph: 150 nodes, canvases: 30 boards/200 nodes/500 edges) — fine at hundreds of notes; virtualization is the future step if thousands.
- Autosave: 2 s debounce, sync `localStorage.setItem`, quota-failure warning, pagehide flush — unchanged, sane.

## Code removed

- Database list view (`renderList`, dispatch branch, `DATABASE_VIEWS` entry; stored `"list"` views sanitize to `"table"`).
- Duplicate feature-tabs row (+ dead CSS); one "New folder" button (hidden, not removed — `byId` refs).
- Dead `--timeline-index` setProperty; stale Capacitor template tests (wrong package); duplicated date-format helpers consolidated.

## Dependencies

Only `@capacitor/android`, `@capacitor/core`, `@capacitor/cli` — all `^8.6.0` (latest published at audit time), all used, lockfile committed. No new dependencies added. `npm audit` was blocked by registry policy (noted, not a finding).

## Tests run (all real, none fabricated)

| Test | Command | Result |
|------|---------|--------|
| Headless boot + workflow suite (repo) | `npm run test:smoke` (`tests/smoke-headless.cjs`) | **58/58 pass**, 0 console errors |
| Syntax | `node --check` on all 6 JS files | clean |
| Android bundle script | `node scripts/prepare-web.mjs` | 8 assets, `www/feature-suite.js` byte-identical |
| Worker prelude neutering | stubbed worker global in node | 13 APIs neutered, fail-closed |
| Drive URL handling | extracted `resolveEmbed`, 11 cases in node | 11/11 pass |
| Build-out function checks | `/tmp/xpin-buildout/verify.cjs` | 45/45 pass |
| Mutation test (M1 fix) | revert fix → T16 fails "entry lost" → re-apply → passes | proves regression test is real |

Suite covers: fresh boot, legacy migration (note + canvas node, no leak, backup kept), note CRUD, query grammar (F-H1/F-H2), cheat-sheet, canvas board delete/rename buttons, Today button, shortcuts dialog, plugin boot, graph, databases, list-view removal, encrypted backup export (real AES-GCM payload), quick capture (incl. focused-editor data-loss regression), backlinks, tag search, daily-note template.

## Build verification

- `node --check`: clean on all JS. `prepare-web.mjs`: verified by execution.
- `android:debug` path fixed but **the Gradle build itself was not run** (no Android SDK in this environment) — config verified consistent (appId/namespace/MainActivity all `com.xfactor21.xpin`).
- **CSP needs a live-browser click-through** (plugins boot, embeds, fonts, no console violations) — no browser available to the agents.

## Remaining issues (minor, documented)

- CSP live-browser verification (above).
- `window.prompt` for passphrase/folder names (functional; a proper dialog is future polish).
- PBKDF2 export has no progress feedback (U10).
- `.mov` kept in video allowlist (plays in Chromium when H.264 — removal could break working embeds).
- F-M3: static export renders raw markdown (didn't wire the existing markdown renderer into `exportPage` — real but low priority).
- F-M5: no COUNT in query grammar (documented limitation, not a bug).

## Blocked items (need owner input/credentials — nothing blocks the current release)

- None for the local app. Live sync needs a server (owner: no servers — documented as future).

## Never-implemented features (owner-prohibited or out of scope)

Accounts, servers, live sync, collaboration, remote marketplace, cloud AI / credit metering. Sync documented as future/blocked.

## Future enhancements (not defects)

Virtualized note list (thousands of notes), share-target/voice capture on mobile, PDF annotation, semantic search, one-click Notion/Evernote/Apple-Notes zip importers, proper passphrase dialog, import progress UI, `[[` autocomplete position refinement.

---

## Plugin system build-out — 2026-11-01 (plugin-system engineer)

Owner report: "imported plugins don't seem to work at all — only the built-in ones."

### Root cause

The import/enable machinery was logically sound (proven end-to-end in headless
Chromium: import → review → approve → command runs via real worker RPC). The
actual defect was a UX trap in the review dialog: **requested capabilities
started UNCHECKED**, so the natural flow (check the trust box → "Allow and run")
approved the plugin with **zero granted capabilities**. The plugin then
"enabled" successfully, but its first capability call failed with "This
permission was not granted" — an unhandled worker rejection invisible to the
user. Net effect: the plugin looked enabled and did nothing at all.

### What was built

**Root-cause fixes**
- Review dialog now **pre-checks requested capabilities** (review = uncheck what
  the plugin should NOT have). Trust checkbox still required.
- Approving with zero of N requested capabilities asks for explicit
  confirmation ("It probably won't work. Approve anyway?").
- Worker `unhandledrejection`s are now relayed to the host as a visible toast
  naming the plugin and the error — async plugin failures are never silent.

**Approval queue (owner's ask)**
- Import → **Pending review** (inert, nothing runs) → **Approve and enable** or
  **Reject with reason** → rejected stays inert, removable, re-reviewable.
- Catalogue shows Pending review / Approved / Rejected pills, sorted pending-first.
- Registry persisted in the workspace per package: status, reason, reviewed-at,
  SHA-256, approved hash, grants. Old saves migrate (once-approved → approved,
  else pending).
- Changed-since-approval packages go back to pending with the reason recorded.
- `startExtension` refuses to run a plugin whose grants exceed its declared
  permissions (defense in depth; grants are also sanitized on load).

**Robustness (all with clear user-facing messages, never silent)**
- Corrupt: malformed JSON → "not valid JSON…"; bad shape/unknown permission
  names the exact problem (e.g. `Unknown plugin permission "teleport"`).
- Oversized: refused with actual sizes. Duplicate id: names installed + incoming
  versions ("Remove it first to import v2.0.0").
- Tampered stored grants are stripped on load; ungranted RPC calls fail loudly
  at runtime ("This permission was not granted.").

**Plugin SDK (owner's "anybody could easily create a plugin")**
- `plugins/starter/` — manifest.json + fully commented main.js skeleton +
  README with the local workflow.
- `plugins/pack.mjs` — assembles + validates the importable `.xpin.json`
  (same rules the app enforces on import).
- `plugins/examples/template-pack/` — real working plugin (meeting/decision/
  reading templates) built against the starter; proves the SDK end-to-end.
- `PLUGIN_GUIDE.md`: new "Developing plugins" section (manifest schema,
  capability table, local dev workflow, approval expectations).

**Expanded capabilities**: `notes:update` (edit any note's title/body),
`ui:status` (status-bar item, set/clear) — both validated, capability-gated,
and covered by tests.

### Verification

- `node --check` clean on all touched files (app.js, plugin-sandbox.js,
  index.html/CSS via harness, tests, pack.mjs, template/example sources).
- `npm run test:smoke`: **103/103 pass** (58 pre-existing + 45 new T17–T27).
  New tests execute REAL imports through a faithful iframe+Worker simulation
  (only browser primitives faked; the genuine WORKER_PRELUDE/RUNTIME strings
  run in `vm`): import→pending→approve→command-RPC, zero-grant confirm,
  reject→inert→re-review, corrupt/oversized/duplicate handling, escalation
  blocked (storage tamper + live RPC refusal), changed-package→pending,
  notes:update + ui:status, and the shipped example plugin.
- **Live-browser verification (new)**: installed headless Chromium and drove the
  real app — import, review (pre-checked boxes), approve, template insertion,
  reject-with-reason — 8/8 pass, zero console errors. This also covers the
  "CSP live-browser click-through" item left open in Build verification above:
  plugin boot + worker execution show no CSP violations.
- Gradle build still not run (no Android SDK); live sync still out of scope.

### Needs the owner

Nothing technical. The plugin SDK is ready to share; if he wants a remote
plugin directory/marketplace later, that's a new project (needs a server,
which he ruled out).
