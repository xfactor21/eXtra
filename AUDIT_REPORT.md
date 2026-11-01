# xpin — Forensic Audit Report

**Date:** 2026-11-01 · **Auditors:** 5 parallel forensic workers (feature-suite, UI/UX, core functionality, security/plugins, performance/build/deps) · **Scope:** full repo, read-only · **Method:** every UI claim traced to state, logic, and storage; no trust in comments/docs.

**Repo:** `/home/hatch/workspace/xpin/extra` (cloned from `github.com/xfactor21/eXtra`) · **State at audit:** rename Pinboard→xpin complete + storage migration verified.

---

## Verdict summary

**19 verified working end-to-end** (genuinely real, not mocked): notes CRUD + 6 sorts + filters, nested pages (cycle guard, orphan re-parenting), 2 s autosave w/ quota failure + pagehide flush, JSON Canvas 1.0 import/export/validation + limits, safe https-only sandboxed embeds, static export w/ CSP, AES-GCM-256 + PBKDF2-SHA256(310k) encrypted backup (passphrase never stored), folders CRUD, real Worker plugin sandbox, synced-block recursion guard, tag extraction (`#tag`, `#tag/sub`), query grammar (regex + field whitelist, textContent rendering — no code exec), graph link derivation, theme tokens.

**1 CRITICAL · 9 HIGH · 16 MEDIUM · ~14 LOW.** No CRITICAL/HIGH security issues; crypto and sandbox are genuinely sound.

## CRITICAL

- **P0 — Android build ships broken:** `scripts/prepare-web.mjs` `webFiles` omits `feature-suite.js`, but `index.html:177` loads it and `app.js:2516` calls `window.xpinFeatures.create()` unguarded → TypeError during boot on Android. (1-line fix.)

## HIGH

| # | Finding | Location |
|---|---------|----------|
| F-H1 | Query `WHERE tag=<value>` never matches unless value has `#` prefix | feature-suite.js:578 |
| F-H2 | `TABLE` field names case-sensitive despite case-insensitive grammar | feature-suite.js:560 |
| F-H3 | No delete/rename for databases or columns | feature-suite.js |
| C1/U2 | Canvas boards can't be deleted/renamed (cap is 30 boards — a dead end with no way out) | app.js |
| H-I | Destructive actions lack confirmation: db row delete, canvas node delete (incl. Delete key), synced-block delete | app.js / feature-suite.js |
| U1 | Mobile nav buttons lose accessible names at ≤760px (icon-only) | styles.css |
| U5 | Touch targets <44px pervasive | styles.css |
| P1 | `npm run android:debug` uses `gradlew.bat` — broken on Linux/macOS and PowerShell | package.json:11 |
| P2 | `android/gradlew` not executable (no x bit) | android/gradlew |

## MEDIUM (16)

- F-M1 theme accent/density not applied on boot · F-M2 synced blocks expand whole-line only vs UI claim · F-M3 static export dumps raw markdown · **F-M4 no backlinks panel** (graph works) · F-M5 no COUNT in query grammar (documented) · F-M6 rollup always count-all-inbound
- C-C2 `@drive()` embeds half-dead for docs.google.com URLs (app.js:1155-1161) · C-C4 canvas file-nodes dangle on note delete · C-C5 stale feature-view state reopens on reload · C-C6 slash menu mouse-only · C-C7 no edge label/side editing · C-C9 post-delete selection ignores sort
- U6 stale page subtitle after graph/dataview nav · **U7 daily note has no visible entry point** (palette-only, app.js:2055) · U8 shortcuts undiscoverable · U9 no query cheat-sheet · U10 PBKDF2 no progress feedback · U13 board view hardcodes 3 status lanes
- S-M1 plugin worker denylist incomplete (fetch/XHR/WebSocket/EventSource/sendBeacon not neutered; "no network" rests on iframe CSP `connect-src 'none'`) · S-M2 user guide claim gaps (says no network/storage access — CSP enforces it, prelude doesn't)
- P3 full list re-render per keystroke (no virtualization, notes uncapped; fine at dozens, janky at hundreds) · P4 stale Capacitor template tests w/ wrong package · P5 `.gitignore` signing-key lines commented out · P6 `cap sync` w/o `build:web` fails on fresh clone

## LOW (~14)

F-L1 5/6 db views read-only · F-L2 "Relation to notes" label wrong (selects rows, not notes) · F-L3 feature view from canvas dumps to notes · F-L4 duplicated helpers (getAllNotesByTags/extractTags, date format fns) · F-L5 dead `--timeline-index` var · F-L6 `sanitizeState` aggressive (not corrupting) · U14 no board/timeline density · U15 note count not announced · U16 mobile canvas zoom controls overlap · U17 feature view empty note list not announced · U18 redundant labels in plugin command rows · U19 graph/dataview settings duplicated in main settings · C-C10 no-op ternary · C-C11 `.mov` in video allowlist (likely unplayable) · S-L1 `__proto__` in settings:write (tiny blast radius) · S-L2 no CSP meta on main page · S-L3 passphrase via window.prompt · S-L4 postMessage `targetOrigin "*"` (mitigated by sender spoofing checks) · P8-11 deps clean, Android config consistent, hygiene clean.

## Redundancy audit (owner-flagged)

Confirmed true duplicates: (1) database **list view** ≈ notes list → remove; (2) **feature-tabs row** in feature views duplicates the sidebar nav → remove; (3) two **"New folder"** buttons (sidebar + notes toolbar) → keep one; (4) settings tab "Workspace" vs feature page "Workspace tools" naming → unify as "Workspace tools". "Recently edited" filter label and canvas nav label should be renamed for clarity.

## What was NOT built (owner-blocked, not defects)

No accounts/servers/live sync (no backend exists), no collaboration, no remote marketplace, no cloud AI. Documented as future in AUDIT_REPAIR_LOG.md.

## Auditor artifacts

`/tmp/xpin-audit/{feature-suite,ui-ux,core-functionality,security,perf-build}.md` · smoke test `/tmp/xpin-smoke.js` (boot + migration pass).

*Repair phase targets CRITICAL+HIGH first, then MEDIUM; LOW batched where surgical.*
