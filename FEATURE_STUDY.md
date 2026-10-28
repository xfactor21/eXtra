# Pinboard feature study

This study records product-level behavior and an original implementation plan for Pinboard. It is not a request to reproduce either product's source code, assets, brand, or distinctive interface. Observations from local binaries are separated from public documentation and from design proposals.

## Evidence and limits

### Obsidian desktop

- **Static artifact:** `C:\Users\17143\AppData\Local\Programs\Obsidian\resources\obsidian.asar`, SHA-256 `a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d`.
- **Previously retained evidence:** `ev_a3b0200de690d4070a6a662476e3934bfe093b229d9c1fb57791fcd9efea3bba`, wrapper package 1.13.7.
- **Observed in the selected `app.js` source:** File Explorer supports alphabetical ascending/descending, modified newest/oldest, and created newest/oldest; folders precede files; the sort selection is persisted with workspace layout. Markdown edits request a save after a two-second debounce through the vault adapter, with pending edits flushed on quit.
- **Limits:** This was static analysis of a selected source file, not live interaction or exhaustive application analysis. The wider bundle had incomplete semantic coverage. Two unpacked native dependency integrity mismatches were recorded as untrusted; they did not involve the selected `app.js`.
- **Canvas:** The local analysis was not a complete trace of Canvas internals. The interoperable JSON Canvas 1.0 specification is the stronger evidence for its portable data model: top-level `nodes` and `edges`; text/file/link/group nodes; positioned and sized nodes; edges with endpoints, sides, colors, and labels. Pinboard already validates and imports/exports this format.
- **Plugins:** Earlier static inspection identified plugin-registry and lifecycle patterns, but did not recover every plugin implementation or the full marketplace. Public plugin documentation describes community packages distributed through a catalogue, with a manifest and release assets, and lifecycle cleanup. It is not evidence that every package is trustworthy or interchangeable.

### Notion desktop

- **Static artifact:** `C:\Users\17143\AppData\Local\Programs\Notion\resources\app.asar`, SHA-256 `8fa8ebc856c195b8ba3ed48e243013e5aeb67ecd5d3cb8ec6cbef1dc40f2cae0`.
- **Inventory evidence:** `ev_7cf47527eb6ac38ec21052926bc9bcf9ee353246c2f2f3bda6a93edd49f8baa2`; the archive inventory completed for 854 inspected entries (275 graph nodes and 290 occurrences in the retained summary).
- **Source-analysis evidence:** `ev_5f0d1157b5be40e43a87694cf76d319d294b9324797aff640b5d88f7f5e5478f`; a focused attempt on `.webpack/main/index.js` hit the REA analyzer's 512 MiB worker heap limit before parsing JavaScript. The selected-scope analysis therefore recovered no application modules or feature semantics. It left 164 inventoried files outside the selected source scope and reported partial graph coverage.
- **Integrity caveat:** Five unpacked native files had archive-integrity contradictions and were retained as observed-untrusted. They are not used as evidence for feature behavior.
- **What this does not prove:** The local archive alone does not establish how Notion's cloud backend, collaboration, permissions, publishing, or runtime editor works. This study does not claim to have traced those systems inside the installed app.

### Public product documentation consulted

- [Notion database views, filters, sorts, and groups](https://www.notion.com/help/views-filters-and-sorts)
- [Notion relations and rollups](https://www.notion.com/help/relations-and-rollups)
- [Notion synced blocks](https://www.notion.com/help/synced-blocks)
- [Notion Sites / public publishing](https://www.notion.com/help/public-pages-and-web-publishing)
- [Notion embeds and connected apps](https://www.notion.com/help/embed-and-connect-other-apps)
- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/)

These pages describe public product behavior, not private implementation details of either installed binary.

## Feature notes and Pinboard design

| Capability | Product-level behavior | Pinboard design |
|---|---|---|
| Block editor and slash commands | A page is composed of editable content blocks; an insertion menu turns a typed command into a block type. | Keep Pinboard's Markdown source as the durable format. Offer a slash menu that inserts Markdown structures rather than converting content to proprietary blocks. |
| Nested pages | Pages can contain or link to child pages and can be opened as full pages. | Add a parent-page relation to notes, show hierarchy in note metadata, and prevent self/descendant cycles. Notes remain independently addressable. |
| Database views | The same database records can be shown as table, board, calendar, gallery, list, or timeline; each view may present the same records differently. | Store records and property definitions separately from the active view. Provide all six layouts over one local dataset; unsupported view-specific controls are explicitly out of scope. |
| Relations and rollups | Relation fields connect records across databases. Rollups compute aggregates from related records and their properties. | Store relation IDs, validate them against a target table, and compute a count rollup over inbound relations in code. This first slice intentionally does not claim a general formula engine. Never evaluate user-authored JavaScript or arbitrary formulas. |
| Synced blocks | Multiple references render the same source content; editing the source updates every reference. | Store canonical shared text blocks by ID and insert stable references in notes. Render references read-only in previews; edit the canonical block in a dedicated manager. |
| Publishing | A hosted site exposes a page and can update when its source changes; hosting, access control, and indexing are service responsibilities. | Export a standalone static HTML copy for the user to host. Pinboard does not claim it has published a public URL, custom domain, SEO service, or auto-updating site. |
| Multimedia and embeds | Pages can include files and embeds from external providers; viewers may connect to those providers. | Add explicit embed syntax for a short provider allowlist. Construct provider URLs locally, show a click-to-load control, sandbox frames, and keep ordinary Markdown rendering free of arbitrary HTML and automatic remote fetches. |
| Graph | Notes appear as nodes connected by links/backlinks. | Derive edges from `[[note title]]` references and parent-page relations; never persist a duplicate graph that can drift from note content. |
| Canvas | Spatial boards contain positioned cards and relationships. | Retain JSON Canvas 1.0 import/export and Pinboard's established design system; avoid bundling proprietary Canvas code. |
| Dataview-like queries | Metadata and note content can be selected to build dynamic lists/tables. | Provide a small, documented query grammar over local notes and tables. Parse with explicit operators and field allowlists; do not use `eval`, dynamic imports, or executable query blocks. |
| Themes and custom CSS | Themes and snippets alter presentation. | Expose validated color and density tokens. Arbitrary CSS snippets are not enabled because CSS can exfiltrate data or disguise UI, and this prototype has no safe CSS isolation boundary. |
| Community plugins | A catalogue points to separately maintained packages; the host manages compatibility and plugin lifecycle. | Keep the local catalogue and reviewed sandbox upload path. New packages remain disabled until a manifest/package review and explicit per-capability consent. Do not fetch or execute arbitrary marketplace code. |
| Cross-platform and E2E sync | Sync requires identity, transport, conflict handling, encryption, key recovery, and device management. | Offer a passphrase-encrypted portable workspace backup. This is a local file handoff, not automatic sync; no remote account, sync server, conflict resolution, or recovery escrow is implied. |

## Implementation delivered in this iteration

Pinboard adds a local block-command menu, nested note links, a derived graph, synchronized text references, safe provider embeds, a local relational database with six layouts and a constrained count rollup, a limited read-only query language, validated theme controls, static page export, and passphrase-encrypted workspace export/import. The database and shared-block data are versioned inside the existing local workspace record and are sanitized on load.

The prototype does not implement a hosted CMS, real-time collaboration, cloud sync, user accounts, custom domains, SEO indexing, arbitrary CSS, arbitrary plugin marketplace execution, or unrestricted embeds. Those require infrastructure and security/product decisions outside this local-only repository.
