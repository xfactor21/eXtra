(() => {
  "use strict";

  const STORAGE_KEY = "xPin.workspace.v1";
  const LEGACY_STORAGE_KEYS = ["xpin.workspace.v1", "pinboard.workspace.v1"]; // pre-rename keys; migrated once on first run, newest first
  const SAVE_DELAY = 2000;
  // M4 — storage: IndexedDB is the primary store, localStorage keeps a backup
  // copy of the same JSON so one corrupt value cannot wipe the workspace.
  const IDB_NAME = "xpin";
  const IDB_STORE = "workspace";
  const IDB_KEY = "workspace-v1";
  // M2 — safety net caps. Versions keep the body/title a note had before each
  // save; trash keeps soft-deleted notes until restored or emptied.
  const MAX_NOTE_VERSIONS = 20;
  const MAX_TRASH_NOTES = 200;
  const MAX_UNDO_STEPS = 20;
  // M5 — note properties (frontmatter): keys start with a letter, then
  // letters, digits, spaces, "_" or "-". Values are strings, numbers,
  // booleans, null, or arrays of strings.
  const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,49}$/;
  const MAX_METADATA_ENTRIES = 50;
  const SORTS = ["modified-desc", "modified-asc", "created-desc", "created-asc", "title-asc", "title-desc"];
  const MAX_CANVASES = 30;
  const MAX_CANVAS_NODES = 200;
  const MAX_CANVAS_EDGES = 500;

  function seedTemplates() {
    return [
      {
        id: makeId("template"),
        name: "Daily note",
        content: "# {{date}}\n\n## Inbox\n"
      },
      {
        id: makeId("template"),
        name: "Meeting notes",
        content: "# {{title}} — {{date}}\n\nAttendees: \n\n## Notes\n\n- \n\n## Actions\n\n- [ ] "
      }
    ];
  }

  function sanitizeTemplates(value) {
    if (!Array.isArray(value)) return seedTemplates();
    const clean = value
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" && item.id ? item.id : makeId("template"),
        name: typeof item.name === "string" ? item.name.slice(0, 80) : "Untitled template",
        content: typeof item.content === "string" ? item.content.slice(0, 100_000) : ""
      }))
      .filter((item) => item.name.trim());
    return clean;
  }
  const initialWorkspace = {
    sort: "modified-desc",
    filter: "all",
    view: "notes",
    tagFilter: null,
    collapsed: [],
    plugins: { enabled: {}, settings: {} },
    extensions: [],
    marketplaceDirs: [],
    // Phase 1 — integrations key (fabriX spec §10): the explicit edit point
    // the fabriX adapter owns. The adapter owns the fabrix sub-key shape;
    // this key must survive save/load round-trips (see sanitizeIntegrations).
    integrations: { fabrix: { enabled: false } },
    // Phase 1 — sync state (E2EE sync; relay URL empty = bundles only).
    // Passphrases are NEVER stored — only key-check values + salts.
    sync: {
      deviceId: null, // generated once on first sync use ("xpin-<random>")
      relayUrl: "",
      lastSyncAt: null,
      lastSyncStatus: "off", // off | ok | error | not-configured
      lastSyncLamport: 0,
      lamport: 0,
      seen: [], // envelope ids already applied (last 200, idempotency)
      tombstones: [], // {noteId, lamport, deviceId} for permanent deletes
      syncSalt: null, // base64, 16 bytes — sync key KDF salt
      syncKeyCheck: null, // base64 SHA-256 key-check (see sync/sync.js)
      credentialSalt: null, // base64, 16 bytes — credential key KDF salt
      credentialKeyCheck: null,
      captureToken: null, // random token for the future capture endpoint / fabriX adapter; revocable
      captureTokenCreatedAt: null,
      publishTarget: "" // empty = bundle is the deliverable; no hosted publishing exists
    },
    // Phase 1 — connector credential store (audit C4): per-plugin ENCRYPTED
    // envelopes only ({iv, ciphertext}); plaintext never lands here.
    connectorCredentials: {},
    // Phase 2 — Capture & smarts. Sanitized on load by xPinPhase2 (see
    // loadWorkspace); keys live in the plaintext workspace blob EXCEPT AI
    // keys, which stay in connectorCredentials above.
    settings: { dailyLanding: true, ai: { enabled: false, provider: "claude", baseUrl: "", embeddingsEnabled: false, embeddingsBaseUrl: "" } },
    // Phase 3 — Power & polish state (sanitized on load by xPinPhase3).
    phase3: window.xPinPhase3?.defaultPhase3State?.() ?? { settings: { theme: "dark", font: "system", splitPreview: false }, scripts: { approved: [] }, hooks: [], savedQueries: [], spaces: [], comments: [], mentions: [], reminders: [], dbViews: {} },
    attachments: [], // {id, noteId, name, mime, size, createdAt, data?, synced} — blobs in phase2 IndexedDB
    readLater: [], // {id, url, title, text, fetchedText, fetchedAt, fetchStatus, savedAt, read}
    highlights: [], // {id, quote, sourceId, sourceTitle, sourceUrl, createdAt, dismissedAt, shownCount}
    flashcards: [], // {id, front, back, sourceNoteId, kind, clozeIndex, stability, difficulty, dueAt, lastReviewedAt, reviews, lapses}
    trash: [], // M2: soft-deleted notes ({...note, deletedAt}); restored or emptied, never silently lost
    savedAt: null, // M4: ISO timestamp of the last successful persist; used to reconcile IndexedDB vs localStorage
    templates: seedTemplates(),
    features: window.xPinFeatures.initialState(),
    selectedCanvasId: "canvas-main",
    canvases: [{ id: "canvas-main", name: "Thinking board", nodes: [], edges: [] }],
    folders: [
      { id: "folder-studio", name: "Studio" },
      { id: "folder-ideas", name: "Ideas" }
    ],
    notes: [
      {
        id: "note-weekly-reset",
        title: "A gentler weekly reset",
        body: "A short list for a clearer Monday:\n\n— Clear the desk, not the whole inbox\n— Pick one thing that would make this week feel good\n— Leave a little room for the unexpected\n\nSmall rituals make space for the bigger thoughts.",
        folderId: "folder-studio",
        pinned: true,
        createdAt: "2026-03-16T15:00:00.000Z",
        updatedAt: "2026-10-28T11:15:00.000Z"
      },
      {
        id: "note-colors",
        title: "Color notes — spring",
        body: "Sea glass, warm paper, and one bright little spark.\n\nTry a washed cyan beside a dusty orange. Keep the dark tones soft enough to feel like evening, not midnight.",
        folderId: "folder-studio",
        pinned: false,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-10-28T08:30:00.000Z"
      },
      {
        id: "note-small-ideas",
        title: "Small ideas, big energy",
        body: "A tiny idea does not need a grand plan.\n\nWrite it down while it still feels light. Let the next step reveal itself.",
        folderId: "folder-ideas",
        pinned: false,
        createdAt: "2026-08-03T10:00:00.000Z",
        updatedAt: "2026-10-27T16:20:00.000Z"
      },
      {
        id: "note-reading-list",
        title: "A reading list for later",
        body: "Things to come back to when there is a quiet hour and a warm drink.",
        folderId: null,
        pinned: false,
        createdAt: "2026-10-26T14:00:00.000Z",
        updatedAt: "2026-10-26T14:00:00.000Z"
      }
    ]
  };

  const byId = (id) => document.getElementById(id);
  const ui = {
    noteList: byId("note-list"),
    emptyState: byId("empty-state"),
    emptyTitle: byId("empty-title"),
    emptyDescription: byId("empty-description"),
    emptyCreate: byId("empty-create"),
    noteTitle: byId("note-title"),
    noteBody: byId("note-body"),
    noteFolder: byId("note-folder"),
    noteParent: byId("note-parent"),
    editorFields: byId("editor-fields"),
    editorEmpty: byId("editor-empty"),
    editorFolder: byId("editor-folder"),
    editorDate: byId("editor-date"),
    noteMetaDate: byId("note-meta-date"),
    noteProperties: byId("note-properties"),
    storageNote: document.querySelector(".sync-card small"),
    saveState: byId("save-state"),
    saveLabel: byId("save-label"),
    pinButton: byId("pin-note"),
    deleteButton: byId("delete-note"),
    search: byId("search-input"),
    sort: byId("sort-select"),
    listCount: byId("list-count"),
    listHeading: byId("list-heading-label"),
    currentView: byId("current-view-label"),
    pageTitle: byId("page-title"),
    toast: byId("toast"),
    pluginList: byId("plugin-list"),
    pluginSearch: byId("plugin-search"),
    pluginCategory: byId("plugin-category"),
    pluginCount: byId("plugin-count"),
    pluginsModal: byId("plugins-modal"),
    commandsModal: byId("commands-modal"),
    commandSearch: byId("command-search"),
    commandList: byId("command-list"),
    pluginPanels: byId("plugin-panels"),
    editorStatus: byId("editor-status"),
    canvasView: byId("canvas-view"),
    canvasSelect: byId("canvas-select"),
    canvasStage: byId("canvas-stage"),
    canvasNodes: byId("canvas-nodes"),
    canvasEdges: byId("canvas-edges"),
    canvasViewport: byId("canvas-viewport"),
    canvasEmpty: byId("canvas-empty"),
    canvasStatus: byId("canvas-status"),
    markdownPreview: byId("markdown-preview"),
    codeLanguage: byId("code-language"),
    togglePreview: byId("toggle-preview"),
    pluginConsentModal: byId("plugin-consent-modal"),
    pluginPermissions: byId("plugin-permissions"),
    pluginTrustCheckbox: byId("plugin-trust-checkbox"),
    pluginConsentStatus: byId("plugin-consent-status"),
    pluginConsentProvenance: byId("plugin-consent-provenance"),
    pluginSourceView: byId("plugin-source-view"),
    pluginRejectRow: byId("plugin-reject-row"),
    pluginRejectReason: byId("plugin-reject-reason"),
    allowPluginButton: byId("allow-plugin"),
    pluginFileInput: byId("plugin-file-input"),
    canvasFileInput: byId("canvas-file-input")
  };

  let state = loadWorkspace();
  let selectedNoteId = state.notes[0]?.id ?? null;
  let storageBackend = "localStorage"; // "indexeddb" once a write there succeeds
  let storageBytes = JSON.stringify(state).length;
  let storageRecoveryOffered = false;
  let idbOpenPromise = null;
  // M2 — version baselines (last persisted title/body per note) and the
  // structural-action undo stack (snapshots of notes/folders/trash).
  const versionBaselines = new Map();
  const undoStack = [];
  initVersionBaselines();
  let saveTimer = null;
  let toastTimer = null;
  let pluginManager = null;
  let featureSuite = null;
  // Phase 2 — Capture & smarts UI controller (created at boot).
  let phase2UI = null;
  // Phase 3 — Power & polish UI controller (created at boot).
  let phase3UI = null;
  // Phase 1 — sync session state (in-memory only; never persisted).
  let syncSessionKey = null;
  let captureTokenVisibleOnce = null; // token text shown once after generation
  let activeCommandIndex = 0;
  let canvasViewportState = { x: 0, y: 0, zoom: 1 };
  let canvasSaveTimer = null;
  let canvasGesture = null;
  let connectFromNodeId = null;
  let selectedCanvasNodeId = null;
  let selectedCanvasEdgeId = null;
  let canvasEdgeEditor = null;
  let shortcutsDialog = null;
  let pendingPluginConsent = null;
  const activeExtensions = new Map();
  const extensionCommands = new Map();
  const extensionStatusItems = new Map();

  function sanitizeCanvases(value) {
    if (!Array.isArray(value)) return structuredClone(initialWorkspace.canvases);
    const canvases = [];
    for (const board of value) {
      if (!board || typeof board.id !== "string" || typeof board.name !== "string" ||
        (board.nodes !== undefined && !Array.isArray(board.nodes)) ||
        (board.edges !== undefined && !Array.isArray(board.edges))) continue;
      const sourceNodes = board.nodes ?? [];
      const sourceEdges = board.edges ?? [];
      const ids = new Set();
      const nodes = [];
      for (const node of sourceNodes) {
        if (!node || typeof node.id !== "string" || ids.has(node.id) ||
          !["text", "file", "link", "group"].includes(node.type) ||
          !Number.isFinite(node.x) || !Number.isFinite(node.y) ||
          !Number.isFinite(node.width) || !Number.isFinite(node.height)) continue;
        const safeNode = {
          id: node.id,
          type: node.type,
          x: Math.round(node.x),
          y: Math.round(node.y),
          width: Math.max(100, Math.min(1200, Math.round(node.width))),
          height: Math.max(80, Math.min(1000, Math.round(node.height)))
        };
        if (typeof node.color === "string" && (/^[1-6]$/.test(node.color) || /^#[0-9a-f]{6}$/i.test(node.color))) {
          safeNode.color = node.color;
        }
        if (node.type === "text" && typeof node.text === "string") safeNode.text = node.text;
        if (node.type === "file" && typeof node.file === "string") {
          safeNode.file = node.file;
          if (typeof node.xPinNoteId === "string") safeNode.xPinNoteId = node.xPinNoteId;
          else if (typeof node.pinboardNoteId === "string") safeNode.xPinNoteId = node.pinboardNoteId; // pre-rename field
        }
        if (node.type === "link" && typeof node.url === "string") {
          try {
            const url = new URL(node.url);
            if (["https:", "http:"].includes(url.protocol)) safeNode.url = url.href;
          } catch {}
        }
        if (node.type === "group") {
          if (typeof node.label === "string") safeNode.label = node.label;
          if (typeof node.background === "string") safeNode.background = node.background;
          if (["cover", "ratio", "repeat"].includes(node.backgroundStyle)) safeNode.backgroundStyle = node.backgroundStyle;
        }
        if ((node.type === "text" && typeof safeNode.text !== "string") ||
          (node.type === "file" && typeof safeNode.file !== "string") ||
          (node.type === "link" && typeof safeNode.url !== "string")) continue;
        ids.add(safeNode.id);
        nodes.push(safeNode);
      }
      const validIds = new Set(nodes.map((node) => node.id));
      const edgeIds = new Set();
      const edges = sourceEdges.filter((edge) => {
        if (!edge || typeof edge.id !== "string" || edgeIds.has(edge.id) ||
          !validIds.has(edge.fromNode) || !validIds.has(edge.toNode) || edge.fromNode === edge.toNode) return false;
        edgeIds.add(edge.id);
        return true;
      }).map((edge) => {
        const safeEdge = { id: edge.id, fromNode: edge.fromNode, toNode: edge.toNode };
        for (const side of ["fromSide", "toSide"]) {
          if (["top", "right", "bottom", "left"].includes(edge[side])) safeEdge[side] = edge[side];
        }
        for (const end of ["fromEnd", "toEnd"]) {
          if (["none", "arrow"].includes(edge[end])) safeEdge[end] = edge[end];
        }
        if (typeof edge.color === "string" && (/^[1-6]$/.test(edge.color) || /^#[0-9a-f]{6}$/i.test(edge.color))) safeEdge.color = edge.color;
        if (typeof edge.label === "string") safeEdge.label = edge.label;
        return safeEdge;
      });
      canvases.push({ id: board.id, name: board.name, nodes, edges });
    }
    return canvases.length ? canvases : structuredClone(initialWorkspace.canvases);
  }

  function sanitizeExtensions(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 50).flatMap((record) => {
      try {
        const plugin = window.xPinSandbox.validatePackage(record);
        if (typeof record.fileName !== "string" || typeof record.sha256 !== "string" ||
          typeof record.installedAt !== "string") return [];
        return [{
          ...plugin,
          fileName: record.fileName.slice(0, 180),
          sha256: record.sha256,
          installedAt: record.installedAt,
          enabled: record.enabled === true,
          approvedHash: typeof record.approvedHash === "string" ? record.approvedHash : null,
          grants: Array.isArray(record.grants) ? record.grants.filter((item) =>
            plugin.manifest.permissions.includes(item)
          ) : [],
          // Phase 1 — connector origins: only origins the plugin declared
          // AND the user approved, each individually, in the review queue.
          // Revocation removes an entry here and takes effect immediately
          // (the host checks this list on every network:fetch).
          approvedOrigins: Array.isArray(record.approvedOrigins)
            ? record.approvedOrigins.filter((origin) =>
              typeof origin === "string" && (plugin.manifest.networkOrigins ?? []).includes(origin))
            : [],
          settings: record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
            ? record.settings
            : {},
          // Review queue (added after launch): older saves predate it, so infer
          // the status — anything once approved stays approved, the rest is pending.
          reviewStatus: record.reviewStatus === "approved" || record.reviewStatus === "rejected"
            ? record.reviewStatus
            : (typeof record.approvedHash === "string" && record.approvedHash ? "approved" : "pending"),
          reviewReason: typeof record.reviewReason === "string" ? record.reviewReason.slice(0, 200) : null,
          reviewedAt: typeof record.reviewedAt === "string" ? record.reviewedAt : null
        }];
      } catch (error) {
        console.error("An invalid saved xPin plugin was ignored.", error);
        return [];
      }
    });
  }

  // M5 — note properties: keep only well-formed frontmatter entries. Anything
  // else (nested objects, weird keys, oversize values) is dropped on load
  // rather than trusted. `dailyDate` is an ordinary property and survives.
  function sanitizeNoteMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.keys(clean).length >= MAX_METADATA_ENTRIES) break;
      if (!METADATA_KEY_PATTERN.test(key)) continue;
      if (typeof item === "string") clean[key] = item.slice(0, 2000);
      else if (typeof item === "number" && Number.isFinite(item)) clean[key] = item;
      else if (typeof item === "boolean" || item === null) clean[key] = item;
      else if (Array.isArray(item) && item.length <= 20 && item.every((entry) => typeof entry === "string")) {
        clean[key] = item.map((entry) => entry.slice(0, 200));
      }
    }
    return clean;
  }

  // M2 — per-note version history: [{ title, body, updatedAt }], newest last.
  function sanitizeNoteVersions(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_NOTE_VERSIONS).flatMap((version) => {
      if (!version || typeof version !== "object" ||
        typeof version.title !== "string" || typeof version.body !== "string") return [];
      return [{
        title: version.title.slice(0, 120),
        body: version.body.slice(0, 100_000),
        updatedAt: typeof version.updatedAt === "string" && Number.isFinite(Date.parse(version.updatedAt))
          ? version.updatedAt
          : new Date(0).toISOString()
      }];
    });
  }

  function sanitizeNoteRecord(raw, folderIds) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id ||
      typeof raw.title !== "string") return null;
    const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
      ? value
      : new Date(0).toISOString();
    return {
      id: raw.id,
      title: raw.title,
      body: typeof raw.body === "string" ? raw.body : "",
      folderId: typeof raw.folderId === "string" && folderIds.has(raw.folderId) ? raw.folderId : null,
      pinned: raw.pinned === true,
      parentNoteId: typeof raw.parentNoteId === "string" ? raw.parentNoteId : null,
      createdAt: validDate(raw.createdAt),
      updatedAt: validDate(raw.updatedAt),
      metadata: sanitizeNoteMetadata(raw.metadata),
      versions: sanitizeNoteVersions(raw.versions),
      // Phase 1 — per-note sync version {lamport, deviceId} (LWW clock).
      // Defaults to 0 (never synced); sanitized, never trusted blindly.
      syncVersion: window.xPinSync?.sanitizeSyncVersion
        ? window.xPinSync.sanitizeSyncVersion(raw.syncVersion)
        : { lamport: 0, deviceId: "" }
    };
  }

  function sanitizeTrash(value, folderIds, liveNoteIds) {
    if (!Array.isArray(value)) return [];
    const knownIds = new Set(liveNoteIds);
    const records = [];
    for (const raw of value.slice(-MAX_TRASH_NOTES)) {
      const note = sanitizeNoteRecord(raw, folderIds);
      if (!note) continue;
      knownIds.add(note.id);
      records.push({
        ...note,
        deletedAt: typeof raw.deletedAt === "string" && Number.isFinite(Date.parse(raw.deletedAt))
          ? raw.deletedAt
          : note.updatedAt
      });
    }
    // A trashed note keeps its parent only when the parent still exists.
    records.forEach((note) => {
      if (note.parentNoteId && !knownIds.has(note.parentNoteId)) note.parentNoteId = null;
    });
    return records;
  }

  // Phase 1 (fabriX spec §10 + audit G4): the `integrations` key is an
  // explicit edit point. Known keys are kept, unknown ones dropped — the
  // fabriX adapter owns its sub-key shape and sanitizes it itself.
  function sanitizeIntegrations(value) {
    const clean = { fabrix: { enabled: false } };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const fabrix = value.fabrix;
      if (fabrix && typeof fabrix === "object" && !Array.isArray(fabrix)) {
        clean.fabrix = {
          enabled: fabrix.enabled === true,
          // The adapter owns everything else under fabrix; keep only
          // JSON-safe values so a corrupt sub-key cannot break the load.
          ...(typeof fabrix === "object" ? {} : {})
        };
        // Preserve adapter-owned scalar/JSON fields verbatim (capped), but
        // never trust nested executable content — the adapter re-validates
        // its own state on enable.
        for (const [key, item] of Object.entries(fabrix)) {
          if (key === "enabled") continue;
          if (Object.keys(clean.fabrix).length > 40) break;
          if (typeof item === "string") clean.fabrix[key] = item.slice(0, 4000);
          else if (typeof item === "number" && Number.isFinite(item)) clean.fabrix[key] = item;
          else if (typeof item === "boolean" || item === null) clean.fabrix[key] = item;
          else if (Array.isArray(item) && item.length <= 200) {
            try { clean.fabrix[key] = JSON.parse(JSON.stringify(item.slice(0, 200))); } catch { /* drop */ }
          } else if (item && typeof item === "object") {
            try { clean.fabrix[key] = JSON.parse(JSON.stringify(item)); } catch { /* drop */ }
          }
        }
      }
    }
    return clean;
  }

  // Phase 1: sync state sanitizer — keeps known keys, drops unknown ones,
  // caps the seen-log and tombstone list (audit G4: new state keys must
  // survive load, not be silently stripped).
  function sanitizeSyncState(value) {
    const defaults = structuredClone(initialWorkspace.sync);
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
    const str = (item, max = 400) => typeof item === "string" ? item.slice(0, max) : null;
    const lamport = (item) => Number.isFinite(item) ? Math.max(0, Math.floor(item)) : 0;
    return {
      deviceId: typeof value.deviceId === "string" && /^xpin-[a-z0-9]{1,32}$/.test(value.deviceId)
        ? value.deviceId : null,
      relayUrl: typeof value.relayUrl === "string" ? value.relayUrl.slice(0, 500) : "",
      lastSyncAt: typeof value.lastSyncAt === "string" && Number.isFinite(Date.parse(value.lastSyncAt))
        ? value.lastSyncAt : null,
      lastSyncStatus: ["off", "ok", "error", "not-configured"].includes(value.lastSyncStatus)
        ? value.lastSyncStatus : "off",
      lastSyncLamport: lamport(value.lastSyncLamport),
      lamport: lamport(value.lamport),
      seen: Array.isArray(value.seen)
        ? value.seen.filter((id) => typeof id === "string").slice(-200) : [],
      tombstones: Array.isArray(value.tombstones)
        ? value.tombstones.filter((t) => t && typeof t.noteId === "string" && Number.isFinite(t.lamport))
          .slice(-200).map((t) => ({
            noteId: t.noteId.slice(0, 120),
            lamport: Math.max(0, Math.floor(t.lamport)),
            deviceId: typeof t.deviceId === "string" ? t.deviceId.slice(0, 80) : ""
          })) : [],
      syncSalt: str(value.syncSalt, 64),
      syncKeyCheck: str(value.syncKeyCheck, 64),
      credentialSalt: str(value.credentialSalt, 64),
      credentialKeyCheck: str(value.credentialKeyCheck, 64),
      captureToken: str(value.captureToken, 128),
      captureTokenCreatedAt: typeof value.captureTokenCreatedAt === "string" &&
        Number.isFinite(Date.parse(value.captureTokenCreatedAt)) ? value.captureTokenCreatedAt : null,
      publishTarget: typeof value.publishTarget === "string" ? value.publishTarget.slice(0, 500) : ""
    };
  }

  function loadWorkspace() {
    try {
      let saved = null;
      try {
        saved = localStorage.getItem(STORAGE_KEY);
      } catch (readError) {
        saved = null;
      }
      if (saved === null) {
        // One-time migration: the app was renamed Pinboard -> xpin -> xPin.
        // Copy the newest legacy workspace forward so existing notes are not lost.
        // Legacy keys are intentionally left in place as backups.
        try {
          for (const legacyKey of LEGACY_STORAGE_KEYS) {
            const legacy = localStorage.getItem(legacyKey);
            if (legacy !== null) {
              try {
                localStorage.setItem(STORAGE_KEY, legacy);
              } catch (copyError) {
                /* storage full/blocked: fall through and read legacy directly */
              }
              saved = legacy;
              break;
            }
          }
        } catch (legacyError) {
          /* legacy keys unreadable: continue with a fresh workspace */
        }
      }
      if (saved === null) return structuredClone(initialWorkspace);
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.notes) || !Array.isArray(parsed.folders)) {
        throw new Error("Saved workspace has an invalid shape.");
      }
      const folders = parsed.folders.flatMap((folder) =>
        folder && typeof folder.id === "string" && typeof folder.name === "string"
          ? [{ id: folder.id, name: folder.name }]
          : []
      );
      const folderIds = new Set(folders.map((folder) => folder.id));
      const noteIds = new Set();
      const notes = parsed.notes.flatMap((note) => {
        const clean = sanitizeNoteRecord(note, folderIds);
        if (!clean || noteIds.has(clean.id)) return [];
        noteIds.add(clean.id);
        return [clean];
      });
      notes.forEach((note) => {
        if (!noteIds.has(note.parentNoteId) || note.parentNoteId === note.id) note.parentNoteId = null;
        const visited = new Set([note.id]);
        let parent = note.parentNoteId;
        while (parent) {
          if (visited.has(parent)) {
            note.parentNoteId = null;
            break;
          }
          visited.add(parent);
          parent = notes.find((item) => item.id === parent)?.parentNoteId ?? null;
        }
      });
      return {
        notes,
        folders,
        trash: sanitizeTrash(parsed.trash, folderIds, noteIds),
        savedAt: typeof parsed.savedAt === "string" && Number.isFinite(Date.parse(parsed.savedAt))
          ? parsed.savedAt
          : null,
        sort: SORTS.includes(parsed.sort) ? parsed.sort : "modified-desc",
        filter: ["all", "pinned", "recent", "trash"].includes(parsed.filter) ? parsed.filter : "all",
        view: parsed.view === "canvas" ? "canvas" : "notes",
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((id) => typeof id === "string") : [],
        tagFilter: typeof parsed.tagFilter === "string" ? parsed.tagFilter : null,
        selectedCanvasId: typeof parsed.selectedCanvasId === "string" ? parsed.selectedCanvasId : "canvas-main",
        canvases: sanitizeCanvases(parsed.canvases),
        extensions: sanitizeExtensions(parsed.extensions),
        templates: sanitizeTemplates(parsed.templates),
        integrations: sanitizeIntegrations(parsed.integrations),
        sync: sanitizeSyncState(parsed.sync),
        connectorCredentials: window.xPinCredentials?.sanitizeCredentialStore
          ? window.xPinCredentials.sanitizeCredentialStore(parsed.connectorCredentials)
          : {},
        // Phase 2 — Capture & smarts state (sanitized by the phase2 module;
        // unknown keys are dropped, known ones survive the round-trip).
        ...(window.xPinPhase2?.sanitizePhase2State
          ? window.xPinPhase2.sanitizePhase2State(parsed)
          : { settings: { dailyLanding: true, ai: { enabled: false, provider: "claude", baseUrl: "", embeddingsEnabled: false, embeddingsBaseUrl: "" } }, attachments: [], readLater: [], highlights: [], flashcards: [] }),
        // Phase 3 — Power & polish state (sanitized by the phase3 module;
        // unknown keys are dropped, known ones survive the round-trip).
        ...(window.xPinPhase3?.sanitizePhase3State
          ? window.xPinPhase3.sanitizePhase3State(parsed)
          : { phase3: window.xPinPhase3?.defaultPhase3State?.() ?? { settings: { theme: "dark", font: "system", splitPreview: false }, scripts: { approved: [] }, hooks: [], savedQueries: [], spaces: [], comments: [], mentions: [], reminders: [], dbViews: {} } }),
        features: window.xPinFeatures.sanitizeState(parsed.features, notes),
        plugins: parsed.plugins && typeof parsed.plugins === "object"
          ? {
            enabled: parsed.plugins.enabled && typeof parsed.plugins.enabled === "object" ? parsed.plugins.enabled : {},
            settings: parsed.plugins.settings && typeof parsed.plugins.settings === "object" ? parsed.plugins.settings : {}
          }
          : { enabled: {}, settings: {} }
      };
    } catch (error) {
      console.error("Could not load the saved xPin workspace.", error);
      window.setTimeout(() => showToast("Saved notes could not be read. A fresh workspace is open."), 0);
      return structuredClone(initialWorkspace);
    }
  }

  // M4 — storage layer. IndexedDB is the primary store; localStorage keeps a
  // backup copy of the same JSON, so one corrupt value cannot wipe the
  // workspace. When IndexedDB is unavailable (older browsers, and the
  // headless smoke suite's fake DOM) localStorage is the only store and the
  // app behaves exactly as before. Boot stays synchronous from localStorage;
  // the IndexedDB copy is reconciled asynchronously afterwards (see
  // reconcileIdbStore): migration seeds it on first run, and a missing
  // localStorage copy is restored from it. Sync design note for Phase 1:
  // each record carries `savedAt` (ISO) plus a monotonically useful
  // `updatedAt` per note, and every note keeps a `versions` history — a
  // change log can be built on top of these without changing the shape.

  function formatBytes(bytes) {
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function storageInfo() {
    // Phase 2 — attachment usage comes from attachment metadata (bytes are
    // in IndexedDB, so the workspace JSON size alone would understate it).
    const attachmentUsage = window.xPinPhase2?.attachmentUsage
      ? window.xPinPhase2.attachmentUsage(state.attachments)
      : { count: 0, bytes: 0 };
    return {
      backend: storageBackend,
      bytes: storageBytes,
      displayBytes: formatBytes(storageBytes),
      notes: state.notes.length,
      trash: state.trash.length,
      attachments: attachmentUsage.count,
      attachmentBytes: attachmentUsage.bytes,
      attachmentDisplayBytes: formatBytes(attachmentUsage.bytes)
    };
  }

  function updateStorageIndicator() {
    if (!ui.storageNote) return;
    const attachmentUsage = window.xPinPhase2?.attachmentUsage
      ? window.xPinPhase2.attachmentUsage(state.attachments)
      : { count: 0, bytes: 0 };
    ui.storageNote.textContent = `Saved on this device · ${formatBytes(storageBytes)} · ${storageBackend === "indexeddb" ? "IndexedDB" : "localStorage"}${attachmentUsage.count ? ` · ${attachmentUsage.count} attachment${attachmentUsage.count === 1 ? "" : "s"} (${formatBytes(attachmentUsage.bytes)})` : ""}`;
  }

  function openIdb() {
    if (idbOpenPromise) return idbOpenPromise;
    idbOpenPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available."));
        return;
      }
      const timeout = window.setTimeout(() => reject(new Error("IndexedDB open timed out.")), 3000);
      let request;
      try {
        request = indexedDB.open(IDB_NAME, 1);
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDB_STORE)) {
          request.result.createObjectStore(IDB_STORE);
        }
      };
      request.onsuccess = () => {
        window.clearTimeout(timeout);
        resolve(request.result);
      };
      request.onerror = () => {
        window.clearTimeout(timeout);
        reject(request.error ?? new Error("IndexedDB could not be opened."));
      };
      request.onblocked = () => {
        window.clearTimeout(timeout);
        reject(new Error("IndexedDB is blocked by another tab."));
      };
    }).catch((error) => {
      idbOpenPromise = null;
      throw error;
    });
    return idbOpenPromise;
  }

  function idbPutWorkspace(serialized, savedAt) {
    return openIdb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(IDB_STORE, "readwrite");
      const request = transaction.objectStore(IDB_STORE).put({ serialized, savedAt }, IDB_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed."));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    }));
  }

  function idbGetWorkspace() {
    return openIdb().then((db) => new Promise((resolve, reject) => {
      const request = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(IDB_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed."));
    }));
  }

  async function reconcileIdbStore() {
    if (typeof indexedDB === "undefined") return; // localStorage-only fallback
    let record = null;
    try {
      record = await idbGetWorkspace();
    } catch (error) {
      console.error("Could not read the xPin IndexedDB store.", error);
      return;
    }
    let saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      saved = null;
    }
    if (!record) {
      // First run with IndexedDB: migrate the localStorage workspace in.
      if (saved !== null) {
        try {
          await idbPutWorkspace(saved, state.savedAt);
          storageBackend = "indexeddb";
          updateStorageIndicator();
        } catch (error) {
          console.error("Could not migrate the xPin workspace to IndexedDB.", error);
        }
      }
      return;
    }
    if (saved === null) {
      // localStorage was lost but IndexedDB survived: restore, then reload so
      // the synchronous boot path picks it up. Next boot the copies agree.
      try {
        localStorage.setItem(STORAGE_KEY, record.serialized);
      } catch {
        return; // cannot restore without a writable backup; stay on current state
      }
      window.location.reload();
      return;
    }
    // Both copies exist: localStorage is authoritative on boot (an import may
    // just have replaced it), so only bring IndexedDB up to date.
    if (record.serialized !== saved) {
      try {
        await idbPutWorkspace(saved, state.savedAt);
      } catch (error) {
        console.error("Could not sync the xPin workspace to IndexedDB.", error);
      }
    }
    storageBackend = "indexeddb";
    updateStorageIndicator();
  }

  function offerSaveRecovery() {
    showToast("Could not save on this device. Check browser storage settings.");
    if (storageRecoveryOffered) return;
    storageRecoveryOffered = true;
    // M4 — export-on-quota-failure: offer a portable copy instead of a toast
    // while in-memory edits keep diverging from disk.
    if (window.confirm("xPin could not save your notes on this device — storage may be full. Download a Markdown backup of all notes now?")) {
      exportMarkdownZip();
    }
  }

  function persistWorkspace() {
    state.savedAt = new Date().toISOString();
    snapshotVersions();
    let serialized;
    try {
      serialized = JSON.stringify(state);
    } catch (error) {
      console.error("Could not save the xPin workspace.", error);
      setSaveState("error");
      offerSaveRecovery();
      return false;
    }
    storageBytes = serialized.length;
    updateStorageIndicator();
    // Primary store: IndexedDB. Async and best-effort — a failure here must
    // never block the save, because the localStorage backup below still lands.
    if (typeof indexedDB !== "undefined") {
      idbPutWorkspace(serialized, state.savedAt).then(() => {
        storageBackend = "indexeddb";
        updateStorageIndicator();
      }).catch((error) => {
        console.error("Could not save the xPin workspace to IndexedDB.", error);
      });
    }
    // Backup copy in localStorage (same JSON). One corrupt value cannot wipe
    // everything, and boot can always read synchronously from here.
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
      storageRecoveryOffered = false;
      setSaveState("saved");
      // Phase 1 — save lifecycle event (audit C2). Integrations subscribe
      // to know a persist completed; the emit is best-effort and never
      // breaks the save itself.
      pluginManager?.emit("save:completed", { savedAt: state.savedAt, bytes: storageBytes });
      return true;
    } catch (error) {
      console.error("Could not save the xPin workspace.", error);
      setSaveState("error");
      offerSaveRecovery();
      return false;
    }
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    setSaveState("saving");
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      persistWorkspace();
    }, SAVE_DELAY);
  }

  function flushSave() {
    if (saveTimer === null) return;
    window.clearTimeout(saveTimer);
    saveTimer = null;
    persistWorkspace();
  }

  function setSaveState(status) {
    ui.saveState.classList.toggle("is-saving", status === "saving");
    ui.saveState.classList.toggle("has-error", status === "error");
    ui.saveLabel.textContent = status === "saving" ? "Saving..." : status === "error" ? "Save failed" : "All changes saved";
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ui.toast.classList.remove("is-visible"), 3600);
  }

  // M2 — per-note version history. Before each persist, any note whose title
  // or body changed since its last persisted snapshot gets that snapshot
  // appended to note.versions (newest last, capped). Empty drafts never
  // produce a version, so a brand-new note's first keystrokes are not saved
  // as a blank "version".
  function initVersionBaselines() {
    versionBaselines.clear();
    state.notes.forEach((note) => versionBaselines.set(note.id, {
      title: note.title,
      body: note.body,
      updatedAt: note.updatedAt
    }));
  }

  function snapshotVersions() {
    for (const note of state.notes) {
      const baseline = versionBaselines.get(note.id);
      if (!baseline) {
        versionBaselines.set(note.id, { title: note.title, body: note.body, updatedAt: note.updatedAt });
        continue;
      }
      if (baseline.title === note.title && baseline.body === note.body) continue;
      if (!baseline.title && !baseline.body) {
        versionBaselines.set(note.id, { title: note.title, body: note.body, updatedAt: note.updatedAt });
        continue;
      }
      note.versions = note.versions ?? [];
      note.versions.push({ ...baseline });
      while (note.versions.length > MAX_NOTE_VERSIONS) note.versions.shift();
      versionBaselines.set(note.id, { title: note.title, body: note.body, updatedAt: note.updatedAt });
    }
  }

  function restoreVersion(noteId, index) {
    const note = state.notes.find((item) => item.id === noteId);
    const version = note?.versions?.[index];
    if (!note || !version) return false;
    // The current text becomes a version first, so restoring is itself undoable.
    note.versions.push({ title: note.title, body: note.body, updatedAt: note.updatedAt });
    while (note.versions.length > MAX_NOTE_VERSIONS) note.versions.shift();
    note.title = version.title;
    note.body = version.body;
    note.updatedAt = new Date().toISOString();
    versionBaselines.set(note.id, { title: note.title, body: note.body, updatedAt: note.updatedAt });
    renderEditor();
    renderList();
    persistWorkspace();
    showToast("Earlier version restored.");
    return true;
  }

  // M2 — undo for structural actions (note/folder delete, trash restore,
  // permanent delete, empty trash). Snapshots are small (notes/folders/trash
  // only) and capped; typing undo stays with the browser textarea.
  function pushUndo(label) {
    undoStack.push({
      label,
      notes: structuredClone(state.notes),
      folders: structuredClone(state.folders),
      trash: structuredClone(state.trash),
      selectedNoteId
    });
    while (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
  }

  function undoLastAction() {
    const entry = undoStack.pop();
    if (!entry) {
      showToast("Nothing to undo.");
      return false;
    }
    state.notes = entry.notes;
    state.folders = entry.folders;
    state.trash = entry.trash;
    selectedNoteId = state.notes.some((note) => note.id === entry.selectedNoteId)
      ? entry.selectedNoteId
      : state.notes[0]?.id ?? null;
    initVersionBaselines();
    render();
    persistWorkspace();
    showToast(`Undid: ${entry.label}`);
    return true;
  }

  // M5 — note properties (frontmatter) API.
  // Plugins write properties through notes:update with patch.metadata:
  //   { status: "In progress", due: "2026-11-20", source: "https://…" }
  // Keys must match METADATA_KEY_PATTERN; values are strings, numbers,
  // booleans, null, or arrays of strings. A null value deletes the key.
  // Invalid keys/values throw instead of being silently dropped, so an
  // integration learns immediately that a write did not land.
  function mergeNoteMetadata(current, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Note properties must be an object.");
    }
    for (const key of Object.keys(patch)) {
      if (!METADATA_KEY_PATTERN.test(key)) throw new TypeError(`Property name "${key}" is invalid.`);
      const value = patch[key];
      if (value !== null && typeof value !== "string" && typeof value !== "number" &&
        typeof value !== "boolean" && !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
        throw new TypeError(`Property "${key}" has an unsupported value.`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`Property "${key}" must be a finite number.`);
      }
    }
    const next = sanitizeNoteMetadata({ ...(current ?? {}), ...patch });
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
    }
    return next;
  }

  function setNoteMetadata(note, patch) {
    note.metadata = mergeNoteMetadata(note.metadata, patch);
    return note.metadata;
  }

  function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function currentNote() {
    return state.notes.find((note) => note.id === selectedNoteId) ?? null;
  }

  function timestamp(value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function sortNotes(notes) {
    const [field, direction] = state.sort.split("-");
    return [...notes].sort((a, b) => {
      if (field === "title") {
        const order = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        return direction === "asc" ? order : -order;
      }
      const property = field === "created" ? "createdAt" : "updatedAt";
      const order = timestamp(a[property]) - timestamp(b[property]);
      return direction === "asc" ? order : -order;
    });
  }

  function extractTags(text) {
    const tags = new Set();
    const pattern = /(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi;
    for (const match of text.matchAll(pattern)) tags.add(`#${match[1].toLocaleLowerCase()}`);
    return [...tags];
  }

  // Phase 2 — last ranked-search results (note id -> {score, snippet}).
  // Set by visibleNotes() when a text query is active; renderNoteRow()
  // shows the snippet. Cleared whenever there is no query.
  let lastSearchResults = new Map();

  function visibleNotes() {
    if (state.filter === "trash") {
      return [...state.trash].sort((a, b) => timestamp(b.deletedAt) - timestamp(a.deletedAt));
    }
    let notes = state.notes;
    if (state.filter === "pinned") notes = notes.filter((note) => note.pinned);
    if (state.filter === "recent") {
      notes = [...notes].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)).slice(0, 5);
    }
    if (state.tagFilter) {
      notes = notes.filter((note) => extractTags(`${note.title}\n${note.body}`).includes(state.tagFilter));
    }
    const rawQuery = ui.search.value.trim();
    if (rawQuery.startsWith("#")) {
      // Tag search: "#parent" matches #parent exactly and nested #parent/child tags.
      const tagQuery = rawQuery.toLocaleLowerCase();
      notes = notes.filter((note) => extractTags(`${note.title}\n${note.body}`)
        .some((tag) => tag === tagQuery || tag.startsWith(`${tagQuery}/`)));
      lastSearchResults = new Map();
    } else {
      const query = rawQuery.toLocaleLowerCase();
      if (query) {
        // Phase 2 (audit B2) — ranked search: title > headings > body
        // frequency, recency as a small tiebreak; snippets with matches.
        // Falls back to the old substring filter if the phase2 module is
        // unavailable, so search never breaks outright.
        const ranked = window.xPinPhase2?.rankNotes
          ? window.xPinPhase2.rankNotes(notes, query)
          : null;
        if (ranked) {
          lastSearchResults = new Map(ranked.map((result) => [result.note.id, result]));
          return ranked.map((result) => result.note);
        }
        notes = notes.filter((note) => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(query));
        lastSearchResults = new Map();
      } else {
        lastSearchResults = new Map();
      }
    }
    return sortNotes(notes);
  }

  function formatRelative(value) {
    const time = timestamp(value);
    if (!time) return "Just now";
    const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function renderNoteRow(note) {
    const row = document.createElement("button");
    const preview = note.body.trim().replace(/\s+/g, " ") || "A blank page, ready when you are.";
    row.type = "button";
    row.className = `note-row${note.id === selectedNoteId ? " is-selected" : ""}`;
    row.dataset.noteId = note.id;
    row.innerHTML = `<span class="note-row-titleline"><span class="note-row-title">${escapeText(note.title.trim() || "Untitled note")}</span>${note.pinned ? '<span class="note-row-pin" aria-label="Pinned">◆</span>' : ""}</span><span class="note-preview">${escapeText(preview)}</span><span class="note-row-time">${escapeText(formatRelative(note.updatedAt))}</span>`;
    // Phase 2 — ranked-search snippet with the match highlighted.
    const searchHit = lastSearchResults.get(note.id);
    if (searchHit?.snippet) {
      const snippetEl = document.createElement("span");
      snippetEl.className = "note-search-snippet";
      const { text, ranges, prefix, suffix } = searchHit.snippet;
      if (prefix) snippetEl.append(document.createTextNode("… "));
      let at = 0;
      const merged = [...ranges].sort((a, b) => a[0] - b[0]);
      for (const [start, end] of merged) {
        if (start < at) continue;
        if (start > at) snippetEl.append(document.createTextNode(text.slice(at, start)));
        const mark = document.createElement("mark");
        mark.textContent = text.slice(start, end);
        snippetEl.append(mark);
        at = end;
      }
      snippetEl.append(document.createTextNode(text.slice(at)));
      if (suffix) snippetEl.append(document.createTextNode(" …"));
      row.append(snippetEl);
    }
    row.addEventListener("click", () => selectNote(note.id));
    return row;
  }

  function renderTrashRow(note) {
    const row = document.createElement("div");
    row.className = "note-row trash-row";
    row.dataset.noteId = note.id;
    const preview = note.body.trim().replace(/\s+/g, " ") || "A blank page, ready when you are.";
    const titleLine = document.createElement("span");
    titleLine.className = "note-row-titleline";
    const title = document.createElement("span");
    title.className = "note-row-title";
    title.textContent = note.title.trim() || "Untitled note";
    titleLine.append(title);
    const previewEl = document.createElement("span");
    previewEl.className = "note-preview";
    previewEl.textContent = preview;
    const time = document.createElement("span");
    time.className = "note-row-time";
    time.textContent = `Deleted ${formatRelative(note.deletedAt)}`;
    const actions = document.createElement("div");
    actions.className = "trash-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "trash-restore";
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore ${note.title.trim() || "Untitled note"}`);
    restore.addEventListener("click", () => restoreTrashNote(note.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "trash-delete";
    remove.textContent = "Delete forever";
    remove.setAttribute("aria-label", `Permanently delete ${note.title.trim() || "Untitled note"}`);
    remove.addEventListener("click", () => permanentlyDeleteTrashNote(note.id));
    actions.append(restore, remove);
    row.append(titleLine, previewEl, time, actions);
    return row;
  }

  function renderTrashList() {
    const trashed = visibleNotes();
    ui.noteList.replaceChildren();
    if (trashed.length) {
      const actions = document.createElement("div");
      actions.className = "trash-toolbar";
      const emptyButton = document.createElement("button");
      emptyButton.type = "button";
      emptyButton.className = "trash-empty";
      emptyButton.textContent = "Empty Trash";
      emptyButton.addEventListener("click", emptyTrash);
      actions.append(emptyButton);
      ui.noteList.append(actions);
      trashed.forEach((note) => ui.noteList.append(renderTrashRow(note)));
    }
    ui.emptyState.hidden = trashed.length !== 0;
    ui.noteList.hidden = trashed.length === 0;
    ui.listCount.textContent = `${trashed.length} ${trashed.length === 1 ? "note" : "notes"} in Trash`;
    if (!trashed.length) {
      ui.emptyTitle.textContent = "Trash is empty";
      ui.emptyDescription.textContent = "Deleted notes land here first, so nothing is lost by accident.";
      ui.emptyCreate.hidden = true;
    }
    byId("all-count").textContent = String(state.notes.length);
    byId("pinned-count").textContent = String(state.notes.filter((note) => note.pinned).length);
    byId("trash-count").textContent = String(state.trash.length);
    ui.listHeading.textContent = "TRASH";
    if (!state.features.activeView) {
      ui.currentView.textContent = "Trash";
      ui.pageTitle.innerHTML = `Trash<span class="title-period">.</span>`;
    }
  }

  function renderList() {
    if (state.filter === "trash") {
      renderTrashList();
      return;
    }
    const notes = visibleNotes();
    const folders = [...state.folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    ui.noteList.replaceChildren();

    folders.forEach((folder) => {
      const folderNotes = notes.filter((note) => note.folderId === folder.id);
      const collapsed = state.collapsed.includes(folder.id);
      const folderEntry = document.createElement("div");
      folderEntry.className = "folder-entry";
      const folderRow = document.createElement("button");
      folderRow.type = "button";
      folderRow.className = "folder-row";
      folderRow.setAttribute("aria-expanded", String(!collapsed));
      folderRow.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${folder.name} folder`);
      folderRow.innerHTML = `<span class="folder-caret">${collapsed ? "›" : "⌄"}</span><span class="folder-glyph">▱</span><span class="folder-name">${escapeText(folder.name)}</span><span class="folder-count">${folderNotes.length}</span>`;
      folderRow.addEventListener("click", () => {
        state.collapsed = collapsed ? state.collapsed.filter((id) => id !== folder.id) : [...state.collapsed, folder.id];
        persistWorkspace();
        renderList();
      });
      const actions = document.createElement("div");
      actions.className = "folder-actions";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "folder-action";
      rename.textContent = "Rename";
      rename.setAttribute("aria-label", `Rename ${folder.name} folder`);
      rename.addEventListener("click", () => renameFolder(folder));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "folder-action folder-delete";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete ${folder.name} folder`);
      remove.addEventListener("click", () => deleteFolder(folder));
      actions.append(rename, remove);
      folderEntry.append(folderRow, actions);
      ui.noteList.append(folderEntry);
      if (!collapsed) {
        const group = document.createElement("div");
        group.className = "folder-notes";
        folderNotes.forEach((note) => group.append(renderNoteRow(note)));
        ui.noteList.append(group);
      }
    });

    const rootNotes = notes.filter((note) => !state.folders.some((folder) => folder.id === note.folderId));
    if (rootNotes.length) {
      if (folders.length) {
        const label = document.createElement("div");
        label.className = "root-notes-heading";
        label.textContent = "UNCATEGORIZED";
        ui.noteList.append(label);
      }
      rootNotes.forEach((note) => ui.noteList.append(renderNoteRow(note)));
    }

    const empty = notes.length === 0;
    ui.emptyState.hidden = !empty;
    ui.noteList.hidden = empty && folders.length === 0;
    // Phase 2 — ranked search also covers database rows and canvas titles;
    // those matches land here, below the note list.
    const existingExtras = ui.noteList.querySelector(".search-extras");
    existingExtras?.remove();
    const rawQuery = ui.search.value.trim();
    if (rawQuery && !rawQuery.startsWith("#") && window.xPinPhase2?.searchExtras) {
      const extras = window.xPinPhase2.searchExtras(state, rawQuery);
      if (extras.length) {
        const extrasEl = document.createElement("div");
        extrasEl.className = "search-extras";
        const heading = document.createElement("div");
        heading.className = "search-extras-heading";
        heading.textContent = "ALSO FOUND IN DATABASES & CANVAS";
        extrasEl.append(heading);
        for (const extra of extras) {
          const line = document.createElement("button");
          line.type = "button";
          line.className = "search-extra-row";
          line.textContent = extra.label;
          if (extra.kind === "canvas") {
            line.addEventListener("click", () => {
              state.selectedCanvasId = extra.canvasId;
              switchView("canvas");
              renderCanvas();
            });
          }
          extrasEl.append(line);
        }
        ui.noteList.append(extrasEl);
      }
    }
    ui.listCount.textContent = `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
    if (empty) {
      ui.emptyTitle.textContent = ui.search.value ? "No matching notes" : state.tagFilter ? `Nothing tagged ${state.tagFilter}` : state.filter === "pinned" ? "Nothing pinned yet" : "No notes yet";
      ui.emptyDescription.textContent = ui.search.value ? "Try a different search." : state.tagFilter ? "Add this tag to a note to see it here." : "Start with one small thought.";
      ui.emptyCreate.hidden = Boolean(ui.search.value);
    }

    byId("all-count").textContent = String(state.notes.length);
    byId("pinned-count").textContent = String(state.notes.filter((note) => note.pinned).length);
    byId("trash-count").textContent = String(state.trash.length);
    const labels = { all: ["All notes", "ALL NOTES"], pinned: ["Pinned", "PINNED"], recent: ["Recent notes", "RECENT NOTES"], trash: ["Trash", "TRASH"] };
    const [label, heading] = labels[state.filter] ?? labels.all;
    const viewLabel = state.tagFilter ? `Tagged ${state.tagFilter}` : label;
    const featureViewOpen = Boolean(state.features.activeView);
    if (!featureViewOpen) {
      ui.currentView.textContent = state.view === "canvas" ? "Canvas" : viewLabel;
    }
    ui.listHeading.textContent = state.tagFilter ? `TAG ${state.tagFilter.toLocaleUpperCase()}` : heading;
    if (state.view === "notes" && !featureViewOpen) {
      ui.pageTitle.innerHTML = `${state.tagFilter ? `Tag ${escapeText(state.tagFilter)}` : state.filter === "all" ? "Your notes" : escapeText(label)}<span class="title-period">.</span>`;
    }
  }

  function currentCanvas() {
    return state.canvases.find((canvas) => canvas.id === state.selectedCanvasId) ?? state.canvases[0] ?? null;
  }

  function canvasStatus(message, failed = false) {
    ui.canvasStatus.textContent = message;
    ui.canvasStatus.classList.toggle("has-error", failed);
  }

  function saveCanvasSoon() {
    window.clearTimeout(canvasSaveTimer);
    canvasStatus("Saving board…");
    canvasSaveTimer = window.setTimeout(() => {
      canvasSaveTimer = null;
      updateCanvasSaveStatus(persistWorkspace());
    }, 500);
  }

  function updateCanvasSaveStatus(saved) {
    canvasStatus(
      saved ? "JSON Canvas compatible · saved on this device" : "Could not save this board on this device.",
      !saved
    );
  }

  function canvasEdgePoint(node, side) {
    if (side === "top") return { x: node.x + node.width / 2, y: node.y };
    if (side === "right") return { x: node.x + node.width, y: node.y + node.height / 2 };
    if (side === "bottom") return { x: node.x + node.width / 2, y: node.y + node.height };
    if (side === "left") return { x: node.x, y: node.y + node.height / 2 };
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }

  function applyCanvasTransform() {
    ui.canvasStage.style.transform = `translate(${canvasViewportState.x}px, ${canvasViewportState.y}px) scale(${canvasViewportState.zoom})`;
    byId("canvas-zoom").textContent = `${Math.round(canvasViewportState.zoom * 100)}%`;
  }

  function canvasColor(value) {
    const palette = { "1": "#ff755d", "2": "#f4a45f", "3": "#e9c96b", "4": "#71d4a9", "5": "#54dce8", "6": "#b49aff" };
    return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value : palette[value] ?? palette["5"];
  }

  function selectCanvasNode(nodeId) {
    if (connectFromNodeId) {
      addCanvasEdge(connectFromNodeId, nodeId);
      connectFromNodeId = null;
      byId("connect-nodes").setAttribute("aria-pressed", "false");
      return;
    }
    selectedCanvasNodeId = nodeId;
    hideEdgeEditor();
    ui.canvasNodes.querySelectorAll(".canvas-node").forEach((item) =>
      item.classList.toggle("is-selected", item.dataset.nodeId === selectedCanvasNodeId)
    );
  }

  function renderCanvas() {
    const board = currentCanvas();
    ui.canvasSelect.replaceChildren();
    state.canvases.forEach((canvas) => {
      const option = document.createElement("option");
      option.value = canvas.id;
      option.textContent = canvas.name;
      ui.canvasSelect.append(option);
    });
    if (!board) return;
    ui.canvasSelect.value = board.id;
    ui.canvasEmpty.hidden = board.nodes.length > 0;
    ui.canvasNodes.replaceChildren();
    ui.canvasEdges.replaceChildren();
    ui.canvasEdges.setAttribute("viewBox", "0 0 3000 2000");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "canvas-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "#76cbd1");
    marker.append(arrow);
    defs.append(marker);
    ui.canvasEdges.append(defs);
    const nodeById = new Map(board.nodes.map((node) => [node.id, node]));
    board.edges.forEach((edge) => {
      const from = nodeById.get(edge.fromNode);
      const to = nodeById.get(edge.toNode);
      if (!from || !to) return;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const fromPoint = canvasEdgePoint(from, edge.fromSide);
      const toPoint = canvasEdgePoint(to, edge.toSide);
      line.setAttribute("x1", String(fromPoint.x));
      line.setAttribute("y1", String(fromPoint.y));
      line.setAttribute("x2", String(toPoint.x));
      line.setAttribute("y2", String(toPoint.y));
      line.setAttribute("stroke", canvasColor(edge.color));
      line.setAttribute("stroke-width", "2");
      line.dataset.edgeId = edge.id;
      line.style.pointerEvents = "stroke";
      line.style.cursor = "pointer";
      const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
      tip.textContent = edge.label ? `Connection: ${edge.label}` : "Connection — select to edit";
      line.append(tip);
      if (edge.id === selectedCanvasEdgeId) {
        line.setAttribute("stroke-width", "3.5");
        line.style.opacity = "1";
      }
      if (edge.fromEnd === "arrow") line.setAttribute("marker-start", "url(#canvas-arrow)");
      if (edge.toEnd === "arrow") line.setAttribute("marker-end", "url(#canvas-arrow)");
      ui.canvasEdges.append(line);
      if (edge.label) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", String((from.x + to.x + (from.width + to.width) / 2) / 2));
        label.setAttribute("y", String((from.y + to.y + (from.height + to.height) / 2) / 2 - 7));
        label.setAttribute("fill", "#a9c7ca");
        label.setAttribute("font-size", "12");
        label.textContent = edge.label;
        ui.canvasEdges.append(label);
      }
    });
    board.nodes.forEach((node) => {
      const card = document.createElement("article");
      card.className = `canvas-node canvas-node-${node.type}${node.id === selectedCanvasNodeId ? " is-selected" : ""}`;
      card.dataset.nodeId = node.id;
      card.tabIndex = 0;
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", `${node.type} card`);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectCanvasNode(node.id);
          return;
        }
        if (event.target !== card || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const distance = event.shiftKey ? 10 : 1;
        const horizontal = event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0;
        const vertical = event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0;
        if (event.altKey) {
          node.width = Math.max(180, Math.min(1200, node.width + horizontal));
          node.height = Math.max(100, Math.min(1000, node.height + vertical));
        } else {
          node.x += horizontal;
          node.y += vertical;
        }
        renderCanvas();
        ui.canvasNodes.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`)?.focus();
        saveCanvasSoon();
      });
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      card.style.width = `${node.width}px`;
      card.style.height = `${node.height}px`;
      card.style.setProperty("--node-color", canvasColor(node.color));
      if (node.type === "group") card.style.zIndex = "0";
      const handle = document.createElement("header");
      handle.className = "canvas-node-header canvas-node-drag-handle";
      const title = document.createElement("strong");
      title.textContent = node.type === "text" ? "TEXT CARD" : node.type === "file" ? "NOTE REFERENCE" : node.type === "link" ? "WEB LINK" : "GROUP";
      handle.append(title);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "canvas-node-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove card from board");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeCanvasNode(node.id);
      });
      handle.append(remove);
      card.append(handle);

      if (node.type === "text") {
        const text = document.createElement("textarea");
        text.className = "canvas-text-editor";
        text.value = node.text;
        text.setAttribute("aria-label", "Canvas text card");
        text.addEventListener("input", () => {
          if (text.value.length > 100_000) {
            text.value = node.text;
            showToast("Canvas text cards are limited to 100,000 characters.");
            return;
          }
          node.text = text.value;
          saveCanvasSoon();
        });
        card.append(text);
      } else if (node.type === "file") {
        const note = state.notes.find((item) => item.id === node.xPinNoteId);
        const link = document.createElement("button");
        link.type = "button";
        link.className = "canvas-note-link";
        link.textContent = note?.title || node.file;
        link.disabled = !note;
        if (note) {
          link.addEventListener("click", () => {
            setActiveFilter("all");
            switchView("notes");
            selectNote(note.id);
          });
        }
        const path = document.createElement("small");
        path.textContent = node.file;
        card.append(link, path);
      } else if (node.type === "link") {
        const link = document.createElement("a");
        link.className = "canvas-web-link";
        link.href = node.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = node.url;
        card.append(link);
      } else {
        const label = document.createElement("input");
        label.className = "canvas-group-label";
        label.type = "text";
        label.maxLength = 100;
        label.value = node.label || "New group";
        label.setAttribute("aria-label", "Canvas group label");
        label.addEventListener("input", () => {
          node.label = label.value.slice(0, 100);
          saveCanvasSoon();
        });
        card.append(label);
      }
      const resize = document.createElement("span");
      resize.className = "canvas-resize-handle";
      resize.setAttribute("aria-hidden", "true");
      card.append(resize);
      ui.canvasNodes.append(card);
    });
    applyCanvasTransform();
  }

  function switchView(view) {
    featureSuite?.deactivate();
    hideEdgeEditor();
    hidePhase2View();
    hidePhase3View();
    state.view = view === "canvas" ? "canvas" : "notes";
    const isCanvas = state.view === "canvas";
    ui.currentView.textContent = isCanvas ? "Canvas" : (state.tagFilter ? `Tagged ${state.tagFilter}` : state.filter === "all" ? "All notes" : state.filter === "pinned" ? "Pinned" : state.filter === "trash" ? "Trash" : "Recent notes");
    byId("notes-toolbar").hidden = isCanvas;
    byId("notes-layout").hidden = isCanvas;
    ui.canvasView.hidden = !isCanvas;
    byId("new-folder").hidden = isCanvas;
    ui.pageTitle.innerHTML = `${isCanvas ? "Canvas" : (state.tagFilter ? `Tag ${escapeText(state.tagFilter)}` : state.filter === "all" ? "Your notes" : escapeText(state.filter === "pinned" ? "Pinned" : state.filter === "trash" ? "Trash" : "Recent notes"))}<span class="title-period">.</span>`;
    byId("notes-heading").querySelector(".page-subtitle").textContent = isCanvas
      ? "Arrange notes, fragments, and links into a visual map."
      : "A home for the thoughts worth keeping.";
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", isCanvas
        ? button.dataset.view === "canvas"
        : button.dataset.filter === state.filter);
    });
    if (isCanvas) renderCanvas();
    const saved = persistWorkspace();
    if (isCanvas) updateCanvasSaveStatus(saved);
  }

  function makeCanvasNode(type, extras = {}) {
    const viewport = ui.canvasViewport.getBoundingClientRect();
    const width = type === "group" ? 420 : 280;
    const height = type === "group" ? 300 : 180;
    const startX = Math.max(40, Math.round((viewport.width / 2 - canvasViewportState.x) / canvasViewportState.zoom - width / 2));
    const startY = Math.max(40, Math.round((viewport.height / 2 - canvasViewportState.y) / canvasViewportState.zoom - height / 2));
    const nodes = currentCanvas()?.nodes ?? [];
    const columns = Math.max(1, Math.floor((viewport.width - 64) / 460));
    let x = startX;
    let y = startY;
    for (let index = 0; index <= nodes.length; index += 1) {
      x = startX + (index % columns) * 460;
      y = startY + Math.floor(index / columns) * 360;
      const overlaps = nodes.some((node) =>
        x < node.x + node.width + 24 && x + width + 24 > node.x &&
        y < node.y + node.height + 24 && y + height + 24 > node.y
      );
      if (!overlaps) break;
    }
    return {
      id: makeId("node"),
      type,
      x,
      y,
      width,
      height,
      ...extras
    };
  }

  function addCanvasNode(type, extras = {}) {
    const board = currentCanvas();
    if (!board) throw new Error("No canvas is available.");
    if (board.nodes.length >= MAX_CANVAS_NODES) {
      showToast(`A board can contain at most ${MAX_CANVAS_NODES} cards.`);
      return null;
    }
    const node = makeCanvasNode(type, extras);
    board.nodes.push(node);
    selectedCanvasNodeId = node.id;
    renderCanvas();
    saveCanvasSoon();
    if (type === "text") ui.canvasNodes.querySelector(`[data-node-id="${CSS.escape(node.id)}"] .canvas-text-editor`)?.focus();
    return node;
  }

  function removeCanvasNode(nodeId) {
    const board = currentCanvas();
    if (!board) return;
    const node = board.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const label = node.type === "text"
      ? `“${node.text.trim().split("\n")[0].slice(0, 40) || "Text card"}”`
      : node.type === "file" ? "this note reference" : node.type === "link" ? "this web link" : "this group";
    if (!window.confirm(`Remove ${label} from the board? This cannot be undone.`)) return;
    hideEdgeEditor();
    board.nodes = board.nodes.filter((item) => item.id !== nodeId);
    board.edges = board.edges.filter((edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId);
    if (selectedCanvasNodeId === nodeId) selectedCanvasNodeId = null;
    if (selectedCanvasEdgeId && !board.edges.some((edge) => edge.id === selectedCanvasEdgeId)) selectedCanvasEdgeId = null;
    renderCanvas();
    saveCanvasSoon();
  }

  function addCanvasEdge(fromNode, toNode) {
    if (fromNode === toNode) return;
    const board = currentCanvas();
    if (!board || board.edges.some((edge) => edge.fromNode === fromNode && edge.toNode === toNode)) return;
    if (board.edges.length >= MAX_CANVAS_EDGES) {
      showToast(`A board can contain at most ${MAX_CANVAS_EDGES} connections.`);
      return;
    }
    board.edges.push({ id: makeId("edge"), fromNode, toNode, toEnd: "arrow", color: "5" });
    renderCanvas();
    saveCanvasSoon();
  }

  const EDGE_SIDES = ["top", "right", "bottom", "left"];
  const EDGE_COLORS = [["1", "Coral"], ["2", "Amber"], ["3", "Sand"], ["4", "Mint"], ["5", "Cyan"], ["6", "Lavender"]];

  function hideEdgeEditor() {
    selectedCanvasEdgeId = null;
    if (canvasEdgeEditor) canvasEdgeEditor.hidden = true;
  }

  function removeCanvasEdge(edgeId) {
    const board = currentCanvas();
    if (!board || !board.edges.some((edge) => edge.id === edgeId)) return;
    if (!window.confirm("Delete this connection? This cannot be undone.")) return;
    hideEdgeEditor();
    board.edges = board.edges.filter((edge) => edge.id !== edgeId);
    renderCanvas();
    saveCanvasSoon();
  }

  async function renameCanvasBoard() {
    const board = currentCanvas();
    if (!board) return;
    const name = await window.xPinPhase3?.showDialog(document, {
      title: "Rename board", label: "Board name", value: board.name, confirmLabel: "Rename"
    });
    if (name === null || name === undefined) return;
    const cleanName = name.trim().slice(0, 100);
    if (!cleanName) return showToast("Board names cannot be empty.");
    board.name = cleanName;
    pluginManager?.emit("canvas:updated", { id: board.id, name: board.name });
    renderCanvas();
    updateCanvasSaveStatus(persistWorkspace());
    showToast("Board renamed.");
  }

  function deleteCanvasBoard() {
    const board = currentCanvas();
    if (!board) return;
    if (state.canvases.length <= 1) return showToast("Keep at least one board — rename it instead.");
    const cardCount = board.nodes.length;
    if (!window.confirm(`Delete the board “${board.name}”?${cardCount ? ` Its ${cardCount} ${cardCount === 1 ? "card" : "cards"} will go too.` : ""} This cannot be undone.`)) return;
    hideEdgeEditor();
    state.canvases = state.canvases.filter((canvas) => canvas.id !== board.id);
    state.selectedCanvasId = state.canvases[0]?.id ?? null;
    selectedCanvasNodeId = null;
    pluginManager?.emit("canvas:deleted", { id: board.id, name: board.name });
    renderCanvas();
    updateCanvasSaveStatus(persistWorkspace());
    showToast("Board deleted.");
  }

  function ensureEdgeEditor() {
    if (canvasEdgeEditor) return canvasEdgeEditor;
    const panel = document.createElement("div");
    panel.id = "canvas-edge-editor";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Edit connection");
    Object.assign(panel.style, {
      position: "fixed", zIndex: "70", width: "252px", boxSizing: "border-box",
      background: "var(--sidebar)", border: "1px solid #28454e", borderRadius: "10px",
      padding: "12px", boxShadow: "0 12px 32px rgba(0,0,0,.5)",
      color: "var(--ink)", fontFamily: "var(--sans)", fontSize: "12px"
    });
    const inputStyle = "width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #28454e;border-radius:6px;background:#0a1d26;color:var(--ink);font-size:12px;";
    const sideOptions = ['<option value="">Auto</option>', ...EDGE_SIDES.map((side) =>
      `<option value="${side}">${side[0].toLocaleUpperCase()}${side.slice(1)}</option>`)].join("");
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <strong style="font-size:11px;letter-spacing:.08em;color:var(--muted);">CONNECTION</strong>
        <button type="button" data-edge-close aria-label="Close connection editor" style="border:0;background:transparent;color:var(--muted);font-size:16px;cursor:pointer;line-height:1;">×</button>
      </div>
      <label style="display:block;margin-bottom:10px;color:var(--muted);">Label
        <input type="text" data-edge-label maxlength="120" placeholder="Describe this link…" style="${inputStyle}">
      </label>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <label style="flex:1;color:var(--muted);">From side
          <select data-edge-fromside style="${inputStyle}">${sideOptions}</select>
        </label>
        <label style="flex:1;color:var(--muted);">To side
          <select data-edge-toside style="${inputStyle}">${sideOptions}</select>
        </label>
      </div>
      <div style="display:flex;gap:14px;margin-bottom:10px;color:var(--muted);">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-edge-fromend> Arrow at start</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-edge-toend> Arrow at end</label>
      </div>
      <label style="display:block;color:var(--muted);">Color
        <select data-edge-color style="${inputStyle};margin-bottom:12px;"></select>
      </label>
      <button type="button" data-edge-delete style="width:100%;padding:7px 8px;border:1px solid rgba(255,117,93,.4);border-radius:6px;background:rgba(255,117,93,.08);color:#ff9a87;font-size:12px;cursor:pointer;">Delete connection</button>`;
    const field = (name) => panel.querySelector(`[data-edge-${name}]`);
    const currentEdge = () => currentCanvas()?.edges.find((edge) => edge.id === selectedCanvasEdgeId);
    const apply = (mutate) => {
      const edge = currentEdge();
      if (!edge) return;
      mutate(edge);
      renderCanvas();
      saveCanvasSoon();
    };
    field("label").addEventListener("input", (event) => apply((edge) => {
      const value = event.target.value.slice(0, 120);
      if (value.trim()) edge.label = value;
      else delete edge.label;
    }));
    field("fromside").addEventListener("change", (event) => apply((edge) => {
      if (EDGE_SIDES.includes(event.target.value)) edge.fromSide = event.target.value;
      else delete edge.fromSide;
    }));
    field("toside").addEventListener("change", (event) => apply((edge) => {
      if (EDGE_SIDES.includes(event.target.value)) edge.toSide = event.target.value;
      else delete edge.toSide;
    }));
    field("fromend").addEventListener("change", (event) => apply((edge) => {
      edge.fromEnd = event.target.checked ? "arrow" : "none";
    }));
    field("toend").addEventListener("change", (event) => apply((edge) => {
      edge.toEnd = event.target.checked ? "arrow" : "none";
    }));
    field("color").addEventListener("change", (event) => apply((edge) => {
      edge.color = event.target.value;
    }));
    field("delete").addEventListener("click", () => {
      if (selectedCanvasEdgeId) removeCanvasEdge(selectedCanvasEdgeId);
    });
    field("close").addEventListener("click", () => {
      hideEdgeEditor();
      renderCanvas();
    });
    document.body.append(panel);
    canvasEdgeEditor = panel;
    return panel;
  }

  function openEdgeEditor(clientX, clientY) {
    const board = currentCanvas();
    const edge = board?.edges.find((item) => item.id === selectedCanvasEdgeId);
    const panel = ensureEdgeEditor();
    if (!edge) {
      panel.hidden = true;
      return;
    }
    const field = (name) => panel.querySelector(`[data-edge-${name}]`);
    field("label").value = edge.label ?? "";
    field("fromside").value = edge.fromSide ?? "";
    field("toside").value = edge.toSide ?? "";
    field("fromend").checked = edge.fromEnd === "arrow";
    field("toend").checked = edge.toEnd === "arrow";
    const colorField = field("color");
    colorField.replaceChildren();
    EDGE_COLORS.forEach(([value, name]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = name;
      colorField.append(option);
    });
    if (typeof edge.color === "string" && /^#[0-9a-f]{6}$/i.test(edge.color)) {
      const custom = document.createElement("option");
      custom.value = edge.color;
      custom.textContent = "Custom";
      colorField.append(custom);
    }
    colorField.value = typeof edge.color === "string" ? edge.color : "5";
    const x = Math.max(8, Math.min(clientX ?? window.innerWidth / 2, window.innerWidth - 268));
    const y = Math.max(8, Math.min(clientY ?? 120, window.innerHeight - 340));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.hidden = false;
  }

  function selectCanvasEdge(edgeId, clientX, clientY) {
    const board = currentCanvas();
    if (!board?.edges.some((edge) => edge.id === edgeId)) return;
    selectedCanvasEdgeId = edgeId;
    selectedCanvasNodeId = null;
    renderCanvas();
    openEdgeEditor(clientX, clientY);
  }

  function beginCanvasGesture(event, kind, node) {
    if (event.button !== 0) return;
    event.preventDefault();
    canvasGesture = {
      kind,
      pointerId: event.pointerId,
      nodeId: node?.id ?? null,
      startX: event.clientX,
      startY: event.clientY,
      originX: canvasViewportState.x,
      originY: canvasViewportState.y,
      nodeX: node?.x ?? 0,
      nodeY: node?.y ?? 0,
      nodeWidth: node?.width ?? 0,
      nodeHeight: node?.height ?? 0
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCanvasGesture(event) {
    if (!canvasGesture || event.pointerId !== canvasGesture.pointerId) return;
    const deltaX = (event.clientX - canvasGesture.startX) / canvasViewportState.zoom;
    const deltaY = (event.clientY - canvasGesture.startY) / canvasViewportState.zoom;
    const board = currentCanvas();
    if (canvasGesture.kind === "pan") {
      canvasViewportState.x = canvasGesture.originX + event.clientX - canvasGesture.startX;
      canvasViewportState.y = canvasGesture.originY + event.clientY - canvasGesture.startY;
      applyCanvasTransform();
      return;
    }
    const node = board?.nodes.find((item) => item.id === canvasGesture.nodeId);
    if (!node) return;
    if (canvasGesture.kind === "drag") {
      node.x = Math.round(canvasGesture.nodeX + deltaX);
      node.y = Math.round(canvasGesture.nodeY + deltaY);
    } else {
      node.width = Math.max(180, Math.min(1200, Math.round(canvasGesture.nodeWidth + deltaX)));
      node.height = Math.max(100, Math.min(1000, Math.round(canvasGesture.nodeHeight + deltaY)));
    }
    const card = ui.canvasNodes.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (card) {
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      card.style.width = `${node.width}px`;
      card.style.height = `${node.height}px`;
    }
    renderCanvasEdgesOnly();
  }

  function renderCanvasEdgesOnly() {
    const board = currentCanvas();
    if (!board) return;
    const nodes = new Map(board.nodes.map((node) => [node.id, node]));
    ui.canvasEdges.querySelectorAll("line, text").forEach((element) => element.remove());
    board.edges.forEach((edge) => {
      const from = nodes.get(edge.fromNode);
      const to = nodes.get(edge.toNode);
      if (!from || !to) return;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const fromPoint = canvasEdgePoint(from, edge.fromSide);
      const toPoint = canvasEdgePoint(to, edge.toSide);
      line.setAttribute("x1", String(fromPoint.x));
      line.setAttribute("y1", String(fromPoint.y));
      line.setAttribute("x2", String(toPoint.x));
      line.setAttribute("y2", String(toPoint.y));
      line.setAttribute("stroke", canvasColor(edge.color));
      line.setAttribute("stroke-width", "2");
      line.dataset.edgeId = edge.id;
      line.style.pointerEvents = "stroke";
      line.style.cursor = "pointer";
      if (edge.id === selectedCanvasEdgeId) line.setAttribute("stroke-width", "3.5");
      if (edge.fromEnd === "arrow") line.setAttribute("marker-start", "url(#canvas-arrow)");
      if (edge.toEnd === "arrow") line.setAttribute("marker-end", "url(#canvas-arrow)");
      ui.canvasEdges.append(line);
    });
  }

  function finishCanvasGesture(event) {
    if (!canvasGesture || event.pointerId !== canvasGesture.pointerId) return;
    const changed = canvasGesture.kind !== "pan";
    canvasGesture = null;
    if (changed) {
      renderCanvas();
      saveCanvasSoon();
    }
  }

  function validateCanvasDocument(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray(value.nodes) || !Array.isArray(value.edges) ||
      value.nodes.length > MAX_CANVAS_NODES || value.edges.length > MAX_CANVAS_EDGES) {
      throw new TypeError("Canvas file must contain nodes and edges within the supported size limits.");
    }
    if (value.nodes.some((node) =>
      node && ((node.type === "text" && typeof node.text === "string" && node.text.length > 100_000) ||
        (node.type === "file" && typeof node.file === "string" && node.file.length > 240) ||
        (node.type === "file" && typeof node.xPinNoteId === "string" && node.xPinNoteId.length > 100) ||
        (node.type === "group" && typeof node.label === "string" && node.label.length > 100) ||
        (node.type === "group" && typeof node.background === "string" && node.background.length > 240))
    ) || value.edges.some((edge) => edge && typeof edge.label === "string" && edge.label.length > 120)) {
      throw new TypeError("Canvas text fields exceed the supported size limits.");
    }
    const board = {
      id: makeId("canvas"),
      name: String(name || "Imported canvas").replace(/\.canvas$/i, "").slice(0, 100),
      nodes: value.nodes,
      edges: value.edges
    };
    if (state.canvases.length >= MAX_CANVASES) {
      throw new TypeError(`This workspace can contain at most ${MAX_CANVASES} boards.`);
    }
    const clean = sanitizeCanvases([board])[0];
    if (!clean || clean.nodes.length !== value.nodes.length || clean.edges.length !== value.edges.length) {
      throw new TypeError("Canvas contains duplicate, malformed, or unsupported nodes or connections.");
    }
    return clean;
  }

  function exportCanvas() {
    const board = currentCanvas();
    if (!board) return;
    const payload = JSON.stringify({ nodes: board.nodes, edges: board.edges }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${board.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "xPin"}.canvas`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    canvasStatus("Canvas exported as JSON Canvas 1.0");
  }

  let previewMode = false;

  function isCursorInsideCodeBlock(position) {
    const before = ui.noteBody.value.slice(0, position);
    const fences = before.match(/^ {0,3}(```|~~~)/gm) ?? [];
    return fences.length % 2 === 1;
  }

  function insertCodeBlock() {
    if (!currentNote()) createNote();
    const textarea = ui.noteBody;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const language = ui.codeLanguage.value;
    const before = start > 0 && textarea.value[start - 1] !== "\n" ? "\n\n" : "";
    const after = end < textarea.value.length && textarea.value[end] !== "\n" ? "\n\n" : "\n";
    const block = `${before}\`\`\`${language}\n${selected}\n\`\`\`${after}`;
    textarea.setRangeText(block, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function handleCodeEditorKeydown(event) {
    const textarea = ui.noteBody;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (!isCursorInsideCodeBlock(start)) return;
    if (event.key === "Tab") {
      event.preventDefault();
      const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
      const lineEndIndex = textarea.value.indexOf("\n", end);
      const lineEnd = lineEndIndex < 0 ? textarea.value.length : lineEndIndex;
      const selectedLines = textarea.value.slice(lineStart, lineEnd);
      const lines = selectedLines.split("\n");
      const replacement = event.shiftKey
        ? lines.map((line) => line.replace(/^(?: {1,2}|\t)/, "")).join("\n")
        : lines.map((line) => `  ${line}`).join("\n");
      const adjustIndent = (text) => text.split("\n").map((line) =>
        event.shiftKey ? line.replace(/^(?: {1,2}|\t)/, "") : `  ${line}`
      ).join("\n");
      const nextStart = lineStart + adjustIndent(selectedLines.slice(0, start - lineStart)).length;
      const nextEnd = lineStart + adjustIndent(selectedLines.slice(0, end - lineStart)).length;
      textarea.setRangeText(replacement, lineStart, lineEnd, "select");
      textarea.setSelectionRange(nextStart, Math.max(nextStart, nextEnd));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
      const line = textarea.value.slice(lineStart, start);
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const extra = /[{\[(]\s*$/.test(line) ? "  " : "";
      textarea.setRangeText(`\n${indent}${extra}`, start, end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const pairs = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'" };
    if (Object.hasOwn(pairs, event.key)) {
      event.preventDefault();
      const selected = textarea.value.slice(start, end);
      const pair = `${event.key}${selected}${pairs[event.key]}`;
      textarea.setRangeText(pair, start, end, "select");
      const cursor = start + 1 + selected.length;
      textarea.setSelectionRange(cursor, cursor);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function highlightCode(source, language) {
    const keywords = language === "python"
      ? "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield False None True"
      : "as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while yield";
    const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
    let result = "";
    let previous = 0;
    for (const match of source.matchAll(pattern)) {
      result += escapeText(source.slice(previous, match.index));
      const token = match[0];
      let kind = "";
      if (/^(["'`])/.test(token)) kind = "string";
      else if (/^(\/\/|#)/.test(token)) kind = "comment";
      else if (/^\d/.test(token)) kind = "number";
      else if (keywords.split(" ").includes(token)) kind = "keyword";
      result += kind ? `<span class="code-token-${kind}">${escapeText(token)}</span>` : escapeText(token);
      previous = match.index + token.length;
    }
    return result + escapeText(source.slice(previous));
  }

  // Phase 2 (audit B1) — `![name](attachment:<id>)` / `[name](attachment:<id>)`
  // references. Renders a placeholder the phase2 module resolves after the
  // preview builds (image inline, PDF embedded, other files as download
  // links). Unknown ids stay honest instead of linking nowhere.
  function attachmentRefElement(id, fallbackName) {
    const attachment = state.attachments.find((item) => item.id === id);
    const span = document.createElement("span");
    span.className = "attachment-ref";
    if (!attachment) {
      span.textContent = `Attachment unavailable: ${fallbackName || id}`;
      return span;
    }
    const kind = /^image\//.test(attachment.mime) ? "image"
      : attachment.mime === "application/pdf" ? "pdf" : "file";
    span.dataset.attachmentId = attachment.id;
    span.dataset.attachmentKind = kind;
    span.dataset.attachmentName = attachment.name;
    span.dataset.attachmentMime = attachment.mime;
    span.textContent = `${kind === "image" ? "Image" : kind === "pdf" ? "PDF" : "File"}: ${attachment.name} — loading…`;
    const note = document.createElement("small");
    note.className = "attachment-sync-note";
    note.textContent = window.xPinPhase2?.attachmentSyncNote
      ? window.xPinPhase2.attachmentSyncNote(attachment)
      : "";
    span.append(document.createTextNode(" "), note);
    return span;
  }

  function appendInlineMarkdown(element, source) {
    const pattern = /(!\[[^\]]*\]\([^)]+\)|\[\[[^\]]+\]\]|`[^`]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?!\s)(.+?)\*|_(?!\s)(.+?)_)/g;
    let previous = 0;
    for (const match of source.matchAll(pattern)) {
      element.append(document.createTextNode(source.slice(previous, match.index)));
      const token = match[0];
      let rendered;
      if (token.startsWith("![")) {
        // Phase 2 — image attachments render inline; other images stay as
        // plain text (unchanged pre-Phase 2 behavior).
        const imageMatch = token.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
        const attachmentId = imageMatch?.[2]?.startsWith("attachment:")
          ? imageMatch[2].slice("attachment:".length) : null;
        rendered = attachmentId
          ? attachmentRefElement(attachmentId, imageMatch[1])
          : document.createTextNode(token);
      } else if (token.startsWith("[[")) {
        const [target, alias] = token.slice(2, -2).split("|", 2);
        const cleanTarget = target.trim();
        const note = state.notes.find((item) =>
          item.id === cleanTarget || item.title.trim().toLocaleLowerCase() === cleanTarget.toLocaleLowerCase()
        );
        if (note) {
          rendered = document.createElement("button");
          rendered.type = "button";
          rendered.className = "wiki-link";
          rendered.textContent = alias?.trim() || note.title || "Untitled note";
          rendered.addEventListener("click", () => selectNote(note.id));
        } else {
          rendered = document.createTextNode(token);
        }
      } else if (token.startsWith("`")) {
        rendered = document.createElement("code");
        rendered.textContent = token.slice(1, -1);
      } else if (token.startsWith("[")) {
        // Phase 2 — attachment links resolve to the stored file.
        if (typeof match[3] === "string" && match[3].startsWith("attachment:")) {
          rendered = attachmentRefElement(match[3].slice("attachment:".length), match[2]);
        } else {
          try {
            const url = new URL(match[3], window.location.href);
          if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Unsupported link protocol.");
          rendered = document.createElement("a");
          rendered.href = url.href;
          rendered.target = "_blank";
          rendered.rel = "noopener noreferrer";
          rendered.textContent = match[2];
          if (match[4]) rendered.title = match[4];
          } catch {
            rendered = document.createTextNode(token);
          }
        }
      } else {
        const content = match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9];
        rendered = document.createElement(match[5] || match[6] ? "strong" : match[7] ? "del" : "em");
        rendered.textContent = content;
      }
      element.append(rendered);
      previous = match.index + token.length;
    }
    element.append(document.createTextNode(source.slice(previous)));
  }

  function parseTableCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  }

  function isMarkdownBlockStart(lines, index) {
    const line = lines[index] ?? "";
    return /^ {0,3}(#{1,6}\s|```|~~~|>|[-+*]\s|\d+[.)]\s|([-*_]\s*){3,}$)/.test(line) ||
      (index + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1]) && line.includes("|"));
  }

  function resolveEmbed(provider, source) {
    let url;
    try {
      url = new URL(source);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLocaleLowerCase();
    if (provider === "youtube" && ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com"].includes(host)) {
      const id = host.includes("youtu.be") ? url.pathname.slice(1).split("/")[0]
        : url.pathname === "/watch" ? url.searchParams.get("v")
          : url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{6,20})$/)?.[1];
      return id && /^[A-Za-z0-9_-]{6,20}$/.test(id)
        ? { kind: "frame", url: `https://www.youtube-nocookie.com/embed/${id}`, label: "YouTube video" }
        : null;
    }
    if (provider === "figma" && ["figma.com", "www.figma.com"].includes(host) && /^\/(file|design|board)\/[A-Za-z0-9]+/.test(url.pathname)) {
      return { kind: "frame", url: `https://www.figma.com/embed?embed_host=xPin&url=${encodeURIComponent(url.href)}`, label: "Figma file" };
    }
    if (provider === "drive" && ["drive.google.com", "docs.google.com"].includes(host)) {
      const idPattern = "([A-Za-z0-9_-]{8,})";
      if (host === "drive.google.com") {
        const pathId = url.pathname.match(new RegExp(`/(?:file/d|drive/folders)/${idPattern}`))?.[1];
        const paramId = url.searchParams.get("id");
        const fileId = pathId ?? (/^[A-Za-z0-9_-]{8,}$/.test(paramId ?? "") ? paramId : null);
        if (!fileId) return null;
        if (url.pathname.includes("/drive/folders/")) {
          return { kind: "frame", url: `https://drive.google.com/embeddedfolderview?id=${fileId}#list`, label: "Google Drive folder" };
        }
        return { kind: "frame", url: `https://drive.google.com/file/d/${fileId}/preview`, label: "Google Drive file" };
      }
      const docMatch = url.pathname.match(new RegExp(`^/(document|spreadsheets|presentation)/d/${idPattern}`));
      if (!docMatch) return null;
      const [, docKind, docId] = docMatch;
      const label = docKind === "document" ? "Google Doc" : docKind === "spreadsheets" ? "Google Sheet" : "Google Slides";
      const embedPath = docKind === "presentation" ? "embed" : "preview";
      return { kind: "frame", url: `https://docs.google.com/${docKind}/d/${docId}/${embedPath}`, label };
    }
    if (provider === "typeform" && ["typeform.com", "www.typeform.com", "form.typeform.com"].includes(host)) {
      const formId = url.pathname.match(/\/to\/([A-Za-z0-9]+)/)?.[1];
      return formId ? { kind: "frame", url: `https://form.typeform.com/to/${formId}`, label: "Typeform" } : null;
    }
    if (["image", "audio", "video"].includes(provider)) {
      const extension = url.pathname.toLocaleLowerCase().split(".").pop();
      const allowed = {
        image: ["png", "jpg", "jpeg", "gif", "webp"],
        audio: ["mp3", "m4a", "ogg", "wav", "aac"],
        video: ["mp4", "webm", "ogv", "mov"]
      };
      return allowed[provider].includes(extension) ? { kind: provider, url: url.href, label: `${provider} media` } : null;
    }
    return null;
  }

  function appendEmbed(container, provider, source) {
    const embed = resolveEmbed(provider, source);
    const section = document.createElement("section");
    section.className = "preview-embed";
    if (!embed) {
      section.textContent = `This ${provider} embed is unsupported or the URL is not allowed.`;
      container.append(section);
      return;
    }
    const load = document.createElement("button");
    load.type = "button";
    load.className = "preview-embed-load";
    load.textContent = `Load ${embed.label} from ${new URL(embed.url).hostname}`;
    load.addEventListener("click", () => {
      if (embed.kind === "frame") {
        const frame = document.createElement("iframe");
        frame.src = embed.url;
        frame.title = embed.label;
        frame.loading = "lazy";
        frame.referrerPolicy = "no-referrer";
        frame.sandbox = "allow-scripts allow-same-origin allow-forms allow-popups";
        frame.allow = "fullscreen; picture-in-picture";
        section.replaceChildren(frame);
      } else if (embed.kind === "image") {
        const image = document.createElement("img");
        image.src = embed.url;
        image.alt = "Embedded image";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        section.replaceChildren(image);
      } else {
        const media = document.createElement(embed.kind);
        media.src = embed.url;
        media.controls = true;
        media.preload = "none";
        media.referrerPolicy = "no-referrer";
        section.replaceChildren(media);
      }
    }, { once: true });
    section.append(load);
    container.append(section);
  }

  function appendMarkdownBlocks(container, source, sharedPath = new Set()) {
    const lines = source.split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      const fence = line.match(/^ {0,3}(```|~~~)\s*([a-z0-9_+-]*)/i);
      if (fence) {
        const code = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^ {0,3}${fence[1]}\\s*$`).test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const block = document.createElement("section");
        block.className = "preview-code-block";
        const header = document.createElement("header");
        const language = document.createElement("span");
        language.textContent = fence[2] || "plain text";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy code";
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(code.join("\n"));
            showToast("Code copied.");
          } catch (error) {
            console.error("Could not copy code block.", error);
            showToast("Clipboard access is unavailable in this browser.");
          }
        });
        header.append(language, copy);
        const pre = document.createElement("pre");
        const codeElement = document.createElement("code");
        // Phase 3 — tag the code element with its fence language so the
        // preview enhancer can find xpin-task / xpin-script blocks.
        codeElement.className = `language-${(fence[2] || "text").toLocaleLowerCase()}`;
        codeElement.innerHTML = highlightCode(code.join("\n"), fence[2]?.toLocaleLowerCase() || "text");
        pre.append(codeElement);
        block.append(header, pre);
        container.append(block);
        continue;
      }
      const embed = line.match(/^ {0,3}@([a-z]+)\((https:\/\/[^)\s]+)\)\s*$/i);
      if (embed) {
        appendEmbed(container, embed[1].toLocaleLowerCase(), embed[2]);
        index += 1;
        continue;
      }
      const synced = line.match(/^ {0,3}\{\{sync:([A-Za-z0-9_-]{1,100})\}\}\s*$/);
      if (synced) {
        const block = state.features.syncedBlocks.find((item) => item.id === synced[1]);
        const wrapper = document.createElement("section");
        wrapper.className = "synced-block-preview";
        if (!block) {
          wrapper.textContent = "This shared block is missing.";
        } else if (sharedPath.has(block.id) || sharedPath.size >= 8) {
          wrapper.textContent = "A shared-block reference loop was stopped.";
        } else {
          const heading = document.createElement("strong");
          heading.textContent = block.title;
          const content = document.createElement("div");
          const nextPath = new Set(sharedPath);
          nextPath.add(block.id);
          appendMarkdownBlocks(content, block.content, nextPath);
          wrapper.append(heading, content);
        }
        container.append(wrapper);
        index += 1;
        continue;
      }
      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const element = document.createElement(`h${heading[1].length}`);
        appendInlineMarkdown(element, heading[2]);
        container.append(element);
        index += 1;
        continue;
      }
      if (/^ {0,3}([-*_]\s*){3,}$/.test(line)) {
        container.append(document.createElement("hr"));
        index += 1;
        continue;
      }
      if (/^ {0,3}>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
          quote.push(lines[index].replace(/^ {0,3}> ?/, ""));
          index += 1;
        }
        const blockquote = document.createElement("blockquote");
        appendMarkdownBlocks(blockquote, quote.join("\n"), sharedPath);
        container.append(blockquote);
        continue;
      }
      if (/^\s*\|?.+\|.+\|?\s*$/.test(line) && index + 1 < lines.length &&
        /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1])) {
        const headers = parseTableCells(line);
        const alignments = parseTableCells(lines[index + 1]).map((cell) =>
          cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""
        );
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        headers.forEach((value, cellIndex) => {
          const cell = document.createElement("th");
          cell.scope = "col";
          if (alignments[cellIndex]) cell.style.textAlign = alignments[cellIndex];
          appendInlineMarkdown(cell, value);
          headerRow.append(cell);
        });
        thead.append(headerRow);
        table.append(thead);
        const body = document.createElement("tbody");
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const cells = parseTableCells(lines[index]);
          const row = document.createElement("tr");
          headers.forEach((_, cellIndex) => {
            const cell = document.createElement("td");
            if (alignments[cellIndex]) cell.style.textAlign = alignments[cellIndex];
            appendInlineMarkdown(cell, cells[cellIndex] ?? "");
            row.append(cell);
          });
          body.append(row);
          index += 1;
        }
        table.append(body);
        container.append(table);
        continue;
      }
      const listMatch = line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.*)$/);
      if (listMatch) {
        const ordered = /^\d/.test(listMatch[1]);
        const list = document.createElement(ordered ? "ol" : "ul");
        if (ordered) list.start = Number.parseInt(listMatch[1], 10);
        while (index < lines.length) {
          const itemMatch = lines[index].match(/^ {0,3}([-+*]|\d+[.)])\s+(.*)$/);
          if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break;
          const item = document.createElement("li");
          const task = itemMatch[2].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.disabled = true;
            checkbox.checked = task[1].toLocaleLowerCase() === "x";
            item.append(checkbox);
            appendInlineMarkdown(item, task[2]);
          } else {
            appendInlineMarkdown(item, itemMatch[2]);
          }
          list.append(item);
          index += 1;
        }
        container.append(list);
        continue;
      }
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const paragraph = document.createElement("p");
      const text = [];
      while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
        text.push(lines[index].trim());
        index += 1;
      }
      if (!text.length) {
        text.push(lines[index].trim());
        index += 1;
      }
      appendInlineMarkdown(paragraph, text.join(" "));
      container.append(paragraph);
    }
  }

  function renderMarkdownPreview(source) {
    ui.markdownPreview.replaceChildren();
    appendMarkdownBlocks(ui.markdownPreview, source);
    // Phase 2 — resolve attachment references (images inline, PDFs
    // embedded, files as download links). Best-effort: a missing blob
    // leaves the honest placeholder the renderer already wrote.
    if (window.xPinPhase2?.resolveAttachmentRefs) {
      window.xPinPhase2.resolveAttachmentRefs(ui.markdownPreview).catch((error) => {
        console.error("Could not resolve note attachments.", error);
      });
    }
    // Phase 3 — typed blocks and script blocks render as cards in preview.
    phase3UI?.enhancePreview(ui.markdownPreview, currentNote());
  }

  function setPreviewMode(enabled) {
    previewMode = Boolean(enabled);
    ui.noteBody.hidden = previewMode;
    ui.markdownPreview.hidden = !previewMode || !currentNote();
    ui.togglePreview.setAttribute("aria-pressed", String(previewMode));
    ui.togglePreview.textContent = previewMode ? "Edit" : "Preview";
    if (previewMode) renderMarkdownPreview(currentNote()?.body ?? "");
  }

  // M6 — render Markdown to an HTML string through the same renderer the
  // in-app preview uses, so exports look like the preview. The fake DOM in
  // the smoke suite does not serialize innerHTML from built nodes, so this
  // walks the rendered tree with a small allowlisted serializer instead.
  const SERIALIZE_VOID_TAGS = new Set(["br", "hr", "img", "input"]);
  const SERIALIZE_ATTRS = new Set(["class", "href", "src", "alt", "title", "type", "checked", "disabled", "start", "colspan", "rowspan"]);

  function serializeNodeToHtml(node) {
    if (!node) return "";
    if (node.nodeType === 3) return escapeText(node.textContent ?? "");
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "iframe" || tag === "script" || tag === "style") return "";
    const attrs = [];
    const seen = new Set();
    const pushAttr = (name, value) => {
      if (!SERIALIZE_ATTRS.has(name) || seen.has(name) || value === null || value === undefined) return;
      seen.add(name);
      attrs.push(` ${name}="${escapeText(String(value))}"`);
    };
    if (node.attributes) {
      if (typeof node.attributes[Symbol.iterator] === "function") {
        for (const attr of node.attributes) pushAttr(attr.name, attr.value);
      } else {
        for (const [name, value] of Object.entries(node.attributes)) pushAttr(name, value);
      }
    }
    if (node.className) pushAttr("class", node.className);
    if (node.checked) pushAttr("checked", "checked");
    if (node.disabled) pushAttr("disabled", "disabled");
    const children = [...(node.childNodes ?? [])].map(serializeNodeToHtml).join("");
    if (SERIALIZE_VOID_TAGS.has(tag)) return `<${tag}${attrs.join("")}>`;
    return `<${tag}${attrs.join("")}>${children}</${tag}>`;
  }

  function markdownToHtml(source) {
    const container = document.createElement("div");
    appendMarkdownBlocks(container, source ?? "");
    return [...container.childNodes].map(serializeNodeToHtml).join("");
  }

  // M3 — Markdown export. Per-note .md with frontmatter, and a workspace
  // .zip that preserves folder structure. The zip is a minimal stored
  // (uncompressed) archive written by hand — no new dependency.
  function slugifyFileName(value, fallback = "note") {
    const slug = String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || fallback;
  }

  function downloadFile(fileName, contents, type) {
    const blob = contents instanceof Blob ? contents : new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatFrontmatterValue(value) {
    if (value === null) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(String(value));
  }

  function noteToMarkdown(note) {
    const lines = [];
    const metadata = note.metadata ?? {};
    const keys = Object.keys(metadata);
    if (keys.length) {
      lines.push("---");
      keys.sort().forEach((key) => lines.push(`${key}: ${formatFrontmatterValue(metadata[key])}`));
      lines.push("---", "");
    }
    const title = note.title.trim() || "Untitled note";
    if (!note.body.startsWith(`# ${title}\n`) && note.body.trim() !== `# ${title}`) {
      lines.push(`# ${title}`, "");
    }
    lines.push(note.body);
    return lines.join("\n");
  }

  function exportNoteMarkdown(note) {
    const target = note ?? currentNote();
    if (!target) {
      showToast("Open a note before exporting Markdown.");
      return false;
    }
    downloadFile(`${slugifyFileName(target.title)}.md`, noteToMarkdown(target), "text/markdown;charset=utf-8");
    showToast("Markdown file exported.");
    return true;
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const dosDate = (() => {
      const now = new Date();
      const time = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
      const date = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);
      return { time, date };
    })();
    for (const file of files) {
      const name = encoder.encode(file.path);
      const data = encoder.encode(file.content);
      const crc = crc32(data);
      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 0x04034b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 0x0800, true); // UTF-8 filenames
      header.setUint16(8, 0, true); // stored, no compression
      header.setUint16(10, dosDate.time, true);
      header.setUint16(12, dosDate.date, true);
      header.setUint32(14, crc, true);
      header.setUint32(18, data.length, true);
      header.setUint32(22, data.length, true);
      header.setUint16(26, name.length, true);
      header.setUint16(28, 0, true);
      localParts.push(new Uint8Array(header.buffer), name, data);
      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, dosDate.time, true);
      central.setUint16(14, dosDate.date, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, name.length, true);
      central.setUint16(30, 0, true);
      central.setUint16(32, 0, true);
      central.setUint16(34, 0, true);
      central.setUint16(36, 0, true);
      central.setUint32(38, 0, true);
      central.setUint32(42, offset, true);
      centralParts.push(new Uint8Array(central.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of [...localParts, ...centralParts, new Uint8Array(end.buffer)]) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  function exportMarkdownZip() {
    const used = new Set();
    const uniquePath = (path) => {
      let candidate = path;
      let n = 2;
      while (used.has(candidate)) {
        candidate = path.replace(/\.md$/, `-${n}.md`);
        n += 1;
      }
      used.add(candidate);
      return candidate;
    };
    const folderName = (id) => state.folders.find((folder) => folder.id === id)?.name ?? "";
    const files = [];
    for (const note of state.notes) {
      const folder = folderName(note.folderId);
      files.push({
        path: uniquePath(`${folder ? `${slugifyFileName(folder, "folder")}/` : ""}${slugifyFileName(note.title)}.md`),
        content: noteToMarkdown(note)
      });
    }
    for (const note of state.trash) {
      files.push({
        path: uniquePath(`Trash/${slugifyFileName(note.title)}.md`),
        content: noteToMarkdown(note)
      });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`xpin-notes-${stamp}.zip`, buildZip(files), "application/zip");
    showToast(`Exported ${files.length} ${files.length === 1 ? "note" : "notes"} as Markdown (.zip).`);
    return files.length;
  }

  // M3 — frontmatter round-trip: .md imports that start with a --- block get
  // their properties parsed into metadata (and a `title:` key becomes the
  // note title) instead of being stored as literal body text.
  function parseFrontmatter(text) {
    const body = String(text ?? "");
    if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return { metadata: {}, body };
    const lines = body.split("\n");
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end < 0) return { metadata: {}, body };
    const metadata = {};
    for (const line of lines.slice(1, end)) {
      const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]{0,49}):\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean" || parsed === null ||
          (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string"))) {
          value = parsed;
        }
      } catch {
        value = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      }
      metadata[key] = value;
    }
    const rest = lines.slice(end + 1).join("\n").replace(/^\n/, "");
    const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : null;
    if (title !== null) delete metadata.title;
    return { metadata: sanitizeNoteMetadata(metadata), body: rest, title };
  }

  function renderEditor() {
    const note = currentNote();
    hideLinkSuggestions();
    renderBacklinks();
    ui.editorFields.hidden = !note;
    ui.editorEmpty.hidden = Boolean(note);
    ui.pinButton.disabled = !note;
    ui.deleteButton.disabled = !note;
    byId("create-child-page").disabled = !note;
    byId("insert-synced-block").disabled = !note && state.notes.length === 0;
    ui.pinButton.classList.toggle("is-pinned", Boolean(note?.pinned));
    ui.pinButton.setAttribute("aria-label", note?.pinned ? "Unpin note" : "Pin note");
    ui.pinButton.title = note?.pinned ? "Unpin note" : "Pin note";
    if (!note) {
      ui.editorFolder.textContent = "NOTES";
      ui.editorDate.textContent = "NO NOTE SELECTED";
      ui.markdownPreview.hidden = true;
      renderNoteProperties(null);
      return;
    }

    const folder = state.folders.find((item) => item.id === note.folderId);
    ui.editorFolder.textContent = folder?.name.toLocaleUpperCase() ?? "NOTES";
    ui.editorDate.textContent = `EDITED ${formatRelative(note.updatedAt).toLocaleUpperCase()}`;
    ui.noteTitle.value = note.title;
    ui.noteBody.value = note.body;
    ui.noteBody.hidden = previewMode;
    ui.markdownPreview.hidden = !previewMode;
    if (previewMode) renderMarkdownPreview(note.body);
    ui.noteMetaDate.textContent = `Created ${formatRelative(note.createdAt).toLocaleLowerCase()}`;
    ui.noteFolder.replaceChildren();
    const noFolder = document.createElement("option");
    noFolder.value = "";
    noFolder.textContent = "No folder";
    ui.noteFolder.append(noFolder);
    state.folders.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      ui.noteFolder.append(option);
    });
    ui.noteFolder.value = note.folderId ?? "";
    ui.noteParent.replaceChildren();
    const rootPage = document.createElement("option");
    rootPage.value = "";
    rootPage.textContent = "No parent";
    ui.noteParent.append(rootPage);
    const descendants = new Set();
    const collectDescendants = (parentId) => {
      state.notes.filter((item) => item.parentNoteId === parentId).forEach((child) => {
        descendants.add(child.id);
        collectDescendants(child.id);
      });
    };
    collectDescendants(note.id);
    state.notes.filter((item) => item.id !== note.id && !descendants.has(item.id))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
      .forEach((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.title.trim() || "Untitled note";
        ui.noteParent.append(option);
      });
    ui.noteParent.value = note.parentNoteId ?? "";
    renderNoteProperties(note);
  }

  // M5 — properties editor (frontmatter key/value rows) + M2 version history.
  // `dailyDate` is internal and stays out of the editable list.
  function renderNoteProperties(note) {
    const container = ui.noteProperties;
    if (!container) return;
    container.replaceChildren();
    if (!note) return;
    const heading = document.createElement("div");
    heading.className = "properties-heading";
    heading.textContent = "PROPERTIES";
    container.append(heading);
    const entries = Object.entries(note.metadata ?? {}).filter(([key]) => key !== "dailyDate");
    entries.forEach(([key, value]) => {
      const row = document.createElement("div");
      row.className = "property-row";
      const keyLabel = document.createElement("span");
      keyLabel.className = "property-key";
      keyLabel.textContent = key;
      const valueInput = document.createElement("input");
      valueInput.type = "text";
      valueInput.className = "property-value";
      valueInput.value = typeof value === "string" ? value : JSON.stringify(value ?? "");
      valueInput.setAttribute("aria-label", `Property ${key}`);
      valueInput.addEventListener("change", () => {
        setNoteMetadata(note, { [key]: valueInput.value });
        scheduleSave();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "property-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove property ${key}`);
      remove.addEventListener("click", () => {
        setNoteMetadata(note, { [key]: null });
        renderEditor();
        scheduleSave();
      });
      row.append(keyLabel, valueInput, remove);
      container.append(row);
    });
    const addRow = document.createElement("div");
    addRow.className = "property-row property-add";
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "property-key-input";
    keyInput.placeholder = "key";
    keyInput.setAttribute("aria-label", "New property name");
    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "property-value";
    valueInput.placeholder = "value";
    valueInput.setAttribute("aria-label", "New property value");
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "property-add-button";
    addButton.textContent = "Add";
    addButton.addEventListener("click", () => {
      const key = keyInput.value.trim();
      if (!METADATA_KEY_PATTERN.test(key)) {
        showToast("Property names start with a letter and use letters, digits, spaces, _ or -.");
        return;
      }
      if (Object.hasOwn(note.metadata ?? {}, key)) {
        showToast(`"${key}" already exists — edit its value instead.`);
        return;
      }
      setNoteMetadata(note, { [key]: valueInput.value });
      renderEditor();
      scheduleSave();
    });
    addRow.append(keyInput, valueInput, addButton);
    container.append(addRow);
    if (note.versions?.length) {
      const details = document.createElement("details");
      details.className = "version-history";
      const summary = document.createElement("summary");
      summary.textContent = `Version history · ${note.versions.length}`;
      details.append(summary);
      [...note.versions].reverse().forEach((version, reverseIndex) => {
        const index = note.versions.length - 1 - reverseIndex;
        const row = document.createElement("div");
        row.className = "version-row";
        const label = document.createElement("span");
        label.textContent = `${formatRelative(version.updatedAt)} · ${(version.title.trim() || "Untitled note").slice(0, 60)}`;
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "version-restore";
        restore.textContent = "Restore";
        restore.setAttribute("aria-label", `Restore version from ${formatRelative(version.updatedAt)}`);
        restore.addEventListener("click", () => restoreVersion(note.id, index));
        row.append(label, restore);
        details.append(row);
      });
      container.append(details);
    }
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findBacklinks(note) {
    const title = note.title.trim();
    const linkPattern = title ? new RegExp(`\\[\\[${escapeRegExp(title)}\\]\\]`, "i") : null;
    return state.notes
      .filter((other) => other.id !== note.id &&
        (other.parentNoteId === note.id || (linkPattern !== null && linkPattern.test(other.body))))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  }

  function renderBacklinks() {
    const note = currentNote();
    const meta = byId("editor-fields")?.querySelector(".note-meta");
    let section = byId("backlinks-section");
    if (!note || !meta) {
      section?.remove();
      return;
    }
    if (!section) {
      section = document.createElement("div");
      section.id = "backlinks-section";
      section.className = "backlinks";
      section.setAttribute("aria-label", "Notes linking here");
      meta.insertAdjacentElement("afterend", section);
    }
    section.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "backlinks-heading";
    heading.textContent = "LINKED HERE";
    section.append(heading);
    const backlinks = findBacklinks(note);
    if (!backlinks.length) {
      const empty = document.createElement("p");
      empty.className = "backlinks-empty";
      empty.textContent = "No notes link here yet.";
      section.append(empty);
      return;
    }
    backlinks.forEach((other) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "backlink-row";
      row.title = other.parentNoteId === note.id ? "Sub-page — open" : "Links here — open";
      const label = document.createElement("span");
      label.textContent = other.title.trim() || "Untitled note";
      row.append(label);
      if (other.parentNoteId === note.id) {
        const tag = document.createElement("span");
        tag.className = "backlink-tag";
        tag.textContent = "SUB-PAGE";
        row.append(tag);
      }
      row.addEventListener("click", () => selectNote(other.id));
      section.append(row);
    });
  }

  /* ---------- [[ page-link autocomplete ---------- */
  let linkSuggestMenu = null;
  let linkSuggestItems = [];
  let linkSuggestIndex = 0;
  let linkTriggerStart = -1;

  function hideLinkSuggestions() {
    if (linkSuggestMenu) linkSuggestMenu.hidden = true;
    linkSuggestItems = [];
    linkSuggestIndex = 0;
    linkTriggerStart = -1;
  }

  function caretViewportOffset(textarea, position) {
    // Mirror-div caret measurement: copy the textarea's text metrics into an
    // invisible div, mark the caret with a zero-width span, and read its offset.
    const mirror = document.createElement("div");
    const style = window.getComputedStyle(textarea);
    ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "textTransform", "wordSpacing", "textIndent"].forEach((property) => {
      mirror.style[property] = style[property];
    });
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflowWrap = "break-word";
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.textContent = textarea.value.slice(0, position);
    const marker = document.createElement("span");
    marker.textContent = "​";
    mirror.append(marker);
    document.body.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    const fieldRect = textarea.getBoundingClientRect();
    const top = markerRect.top - fieldRect.top;
    const left = markerRect.left - fieldRect.left;
    mirror.remove();
    return { top, left };
  }

  function renderLinkSuggestions() {
    if (!linkSuggestMenu) {
      linkSuggestMenu = document.createElement("div");
      linkSuggestMenu.className = "link-suggest";
      linkSuggestMenu.setAttribute("role", "listbox");
      linkSuggestMenu.setAttribute("aria-label", "Link to a note");
      linkSuggestMenu.hidden = true;
      document.body.append(linkSuggestMenu);
    }
    linkSuggestMenu.replaceChildren();
    if (!linkSuggestItems.length) {
      linkSuggestMenu.hidden = true;
      return;
    }
    linkSuggestIndex = Math.max(0, Math.min(linkSuggestIndex, linkSuggestItems.length - 1));
    linkSuggestItems.forEach((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = `link-suggest-option${index === linkSuggestIndex ? " is-active" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === linkSuggestIndex));
      option.textContent = item.title.trim() || "Untitled note";
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => completeLinkSuggestion(item));
      option.addEventListener("mouseenter", () => {
        linkSuggestIndex = index;
        renderLinkSuggestions();
      });
      linkSuggestMenu.append(option);
    });
    try {
      const caret = caretViewportOffset(ui.noteBody, ui.noteBody.selectionStart);
      const fieldRect = ui.noteBody.getBoundingClientRect();
      const lineHeight = Number.parseFloat(window.getComputedStyle(ui.noteBody).lineHeight) || 20;
      linkSuggestMenu.style.left = `${Math.max(8, Math.min(fieldRect.left + caret.left, window.innerWidth - 260))}px`;
      linkSuggestMenu.style.top = `${fieldRect.top + caret.top + lineHeight + 4}px`;
    } catch (error) {
      linkSuggestMenu.style.left = "24px";
      linkSuggestMenu.style.top = "50%";
    }
    linkSuggestMenu.hidden = false;
  }

  function updateLinkSuggestions() {
    const note = currentNote();
    const caret = ui.noteBody.selectionStart;
    const before = ui.noteBody.value.slice(0, caret);
    const match = before.match(/\[\[([^\[\]\n]*)$/);
    if (!match) {
      hideLinkSuggestions();
      return;
    }
    linkTriggerStart = caret - match[0].length;
    const query = match[1].toLocaleLowerCase();
    linkSuggestItems = state.notes
      .filter((item) => (!note || item.id !== note.id) &&
        item.title.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
      .slice(0, 8);
    linkSuggestIndex = 0;
    renderLinkSuggestions();
  }

  function completeLinkSuggestion(item) {
    const textarea = ui.noteBody;
    const caret = textarea.selectionStart;
    if (linkTriggerStart < 0 || caret < linkTriggerStart) {
      // The caret moved away from the trigger (e.g. arrow keys) after the
      // suggestions appeared — re-scan from the current position instead of
      // throwing IndexSizeError in setRangeText.
      const before = textarea.value.slice(0, caret);
      const match = before.match(/\[\[([^\[\]\n]*)$/);
      if (!match) { hideLinkSuggestions(); return; }
      linkTriggerStart = caret - match[0].length;
    }
    const title = item.title.trim() || "Untitled note";
    const insertion = `[[${title}]]`;
    textarea.setRangeText(insertion, linkTriggerStart, caret, "end");
    let end = linkTriggerStart + insertion.length;
    if (textarea.value.slice(end, end + 2) === "]]") {
      // Consume the auto-closed brackets left by the editor's bracket pairing.
      textarea.setRangeText("", end, end + 2, "end");
    }
    textarea.setSelectionRange(end, end);
    hideLinkSuggestions();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function setupLinkAutocomplete() {
    ui.noteBody.addEventListener("input", () => {
      const slashMenu = document.querySelector(".slash-command-menu");
      if (slashMenu && !slashMenu.hidden) {
        hideLinkSuggestions();
        return;
      }
      updateLinkSuggestions();
    });
    ui.noteBody.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      if (!linkSuggestMenu || linkSuggestMenu.hidden || !linkSuggestItems.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        linkSuggestIndex = (linkSuggestIndex + (event.key === "ArrowDown" ? 1 : -1) + linkSuggestItems.length) % linkSuggestItems.length;
        renderLinkSuggestions();
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        completeLinkSuggestion(linkSuggestItems[linkSuggestIndex]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        hideLinkSuggestions();
      }
      event.stopPropagation();
    });
    ui.noteBody.addEventListener("blur", () => {
      window.setTimeout(hideLinkSuggestions, 120);
    });
    ui.noteBody.addEventListener("scroll", hideLinkSuggestions);
  }

  function renderPluginPanels() {
    if (!ui.pluginPanels) return;
    ui.pluginPanels.replaceChildren();
    if (!pluginManager) return;
    const note = currentNote();
    const context = {
      note,
      notes: state.notes,
      folders: state.folders
    };
    pluginManager.panels().forEach((panel) => {
      const wrapper = document.createElement("section");
      wrapper.className = "plugin-panel-wrap";
      const heading = document.createElement("h2");
      heading.textContent = panel.title;
      wrapper.append(heading);
      try {
        const content = panel.render(context);
        if (!(content instanceof Node)) throw new TypeError(`Panel "${panel.title}" did not return a DOM node.`);
        wrapper.append(content);
      } catch (error) {
        console.error(`xPin plugin panel "${panel.title}" failed.`, error);
        const message = document.createElement("p");
        message.className = "plugin-error";
        message.textContent = "This feature could not be displayed.";
        wrapper.append(message);
      }
      ui.pluginPanels.append(wrapper);
    });
  }

  function renderEditorStatus() {
    if (!ui.editorStatus) return;
    ui.editorStatus.replaceChildren();
    if (!pluginManager) return;
    const note = currentNote();
    const context = { note: note ? { ...note } : null };
    pluginManager.statusItems().forEach((item) => {
      try {
        const content = item.render(context);
        if (!(content instanceof Node)) throw new TypeError(`Status item "${item.id}" did not return a DOM node.`);
        ui.editorStatus.append(content);
      } catch (error) {
        console.error(`xPin plugin status item "${item.id}" failed.`, error);
        const message = document.createElement("span");
        message.className = "plugin-error";
        message.textContent = "Feature unavailable";
        ui.editorStatus.append(message);
      }
    });
    extensionStatusItems.forEach((item) => {
      const status = document.createElement("span");
      status.className = "extension-status-item";
      status.dataset.pluginId = item.pluginId;
      status.textContent = item.text;
      ui.editorStatus.append(status);
    });
  }

  // Core commands (M2/M3): undo, Trash, and Markdown export live in the
  // palette alongside plugin commands so they are one keystroke away.
  function coreCommands() {
    return [
      {
        id: "undo-last-action",
        name: "Undo last action",
        description: "Undo the last note or folder change.",
        run: () => undoLastAction()
      },
      {
        id: "open-trash",
        name: "Open Trash",
        description: "See deleted notes, restore them, or delete them forever.",
        run: () => {
          setActiveFilter("trash");
          switchView("notes");
          render();
        }
      },
      {
        id: "export-note-markdown",
        name: "Export current note as Markdown",
        description: "Download this note as a .md file with its properties.",
        run: () => exportNoteMarkdown()
      },
      {
        id: "export-workspace-markdown",
        name: "Export all notes as Markdown (.zip)",
        description: "Download every note as .md files, folders preserved.",
        run: () => exportMarkdownZip()
      }
    ];
  }

  function availableCommands() {
    return [
      ...coreCommands(),
      ...(pluginManager?.commands() ?? []),
      ...extensionCommands.values()
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  function removeExtensionCommands(pluginId) {
    for (const [key, command] of extensionCommands) {
      if (command.pluginId === pluginId) extensionCommands.delete(key);
    }
    if (!ui.commandsModal.hidden) renderCommands();
  }

  function removeExtensionStatusItems(pluginId) {
    let changed = false;
    for (const key of extensionStatusItems.keys()) {
      if (extensionStatusItems.get(key).pluginId === pluginId) {
        extensionStatusItems.delete(key);
        changed = true;
      }
    }
    if (changed) renderEditorStatus();
  }

  function copyPluginValue(value) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 16_000) {
      throw new TypeError("Plugin settings must be JSON values under 16 KB.");
    }
    return JSON.parse(encoded);
  }

  async function handleExtensionRequest(plugin, capability, payload) {
    if (!plugin.grants.includes(capability) || !plugin.manifest.permissions.includes(capability)) {
      throw new Error("This plugin capability was not granted.");
    }
    if (capability === "notes:read") {
      if (payload?.action === "current") {
        const note = currentNote();
        return note ? { ...note } : null;
      }
      if (payload?.action === "list") return state.notes.slice(0, 500).map((note) => ({ ...note }));
      throw new TypeError("Unknown note-read action.");
    }
    if (capability === "notes:select") {
      if (typeof payload?.id !== "string") throw new TypeError("Note selection requires a note id.");
      selectNote(payload.id);
      return true;
    }
    if (capability === "notes:create") {
      const options = payload?.options ?? {};
      if (!options || typeof options !== "object" || Array.isArray(options) ||
        typeof options.title !== "string" || typeof options.body !== "string" ||
        options.title.length > 120 || options.body.length > 100_000) {
        throw new TypeError("Plugin note content must be text within the supported size limits.");
      }
      const folderId = options.folderId ?? null;
      if (folderId !== null && typeof folderId !== "string") throw new TypeError("Plugin folder id is invalid.");
      return createNote({ title: options.title, body: options.body, folderId });
    }
    if (capability === "notes:update") {
      if (typeof payload?.id !== "string") throw new TypeError("Plugin note update requires a note id.");
      // Phase 1: the RPC handler delegates to the shared domain function
      // (same validation as createNote; folder/parent/pinned/metadata all
      // supported). The editor re-renders when the open note changed from
      // outside the editor itself.
      const updated = updateNote(payload.id, payload?.patch ?? {});
      if (updated.id === selectedNoteId) renderEditor();
      persistWorkspace();
      return updated;
    }
    if (capability === "notes:delete") {
      if (typeof payload?.id !== "string") throw new TypeError("Plugin note delete requires a note id.");
      const permanent = payload?.permanent === true;
      if (permanent) {
        const trashed = state.trash.find((item) => item.id === payload.id);
        if (!trashed) throw new Error("Only a note already in Trash can be permanently deleted.");
        if (!window.confirm(`Permanently delete “${trashed.title.trim() || "Untitled note"}”? This cannot be undone.`)) {
          return false;
        }
      }
      return deleteNote(payload.id, { permanent });
    }
    if (capability === "editor:write") {
      if (typeof payload?.text !== "string" || payload.text.length > 5_000) {
        throw new TypeError("Plugin editor insertion must be text under 5 KB.");
      }
      if (!currentNote()) createNote();
      const start = ui.noteBody.selectionStart;
      const end = ui.noteBody.selectionEnd;
      ui.noteBody.setRangeText(payload.text, start, end, "end");
      ui.noteBody.dispatchEvent(new Event("input", { bubbles: true }));
      ui.noteBody.focus();
      return true;
    }
    if (capability === "ui:notify") {
      if (typeof payload?.message !== "string" || payload.message.length > 200) {
        throw new TypeError("Plugin notifications must be text under 200 characters.");
      }
      showToast(payload.message);
      return true;
    }
    if (capability === "ui:status") {
      const action = payload?.action;
      if (action === "clear") {
        if (typeof payload?.id !== "string" || !payload.id) throw new TypeError("Plugin status item needs an id.");
        extensionStatusItems.delete(`${plugin.manifest.id}:${payload.id}`);
        renderEditorStatus();
        return true;
      }
      if (action === "set") {
        const item = payload?.item;
        if (!item || typeof item !== "object" || Array.isArray(item) ||
          typeof item.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) ||
          typeof item.text !== "string" || !item.text.trim() || item.text.length > 80) {
          throw new TypeError("Plugin status item needs an id and text under 80 characters.");
        }
        extensionStatusItems.set(`${plugin.manifest.id}:${item.id}`, {
          pluginId: plugin.manifest.id,
          id: item.id,
          text: item.text.trim()
        });
        renderEditorStatus();
        return true;
      }
      throw new TypeError("Unknown plugin status action.");
    }
    if (capability === "commands:register") {
      const command = payload;
      if (!command || typeof command.id !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.id) || command.id.length > 50 ||
        typeof command.name !== "string" || !command.name.trim() || command.name.length > 80 ||
        typeof command.description !== "string" || command.description.length > 180) {
        throw new TypeError("Plugin command metadata is invalid.");
      }
      const key = `${plugin.manifest.id}:${command.id}`;
      if (extensionCommands.has(key)) throw new Error("Plugin command id is already registered.");
      const sandbox = activeExtensions.get(plugin.manifest.id);
      if (!sandbox) throw new Error("Plugin sandbox is not active.");
      extensionCommands.set(key, {
        id: `extension-${key}`,
        name: command.name.trim(),
        description: command.description.trim(),
        pluginId: plugin.manifest.id,
        run: () => sandbox.invoke(command.id)
      });
      if (!ui.commandsModal.hidden) renderCommands();
      return { registered: true };
    }
    if (capability === "settings:read") {
      if (typeof payload?.key !== "string" || payload.key.length > 80) throw new TypeError("Plugin setting key is invalid.");
      return Object.hasOwn(plugin.settings, payload.key) ? copyPluginValue(plugin.settings[payload.key]) : payload.fallback ?? null;
    }
    if (capability === "settings:write") {
      if (typeof payload?.key !== "string" || !payload.key || payload.key.length > 80) throw new TypeError("Plugin setting key is invalid.");
      plugin.settings[payload.key] = copyPluginValue(payload.value);
      persistWorkspace();
      return true;
    }
    // Phase 1 (audit C3) — folders, databases, canvas, templates, export.
    // All delegate to the same domain functions the built-in host API uses.
    if (capability === "folders:read") {
      if (payload?.action === "list") return state.folders.map((folder) => ({ ...folder }));
      throw new TypeError("Unknown folder-read action.");
    }
    if (capability === "folders:write") {
      const action = payload?.action;
      if (action === "create") {
        if (typeof payload?.name !== "string") throw new TypeError("Folder creation needs a name.");
        const folder = createFolderRecord(payload.name);
        persistWorkspace();
        render();
        return folder;
      }
      if (action === "rename") {
        if (typeof payload?.id !== "string" || typeof payload?.name !== "string") {
          throw new TypeError("Folder rename needs an id and a name.");
        }
        const folder = renameFolderRecord(payload.id, payload.name);
        persistWorkspace();
        render();
        return folder;
      }
      if (action === "delete") {
        if (typeof payload?.id !== "string") throw new TypeError("Folder deletion needs an id.");
        const folder = deleteFolderRecord(payload.id);
        persistWorkspace();
        render();
        return folder;
      }
      throw new TypeError("Unknown folder-write action.");
    }
    if (capability === "databases:read") {
      if (payload?.action === "list") return listDatabaseTables();
      if (payload?.action === "rows") {
        if (typeof payload?.tableId !== "string") throw new TypeError("Database rows need a table id.");
        return readDatabaseRows(payload.tableId);
      }
      throw new TypeError("Unknown database-read action.");
    }
    if (capability === "databases:write") {
      if (payload?.action === "add-row") {
        if (typeof payload?.tableId !== "string") throw new TypeError("Adding a row needs a table id.");
        return addDatabaseRow(payload.tableId, payload?.values ?? {});
      }
      if (payload?.action === "update-row") {
        if (typeof payload?.tableId !== "string" || typeof payload?.rowId !== "string") {
          throw new TypeError("Updating a row needs a table id and a row id.");
        }
        return updateDatabaseRow(payload.tableId, payload.rowId, payload?.values ?? {});
      }
      throw new TypeError("Unknown database-write action.");
    }
    if (capability === "canvas:read") {
      if (payload?.action === "list") {
        return state.canvases.map((board) => ({
          id: board.id, name: board.name, nodes: board.nodes.length, edges: board.edges.length
        }));
      }
      throw new TypeError("Unknown canvas-read action.");
    }
    if (capability === "templates:read") {
      if (payload?.action === "list") return state.templates.map((template) => ({ ...template }));
      throw new TypeError("Unknown template-read action.");
    }
    if (capability === "export:note") {
      if (payload?.action === "note-markdown") {
        const target = typeof payload?.id === "string"
          ? state.notes.find((note) => note.id === payload.id) ?? null
          : currentNote();
        if (!target) throw new Error("The note to export no longer exists.");
        return exportNoteMarkdown(target);
      }
      if (payload?.action === "markdown-zip") return exportMarkdownZip();
      throw new TypeError("Unknown export action.");
    }
    // Phase 1 (audit C1/C4) — connector tier: gated host-side fetch and the
    // encrypted credential store. The sandboxed tier never reaches these:
    // the sandbox rejects connector permissions at validation time, and the
    // host double-checks the tier + grants here.
    if (capability === "network:fetch") {
      if (plugin.manifest.tier !== "connector") {
        throw new Error("Only connector-tier plugins can use network:fetch.");
      }
      return connectorFetch(plugin, payload);
    }
    if (capability === "credentials:set" || capability === "credentials:get" || capability === "credentials:delete") {
      if (plugin.manifest.tier !== "connector") {
        throw new Error("Only connector-tier plugins can use the credential store.");
      }
      return connectorCredential(plugin, capability, payload);
    }
    throw new Error("Unknown plugin capability.");
  }

  // Connector fetch: the HOST performs the request; the worker never
  // touches the network. Enforced here: connector tier (checked by the
  // caller), grant + declared permission (checked by the caller), exact
  // origin match against individually approved origins, https only, 10 s
  // timeout, 1 MB response cap.
  async function connectorFetch(plugin, payload) {
    const url = payload?.url;
    if (typeof url !== "string" || !url) throw new TypeError("Connector fetch needs a URL.");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError("Connector fetch URL is invalid.");
    }
    if (parsed.protocol !== "https:") throw new TypeError("Connector fetches must use https.");
    const approved = (plugin.approvedOrigins ?? []).includes(parsed.origin);
    if (!approved) {
      throw new Error(`Origin ${parsed.origin} is not approved for “${plugin.manifest.name}”. Approve it in the plugin review queue.`);
    }
    const options = payload?.options ?? {};
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
      throw new TypeError("Connector fetch method is not supported.");
    }
    const headers = {};
    if (options.headers && typeof options.headers === "object" && !Array.isArray(options.headers)) {
      const entries = Object.entries(options.headers).slice(0, 20);
      for (const [name, value] of entries) {
        if (typeof name !== "string" || typeof value !== "string") continue;
        if (["host", "content-length", "connection"].includes(name.toLocaleLowerCase())) continue;
        headers[name] = value.slice(0, 4000);
      }
    }
    let body;
    if (options.body !== undefined) {
      if (typeof options.body !== "string" || options.body.length > 100_000) {
        throw new TypeError("Connector request bodies must be text under 100 KB.");
      }
      body = options.body;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response;
    try {
      response = await fetch(parsed.toString(), { method, headers, body, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Connector fetch timed out after 10 seconds.");
      throw new Error(`Connector fetch failed: ${String(error.message || error).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 1_048_576) {
      throw new Error("Connector response exceeds the 1 MB limit and was discarded.");
    }
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers?.get?.("content-type") ?? null,
      body: new TextDecoder().decode(buffer)
    };
  }

  // Connector credentials: per-plugin secrets, encrypted with the workspace
  // passphrase envelope. Values never appear in the plaintext workspace
  // blob and are never logged. Locked storage fails honestly — plaintext is
  // never stored as a fallback.
  async function connectorCredential(plugin, capability, payload) {
    const key = payload?.key;
    window.xPinCredentials.validateSecretKey(key);
    const pluginId = plugin.manifest.id;
    const store = state.connectorCredentials[pluginId] ?? {};
    if (capability === "credentials:set") {
      if (typeof payload?.value !== "string") throw new TypeError("Credential values must be text.");
      const envelope = await window.xPinCredentials.encryptSecret(payload.value);
      store[key] = envelope;
      state.connectorCredentials[pluginId] = store;
      persistWorkspace();
      return true;
    }
    if (capability === "credentials:get") {
      const envelope = store[key];
      if (!envelope) return null;
      return window.xPinCredentials.decryptSecret(envelope);
    }
    // credentials:delete
    if (store[key]) {
      delete store[key];
      if (Object.keys(store).length) state.connectorCredentials[pluginId] = store;
      else delete state.connectorCredentials[pluginId];
      persistWorkspace();
    }
    return true;
  }

  async function startExtension(plugin) {
    if (activeExtensions.has(plugin.manifest.id)) return;
    if (plugin.reviewStatus && plugin.reviewStatus !== "approved") {
      throw new Error(`"${plugin.manifest.name}" has not been approved yet. Review it in the plugin catalogue first.`);
    }
    // Defense in depth: an approved plugin must never run with capabilities it
    // did not declare. Grants are sanitized on load and on approval, so reaching
    // here with a mismatch means the approval is stale — send it back to review.
    const revoked = plugin.grants.filter((grant) => !plugin.manifest.permissions.includes(grant));
    if (revoked.length) {
      plugin.enabled = false;
      plugin.grants = [];
      plugin.approvedHash = null;
      plugin.reviewStatus = "pending";
      plugin.reviewReason = "Its approved capabilities changed since review.";
      plugin.reviewedAt = null;
      persistWorkspace();
      renderPluginManager();
      throw new Error(`"${plugin.manifest.name}" was sent back for review because its approved capabilities changed.`);
    }
    const sandbox = window.xPinSandbox.create({
      plugin,
      permissions: plugin.grants,
      onRequest: (capability, payload) => handleExtensionRequest(plugin, capability, payload),
      onWarning(warning) {
        showToast(`${plugin.manifest.name}: ${warning.message}`);
      },
      onError(error) {
        console.error(`Imported xPin plugin "${plugin.manifest.name}" stopped.`, error);
        plugin.enabled = false;
        activeExtensions.delete(plugin.manifest.id);
        removeExtensionCommands(plugin.manifest.id);
        removeExtensionStatusItems(plugin.manifest.id);
        persistWorkspace();
        renderPluginManager();
        showToast(`${plugin.manifest.name} stopped: ${error.message}`);
      }
    });
    activeExtensions.set(plugin.manifest.id, sandbox);
    try {
      await sandbox.start();
    } catch (error) {
      activeExtensions.delete(plugin.manifest.id);
      removeExtensionCommands(plugin.manifest.id);
      throw error;
    }
  }

  async function startSavedExtensions() {
    let updated = false;
    for (const plugin of state.extensions) {
      if (!plugin.enabled) continue;
      if (plugin.reviewStatus === "rejected") {
        plugin.enabled = false;
        updated = true;
        continue;
      }
      const actualHash = await window.xPinSandbox.digestPackage(plugin);
      if (!actualHash || actualHash !== plugin.sha256 || actualHash !== plugin.approvedHash) {
        plugin.enabled = false;
        plugin.grants = [];
        plugin.approvedHash = null;
        plugin.reviewStatus = "pending";
        plugin.reviewReason = "Its package changed since approval.";
        plugin.reviewedAt = null;
        updated = true;
        showToast(`${plugin.manifest.name} needs permission review because its package changed.`);
        continue;
      }
      try {
        await startExtension(plugin);
      } catch (error) {
        plugin.enabled = false;
        updated = true;
        console.error(`Could not start imported plugin "${plugin.manifest.name}".`, error);
        showToast(error.message || `${plugin.manifest.name} could not start. Review its package and permissions.`);
      }
    }
    if (updated) persistWorkspace();
    renderPluginManager();
  }

  async function importPluginFile(file) {
    if (!file) return;
    if (file.size > window.xPinSandbox.maxPackageBytes) {
      throw new TypeError(`Plugin package must be smaller than ${window.xPinSandbox.maxPackageBytes / 1000} KB. This file is ${Math.round(file.size / 1000)} KB.`);
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      throw new TypeError(`"${file.name}" is not valid JSON, so it can't be a plugin package.`);
    }
    await importPluginPackage(parsed, file.name);
  }

  // Shared core for local file imports AND marketplace installs: validate a
  // parsed package and stage it in the Pending review queue. Nothing runs
  // until the owner reviews and approves it in the Plugins catalogue.
  async function importPluginPackage(parsed, fileName, provenance, { update = false } = {}) {
    const plugin = window.xPinSandbox.validatePackage(parsed);
    const clash = state.extensions.find((item) => item.manifest.id === plugin.manifest.id);
    if (pluginManager.plugins().some((item) => item.id === plugin.manifest.id)) {
      throw new Error(`"${plugin.manifest.name}" clashes with a built-in xPin feature id. Pick a different plugin id.`);
    }
    if (clash && !update) {
      throw new Error(`"${clash.manifest.name}" v${clash.manifest.version} is already installed. Remove it first to import v${plugin.manifest.version}.`);
    }
    if (clash && update && comparePluginVersions(plugin.manifest.version, clash.manifest.version) <= 0) {
      throw new Error(`"${clash.manifest.name}" v${clash.manifest.version} is already installed — v${plugin.manifest.version} is not newer.`);
    }
    const sha256 = await window.xPinSandbox.digestPackage(plugin);
    if (!sha256) throw new Error("This browser cannot calculate a package fingerprint, so the plugin was not installed.");
    if (clash && update) {
      // Phase 1 (audit C6): an update REPLACES the installed record and
      // sends it back through the review queue — the old version stops
      // running until the new package is approved (changed package →
      // re-review, as today). The running sandbox is stopped first.
      disableExtension(clash);
      state.extensions = state.extensions.filter((item) => item.manifest.id !== clash.manifest.id);
    }
    state.extensions.push({
      ...plugin,
      fileName,
      sha256,
      installedAt: new Date().toISOString(),
      installedFrom: provenance ?? "local file",
      enabled: false,
      approvedHash: null,
      grants: [],
      approvedOrigins: [],
      settings: {},
      reviewStatus: "pending",
      reviewReason: clash && update ? "Updated package — review the new version before it can run." : null,
      reviewedAt: null
    });
    persistWorkspace();
    renderPluginManager();
    showToast(`${plugin.manifest.name} was imported and is waiting for your review.`);
  }

  /* ---------------- Marketplace browser ----------------
     Directories are JSON indexes (see marketplace/index.json). Packages are
     fetched as JSON and staged through importPluginPackage(), so every
     marketplace install lands in the Pending review queue — nothing runs
     until the owner reviews and approves it, exactly like a local import. */
  const MARKETPLACE_DEFAULT_DIR = "https://raw.githubusercontent.com/xfactor21/eXtra/main/marketplace/index.json";
  const MARKETPLACE_CACHE_PREFIX = "xpin.marketplace.cache.";
  // Phase 1 (audit C6): Ed25519 public key (SPKI DER, base64) that verifies
  // marketplace/index.json. The matching private key lives outside the repo
  // (see marketplace/SIGNING.md). window.__xPinMarketplacePublicKey is a
  // TEST-ONLY override the smoke suite uses to sign mock indexes; the app
  // never sets it itself.
  const MARKETPLACE_PUBLIC_KEY_SPKI_B64 = window.__xPinMarketplacePublicKey ??
    "MCowBQYDK2VwAyEAbp+0jHeAGI96yYl8G2hQubegyisqk8oeKtXncDa6A+U=";
  const MARKETPLACE_SIGNATURE_KEY_ID = "xpin-marketplace-1";
  let marketplaceEntries = [];
  let marketplaceNotice = "";

  function marketplaceB64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  // Verify an index's Ed25519 signature (covers the index JSON without the
  // signature fields). A bad/missing signature fails closed: the directory
  // is unusable, never silently trusted.
  async function verifyMarketplaceIndex(index) {
    if (!index || typeof index !== "object" || Array.isArray(index)) {
      return { ok: false, reason: "not a plugin index" };
    }
    if (typeof index.signature !== "string" || !index.signature) {
      return { ok: false, reason: "missing signature" };
    }
    if (index.signatureKeyId && index.signatureKeyId !== MARKETPLACE_SIGNATURE_KEY_ID) {
      return { ok: false, reason: `unknown signing key (${index.signatureKeyId})` };
    }
    if (!globalThis.crypto?.subtle) return { ok: false, reason: "Web Crypto unavailable" };
    try {
      // _cachedAt is local cache metadata added by writeMarketplaceCache;
      // it was not part of the signed payload and is ignored here.
      const { signature, signatureKeyId: _keyId, _cachedAt: _cachedAt, ...rest } = index;
      const subtle = globalThis.crypto.subtle;
      const key = await subtle.importKey(
        "spki",
        marketplaceB64ToBytes(MARKETPLACE_PUBLIC_KEY_SPKI_B64),
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      const ok = await subtle.verify(
        { name: "Ed25519" },
        key,
        marketplaceB64ToBytes(signature),
        new TextEncoder().encode(JSON.stringify(rest))
      );
      return ok ? { ok: true } : { ok: false, reason: "bad signature" };
    } catch (error) {
      return { ok: false, reason: "verification failed" };
    }
  }

  function comparePluginVersions(a, b) {
    const parse = (v) => String(v ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function marketplaceDirList() {
    if (Array.isArray(state.marketplaceDirs) && state.marketplaceDirs.length) return state.marketplaceDirs;
    return [MARKETPLACE_DEFAULT_DIR];
  }

  function setMarketplaceDirs(dirs) {
    state.marketplaceDirs = dirs;
    persistWorkspace();
    renderMarketplaceDirs();
    renderMarketplace();
  }

  function switchPluginTab(tab) {
    const isMarketplace = tab === "marketplace";
    byId("plugin-tab-catalogue").hidden = isMarketplace;
    byId("plugin-tab-marketplace").hidden = !isMarketplace;
    document.querySelectorAll(".plugin-tab").forEach((button) => {
      const active = button.dataset.ptab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (isMarketplace) renderMarketplace();
  }

  function marketplaceCacheKey(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) | 0;
    return `${MARKETPLACE_CACHE_PREFIX}${(hash >>> 0).toString(36)}`;
  }

  function readMarketplaceCache(url) {
    try {
      const parsed = JSON.parse(localStorage.getItem(marketplaceCacheKey(url)));
      if (!parsed || !Array.isArray(parsed.plugins)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeMarketplaceCache(url, index) {
    try {
      localStorage.setItem(marketplaceCacheKey(url), JSON.stringify({ ...index, _cachedAt: new Date().toISOString() }));
    } catch {
      /* cache is best-effort */
    }
  }

  async function fetchMarketplaceIndex(url) {
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
    } catch {
      throw new Error("unreachable");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let index;
    try {
      index = await response.json();
    } catch {
      throw new Error("invalid JSON");
    }
    if (!index || !Array.isArray(index.plugins)) throw new Error("not a plugin index");
    const verification = await verifyMarketplaceIndex(index);
    if (!verification.ok) throw new Error(`unverified index (${verification.reason})`);
    writeMarketplaceCache(url, index);
    return index;
  }

  function resolveMarketplaceUrl(dirUrl, downloadUrl) {
    try {
      return new URL(downloadUrl, dirUrl).toString();
    } catch {
      return downloadUrl;
    }
  }

  function renderMarketplaceDirs() {
    const list = byId("marketplace-dir-list");
    list.replaceChildren();
    marketplaceDirList().forEach((url) => {
      const row = document.createElement("div");
      row.className = "marketplace-dir-row";
      const label = document.createElement("code");
      label.textContent = url;
      label.title = url;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "plugin-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove directory ${url}`);
      remove.addEventListener("click", () => {
        const next = marketplaceDirList().filter((item) => item !== url);
        setMarketplaceDirs(next.length ? next : [MARKETPLACE_DEFAULT_DIR]);
        showToast("Directory removed.");
      });
      row.append(label, remove);
      list.append(row);
    });
  }

  async function renderMarketplace(forceRefresh = false) {
    const status = byId("marketplace-status");
    const list = byId("marketplace-list");
    const query = byId("marketplace-search").value.trim().toLocaleLowerCase();
    renderMarketplaceDirs();
    status.textContent = "Loading directories…";
    list.replaceChildren();
    marketplaceEntries = [];
    const problems = [];
    for (const dirUrl of marketplaceDirList()) {
      let index = null;
      let cached = false;
      const cachedIndex = readMarketplaceCache(dirUrl);
      if (!forceRefresh && cachedIndex) {
        // Tab switches and searches reuse the cache without hitting the
        // network; the refresh button always tries the network first.
        // Cached indexes are verified on every read, not just on fetch.
        const verification = await verifyMarketplaceIndex(cachedIndex);
        if (verification.ok) {
          index = cachedIndex;
          cached = true;
        } else {
          problems.push(`${dirUrl} (cached index unverified: ${verification.reason})`);
        }
      } else {
        try {
          index = await fetchMarketplaceIndex(dirUrl);
        } catch (error) {
          // Offline or unreachable: fall back to the last good index so the
          // directory stays browsable — but only if that copy verifies.
          if (cachedIndex) {
            const verification = await verifyMarketplaceIndex(cachedIndex);
            if (verification.ok) {
              index = cachedIndex;
              cached = true;
            } else {
              problems.push(`${dirUrl} (cached index unverified: ${verification.reason})`);
            }
          } else {
            problems.push(`${dirUrl} (${error.message})`);
            continue;
          }
        }
      }
      for (const plugin of index.plugins) {
        if (!plugin || typeof plugin.id !== "string") continue;
        marketplaceEntries.push({ ...plugin, dirUrl, cached });
      }
    }
    const installed = new Map(state.extensions.map((item) => [item.manifest.id, item.manifest.version]));
    const matches = marketplaceEntries.filter((entry) =>
      !query || `${entry.name} ${entry.description ?? ""} ${entry.id}`.toLocaleLowerCase().includes(query)
    );
    if (problems.length) {
      const unverified = problems.some((problem) => /unverified/.test(problem));
      status.textContent = `Some directories could not be reached: ${problems.join("; ")}.` +
        (unverified ? " Unverified — showing installed plugins only; no installs from unverified directories." : "");
    } else if (matches.length === 0) {
      status.textContent = query ? "No plugins match your search." : "No plugins listed in these directories yet.";
    } else {
      const cachedCount = matches.filter((entry) => entry.cached).length;
      status.textContent = `${matches.length} plugin${matches.length === 1 ? "" : "s"}${cachedCount ? ` (${cachedCount} from offline cache)` : ""}. Every install waits for your review before it can run.`;
    }
    const seen = new Set();
    for (const entry of matches) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const card = document.createElement("article");
      card.className = "marketplace-card";
      const head = document.createElement("div");
      head.className = "marketplace-card-head";
      const name = document.createElement("strong");
      name.textContent = entry.name || entry.id;
      const version = document.createElement("span");
      version.className = "marketplace-version";
      version.textContent = `v${entry.version || "?"}`;
      head.append(name, version);
      const description = document.createElement("p");
      description.textContent = entry.description || "No description.";
      const meta = document.createElement("small");
      meta.className = "marketplace-meta";
      meta.textContent = `${entry.author || "Unknown author"}${entry.cached ? " · offline copy" : ""}`;
      const caps = document.createElement("div");
      caps.className = "marketplace-caps";
      for (const cap of entry.capabilities ?? []) {
        const badge = document.createElement("span");
        badge.className = "marketplace-cap";
        badge.textContent = cap;
        caps.append(badge);
      }
      const actions = document.createElement("div");
      actions.className = "marketplace-card-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "editor-tool-button";
      const installedVersion = installed.get(entry.id);
      const updateAvailable = installedVersion &&
        comparePluginVersions(entry.version, installedVersion) > 0;
      let changelog = null;
      if (installedVersion && !updateAvailable) {
        button.disabled = true;
        button.textContent = `Installed (v${installedVersion})`;
      } else if (updateAvailable) {
        // Phase 1 (audit C6): an available update shows the version +
        // changelog line, and updating routes through the review queue
        // (changed package → re-review, as today).
        button.textContent = `Update available (v${entry.version})`;
        button.addEventListener("click", () => installMarketplacePlugin(entry, { update: true }));
        if (entry.changelog) {
          changelog = document.createElement("small");
          changelog.className = "marketplace-changelog";
          changelog.textContent = entry.changelog;
        }
      } else {
        button.textContent = "Install";
        button.addEventListener("click", () => installMarketplacePlugin(entry));
      }
      actions.append(button);
      card.append(head, description, meta, caps, actions);
      if (changelog) card.append(changelog);
      list.append(card);
    }
    marketplaceNotice = problems.join("; ");
  }

  async function installMarketplacePlugin(entry, { update = false } = {}) {
    const url = resolveMarketplaceUrl(entry.dirUrl, entry.downloadUrl);
    showToast(`Downloading ${entry.name}…`);
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
    } catch {
      showToast("Download failed — check your connection.");
      return;
    }
    if (!response.ok) {
      showToast(`Download failed (HTTP ${response.status}).`);
      return;
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      showToast("Downloaded file is not valid JSON.");
      return;
    }
    try {
      const fileName = url.split("/").pop() || `${entry.id}.xpin.json`;
      await importPluginPackage(parsed, fileName, `marketplace: ${entry.dirUrl}`, { update });
      switchPluginTab("catalogue");
    } catch (error) {
      console.error("Could not install marketplace plugin.", error);
      showToast(error.message || "Plugin could not be installed.");
    }
  }

  function openPluginConsent(plugin) {
    pendingPluginConsent = plugin;
    ui.pluginPermissions.replaceChildren();
    ui.pluginConsentProvenance.textContent =
      `Local package: ${plugin.fileName} · SHA-256 ${plugin.sha256.slice(0, 16)}… · Author is self-reported; this fingerprint is not a signature.` +
      (plugin.manifest.tier === "connector" ? " · Connector tier: network access is host-side only, per approved origin." : "");
    ui.pluginSourceView.textContent = plugin.source;
    plugin.manifest.permissions.forEach((permission) => {
      const label = document.createElement("label");
      label.className = "permission-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = permission;
      checkbox.dataset.permission = permission;
      // Requested capabilities start selected: reviewing means unchecking what
      // the plugin should NOT have. Approving with none selected leaves the
      // plugin unable to do anything, so that choice asks for confirmation.
      checkbox.checked = true;
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = permission;
      const description = document.createElement("small");
      description.textContent = window.xPinSandbox.permissions[permission];
      text.append(name, description);
      label.append(checkbox, text);
      ui.pluginPermissions.append(label);
    });
    // Phase 1 — connector origins: each declared origin is approved
    // individually, in the same review (pre-checked like capabilities;
    // uncheck any origin the plugin should not reach). Revocation later
    // removes it from approvedOrigins and takes effect immediately.
    if (plugin.manifest.tier === "connector" && (plugin.manifest.networkOrigins ?? []).length) {
      const heading = document.createElement("p");
      heading.className = "consent-origins-heading";
      heading.textContent = "Network origins — approve each one separately. The plugin can only fetch from approved origins, over https.";
      ui.pluginPermissions.append(heading);
      plugin.manifest.networkOrigins.forEach((origin) => {
        const label = document.createElement("label");
        label.className = "permission-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = origin;
        checkbox.dataset.origin = origin;
        checkbox.checked = true;
        const text = document.createElement("span");
        const name = document.createElement("strong");
        name.textContent = origin;
        const description = document.createElement("small");
        description.textContent = "Host-side fetch only: 10 s timeout, 1 MB response cap.";
        text.append(name, description);
        label.append(checkbox, text);
        ui.pluginPermissions.append(label);
      });
    }
    ui.pluginTrustCheckbox.checked = false;
    ui.allowPluginButton.disabled = true;
    ui.pluginRejectRow.hidden = true;
    ui.pluginRejectReason.value = "";
    ui.pluginConsentStatus.textContent = plugin.manifest.permissions.length
      ? "Requested capabilities are pre-selected. Uncheck anything this plugin should not have."
      : "This plugin requested no xPin capabilities.";
    ui.pluginConsentModal.hidden = false;
    document.body.classList.add("modal-open");
    byId("cancel-plugin-consent").focus();
  }

  function closePluginConsent() {
    ui.pluginConsentModal.hidden = true;
    pendingPluginConsent = null;
    syncModalOpenClass();
    byId("open-plugins").focus();
  }

  async function approvePendingPlugin() {
    const plugin = pendingPluginConsent;
    if (!plugin || !ui.pluginTrustCheckbox.checked) return;
    const granted = [...ui.pluginPermissions.querySelectorAll("[data-permission]:checked")]
      .map((checkbox) => checkbox.dataset.permission)
      .filter((permission) => plugin.manifest.permissions.includes(permission));
    if (!granted.length && plugin.manifest.permissions.length) {
      const proceed = window.confirm(
        `"${plugin.manifest.name}" asked for ${plugin.manifest.permissions.length} ` +
        `capabilities and you granted none. It probably won't work. Approve anyway?`
      );
      if (!proceed) return;
    }
    plugin.grants = granted;
    // Phase 1 — approved origins are whatever the reviewer left checked.
    plugin.approvedOrigins = [...ui.pluginPermissions.querySelectorAll("[data-origin]:checked")]
      .map((checkbox) => checkbox.dataset.origin)
      .filter((origin) => (plugin.manifest.networkOrigins ?? []).includes(origin));
    plugin.approvedHash = plugin.sha256;
    plugin.enabled = true;
    plugin.reviewStatus = "approved";
    plugin.reviewReason = null;
    plugin.reviewedAt = new Date().toISOString();
    closePluginConsent();
    try {
      await startExtension(plugin);
      persistWorkspace();
      renderPluginManager();
      showToast(`${plugin.manifest.name} is approved with ${plugin.grants.length} granted ${plugin.grants.length === 1 ? "capability" : "capabilities"}.`);
    } catch (error) {
      plugin.enabled = false;
      persistWorkspace();
      renderPluginManager();
      console.error(`Could not enable imported plugin "${plugin.manifest.name}".`, error);
      showToast(`${plugin.manifest.name} could not start: ${error.message}`);
    }
  }

  function rejectPendingPlugin() {
    const plugin = pendingPluginConsent;
    if (!plugin) return;
    const reason = ui.pluginRejectReason.value.trim();
    if (!reason) {
      ui.pluginConsentStatus.textContent = "Add a short reason so you remember why this package was rejected.";
      ui.pluginRejectReason.focus();
      return;
    }
    plugin.reviewStatus = "rejected";
    plugin.reviewReason = reason.slice(0, 200);
    plugin.reviewedAt = new Date().toISOString();
    plugin.enabled = false;
    plugin.grants = [];
    plugin.approvedOrigins = [];
    plugin.approvedHash = null;
    closePluginConsent();
    persistWorkspace();
    renderPluginManager();
    showToast(`${plugin.manifest.name} was rejected and will not run.`);
  }

  function disableExtension(plugin) {
    const sandbox = activeExtensions.get(plugin.manifest.id);
    activeExtensions.delete(plugin.manifest.id);
    plugin.enabled = false;
    sandbox?.stop();
    removeExtensionCommands(plugin.manifest.id);
    removeExtensionStatusItems(plugin.manifest.id);
    persistWorkspace();
    renderPluginManager();
  }

  function uninstallExtension(plugin) {
    if (!window.confirm(`Remove "${plugin.manifest.name}" and its saved settings from this device?`)) return;
    disableExtension(plugin);
    state.extensions = state.extensions.filter((item) => item.manifest.id !== plugin.manifest.id);
    persistWorkspace();
    renderPluginManager();
    showToast(`${plugin.manifest.name} was removed.`);
  }

  function renderPluginManager() {
    ui.pluginList.replaceChildren();
    const query = ui.pluginSearch.value.trim().toLocaleLowerCase();
    const category = ui.pluginCategory.value;
    const matches = (item) => {
      const haystack = `${item.name} ${item.description} ${item.category} ${item.id ?? ""} ${item.author ?? ""}`.toLocaleLowerCase();
      return (!query || haystack.includes(query)) && (category === "all" || category === item.category);
    };
    const plugins = (pluginManager?.plugins() ?? []).filter(matches);
    plugins.forEach((plugin) => {
      const row = document.createElement("article");
      row.className = "plugin-row";
      const details = document.createElement("div");
      details.className = "plugin-row-details";
      const name = document.createElement("strong");
      name.textContent = plugin.name;
      const description = document.createElement("p");
      description.textContent = plugin.description;
      const version = document.createElement("small");
      version.textContent = `${plugin.category.toLocaleUpperCase()} · BUILT-IN · v${plugin.version}`;
      details.append(name, description, version);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `plugin-toggle${plugin.active ? " is-enabled" : ""}`;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(plugin.active));
      toggle.setAttribute("aria-label", `${plugin.active ? "Disable" : "Enable"} ${plugin.name}`);
      toggle.disabled = !plugin.active && plugin.enabled;
      toggle.innerHTML = `<span></span>`;
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await pluginManager.setEnabled(plugin.id, !plugin.active);
          if (plugin.id === "tags" && plugin.active) {
            state.tagFilter = null;
            persistWorkspace();
          }
          renderPluginManager();
          render();
          [...ui.pluginList.querySelectorAll(".plugin-toggle")].find((item) =>
            item.getAttribute("aria-label") === `${plugin.active ? "Enable" : "Disable"} ${plugin.name}`
          )?.focus();
        } catch (error) {
          console.error(`Could not change plugin "${plugin.name}" state.`, error);
          showToast(`${plugin.name} could not be ${plugin.active ? "disabled" : "enabled"}.`);
          renderPluginManager();
        }
      });
      row.append(details, toggle);
      ui.pluginList.append(row);
    });
    const statusWeight = { pending: 0, approved: 1, rejected: 2 };
    const extensions = state.extensions.map((sourcePlugin) => ({
      sourcePlugin,
      id: sourcePlugin.manifest.id,
      name: sourcePlugin.manifest.name,
      description: sourcePlugin.manifest.description,
      author: sourcePlugin.manifest.author,
      category: "Imported",
      reviewStatus: sourcePlugin.reviewStatus === "rejected" ? "rejected"
        : sourcePlugin.reviewStatus === "approved" ? "approved" : "pending"
    })).filter(matches)
      .sort((a, b) => (statusWeight[a.reviewStatus] ?? 1) - (statusWeight[b.reviewStatus] ?? 1));
    extensions.forEach((plugin) => {
      const { sourcePlugin } = plugin;
      const active = activeExtensions.has(plugin.id);
      const row = document.createElement("article");
      row.className = "plugin-row imported-plugin-row";
      const details = document.createElement("div");
      details.className = "plugin-row-details";
      const name = document.createElement("strong");
      name.textContent = plugin.name;
      const status = document.createElement("span");
      status.className = `plugin-review-pill is-${plugin.reviewStatus}`;
      status.textContent = plugin.reviewStatus === "pending" ? "Pending review"
        : plugin.reviewStatus === "approved" ? "Approved" : "Rejected";
      const titleLine = document.createElement("div");
      titleLine.className = "plugin-title-line";
      titleLine.append(name, status);
      const description = document.createElement("p");
      description.textContent = plugin.description;
      const provenance = document.createElement("small");
      provenance.textContent = `${(sourcePlugin.installedFrom ?? "local file").toUpperCase()} · v${sourcePlugin.manifest.version} · ${sourcePlugin.manifest.author} · SHA-256 ${sourcePlugin.sha256.slice(0, 12)}…`;
      const permissions = document.createElement("small");
      permissions.className = "plugin-permissions-summary";
      permissions.textContent = active
        ? `GRANTED: ${sourcePlugin.grants.length ? sourcePlugin.grants.join(", ") : "no capabilities"}`
        : `REQUESTED: ${sourcePlugin.manifest.permissions.length ? sourcePlugin.manifest.permissions.join(", ") : "no capabilities"}`;
      details.append(titleLine, description, provenance, permissions);
      if (sourcePlugin.reviewReason) {
        const reason = document.createElement("small");
        reason.className = "plugin-review-reason";
        reason.textContent = plugin.reviewStatus === "rejected"
          ? `Rejected: ${sourcePlugin.reviewReason}`
          : sourcePlugin.reviewReason;
        details.append(reason);
      }
      // Phase 1 — connector origins: approved origins are listed with a
      // per-origin Revoke button. Revocation removes the origin from the
      // stored record and takes effect immediately (the host checks the
      // live list on every network:fetch).
      if (sourcePlugin.manifest.tier === "connector") {
        const tierNote = document.createElement("small");
        tierNote.className = "plugin-tier-note";
        tierNote.textContent = "CONNECTOR TIER · network access is host-side only";
        details.append(tierNote);
        (sourcePlugin.approvedOrigins ?? []).forEach((origin) => {
          const originRow = document.createElement("div");
          originRow.className = "plugin-origin-row";
          const label = document.createElement("small");
          label.textContent = `Approved origin: ${origin}`;
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "plugin-remove";
          revoke.textContent = "Revoke";
          revoke.setAttribute("aria-label", `Revoke network access to ${origin} for ${plugin.name}`);
          revoke.addEventListener("click", () => {
            sourcePlugin.approvedOrigins = (sourcePlugin.approvedOrigins ?? [])
              .filter((item) => item !== origin);
            persistWorkspace();
            renderPluginManager();
            showToast(`Network access to ${origin} revoked for ${plugin.name}.`);
          });
          originRow.append(label, revoke);
          details.append(originRow);
        });
      }
      const actions = document.createElement("div");
      actions.className = "imported-plugin-actions";
      if (plugin.reviewStatus === "pending") {
        const review = document.createElement("button");
        review.type = "button";
        review.className = "plugin-review-button";
        review.textContent = "Review";
        review.setAttribute("aria-label", `Review ${plugin.name}`);
        review.addEventListener("click", () => openPluginConsent(sourcePlugin));
        actions.append(review);
      } else if (plugin.reviewStatus === "approved") {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = `plugin-toggle${active ? " is-enabled" : ""}`;
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", String(active));
        toggle.setAttribute("aria-label", `${active ? "Disable" : "Enable"} ${plugin.name}`);
        toggle.innerHTML = `<span></span>`;
        toggle.addEventListener("click", async () => {
          if (active) {
            disableExtension(sourcePlugin);
            return;
          }
          toggle.disabled = true;
          try {
            await startExtension(sourcePlugin);
            sourcePlugin.enabled = true;
            persistWorkspace();
            renderPluginManager();
            showToast(`${plugin.name} is enabled.`);
          } catch (error) {
            sourcePlugin.enabled = false;
            persistWorkspace();
            renderPluginManager();
            console.error(`Could not enable imported plugin "${plugin.name}".`, error);
            showToast(error.message || `${plugin.name} could not start.`);
          }
        });
        actions.append(toggle);
      } else {
        const rereview = document.createElement("button");
        rereview.type = "button";
        rereview.className = "plugin-review-button";
        rereview.textContent = "Re-review";
        rereview.setAttribute("aria-label", `Re-review ${plugin.name}`);
        rereview.addEventListener("click", () => {
          sourcePlugin.reviewStatus = "pending";
          sourcePlugin.reviewReason = null;
          sourcePlugin.reviewedAt = null;
          persistWorkspace();
          renderPluginManager();
          openPluginConsent(sourcePlugin);
        });
        actions.append(rereview);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "plugin-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => uninstallExtension(sourcePlugin));
      actions.append(remove);
      row.append(details, actions);
      ui.pluginList.append(row);
    });
    if (plugins.length + extensions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "plugin-empty";
      empty.textContent = query || category !== "all"
        ? "No features match these filters."
        : "No features are available.";
      ui.pluginList.append(empty);
    }
    const enabled = (pluginManager?.plugins() ?? []).filter((plugin) => plugin.active).length + activeExtensions.size;
    ui.pluginCount.textContent = `${enabled} ${enabled === 1 ? "feature" : "features"} enabled`;
  }

  function openPluginManager() {
    renderPluginManager();
    ui.pluginsModal.hidden = false;
    document.body.classList.add("modal-open");
    byId("open-plugins").setAttribute("aria-expanded", "true");
    ui.pluginsModal.querySelector(".dialog-close").focus();
  }

  function closeDialog(dialog) {
    dialog.hidden = true;
    syncModalOpenClass();
    if (dialog === ui.pluginsModal) {
      byId("open-plugins").setAttribute("aria-expanded", "false");
      byId("open-plugins").focus();
    } else {
      byId("open-commands").setAttribute("aria-expanded", "false");
      byId("open-commands").focus();
    }
  }

  function renderCommands() {
    const query = ui.commandSearch.value.trim().toLocaleLowerCase();
    const commands = availableCommands().filter((command) =>
      `${command.name} ${command.description ?? ""}`.toLocaleLowerCase().includes(query)
    );
    activeCommandIndex = Math.min(activeCommandIndex, Math.max(0, commands.length - 1));
    ui.commandList.replaceChildren();
    if (commands.length === 0) {
      const empty = document.createElement("p");
      empty.className = "command-empty";
      empty.textContent = "No matching actions.";
      ui.commandList.append(empty);
      return;
    }
    commands.forEach((command, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `command-option${index === activeCommandIndex ? " is-active" : ""}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === activeCommandIndex));
      const name = document.createElement("strong");
      name.textContent = command.name;
      const description = document.createElement("small");
      description.textContent = command.description ?? "";
      button.append(name, description);
      button.addEventListener("mouseenter", () => {
        activeCommandIndex = index;
        renderCommands();
      });
      button.addEventListener("click", () => runCommand(command));
      ui.commandList.append(button);
    });
  }

  async function runCommand(command) {
    closeDialog(ui.commandsModal);
    try {
      await command.run();
    } catch (error) {
      console.error(`xPin command "${command.name}" failed.`, error);
      // Phase 1: surface the reason, not just a generic failure — a
      // rejected connector fetch (or any capability refusal) must be
      // visible to the user instead of silent.
      showToast(`${command.name} could not be completed: ${String(error.message || error).slice(0, 200)}`);
    }
  }

  function setupSlashMenuKeyboard() {
    document.addEventListener("keydown", (event) => {
      const menu = document.querySelector(".slash-command-menu");
      if (!menu || menu.hidden) return;
      const options = [...menu.querySelectorAll(".slash-command-option")];
      if (!options.length) return;
      const editor = byId("note-body");
      const active = document.activeElement;
      if (active !== editor && !menu.contains(active)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const current = options.indexOf(active);
        const next = event.key === "ArrowDown"
          ? options[(current + 1) % options.length]
          : options[(current - 1 + options.length) % options.length];
        next.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        menu.hidden = true;
        editor.focus();
      }
    }, true);
  }

  function openShortcutsDialog() {
    if (!shortcutsDialog) {
      const isMac = navigator.platform.toLocaleLowerCase().includes("mac");
      const mod = isMac ? "⌘" : "Ctrl";
      const rows = [
        [[`${mod} P`], "Open the command palette"],
        [[`${mod} K`], "Search your notes"],
        [[`${mod} Shift C`], "Quick capture to today's note"],
        [["N"], "New note"],
        [["/"], "Focus the search box"],
        [["?"], "Open this shortcuts reference"],
        [["↑", "↓", "Enter"], "Move through the command palette and the slash menu"],
        [["Esc"], "Close dialogs, menus, and the connection editor"],
        [["Delete"], "Remove the selected canvas card (asks first)"],
        [["Enter", "Space"], "Select the focused canvas card"],
        [["←", "→", "↑", "↓"], "Nudge the focused canvas card (Shift: bigger steps · Alt: resize)"]
      ];
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.id = "shortcuts-modal";
      backdrop.hidden = true;
      const dialog = document.createElement("section");
      dialog.className = "dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "shortcuts-title");
      dialog.style.maxWidth = "440px";
      const header = document.createElement("header");
      header.className = "dialog-header";
      header.innerHTML = '<div><div class="dialog-kicker">REFERENCE</div><h2 id="shortcuts-title">Keyboard shortcuts</h2></div>';
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "icon-button dialog-close";
      closeButton.setAttribute("aria-label", "Close keyboard shortcuts");
      closeButton.textContent = "×";
      closeButton.addEventListener("click", closeShortcutsDialog);
      header.append(closeButton);
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:4px 0 12px;";
      rows.forEach(([keys, description]) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:12px;padding:7px 4px;border-bottom:1px solid rgba(255,255,255,.05);";
        const keyWrap = document.createElement("span");
        keyWrap.style.cssText = "display:flex;gap:4px;min-width:128px;flex-wrap:wrap;";
        keys.forEach((key) => {
          const kbd = document.createElement("kbd");
          kbd.textContent = key;
          keyWrap.append(kbd);
        });
        const label = document.createElement("span");
        label.style.color = "var(--muted)";
        label.textContent = description;
        row.append(keyWrap, label);
        list.append(row);
      });
      const footer = document.createElement("footer");
      footer.className = "dialog-footer";
      const hint = document.createElement("span");
      hint.textContent = "Press ? anywhere to reopen this.";
      const done = document.createElement("button");
      done.type = "button";
      done.className = "dialog-done";
      done.textContent = "Done";
      done.addEventListener("click", closeShortcutsDialog);
      footer.append(hint, done);
      dialog.append(header, list, footer);
      backdrop.append(dialog);
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) closeShortcutsDialog();
      });
      document.querySelector(".app-shell")?.append(backdrop);
      shortcutsDialog = backdrop;
    }
    shortcutsDialog.hidden = false;
    document.body.classList.add("modal-open");
    shortcutsDialog.querySelector(".dialog-close").focus();
  }

  function closeShortcutsDialog() {
    if (!shortcutsDialog) return;
    shortcutsDialog.hidden = true;
    syncModalOpenClass();
    byId("open-shortcuts")?.focus();
  }

  function registerCoreCommands() {
    const core = [
      {
        id: "core-quick-capture",
        name: "Quick capture to today's note",
        description: "Append a timestamped line to today's note without leaving your place",
        run: () => openQuickCaptureDialog()
      },
      {
        id: "core-new-from-template",
        name: "New note from template…",
        description: "Pick a template and create a note from it",
        run: () => openTemplatePickerDialog()
      },
      {
        id: "core-open-daily",
        name: "Open today's note",
        description: "Open or create the daily note",
        run: () => openDailyNote()
      },
      {
        id: "core-new-meeting",
        name: "New meeting note",
        description: "Create a meeting note from the template, linked to today",
        run: () => createMeetingNote()
      },
      {
        id: "core-capture-smarts",
        name: "Capture & smarts",
        description: "Voice memos, read-later, flashcards, highlights, imports, AI assists",
        run: () => openPhase2View("capture")
      },
      {
        id: "core-review-flashcards",
        name: "Review flashcards",
        description: "Review due FSRS flashcards",
        run: () => openPhase2View("flashcards")
      },
      {
        id: "core-read-later",
        name: "Open Read Later",
        description: "Open the read-it-later inbox",
        run: () => openPhase2View("readlater")
      },
      {
        id: "core-shortcuts",
        name: "Keyboard shortcuts",
        description: "Open the shortcuts reference",
        run: () => openShortcutsDialog()
      }
    ];
    core.forEach((command) => {
      if (!extensionCommands.has(command.id)) {
        extensionCommands.set(command.id, { ...command, pluginId: "core" });
      }
    });
  }

  function openCommandPalette() {
    if (!pluginManager?.isEnabled("command-palette")) {
      showToast("Enable the Command palette plugin to use commands.");
      return;
    }
    ui.commandsModal.hidden = false;
    document.body.classList.add("modal-open");
    byId("open-commands").setAttribute("aria-expanded", "true");
    ui.commandSearch.value = "";
    activeCommandIndex = 0;
    renderCommands();
    ui.commandSearch.focus();
  }

  function render() {
    renderList();
    renderEditor();
    renderPluginPanels();
    renderEditorStatus();
    updateStorageIndicator();
    if (state.view === "canvas") renderCanvas();
    featureSuite?.render();
    renderCoreToolsSections();
    // Phase 2 — week strip + sidebar counts (read-later unread, due cards).
    phase2UI?.renderDailyStrip();
    // Phase 3 — sidebar sections, comments, reminders, power view.
    phase3UI?.renderAll();
    const unread = state.readLater.filter((item) => !item.read).length;
    const readLaterCount = byId("readlater-count");
    if (readLaterCount) readLaterCount.textContent = String(unread);
    const dueCount = byId("flashcards-due-count");
    if (dueCount && window.xPinPhase2?.flashcardCounts) {
      dueCount.textContent = String(window.xPinPhase2.flashcardCounts(state.flashcards).due);
    }
  }

  // Phase 2 — Capture & smarts panel (voice, read-later, flashcards,
  // highlights, importers, AI). A view alongside notes/canvas, not a modal.
  function openPhase2View(tab = "capture") {
    featureSuite?.deactivate();
    hideEdgeEditor();
    hidePhase3View();
    byId("notes-toolbar").hidden = true;
    byId("notes-layout").hidden = true;
    ui.canvasView.hidden = true;
    byId("new-folder").hidden = true;
    const view = byId("phase2-view");
    if (view) view.hidden = false;
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.phase2View === tab);
    });
    ui.currentView.textContent = "Capture & smarts";
    ui.pageTitle.innerHTML = `Capture &amp; smarts<span class="title-period">.</span>`;
    byId("notes-heading").querySelector(".page-subtitle").textContent = "Capture fast, resurface what matters, study what you keep.";
    if (phase2UI) phase2UI.setTab(tab);
    else if (view) view.replaceChildren();
  }

  function hidePhase2View() {
    const view = byId("phase2-view");
    if (view) view.hidden = true;
  }

  // Phase 3 — Power & polish panel (scripts, typed blocks, live queries,
  // task scores + calendar, sharing, appearance). A view alongside
  // notes/canvas, not a modal.
  function openPhase3View() {
    featureSuite?.deactivate();
    hideEdgeEditor();
    hidePhase2View();
    byId("notes-toolbar").hidden = true;
    byId("notes-layout").hidden = true;
    ui.canvasView.hidden = true;
    byId("new-folder").hidden = true;
    const view = byId("phase3-view");
    if (view) view.hidden = false;
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.phase3View === "power");
    });
    ui.currentView.textContent = "Power & polish";
    ui.pageTitle.innerHTML = `Power &amp; polish<span class="title-period">.</span>`;
    byId("notes-heading").querySelector(".page-subtitle").textContent = "Scripts, typed blocks, live queries, task scores, sharing.";
    if (phase3UI) phase3UI.renderPowerView();
    else if (view) view.replaceChildren();
  }

  function hidePhase3View() {
    const view = byId("phase3-view");
    if (view) view.hidden = true;
  }

  // Phase 3 (audit D1) — return to the notes list (Android back button).
  function showNotesView() {
    hidePhase2View();
    hidePhase3View();
    switchView("notes");
  }

  // Phase 2 (audit B1) — attach files to the current note. Blobs go to the
  // phase2 IndexedDB store; small ones (<= 1 MB) also base64 into the
  // record so they can travel inside sync envelopes. Large ones stay
  // device-local and the note says so honestly.
  async function attachFiles(fileList) {
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    if (!window.xPinPhase2?.storeAttachment) {
      showToast("Attachments are unavailable in this build.");
      return;
    }
    if (!currentNote()) createNote();
    const note = currentNote();
    let attached = 0;
    let large = 0;
    for (const file of files) {
      try {
        window.xPinPhase2.validateAttachmentFile(file);
        const { record } = await window.xPinPhase2.storeAttachment({ noteId: note.id, file });
        state.attachments.push(record);
        const markdown = window.xPinPhase2.attachmentMarkdown(record);
        const start = ui.noteBody.selectionStart ?? ui.noteBody.value.length;
        const end = ui.noteBody.selectionEnd ?? ui.noteBody.value.length;
        ui.noteBody.setRangeText(`\n${markdown}\n`, start, end, "end");
        ui.noteBody.dispatchEvent(new Event("input", { bubbles: true }));
        attached += 1;
        if (record.size > window.xPinPhase2.SYNCABLE_ATTACHMENT_BYTES) large += 1;
      } catch (error) {
        showToast(error.message || "That file could not be attached.");
      }
    }
    if (attached) {
      persistWorkspace();
      render();
      showToast(large
        ? `${attached} file${attached === 1 ? "" : "s"} attached — ${large} over 1 MB ${large === 1 ? "is" : "are"} stored on this device only, not synced.`
        : `${attached} file${attached === 1 ? "" : "s"} attached.`);
    }
  }

  function selectNote(id) {
    if (!state.notes.some((note) => note.id === id)) throw new Error(`Unknown xPin note: ${id}`);
    flushSave();
    if (state.view !== "notes") switchView("notes");
    selectedNoteId = id;
    render();
    pluginManager?.emit("note:opened", currentNote());
  }

  function updateSelectedNote(changes) {
    const note = currentNote();
    if (!note) return;
    // Phase 1: typing goes through the shared domain function so plugins,
    // sync, and the editor all see the same validation + events. A no-op
    // edit (value set back to what it was) is not an error here.
    let updated;
    try {
      updated = updateNote(note.id, changes);
    } catch (error) {
      if (/changed nothing/.test(error.message)) return;
      throw error;
    }
    ui.editorDate.textContent = `EDITED ${formatRelative(updated.updatedAt).toLocaleUpperCase()}`;
    scheduleSave();
  }

  let listRefreshTimer = null;
  function refreshNoteRow(noteId) {
    const note = state.notes.find((item) => item.id === noteId);
    const existing = note ? ui.noteList.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`) : null;
    if (existing) existing.replaceWith(renderNoteRow(note));
    window.clearTimeout(listRefreshTimer);
    listRefreshTimer = window.setTimeout(() => {
      listRefreshTimer = null;
      renderList();
    }, 600);
  }

  function setActiveFilter(filter) {
    state.filter = filter;
    state.tagFilter = null;
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.filter === filter);
    });
  }

  function buildNoteRecord({ title = "", body = "", folderId = null, parentNoteId = null, metadata = {} } = {}) {
    if (typeof title !== "string" || typeof body !== "string") {
      throw new TypeError("New note title and body must be text.");
    }
    if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) {
      throw new Error(`Unknown xPin folder: ${folderId}`);
    }
    if (parentNoteId !== null && !state.notes.some((note) => note.id === parentNoteId)) {
      throw new Error(`Unknown xPin parent page: ${parentNoteId}`);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new TypeError("New note metadata must be an object.");
    }
    const now = new Date().toISOString();
    return { id: makeId("note"), title, body, folderId, parentNoteId, pinned: false, createdAt: now, updatedAt: now, metadata: sanitizeNoteMetadata(metadata), syncVersion: { lamport: 0, deviceId: "" } };
  }

  function createNote({ title = "", body = "", folderId = null, parentNoteId = null, metadata = {} } = {}) {
    const note = buildNoteRecord({ title, body, folderId, parentNoteId, metadata });
    if (state.view !== "notes") switchView("notes");
    flushSave();
    state.notes.push(note);
    setActiveFilter("all");
    ui.search.value = "";
    selectedNoteId = note.id;
    pluginManager?.emit("note:created", { ...note });
    render();
    persistWorkspace();
    if (!title && !body) ui.noteTitle.focus();
    showToast(title ? "Your note is ready." : "A fresh page, just for you.");
    return note;
  }

  // Phase 1 — shared domain functions (fabriX spec §10). The fabriX
  // adapter and sync both consume these; nothing else duplicates note
  // mutation logic. updateNote validates like createNote (title/body/
  // folder/tags via metadata); deleteNote soft-deletes to Trash through
  // the Phase 0 trash path, or permanently deletes (recording a sync
  // tombstone so other devices learn of the delete).
  function updateNote(id, patch) {
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error("The note no longer exists.");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Note update requires a patch object with title, body, folderId, parentNoteId, pinned, and/or metadata.");
    }
    const beforeTags = extractTags(`${note.title}\n${note.body}`);
    const changes = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || patch.title.length > 120) {
        throw new TypeError("Note title must be text under 120 characters.");
      }
      changes.title = patch.title;
    }
    if (patch.body !== undefined) {
      if (typeof patch.body !== "string" || patch.body.length > 100_000) {
        throw new TypeError("Note body must be text under 100 KB.");
      }
      changes.body = patch.body;
    }
    if (patch.folderId !== undefined) {
      if (patch.folderId !== null && !state.folders.some((folder) => folder.id === patch.folderId)) {
        throw new Error(`Unknown xPin folder: ${patch.folderId}`);
      }
      changes.folderId = patch.folderId;
    }
    if (patch.parentNoteId !== undefined) {
      if (patch.parentNoteId !== null) {
        if (patch.parentNoteId === id) throw new Error("A page cannot be its own parent.");
        if (!state.notes.some((item) => item.id === patch.parentNoteId)) {
          throw new Error(`Unknown xPin parent page: ${patch.parentNoteId}`);
        }
        const descendants = new Set();
        const collect = (parentId) => state.notes.filter((item) => item.parentNoteId === parentId)
          .forEach((item) => { descendants.add(item.id); collect(item.id); });
        collect(id);
        if (descendants.has(patch.parentNoteId)) {
          throw new Error("A page cannot be moved inside one of its own sub-pages.");
        }
      }
      changes.parentNoteId = patch.parentNoteId;
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== "boolean") throw new TypeError("Note pinned must be true or false.");
      changes.pinned = patch.pinned;
    }
    if (patch.metadata !== undefined) {
      const nextMetadata = mergeNoteMetadata(note.metadata, patch.metadata);
      if (JSON.stringify(nextMetadata) !== JSON.stringify(note.metadata ?? {})) {
        changes.metadata = nextMetadata;
      }
    }
    if (!Object.keys(changes).length) throw new TypeError("Note update changed nothing.");
    Object.assign(note, changes, { updatedAt: new Date().toISOString() });
    refreshNoteRow(note.id);
    pluginManager?.emit("note:updated", { ...note });
    const afterTags = extractTags(`${note.title}\n${note.body}`);
    if (JSON.stringify([...beforeTags].sort()) !== JSON.stringify([...afterTags].sort())) {
      pluginManager?.emit("tag:changed", { noteId: note.id, tags: afterTags });
    }
    renderPluginPanels();
    renderEditorStatus();
    return { ...note };
  }

  function nextSyncLamport() {
    const maxNote = state.notes.reduce((max, note) =>
      Math.max(max, window.xPinSync?.noteSyncVersion(note).lamport ?? 0), 0);
    state.sync.lamport = Math.max(state.sync.lamport ?? 0, maxNote) + 1;
    return state.sync.lamport;
  }

  function recordSyncTombstone(noteId) {
    if (!state.sync.deviceId) return; // sync never set up: nothing to tell
    state.sync.tombstones = (state.sync.tombstones ?? []).filter((t) => t.noteId !== noteId);
    state.sync.tombstones.push({ noteId, lamport: nextSyncLamport(), deviceId: state.sync.deviceId });
    while (state.sync.tombstones.length > 200) state.sync.tombstones.shift();
  }

  function deleteNote(id, { permanent = false } = {}) {
    const live = state.notes.find((item) => item.id === id) ?? null;
    const trashed = state.trash.find((item) => item.id === id) ?? null;
    if (!live && !trashed) throw new Error("The note no longer exists.");
    if (permanent) {
      pushUndo("Permanently delete note");
      state.notes = state.notes.filter((item) => item.id !== id);
      state.trash = state.trash.filter((item) => item.id !== id);
      recordSyncTombstone(id);
      if (selectedNoteId === id) selectedNoteId = visibleNotes()[0]?.id ?? null;
      pluginManager?.emit("note:deleted", { ...(live ?? trashed) });
      render();
      persistWorkspace();
      return true;
    }
    if (!live) throw new Error("Only a live note can be moved to Trash — this one is already there.");
    moveNoteToTrash(live);
    return true;
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function applyTemplatePlaceholders(content, { title = "" } = {}) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return String(content ?? "")
      .replaceAll("{{date}}", localDateKey(now))
      .replaceAll("{{time}}", `${pad(now.getHours())}:${pad(now.getMinutes())}`)
      .replaceAll("{{title}}", String(title ?? ""));
  }

  function getOrCreateDailyNote(dateKey = localDateKey()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError("Daily note date must use YYYY-MM-DD.");
    const date = new Date(`${dateKey}T12:00:00`);
    if (Number.isNaN(date.getTime()) || localDateKey(date) !== dateKey) throw new TypeError("Daily note date is not a valid calendar day.");
    const existing = state.notes.find((note) => note.metadata?.dailyDate === dateKey);
    if (existing) return { note: existing, created: false };
    const title = date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const dailyTemplate = state.templates.find((template) => template.name.trim().toLocaleLowerCase() === "daily note");
    const body = dailyTemplate ? applyTemplatePlaceholders(dailyTemplate.content, { title }) : "";
    const note = buildNoteRecord({ title, body, metadata: { dailyDate: dateKey } });
    state.notes.push(note);
    pluginManager?.emit("note:created", { ...note });
    return { note, created: true };
  }

  // Phase 2 (research #5) — meeting note from the template, linked to the
  // day via note properties (Phase 0 metadata): date/time/attendees, plus
  // metadata.dailyDate so it shows up on that day.
  async function createMeetingNote() {
    const title = await window.xPinPhase3?.showDialog(document, {
      title: "Meeting note", label: "Meeting title", value: "", placeholder: "e.g. Weekly sync", confirmLabel: "Next"
    });
    if (title === null || title === undefined) return null;
    const attendees = await window.xPinPhase3?.showDialog(document, {
      title: "Meeting note", label: "Attendees (comma-separated)", value: "", placeholder: "Ana, Bo", confirmLabel: "Next"
    });
    if (attendees === null || attendees === undefined) return null;
    const time = await window.xPinPhase3?.showDialog(document, {
      title: "Meeting note", label: "Time (e.g. 14:30)", value: "", placeholder: "14:30", confirmLabel: "Create"
    });
    if (time === null || time === undefined) return null;
    const built = window.xPinPhase2?.buildMeetingNote
      ? window.xPinPhase2.buildMeetingNote({ title, attendees, time })
      : { title: title.trim() || "Meeting notes", body: `# ${title.trim() || "Meeting notes"}\n\nAttendees: ${attendees}\n\n## Notes\n\n- \n\n## Actions\n\n- [ ] `, metadata: { meetingDate: localDateKey(), meetingTime: time, attendees, dailyDate: localDateKey() } };
    const note = createNote(built);
    selectNote(note.id);
    showToast("Meeting note created — linked to today.");
    return note;
  }

  // Phase 2 (Item 8) — AI keys live in the Phase 1 credential store
  // (plugin id "ai-assists", one key per provider), encrypted with the
  // sync passphrase. Never in the plaintext workspace blob, never logged.
  async function unlockPhase2Credentials(passphrase) {
    if (!window.xPinCredentials) throw new Error("Credential storage is unavailable in this build.");
    if (typeof passphrase !== "string" || passphrase.length < 12) {
      throw new Error("Credential passphrase needs at least 12 characters.");
    }
    if (!state.sync.credentialSalt) {
      // First setup: derive + store the salt and key-check (same KDF as
      // sync), then unlock the session key.
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const key = await window.xPinCredentials.deriveCredentialKey(passphrase, salt);
      const check = await window.xPinCredentials.keyCheckValue(key);
      state.sync.credentialSalt = btoa(String.fromCharCode(...salt));
      state.sync.credentialKeyCheck = check;
      persistWorkspace();
    }
    await window.xPinCredentials.unlock(passphrase, state.sync.credentialSalt, state.sync.credentialKeyCheck);
    return true;
  }

  function aiKeyPresent() {
    const provider = state.settings.ai.provider;
    return Boolean(state.connectorCredentials?.["ai-assists"]?.[provider]);
  }

  async function getAiKey() {
    const provider = state.settings.ai.provider;
    const envelope = state.connectorCredentials?.["ai-assists"]?.[provider];
    if (!envelope) return null;
    if (!window.xPinCredentials?.isUnlocked()) {
      throw new Error("Credential storage is locked — unlock it in Capture & smarts settings first.");
    }
    return window.xPinCredentials.decryptSecret(envelope);
  }

  async function setAiKey(value) {
    const provider = state.settings.ai.provider;
    if (!window.xPinCredentials?.isUnlocked()) {
      throw new Error("Credential storage is locked — unlock it in Capture & smarts settings first.");
    }
    if (!state.connectorCredentials["ai-assists"]) state.connectorCredentials["ai-assists"] = {};
    if (!value) {
      delete state.connectorCredentials["ai-assists"][provider];
    } else {
      state.connectorCredentials["ai-assists"][provider] =
        await window.xPinCredentials.encryptSecret(value);
    }
    persistWorkspace();
    return true;
  }

  function openDailyNote(dateKey = localDateKey()) {
    const { note, created } = getOrCreateDailyNote(dateKey);
    if (!created) {
      selectNote(note.id);
      showToast("Today's note is open.");
      return note;
    }
    if (state.view !== "notes") switchView("notes");
    flushSave();
    setActiveFilter("all");
    ui.search.value = "";
    selectedNoteId = note.id;
    render();
    persistWorkspace();
    showToast("Your note is ready.");
    return note;
  }

  function appendToDailyNote(text) {
    const clean = String(text ?? "").trim();
    if (!clean) {
      showToast("Write something to capture first.");
      return null;
    }
    const { note } = getOrCreateDailyNote(localDateKey());
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const entry = `- [${stamp}] ${clean}`;
    const trimmed = note.body.replace(/\s+$/, "");
    note.body = /^##\s+inbox\s*$/im.test(note.body)
      ? `${trimmed}\n${entry}`
      : `${trimmed}${trimmed ? "\n\n" : ""}## Inbox\n${entry}`;
    note.updatedAt = new Date().toISOString();
    refreshNoteRow(note.id);
    if (note.id === selectedNoteId && ui.noteBody) {
      // The daily note may be open in the editor right now. The textarea is the
      // editor's source of truth on the next keystroke, so it must reflect the
      // appended entry too — otherwise the next keystroke would overwrite
      // note.body with the stale textarea value and silently drop the capture.
      const field = ui.noteBody;
      const focused = document.activeElement === field;
      const caret = focused ? field.selectionStart ?? field.value.length : 0;
      const atEnd = caret >= field.value.length;
      field.value = note.body;
      if (focused) {
        const pos = atEnd ? field.value.length : Math.min(caret, field.value.length);
        field.selectionStart = field.selectionEnd = pos;
      }
    }
    pluginManager?.emit("note:updated", { ...note });
    renderPluginPanels();
    renderEditorStatus();
    persistWorkspace();
    showToast("Captured to today's note");
    return note;
  }

  let quickCaptureDialog = null;
  let captureReturnFocus = null;

  function openQuickCaptureDialog() {
    if (!quickCaptureDialog) {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.id = "quick-capture-modal";
      backdrop.hidden = true;
      const dialog = document.createElement("section");
      dialog.className = "dialog quick-capture-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "quick-capture-title");
      const header = document.createElement("header");
      header.className = "dialog-header";
      header.innerHTML = '<div><div class="dialog-kicker">QUICK CAPTURE</div><h2 id="quick-capture-title">Capture to today\'s note</h2></div>';
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "icon-button dialog-close";
      closeButton.setAttribute("aria-label", "Close quick capture");
      closeButton.textContent = "×";
      header.append(closeButton);
      const field = document.createElement("textarea");
      field.id = "quick-capture-input";
      field.className = "quick-capture-input";
      field.rows = 4;
      field.maxLength = 2000;
      field.placeholder = "What's on your mind?";
      field.setAttribute("aria-label", "Capture text");
      const footer = document.createElement("footer");
      footer.className = "dialog-footer";
      const hint = document.createElement("span");
      hint.textContent = "Ctrl+Enter captures · Esc cancels";
      const actions = document.createElement("span");
      actions.className = "quick-capture-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog-button-secondary";
      cancel.textContent = "Cancel";
      const capture = document.createElement("button");
      capture.type = "button";
      capture.className = "dialog-done";
      capture.textContent = "Capture";
      actions.append(cancel, capture);
      footer.append(hint, actions);
      dialog.append(header, field, footer);
      backdrop.append(dialog);
      const close = () => {
        backdrop.hidden = true;
        syncModalOpenClass();
        // Hand focus back where the user was — capture shouldn't displace them.
        const target = captureReturnFocus;
        captureReturnFocus = null;
        if (target && document.contains(target) && typeof target.focus === "function") {
          target.focus();
        }
      };
      const submit = () => {
        const value = field.value;
        field.value = "";
        close();
        appendToDailyNote(value);
      };
      closeButton.addEventListener("click", close);
      cancel.addEventListener("click", close);
      capture.addEventListener("click", submit);
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) close();
      });
      field.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submit();
        }
        event.stopPropagation();
      });
      document.querySelector(".app-shell")?.append(backdrop);
      quickCaptureDialog = { backdrop, field, close };
    }
    const opener = document.activeElement;
    captureReturnFocus = opener && !quickCaptureDialog.backdrop.contains(opener) ? opener : null;
    quickCaptureDialog.field.value = "";
    quickCaptureDialog.backdrop.hidden = false;
    document.body.classList.add("modal-open");
    quickCaptureDialog.field.focus();
  }

  /* ---------- note templates ---------- */
  function findTemplate(id) {
    return state.templates.find((template) => template.id === id) ?? null;
  }

  function addTemplate(name, content) {
    const cleanName = String(name ?? "").trim().slice(0, 80);
    if (!cleanName) {
      showToast("Give your template a name first.");
      return null;
    }
    if (state.templates.some((template) => template.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      showToast("A template with that name already exists.");
      return null;
    }
    const template = { id: makeId("template"), name: cleanName, content: String(content ?? "").slice(0, 100_000) };
    state.templates.push(template);
    pluginManager?.emit("template:created", { ...template });
    persistWorkspace();
    renderCoreToolsSections(true);
    showToast(`Template “${cleanName}” saved.`);
    return template;
  }

  function deleteTemplate(id) {
    const template = findTemplate(id);
    if (!template) return;
    if (!window.confirm(`Delete the “${template.name}” template? Notes made from it are not affected.`)) return;
    state.templates = state.templates.filter((item) => item.id !== id);
    pluginManager?.emit("template:deleted", { ...template });
    persistWorkspace();
    renderCoreToolsSections(true);
    showToast("Template deleted.");
  }

  function saveCurrentNoteAsTemplate() {
    const note = currentNote();
    if (!note) {
      showToast("Open a note first to save it as a template.");
      return;
    }
    addTemplate(note.title.trim() || "Untitled template", note.body);
  }

  function createNoteFromTemplate(templateId) {
    const template = findTemplate(templateId);
    if (!template) {
      showToast("That template is gone.");
      return null;
    }
    const body = applyTemplatePlaceholders(template.content, { title: template.name });
    const note = createNote({ title: template.name, body });
    featureSuite?.deactivate();
    return note;
  }

  let templatePickerDialog = null;

  function openTemplatePickerDialog() {
    if (!state.templates.length) {
      showToast("No templates yet — add one under Workspace tools.");
      return;
    }
    if (!templatePickerDialog) {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.id = "template-picker-modal";
      backdrop.hidden = true;
      const dialog = document.createElement("section");
      dialog.className = "dialog template-picker-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "template-picker-title");
      const header = document.createElement("header");
      header.className = "dialog-header";
      header.innerHTML = '<div><div class="dialog-kicker">TEMPLATES</div><h2 id="template-picker-title">New note from template</h2></div>';
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "icon-button dialog-close";
      closeButton.setAttribute("aria-label", "Close template picker");
      closeButton.textContent = "×";
      header.append(closeButton);
      const list = document.createElement("div");
      list.className = "template-picker-list";
      const footer = document.createElement("footer");
      footer.className = "dialog-footer";
      const hint = document.createElement("span");
      hint.textContent = "Esc closes";
      const done = document.createElement("button");
      done.type = "button";
      done.className = "dialog-done";
      done.textContent = "Cancel";
      footer.append(hint, done);
      dialog.append(header, list, footer);
      backdrop.append(dialog);
      const close = () => {
        backdrop.hidden = true;
        syncModalOpenClass();
      };
      closeButton.addEventListener("click", close);
      done.addEventListener("click", close);
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) close();
      });
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        event.stopPropagation();
      });
      document.querySelector(".app-shell")?.append(backdrop);
      templatePickerDialog = { backdrop, list, close };
    }
    templatePickerDialog.list.replaceChildren();
    state.templates.forEach((template) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "template-picker-option";
      const name = document.createElement("strong");
      name.textContent = template.name;
      const preview = document.createElement("small");
      preview.textContent = template.content.trim().split("\n")[0]?.slice(0, 80) ?? "";
      option.append(name, preview);
      option.addEventListener("click", () => {
        templatePickerDialog.close();
        createNoteFromTemplate(template.id);
      });
      templatePickerDialog.list.append(option);
    });
    templatePickerDialog.backdrop.hidden = false;
    document.body.classList.add("modal-open");
    templatePickerDialog.list.querySelector(".template-picker-option")?.focus();
  }

  /* Single source of truth for the modal-open body class. Every dialog close
   * funnels through here so no close path can strand (or prematurely drop)
   * the class while another dialog is still visible. */
  function anyModalOpen() {
    if (!ui.pluginsModal.hidden || !ui.commandsModal.hidden || !ui.pluginConsentModal.hidden) return true;
    if (shortcutsDialog && !shortcutsDialog.hidden) return true;
    if (quickCaptureDialog && !quickCaptureDialog.backdrop.hidden) return true;
    if (templatePickerDialog && !templatePickerDialog.backdrop.hidden) return true;
    return false;
  }

  function syncModalOpenClass() {
    document.body.classList.toggle("modal-open", anyModalOpen());
  }

  /* ---------- workspace-tools sections (rendered from app.js) ----------
   * feature-suite.js owns the settings view markup and is outside this batch's
   * file scope, so these core sections are appended to #feature-content from
   * here and kept in place with a MutationObserver (feature-suite re-renders
   * its own sections on some actions, e.g. deleting a shared block).        */
  function renderTemplatesSection() {
    const section = document.createElement("section");
    section.className = "tools-section";
    const heading = document.createElement("h2");
    heading.textContent = "Note templates";
    const blurb = document.createElement("p");
    blurb.textContent = "Reusable starting points for new notes. {{date}}, {{time}} and {{title}} are filled in when a template is used. The “Daily note” template shapes each new daily note.";
    section.append(heading, blurb);
    const list = document.createElement("div");
    list.className = "template-list";
    if (!state.templates.length) {
      const empty = document.createElement("p");
      empty.className = "feature-empty";
      empty.textContent = "No templates yet.";
      list.append(empty);
    }
    state.templates.forEach((template) => {
      const row = document.createElement("div");
      row.className = "template-row";
      const name = document.createElement("span");
      name.className = "template-name";
      name.textContent = template.name;
      const use = document.createElement("button");
      use.type = "button";
      use.className = "feature-button";
      use.textContent = "Use";
      use.setAttribute("aria-label", `Create a note from the ${template.name} template`);
      use.addEventListener("click", () => createNoteFromTemplate(template.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "feature-button";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete the ${template.name} template`);
      remove.addEventListener("click", () => deleteTemplate(template.id));
      row.append(name, use, remove);
      list.append(row);
    });
    section.append(list);
    const form = document.createElement("div");
    form.className = "template-form";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "feature-input template-name-input";
    nameInput.placeholder = "Template name";
    nameInput.maxLength = 80;
    nameInput.setAttribute("aria-label", "New template name");
    const contentInput = document.createElement("textarea");
    contentInput.className = "feature-input template-content-input";
    contentInput.placeholder = "Template content — try {{date}}, {{time}}, {{title}}";
    contentInput.rows = 4;
    contentInput.maxLength = 100_000;
    contentInput.setAttribute("aria-label", "New template content");
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "feature-button feature-button-primary";
    addButton.textContent = "Add template";
    addButton.addEventListener("click", () => addTemplate(nameInput.value, contentInput.value));
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "feature-button";
    saveButton.textContent = "Save current note as template";
    saveButton.addEventListener("click", saveCurrentNoteAsTemplate);
    const formActions = document.createElement("div");
    formActions.className = "template-form-actions";
    formActions.append(addButton, saveButton);
    form.append(nameInput, contentInput, formActions);
    section.append(form);
    return section;
  }

  function renderImportSection() {
    const section = document.createElement("section");
    section.className = "tools-section";
    const heading = document.createElement("h2");
    heading.textContent = "Import Markdown";
    const blurb = document.createElement("p");
    blurb.textContent = "Bring in .md files from this device. Each file becomes one note, titled after its filename. Everything stays local; empty files are skipped.";
    section.append(heading, blurb);
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".md,text/markdown";
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.setAttribute("aria-label", "Choose Markdown files to import");
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "feature-button";
    importButton.textContent = "Import Markdown files";
    importButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      importMarkdownFiles(fileInput.files);
      fileInput.value = "";
    });
    section.append(importButton, fileInput);
    return section;
  }

  /* ---------- Phase 1 — E2EE sync, capture token, publish ----------
   * Local-first: the device store is authoritative; sync exchanges
   * encrypted envelopes, never plaintext. The passphrase is never stored —
   * only key-check values + salts persist. The derived keys live in memory
   * for this session only (syncSessionKey + the credential store's key). */
  function ensureSyncDeviceId() {
    if (!state.sync.deviceId) {
      state.sync.deviceId = window.xPinSync.makeDeviceId();
      persistWorkspace();
    }
    return state.sync.deviceId;
  }

  function syncKeySaltBytes() {
    if (!state.sync.syncSalt) {
      state.sync.syncSalt = window.xPinSync.bytesToBase64(window.xPinSync.newSalt());
    }
    return window.xPinSync.base64ToBytes(state.sync.syncSalt);
  }

  function credentialSaltBytes() {
    if (!state.sync.credentialSalt) {
      state.sync.credentialSalt = window.xPinSync.bytesToBase64(window.xPinSync.newSalt());
    }
    return window.xPinSync.base64ToBytes(state.sync.credentialSalt);
  }

  // Set up (first time) or unlock (later) the sync + credential passphrase.
  // Derives both keys, stores only the key-check values, and unlocks the
  // credential store for the session. Throws on a wrong passphrase.
  async function setSyncPassphrase(passphrase) {
    if (typeof passphrase !== "string" || passphrase.length < 12) {
      throw new TypeError("Use a passphrase with at least 12 characters.");
    }
    const syncKey = await window.xPinSync.deriveSyncKey(passphrase, syncKeySaltBytes());
    const syncCheck = await window.xPinSync.keyCheckValue(syncKey);
    if (state.sync.syncKeyCheck && syncCheck !== state.sync.syncKeyCheck) {
      throw new Error("That passphrase does not match the one sync was set up with.");
    }
    const credentialKey = await window.xPinCredentials.deriveCredentialKey(passphrase, credentialSaltBytes());
    const credentialCheck = await window.xPinCredentials.keyCheckValue(credentialKey);
    if (state.sync.credentialKeyCheck && credentialCheck !== state.sync.credentialKeyCheck) {
      throw new Error("That passphrase does not match the one credential storage was set up with.");
    }
    state.sync.syncKeyCheck = syncCheck;
    state.sync.credentialKeyCheck = credentialCheck;
    syncSessionKey = syncKey;
    await window.xPinCredentials.unlock(passphrase, state.sync.credentialSalt, state.sync.credentialKeyCheck);
    persistWorkspace();
    pluginManager?.emit("settings:changed", { section: "sync" });
    return true;
  }

  function lockSyncSession() {
    syncSessionKey = null;
    window.xPinCredentials.lock();
    showToast("Sync locked. Enter your passphrase to sync again.");
  }

  // Build one envelope per live note (fresh lamport each) plus one tombstone
  // envelope per permanently deleted note. Phase 1 pushes the full set on
  // every sync — simple and correct under last-writer-wins; a later phase
  // can send only changed notes.
  async function buildSyncEnvelopes() {
    const deviceId = ensureSyncDeviceId();
    const envelopes = [];
    for (const note of state.notes) {
      const lamport = nextSyncLamport();
      note.syncVersion = { lamport, deviceId };
      envelopes.push(await window.xPinSync.makeEnvelope({
        key: syncSessionKey, deviceId, lamport, note, op: "upsert"
      }));
    }
    for (const tombstone of state.sync.tombstones ?? []) {
      envelopes.push(await window.xPinSync.makeEnvelope({
        key: syncSessionKey,
        deviceId: tombstone.deviceId || deviceId,
        lamport: tombstone.lamport,
        note: { id: tombstone.noteId, updatedAt: new Date().toISOString() },
        op: "tombstone"
      }));
    }
    return envelopes;
  }

  async function syncNow() {
    if (!syncSessionKey) {
      showToast("Enter your sync passphrase in Sync settings first.");
      return false;
    }
    if (!window.xPinSync) {
      showToast("Sync is unavailable in this build.");
      return false;
    }
    try {
      const envelopes = await buildSyncEnvelopes();
      let pulled = [];
      let relayUsed = false;
      if (state.sync.relayUrl) {
        relayUsed = true;
        const relay = window.xPinSyncTransports.createHttpRelayTransport(state.sync.relayUrl);
        await relay.push(envelopes);
        pulled = await relay.pull(state.sync.lastSyncLamport ?? 0);
      }
      const { results, seen } = await window.xPinSync.applyEnvelopes(
        pulled, state, syncSessionKey, state.sync.seen
      );
      state.sync.seen = seen;
      const maxLamport = Math.max(
        state.sync.lastSyncLamport ?? 0,
        ...envelopes.map((e) => e.lamport),
        ...pulled.map((e) => e.lamport ?? 0)
      );
      state.sync.lastSyncLamport = maxLamport;
      state.sync.lastSyncAt = new Date().toISOString();
      state.sync.lastSyncStatus = "ok";
      const applied = results.filter((r) => r.applied).length;
      const ignored = results.filter((r) => r.outcome === "ignored-newer").length;
      const errors = results.filter((r) => r.outcome === "error");
      persistWorkspace();
      render();
      renderCoreToolsSections(true);
      pluginManager?.emit("sync:completed", {
        pushed: envelopes.length, pulled: pulled.length, applied, ignored,
        errors: errors.length, relay: relayUsed ? state.sync.relayUrl : null
      });
      showToast(errors.length
        ? `Sync finished with ${errors.length} error${errors.length === 1 ? "" : "s"} — see the console.`
        : relayUsed
          ? `Synced via relay: ${envelopes.length} sent, ${applied} applied, ${ignored} kept locally.`
          : `Sync bundle ready: ${envelopes.length} notes. No relay configured — bundles are the sync path today.`);
      return true;
    } catch (error) {
      console.error("Sync failed.", error);
      state.sync.lastSyncStatus = "error";
      persistWorkspace();
      renderCoreToolsSections(true);
      pluginManager?.emit("sync:completed", { error: String(error.message || error).slice(0, 300) });
      showToast(error.message || "Sync could not complete.");
      return false;
    }
  }

  async function exportSyncBundle() {
    if (!syncSessionKey) {
      showToast("Enter your sync passphrase in Sync settings first.");
      return false;
    }
    try {
      const envelopes = await buildSyncEnvelopes();
      const text = window.xPinSyncTransports.BundleTransport.exportBundle(envelopes, state.sync.deviceId);
      downloadFile(`xpin-sync-${new Date().toISOString().slice(0, 10)}.xpin-sync.json`, text, "application/json");
      persistWorkspace();
      showToast(`Sync bundle exported (${envelopes.length} notes, encrypted). Hand the file to your other device and import it there.`);
      return true;
    } catch (error) {
      console.error("Sync bundle export failed.", error);
      showToast(error.message || "Sync bundle could not be exported.");
      return false;
    }
  }

  async function importSyncBundleText(text) {
    if (!syncSessionKey) {
      showToast("Enter your sync passphrase in Sync settings first.");
      return false;
    }
    try {
      const envelopes = window.xPinSyncTransports.BundleTransport.importBundle(text);
      const { results, seen } = await window.xPinSync.applyEnvelopes(
        envelopes, state, syncSessionKey, state.sync.seen
      );
      state.sync.seen = seen;
      state.sync.lastSyncLamport = Math.max(
        state.sync.lastSyncLamport ?? 0,
        ...envelopes.map((e) => e.lamport ?? 0)
      );
      state.sync.lastSyncAt = new Date().toISOString();
      state.sync.lastSyncStatus = "ok";
      const applied = results.filter((r) => r.applied).length;
      const duplicates = results.filter((r) => r.outcome === "duplicate").length;
      const errors = results.filter((r) => r.outcome === "error");
      persistWorkspace();
      render();
      renderCoreToolsSections(true);
      pluginManager?.emit("sync:completed", { imported: envelopes.length, applied, duplicates, errors: errors.length, via: "bundle" });
      showToast(errors.length
        ? `Bundle imported with ${errors.length} error${errors.length === 1 ? "" : "s"} — see the console.`
        : `Bundle imported: ${applied} applied, ${duplicates} already seen.`);
      return true;
    } catch (error) {
      console.error("Sync bundle import failed.", error);
      showToast(error.message || "Sync bundle could not be imported.");
      return false;
    }
  }

  // Phase 1 — capture token (research #3). There is no local HTTP server
  // in a static web app, so there is no HTTP capture endpoint today. The
  // token is the auth the future capture endpoint and the fabriX adapter
  // will use; it is generated here, stored in sync state, revocable, and
  // shown in full exactly once (with a copy button).
  function generateCaptureToken() {
    const random = `${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const token = `xpin_cap_${random.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40)}`;
    state.sync.captureToken = token;
    state.sync.captureTokenCreatedAt = new Date().toISOString();
    captureTokenVisibleOnce = token;
    persistWorkspace();
    pluginManager?.emit("settings:changed", { section: "capture" });
    renderCoreToolsSections(true);
    showToast("Capture token generated — copy it now; it will not be shown in full again.");
    return token;
  }

  function revokeCaptureToken() {
    state.sync.captureToken = null;
    state.sync.captureTokenCreatedAt = null;
    captureTokenVisibleOnce = null;
    persistWorkspace();
    renderCoreToolsSections(true);
    showToast("Capture token revoked.");
  }

  // Phase 1 — Inbox capture (research #3). Shared/captured items land as a
  // note in a dedicated "Inbox" folder (created on first use) with a
  // `captured` marker and the source app name when provided.
  function getOrCreateInboxFolder() {
    const existing = state.folders.find((folder) => folder.name.toLocaleLowerCase() === "inbox");
    if (existing) return existing;
    const folder = createFolderRecord("Inbox");
    persistWorkspace();
    return folder;
  }

  function captureToInbox(text, { title = "", source = "" } = {}) {
    const clean = String(text ?? "").trim();
    if (!clean) {
      showToast("Nothing to capture.");
      return null;
    }
    const folder = getOrCreateInboxFolder();
    const firstLine = clean.split("\n")[0].trim();
    const noteTitle = String(title ?? "").trim().slice(0, 120) || firstLine.slice(0, 120) || "Captured note";
    const body = source ? `${clean}\n\nSource: ${String(source).slice(0, 200)}` : clean;
    const metadata = { captured: "true" };
    if (source) metadata.source = String(source).slice(0, 200);
    const record = buildNoteRecord({ title: noteTitle, body: body.slice(0, 100_000), folderId: folder.id, metadata });
    state.notes.push(record);
    pluginManager?.emit("note:created", { ...record });
    render();
    persistWorkspace();
    showToast(source ? `Captured to Inbox from ${source}.` : "Captured to Inbox.");
    return record;
  }

  // Phase 1 — xpin:// deep links. Parsed on app start from the location
  // hash as a fallback AND wired to Capacitor App's appUrlOpen listener so
  // the native side can deliver URLs. Forms:
  //   xpin://capture?text=...&title=...&source=...  → Inbox capture
  //   xpin://note/<id>                              → open that note
  function handleDeepLink(raw) {
    if (!raw || typeof raw !== "string") return false;
    let urlText = raw.trim();
    if (urlText.startsWith("#")) urlText = urlText.slice(1);
    if (!/^xpin:\/\//i.test(urlText)) return false;
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch {
      return false;
    }
    const host = parsed.hostname.toLocaleLowerCase();
    const path = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
    if (host === "capture" || path === "capture") {
      const text = parsed.searchParams.get("text") ?? "";
      const title = parsed.searchParams.get("title") ?? "";
      const source = parsed.searchParams.get("source") ?? "";
      return Boolean(captureToInbox(text, { title, source }));
    }
    if (host === "note" || path.startsWith("note/")) {
      const id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      if (!id) return false;
      if (!state.notes.some((note) => note.id === id)) {
        showToast("That note is not on this device.");
        return false;
      }
      selectNote(id);
      return true;
    }
    return false;
  }

  function setupDeepLinks() {
    // Hash fallback for the web build (e.g. #xpin/capture?text=...).
    try {
      const hash = window.location?.hash ?? "";
      if (hash) handleDeepLink(hash.replace(/^#xpin\//, "xpin://").replace(/^#/, ""));
    } catch { /* deep links are best-effort on boot */ }
    // Native delivery on Android via @capacitor/app (guarded: the web
    // build has no Capacitor bridge, and this must not throw there).
    try {
      const App = window.Capacitor?.Plugins?.App;
      if (App && typeof App.addListener === "function") {
        App.addListener("appUrlOpen", (event) => {
          if (event?.url) handleDeepLink(event.url);
        });
      }
    } catch { /* no Capacitor bridge: web build */ }
  }

  // Phase 1 — publish a note as a web page (research #15). Produces a
  // publish bundle (self-contained HTML + manifest) with one-click download
  // and a local preview. Default target: none — the bundle is the
  // deliverable ("host this file yourself, or configure a publish
  // service"). No hosted publishing exists and none is claimed.
  function publishCurrentNote({ preview = false } = {}) {
    const note = currentNote();
    if (!note) {
      showToast("Open a note before publishing it.");
      return null;
    }
    try {
      const bundle = window.xPinPublish.buildPublishBundle(note, markdownToHtml);
      if (preview) {
        const url = URL.createObjectURL(new Blob([bundle.html], { type: "text/html;charset=utf-8" }));
        window.open(url, "_blank");
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        showToast("Publish preview opened in a new tab.");
      } else {
        downloadFile(bundle.fileName, bundle.html, "text/html;charset=utf-8");
        showToast(state.sync.publishTarget
          ? "Publish bundle downloaded. (Sending to a configured target is not implemented yet — the bundle is still the deliverable.)"
          : "Publish bundle downloaded. Host this file yourself to make it public.");
      }
      return bundle;
    } catch (error) {
      console.error("Publish failed.", error);
      showToast(error.message || "This note could not be published.");
      return null;
    }
  }

  function renderSyncSection() {
    const section = document.createElement("section");
    section.className = "tools-section";
    section.id = "sync-section";
    const heading = document.createElement("h2");
    heading.textContent = "Sync (encrypted, local-first)";
    section.append(heading);
    const status = document.createElement("p");
    const lastSync = state.sync.lastSyncAt
      ? `Last sync ${new Date(state.sync.lastSyncAt).toLocaleString()} (${state.sync.lastSyncStatus}).`
      : "Never synced on this device.";
    status.textContent = state.sync.deviceId
      ? `Device ${state.sync.deviceId} · ${lastSync}`
      : `This device has no sync id yet — one is generated when you sync. ${lastSync}`;
    section.append(status);
    const copy = document.createElement("p");
    copy.textContent = state.sync.relayUrl
      ? "Relay configured. Sync sends encrypted envelopes only — the relay cannot read your notes."
      : "No relay configured — bundles are the sync path today. Export a bundle, hand the file to your other device, and import it there. Sync is off by default.";
    section.append(copy);
    const passphraseRow = document.createElement("div");
    passphraseRow.className = "backup-actions";
    const passphraseInput = document.createElement("input");
    passphraseInput.type = "password";
    passphraseInput.className = "feature-input";
    passphraseInput.placeholder = "Sync passphrase (12+ characters)";
    passphraseInput.setAttribute("aria-label", "Sync passphrase");
    passphraseInput.autocomplete = "off";
    const setPassphrase = document.createElement("button");
    setPassphrase.type = "button";
    setPassphrase.className = "feature-button feature-button-primary";
    setPassphrase.textContent = state.sync.syncKeyCheck ? "Unlock sync" : "Set sync passphrase";
    setPassphrase.dataset.action = "sync-set-passphrase";
    setPassphrase.addEventListener("click", async () => {
      try {
        await setSyncPassphrase(passphraseInput.value);
        passphraseInput.value = "";
        showToast("Sync unlocked for this session.");
        renderCoreToolsSections(true);
      } catch (error) {
        showToast(error.message || "Passphrase could not be set.");
      }
    });
    const lockButton = document.createElement("button");
    lockButton.type = "button";
    lockButton.className = "feature-button";
    lockButton.textContent = "Lock";
    lockButton.dataset.action = "sync-lock";
    lockButton.addEventListener("click", () => { lockSyncSession(); renderCoreToolsSections(true); });
    passphraseRow.append(passphraseInput, setPassphrase, lockButton);
    section.append(passphraseRow);
    const relayRow = document.createElement("div");
    relayRow.className = "backup-actions";
    const relayInput = document.createElement("input");
    relayInput.type = "url";
    relayInput.className = "feature-input";
    relayInput.placeholder = "Relay URL (optional, e.g. http://127.0.0.1:8787)";
    relayInput.value = state.sync.relayUrl ?? "";
    relayInput.setAttribute("aria-label", "Sync relay URL");
    const saveRelay = document.createElement("button");
    saveRelay.type = "button";
    saveRelay.className = "feature-button";
    saveRelay.textContent = "Save relay URL";
    saveRelay.dataset.action = "sync-save-relay";
    saveRelay.addEventListener("click", () => {
      const value = relayInput.value.trim();
      if (value) {
        let parsed;
        try { parsed = new URL(value); } catch { showToast("That is not a valid URL."); return; }
        if (!["http:", "https:"].includes(parsed.protocol)) { showToast("Relay URLs must use http or https."); return; }
      }
      state.sync.relayUrl = value;
      persistWorkspace();
      pluginManager?.emit("settings:changed", { section: "sync" });
      renderCoreToolsSections(true);
      showToast(value ? "Relay URL saved." : "Relay URL cleared — bundles are the sync path.");
    });
    relayRow.append(relayInput, saveRelay);
    section.append(relayRow);
    const syncActions = document.createElement("div");
    syncActions.className = "backup-actions";
    const syncNowButton = document.createElement("button");
    syncNowButton.type = "button";
    syncNowButton.className = "feature-button feature-button-primary";
    syncNowButton.textContent = "Sync now";
    syncNowButton.dataset.action = "sync-now";
    syncNowButton.addEventListener("click", () => syncNow());
    const exportBundleButton = document.createElement("button");
    exportBundleButton.type = "button";
    exportBundleButton.className = "feature-button";
    exportBundleButton.textContent = "Export sync bundle";
    exportBundleButton.dataset.action = "sync-export-bundle";
    exportBundleButton.addEventListener("click", () => exportSyncBundle());
    const importBundleButton = document.createElement("button");
    importBundleButton.type = "button";
    importBundleButton.className = "feature-button";
    importBundleButton.textContent = "Import sync bundle";
    importBundleButton.dataset.action = "sync-import-bundle";
    const bundleInput = document.createElement("input");
    bundleInput.type = "file";
    bundleInput.accept = ".xpin-sync.json,application/json";
    bundleInput.hidden = true;
    bundleInput.setAttribute("aria-label", "Choose a sync bundle to import");
    bundleInput.addEventListener("change", async () => {
      const [file] = bundleInput.files ?? [];
      bundleInput.value = "";
      if (!file) return;
      try {
        const text = typeof file.text === "function" ? await file.text() : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () => reject(new Error("Could not read the bundle file."));
          reader.readAsText(file);
        });
        await importSyncBundleText(text);
      } catch (error) {
        showToast(error.message || "Sync bundle could not be imported.");
      }
    });
    importBundleButton.addEventListener("click", () => bundleInput.click());
    syncActions.append(syncNowButton, exportBundleButton, importBundleButton, bundleInput);
    section.append(syncActions);
    // Capture token (the auth the future capture endpoint / fabriX adapter
    // will use). Shown in full exactly once, with a copy button.
    const tokenHeading = document.createElement("h3");
    tokenHeading.textContent = "Capture token";
    section.append(tokenHeading);
    const tokenCopy = document.createElement("p");
    tokenCopy.textContent = "For the future capture endpoint and the fabriX adapter. There is no HTTP capture endpoint in this static web build yet — the token is the auth that endpoint will use.";
    section.append(tokenCopy);
    const tokenRow = document.createElement("div");
    tokenRow.className = "backup-actions";
    if (captureTokenVisibleOnce && state.sync.captureToken === captureTokenVisibleOnce) {
      const tokenField = document.createElement("input");
      tokenField.type = "text";
      tokenField.className = "feature-input";
      tokenField.value = captureTokenVisibleOnce;
      tokenField.readOnly = true;
      tokenField.setAttribute("aria-label", "Capture token (shown once)");
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "feature-button";
      copyButton.textContent = "Copy";
      copyButton.dataset.action = "capture-copy-token";
      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard?.writeText(captureTokenVisibleOnce);
          showToast("Capture token copied.");
        } catch {
          tokenField.select();
          showToast("Copy failed — select the token and copy it manually.");
        }
      });
      tokenRow.append(tokenField, copyButton);
    } else if (state.sync.captureToken) {
      const masked = document.createElement("span");
      masked.textContent = `Token set (${state.sync.captureToken.slice(0, 9)}…${state.sync.captureToken.slice(-4)}). It is shown in full only once, right after generation.`;
      tokenRow.append(masked);
    } else {
      const none = document.createElement("span");
      none.textContent = "No capture token yet.";
      tokenRow.append(none);
    }
    const tokenButton = document.createElement("button");
    tokenButton.type = "button";
    tokenButton.className = "feature-button";
    tokenButton.textContent = state.sync.captureToken ? "Regenerate token" : "Generate token";
    tokenButton.dataset.action = "capture-generate-token";
    tokenButton.addEventListener("click", () => generateCaptureToken());
    tokenRow.append(tokenButton);
    if (state.sync.captureToken) {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "feature-button";
      revoke.textContent = "Revoke token";
      revoke.dataset.action = "capture-revoke-token";
      revoke.addEventListener("click", () => revokeCaptureToken());
      tokenRow.append(revoke);
    }
    section.append(tokenRow);
    return section;
  }

  function renderPublishSection() {
    const section = document.createElement("section");
    section.className = "tools-section";
    section.id = "publish-section";
    section.append(Object.assign(document.createElement("h2"), { textContent: "Publish a note as a web page" }));
    const copy = document.createElement("p");
    copy.textContent = state.sync.publishTarget
      ? `Publish target: ${state.sync.publishTarget}. Sending to a target is not implemented yet — the bundle download is still the deliverable.`
      : "No publish target configured — the bundle is the deliverable. Download it and host the file yourself, or configure a publish service.";
    section.append(copy);
    const targetRow = document.createElement("div");
    targetRow.className = "backup-actions";
    const targetInput = document.createElement("input");
    targetInput.type = "url";
    targetInput.className = "feature-input";
    targetInput.placeholder = "Publish target URL (optional)";
    targetInput.value = state.sync.publishTarget ?? "";
    targetInput.setAttribute("aria-label", "Publish target URL");
    const saveTarget = document.createElement("button");
    saveTarget.type = "button";
    saveTarget.className = "feature-button";
    saveTarget.textContent = "Save target";
    saveTarget.dataset.action = "publish-save-target";
    saveTarget.addEventListener("click", () => {
      state.sync.publishTarget = targetInput.value.trim().slice(0, 500);
      persistWorkspace();
      pluginManager?.emit("settings:changed", { section: "publish" });
      renderCoreToolsSections(true);
      showToast(state.sync.publishTarget ? "Publish target saved." : "Publish target cleared.");
    });
    targetRow.append(targetInput, saveTarget);
    section.append(targetRow);
    const actions = document.createElement("div");
    actions.className = "backup-actions";
    const publishButton = document.createElement("button");
    publishButton.type = "button";
    publishButton.className = "feature-button feature-button-primary";
    publishButton.textContent = "Publish current note";
    publishButton.dataset.action = "publish-bundle";
    publishButton.addEventListener("click", () => publishCurrentNote());
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "feature-button";
    previewButton.textContent = "Preview";
    previewButton.dataset.action = "publish-preview";
    previewButton.addEventListener("click", () => publishCurrentNote({ preview: true }));
    actions.append(publishButton, previewButton);
    section.append(actions);
    return section;
  }

  function renderCoreToolsSections(force = false) {
    if (!featureSuite || !featureSuite.active || state.features.activeView !== "settings") return;
    const content = byId("feature-content");
    if (!content) return;
    const existing = content.querySelector("[data-core-tools]");
    if (existing && !force) return;
    // Preserve an in-progress template draft: settings re-renders (e.g. after
    // deleting a shared block) must not wipe what the user already typed.
    const draft = existing ? {
      name: existing.querySelector(".template-name-input")?.value ?? "",
      content: existing.querySelector(".template-content-input")?.value ?? "",
    } : null;
    existing?.remove();
    const wrap = document.createElement("div");
    wrap.dataset.coreTools = "true";
    const templatesSection = renderTemplatesSection();
    if (draft && (draft.name || draft.content)) {
      const nameInput = templatesSection.querySelector(".template-name-input");
      const contentInput = templatesSection.querySelector(".template-content-input");
      if (nameInput) nameInput.value = draft.name;
      if (contentInput) contentInput.value = draft.content;
    }
    wrap.append(templatesSection, renderImportSection(), renderSyncSection(), renderPublishSection());
    content.append(wrap);
  }

  function observeCoreToolsSections() {
    const content = byId("feature-content");
    if (!content || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => renderCoreToolsSections());
    observer.observe(content, { childList: true });
  }

  const MAX_IMPORT_BYTES = 5_000_000; // 5 MB per file — bigger files are skipped, not read
  function importMarkdownFiles(fileList) {
    const picked = [...(fileList ?? [])].filter((file) => /\.md$/i.test(file.name ?? ""));
    if (!picked.length) {
      showToast("Choose .md files to import.");
      return;
    }
    if (typeof FileReader === "undefined") {
      showToast("File import is not available in this browser.");
      return;
    }
    const files = [];
    let oversize = 0;
    for (const file of picked) {
      if (typeof file.size === "number" && file.size > MAX_IMPORT_BYTES) oversize += 1;
      else files.push(file);
    }
    if (!files.length) {
      showToast(oversize ? `All ${oversize === 1 ? "file was" : "files were"} over the 5 MB import limit — nothing imported.` : "Choose .md files to import.");
      return;
    }
    let pending = files.length;
    let created = 0;
    let skipped = oversize;
    const finish = () => {
      setActiveFilter("all");
      ui.search.value = "";
      render();
      persistWorkspace();
      showToast(`Imported ${created} ${created === 1 ? "note" : "notes"} (${skipped} skipped${oversize ? `, ${oversize} over 5 MB` : ""})`);
    };
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? "");
        if (!text.trim()) {
          skipped += 1;
        } else {
          // M3 — frontmatter round-trip: properties parsed out of the --- block.
          const { metadata, body, title: frontmatterTitle } = parseFrontmatter(text);
          const title = (frontmatterTitle ?? (file.name ?? "note").replace(/\.md$/i, "").trim().slice(0, 120)) || "Untitled note";
          const record = buildNoteRecord({ title, body: body.slice(0, 100_000), metadata });
          state.notes.push(record);
          pluginManager?.emit("note:created", { ...record });
          created += 1;
        }
        if (--pending === 0) finish();
      };
      reader.onerror = () => {
        skipped += 1;
        if (--pending === 0) finish();
      };
      reader.readAsText(file);
    });
  }

  // Phase 1 — folder domain functions (shared by the UI, the plugin host
  // API, and the sandboxed RPC). They validate, mutate, emit, and return;
  // the prompt/confirm/toast UI stays in the wrappers below.
  function createFolderRecord(name) {
    const cleanName = String(name ?? "").trim().slice(0, 100);
    if (!cleanName) throw new TypeError("Folder names cannot be empty.");
    if (state.folders.some((folder) => folder.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      throw new Error("A folder with that name already exists.");
    }
    const folder = { id: makeId("folder"), name: cleanName };
    state.folders.push(folder);
    pluginManager?.emit("folder:created", { ...folder });
    return { ...folder };
  }

  function renameFolderRecord(folderId, name) {
    const folder = state.folders.find((item) => item.id === folderId);
    if (!folder) throw new Error(`Unknown xPin folder: ${folderId}`);
    const cleanName = String(name ?? "").trim().slice(0, 100);
    if (!cleanName) throw new TypeError("Folder names cannot be empty.");
    if (state.folders.some((item) => item.id !== folder.id && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      throw new Error("A folder with that name already exists.");
    }
    folder.name = cleanName;
    pluginManager?.emit("folder:updated", { ...folder });
    return { ...folder };
  }

  function deleteFolderRecord(folderId) {
    const folder = state.folders.find((item) => item.id === folderId);
    if (!folder) throw new Error(`Unknown xPin folder: ${folderId}`);
    pushUndo(`Delete folder “${folder.name}”`);
    const noteCount = state.notes.filter((note) => note.folderId === folder.id).length;
    state.folders = state.folders.filter((item) => item.id !== folder.id);
    state.notes.forEach((note) => {
      if (note.folderId === folder.id) note.folderId = null;
    });
    state.collapsed = state.collapsed.filter((id) => id !== folder.id);
    pluginManager?.emit("folder:deleted", { ...folder, noteCount });
    return { ...folder, noteCount };
  }

  async function createFolder() {
    const name = await window.xPinPhase3?.showDialog(document, {
      title: "New folder", label: "Folder name", value: "", placeholder: "e.g. Work", confirmLabel: "Create"
    });
    if (name === null || name === undefined) return;
    try {
      const folder = createFolderRecord(name);
      persistWorkspace();
      render();
      showToast(`“${folder.name}” is ready.`);
    } catch (error) {
      showToast(error.message || "Folder could not be created.");
    }
  }

  async function renameFolder(folder) {
    const name = await window.xPinPhase3?.showDialog(document, {
      title: "Rename folder", label: "Folder name", value: folder.name, confirmLabel: "Rename"
    });
    if (name === null || name === undefined) return;
    try {
      renameFolderRecord(folder.id, name);
      persistWorkspace();
      render();
      showToast("Folder renamed.");
    } catch (error) {
      showToast(error.message || "Folder could not be renamed.");
    }
  }

  function deleteFolder(folder) {
    const noteCount = state.notes.filter((note) => note.folderId === folder.id).length;
    const message = noteCount
      ? `Delete "${folder.name}"? ${noteCount} ${noteCount === 1 ? "note will" : "notes will"} move to Uncategorized.`
      : `Delete the empty "${folder.name}" folder?`;
    if (!window.confirm(message)) return;
    const removed = deleteFolderRecord(folder.id);
    persistWorkspace();
    render();
    showToast(noteCount ? `${noteCount} ${noteCount === 1 ? "note moved" : "notes moved"} to Uncategorized. Press Ctrl+Z to undo.` : "Folder deleted. Press Ctrl+Z to undo.");
    return removed;
  }

  // M2 — Trash. Deleting a note soft-deletes it: the record (with its
  // versions and properties) moves to state.trash and can be restored, or
  // permanently deleted. The old permanent-delete confirm is gone.
  function moveNoteToTrash(note) {
    pushUndo(`Delete “${note.title.trim() || "Untitled note"}”`);
    state.notes = state.notes.filter((item) => item.id !== note.id);
    state.notes.forEach((item) => {
      if (item.parentNoteId === note.id) item.parentNoteId = note.parentNoteId ?? null;
    });
    state.features.tables.forEach((table) => {
      table.columns.filter((column) => column.type === "relation" && column.targetTableId === "notes")
        .forEach((column) => table.rows.forEach((row) => {
          if (row.values[column.id] === note.id) delete row.values[column.id];
        }));
    });
    state.canvases.forEach((board) => {
      board.nodes.forEach((node) => {
        if (node.type === "file" && node.xPinNoteId === note.id) {
          node.xPinNoteId = null;
          node.file = `notes/${note.id}.md (deleted note)`;
        }
      });
    });
    state.trash.push({ ...note, deletedAt: new Date().toISOString() });
    while (state.trash.length > MAX_TRASH_NOTES) state.trash.shift();
    selectedNoteId = visibleNotes()[0]?.id ?? null;
    pluginManager?.emit("note:deleted", { ...note });
    render();
    persistWorkspace();
    showToast("Note moved to Trash. Press Ctrl+Z to undo.");
  }

  function deleteSelectedNote() {
    const note = currentNote();
    if (!note) return;
    if (!window.confirm(`Move “${note.title.trim() || "Untitled note"}” to Trash? You can restore it later.`)) return;
    moveNoteToTrash(note);
  }

  function restoreTrashNote(id) {
    const index = state.trash.findIndex((item) => item.id === id);
    if (index < 0) return false;
    pushUndo("Restore from Trash");
    const [note] = state.trash.splice(index, 1);
    const { deletedAt: _deletedAt, ...restored } = note;
    if (restored.folderId && !state.folders.some((folder) => folder.id === restored.folderId)) restored.folderId = null;
    if (restored.parentNoteId && !state.notes.some((item) => item.id === restored.parentNoteId)) restored.parentNoteId = null;
    state.notes.push(restored);
    selectedNoteId = restored.id;
    setActiveFilter("all");
    render();
    persistWorkspace();
    showToast("Note restored.");
    return true;
  }

  function permanentlyDeleteTrashNote(id) {
    const note = state.trash.find((item) => item.id === id);
    if (!note) return false;
    if (!window.confirm(`Permanently delete “${note.title.trim() || "Untitled note"}”? This cannot be undone.`)) return false;
    pushUndo("Permanently delete note");
    state.trash = state.trash.filter((item) => item.id !== id);
    recordSyncTombstone(id); // Phase 1: other devices learn of the delete
    render();
    persistWorkspace();
    showToast("Note permanently deleted.");
    return true;
  }

  function emptyTrash() {
    if (!state.trash.length) {
      showToast("Trash is already empty.");
      return false;
    }
    if (!window.confirm(`Permanently delete ${state.trash.length} ${state.trash.length === 1 ? "note" : "notes"} in Trash? This cannot be undone.`)) return false;
    pushUndo("Empty Trash");
    state.trash.forEach((item) => recordSyncTombstone(item.id)); // Phase 1
    state.trash = [];
    render();
    persistWorkspace();
    showToast("Trash emptied.");
    return true;
  }

  // Phase 1 — database domain functions (audit C3). Shared by the plugin
  // host API and the sandboxed RPC. Values are validated with the same
  // rules as the feature-suite sanitizer; rollup columns are computed and
  // cannot be written.
  const DATABASE_STATUSES = ["Not started", "In progress", "Done"];
  function findDatabaseTable(tableId) {
    const table = state.features.tables.find((item) => item.id === tableId);
    if (!table) throw new Error(`Unknown xPin database: ${tableId}`);
    return table;
  }

  function validateDatabaseRowValues(table, values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new TypeError("Database row values must be an object.");
    }
    const set = {};
    const unset = [];
    for (const [columnId, value] of Object.entries(values)) {
      const column = table.columns.find((item) => item.id === columnId);
      if (!column) throw new TypeError(`Unknown database column: ${columnId}`);
      if (column.type === "rollup") throw new TypeError("Rollup columns are computed and cannot be written.");
      if (value === undefined || value === null || value === "") {
        unset.push(columnId);
        continue;
      }
      if (column.type === "text") {
        if (typeof value !== "string" || value.length > 2000) throw new TypeError("Text values must be under 2,000 characters.");
        set[columnId] = value;
      } else if (column.type === "status") {
        if (typeof value !== "string" || !DATABASE_STATUSES.includes(value)) {
          throw new TypeError(`Status values must be one of: ${DATABASE_STATUSES.join(", ")}.`);
        }
        set[columnId] = value;
      } else if (column.type === "date") {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new TypeError("Date values must use YYYY-MM-DD.");
        }
        set[columnId] = value;
      } else if (column.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Number values must be finite numbers.");
        set[columnId] = Math.max(-1_000_000, Math.min(1_000_000, value));
      } else if (column.type === "relation") {
        if (typeof value !== "string" || value.length > 100) throw new TypeError("Relation values must be a record id.");
        const exists = column.targetTableId === "notes"
          ? state.notes.some((note) => note.id === value)
          : state.features.tables.find((item) => item.id === column.targetTableId)?.rows.some((row) => row.id === value);
        if (!exists) throw new Error("That related record no longer exists.");
        set[columnId] = value;
      }
    }
    return { set, unset };
  }

  function listDatabaseTables() {
    return state.features.tables.map((table) => ({
      id: table.id,
      name: table.name,
      view: table.view,
      columns: table.columns.map((column) => ({ id: column.id, name: column.name, type: column.type })),
      rowCount: table.rows.length
    }));
  }

  function readDatabaseRows(tableId) {
    const table = findDatabaseTable(tableId);
    return table.rows.map((row) => ({ id: row.id, values: { ...row.values } }));
  }

  function addDatabaseRow(tableId, values) {
    const table = findDatabaseTable(tableId);
    if (table.rows.length >= 5000) throw new Error("This database already has 5,000 rows.");
    const { set } = validateDatabaseRowValues(table, values ?? {});
    table.columns.forEach((column) => {
      if (column.type === "status" && set[column.id] === undefined) set[column.id] = "Not started";
    });
    const row = { id: makeId("row"), values: set };
    table.rows.push(row);
    pluginManager?.emit("database:row:changed", { tableId, rowId: row.id, action: "added" });
    persistWorkspace();
    featureSuite?.render?.();
    return { id: row.id, values: { ...row.values } };
  }

  function updateDatabaseRow(tableId, rowId, values) {
    const table = findDatabaseTable(tableId);
    const row = table.rows.find((item) => item.id === rowId);
    if (!row) throw new Error(`Unknown database row: ${rowId}`);
    const { set, unset } = validateDatabaseRowValues(table, values ?? {});
    Object.assign(row.values, set);
    unset.forEach((columnId) => delete row.values[columnId]);
    pluginManager?.emit("database:row:changed", { tableId, rowId, action: "updated" });
    persistWorkspace();
    featureSuite?.render?.();
    return { id: row.id, values: { ...row.values } };
  }

  function createPluginHost() {
    return {
      notes: Object.freeze({
        list: () => state.notes.map((note) => ({ ...note })),
        current: () => {
          const note = currentNote();
          return note ? { ...note } : null;
        },
        select: selectNote,
        create: (options) => createNote(options),
        update: (id, patch) => updateNote(id, patch),
        delete: (id, options) => deleteNote(id, options ?? {}),
        openDaily: openDailyNote
      }),
      // Phase 1 (audit C3) — folders, databases, canvas, templates, export.
      folders: Object.freeze({
        list: () => state.folders.map((folder) => ({ ...folder })),
        create: (name) => {
          const folder = createFolderRecord(name);
          persistWorkspace();
          render();
          return folder;
        },
        rename: (id, name) => {
          const folder = renameFolderRecord(id, name);
          persistWorkspace();
          render();
          return folder;
        },
        delete: (id) => {
          const folder = deleteFolderRecord(id);
          persistWorkspace();
          render();
          return folder;
        }
      }),
      databases: Object.freeze({
        list: listDatabaseTables,
        rows: readDatabaseRows,
        addRow: addDatabaseRow,
        updateRow: updateDatabaseRow
      }),
      canvas: Object.freeze({
        list: () => state.canvases.map((board) => ({
          id: board.id, name: board.name, nodes: board.nodes.length, edges: board.edges.length
        })),
        open: (id) => {
          const board = state.canvases.find((item) => item.id === id);
          if (!board) throw new Error(`Unknown xPin canvas: ${id}`);
          state.selectedCanvasId = board.id;
          selectedCanvasNodeId = null;
          switchView("canvas");
          renderCanvas();
          return { id: board.id, name: board.name };
        }
      }),
      templates: Object.freeze({
        list: () => state.templates.map((template) => ({ ...template }))
      }),
      importExport: Object.freeze({
        exportNoteMarkdown: (note) => exportNoteMarkdown(note ?? undefined),
        exportMarkdownZip: () => exportMarkdownZip()
      }),
      editor: Object.freeze({
        insertText(text) {
          if (typeof text !== "string") throw new TypeError("Inserted note content must be text.");
          if (!currentNote()) createNote();
          const start = ui.noteBody.selectionStart;
          const end = ui.noteBody.selectionEnd;
          ui.noteBody.setRangeText(text, start, end, "end");
          ui.noteBody.dispatchEvent(new Event("input", { bubbles: true }));
          ui.noteBody.focus();
        },
        jumpTo(offset) {
          const safeOffset = Math.max(0, Math.min(Number(offset) || 0, ui.noteBody.value.length));
          ui.noteBody.focus();
          ui.noteBody.setSelectionRange(safeOffset, safeOffset);
          const progress = ui.noteBody.value.length ? safeOffset / ui.noteBody.value.length : 0;
          ui.noteBody.scrollTop = progress * ui.noteBody.scrollHeight;
        }
      }),
      tags: Object.freeze({
        list: () => {
          const counts = new Map();
          state.notes.forEach((note) => {
            extractTags(`${note.title}\n${note.body}`).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
          });
          return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
        },
        active: () => state.tagFilter,
        setFilter(tag) {
          const nextFilter = tag === null ? null : String(tag).toLocaleLowerCase();
          if (nextFilter && !/^#[a-z0-9][a-z0-9/_-]*$/.test(nextFilter)) {
            throw new TypeError("Tag filters must use a #tag name.");
          }
          setActiveFilter("all");
          state.tagFilter = nextFilter;
          ui.search.value = "";
          render();
          persistWorkspace();
        }
      }),
      notify: showToast,
      openPluginManager
    };
  }

  function setupCanvasEvents() {
    byId("canvas-nav")?.addEventListener("click", () => switchView("canvas"));
    const newCanvasButton = byId("new-canvas");
    const renameBoardButton = document.createElement("button");
    renameBoardButton.type = "button";
    renameBoardButton.className = "canvas-tool-button";
    renameBoardButton.textContent = "Rename";
    renameBoardButton.setAttribute("aria-label", "Rename current board");
    renameBoardButton.title = "Rename current board";
    renameBoardButton.addEventListener("click", renameCanvasBoard);
    const deleteBoardButton = document.createElement("button");
    deleteBoardButton.type = "button";
    deleteBoardButton.className = "canvas-tool-button";
    deleteBoardButton.textContent = "Delete board";
    deleteBoardButton.setAttribute("aria-label", "Delete current board");
    deleteBoardButton.title = "Delete current board";
    deleteBoardButton.addEventListener("click", deleteCanvasBoard);
    newCanvasButton.insertAdjacentElement("afterend", deleteBoardButton);
    newCanvasButton.insertAdjacentElement("afterend", renameBoardButton);
    newCanvasButton.addEventListener("click", async () => {
      if (state.canvases.length >= MAX_CANVASES) {
        showToast(`This workspace can contain at most ${MAX_CANVASES} boards.`);
        return;
      }
      const name = await window.xPinPhase3?.showDialog(document, {
        title: "New board", label: "Board name", value: "", placeholder: "e.g. Thinking board", confirmLabel: "Create"
      });
      if (name === null || name === undefined) return;
      const cleanName = name.trim();
      if (!cleanName) return showToast("Give your board a name first.");
      const canvas = { id: makeId("canvas"), name: cleanName.slice(0, 100), nodes: [], edges: [] };
      state.canvases.push(canvas);
      state.selectedCanvasId = canvas.id;
      selectedCanvasNodeId = null;
      canvasViewportState = { x: 0, y: 0, zoom: 1 };
      pluginManager?.emit("canvas:created", { id: canvas.id, name: canvas.name });
      switchView("canvas");
      renderCanvas();
      showToast(`${canvas.name} is ready.`);
    });
    ui.canvasSelect.addEventListener("change", () => {
      state.selectedCanvasId = ui.canvasSelect.value;
      selectedCanvasNodeId = null;
      hideEdgeEditor();
      canvasViewportState = { x: 0, y: 0, zoom: 1 };
      renderCanvas();
      updateCanvasSaveStatus(persistWorkspace());
    });
    byId("add-text-node").addEventListener("click", () => addCanvasNode("text", { text: "" }));
    byId("canvas-empty-add").addEventListener("click", () => addCanvasNode("text", { text: "" }));
    byId("add-note-node").addEventListener("click", () => {
      const note = currentNote();
      if (!note) return showToast("Open a note first to add it to this board.");
      addCanvasNode("file", { file: `notes/${note.id}.md`, xPinNoteId: note.id });
    });
    byId("add-link-node").addEventListener("click", async () => {
      const value = await window.xPinPhase3?.showDialog(document, {
        title: "Add link", label: "Link URL", value: "", placeholder: "https://example.com", confirmLabel: "Add"
      });
      if (value === null || value === undefined) return;
      try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Only web links are supported.");
        addCanvasNode("link", { url: url.href });
      } catch (error) {
        showToast(error instanceof TypeError ? error.message : "Enter a valid http or https link.");
      }
    });
    byId("add-group-node").addEventListener("click", () => addCanvasNode("group", { label: "New group" }));
    byId("connect-nodes").addEventListener("click", () => {
      if (!selectedCanvasNodeId) return showToast("Select a card first, then choose Connect.");
      connectFromNodeId = selectedCanvasNodeId;
      byId("connect-nodes").setAttribute("aria-pressed", "true");
      canvasStatus("Choose another card to connect it.");
    });
    ui.canvasNodes.addEventListener("click", (event) => {
      const card = event.target.closest(".canvas-node");
      if (!card || event.target.closest(".canvas-node-remove, .canvas-note-link, .canvas-web-link, .canvas-text-editor, .canvas-group-label, .canvas-resize-handle")) return;
      selectCanvasNode(card.dataset.nodeId);
    });
    ui.canvasNodes.addEventListener("pointerdown", (event) => {
      const card = event.target.closest(".canvas-node");
      if (!card || event.target.closest(".canvas-node-remove, .canvas-text-editor, .canvas-group-label, .canvas-note-link, .canvas-web-link")) return;
      const node = currentCanvas()?.nodes.find((item) => item.id === card.dataset.nodeId);
      if (!node) return;
      selectedCanvasNodeId = node.id;
      const kind = event.target.closest(".canvas-resize-handle") ? "resize"
        : event.target.closest(".canvas-node-drag-handle") ? "drag" : null;
      if (kind) beginCanvasGesture(event, kind, node);
    });
    ui.canvasNodes.addEventListener("pointermove", (event) => {
      if (canvasGesture?.kind !== "pan") moveCanvasGesture(event);
    });
    ui.canvasNodes.addEventListener("pointerup", finishCanvasGesture);
    ui.canvasNodes.addEventListener("pointercancel", finishCanvasGesture);
    ui.canvasEdges.addEventListener("pointerdown", (event) => {
      const line = event.target instanceof Element ? event.target.closest("line") : null;
      const edgeId = line?.dataset.edgeId;
      if (!edgeId) return;
      event.stopPropagation();
      event.preventDefault();
      selectCanvasEdge(edgeId, event.clientX, event.clientY);
    });
    ui.canvasViewport.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".canvas-node, button")) return;
      beginCanvasGesture(event, "pan");
    });
    ui.canvasViewport.addEventListener("pointermove", (event) => {
      if (canvasGesture?.kind === "pan") moveCanvasGesture(event);
    });
    ui.canvasViewport.addEventListener("pointerup", finishCanvasGesture);
    ui.canvasViewport.addEventListener("pointercancel", finishCanvasGesture);
    byId("zoom-in").addEventListener("click", () => {
      canvasViewportState.zoom = Math.min(1.8, Math.round((canvasViewportState.zoom + 0.1) * 10) / 10);
      applyCanvasTransform();
    });
    byId("zoom-out").addEventListener("click", () => {
      canvasViewportState.zoom = Math.max(0.4, Math.round((canvasViewportState.zoom - 0.1) * 10) / 10);
      applyCanvasTransform();
    });
    byId("export-canvas").addEventListener("click", exportCanvas);
    byId("import-canvas").addEventListener("click", () => ui.canvasFileInput.click());
    ui.canvasFileInput.addEventListener("change", async () => {
      const [file] = ui.canvasFileInput.files ?? [];
      ui.canvasFileInput.value = "";
      if (!file) return;
      try {
        if (file.size > 2_000_000) throw new TypeError("Canvas files must be smaller than 2 MB.");
        const documentData = JSON.parse(await file.text());
        if (state.canvases.length >= MAX_CANVASES) {
          throw new TypeError(`This workspace can contain at most ${MAX_CANVASES} boards.`);
        }
        const canvas = validateCanvasDocument(documentData, file.name);
        state.canvases.push(canvas);
        state.selectedCanvasId = canvas.id;
        selectedCanvasNodeId = null;
        pluginManager?.emit("canvas:created", { id: canvas.id, name: canvas.name });
        switchView("canvas");
        renderCanvas();
        showToast(`${canvas.name} was imported.`);
      } catch (error) {
        console.error("Could not import JSON Canvas file.", error);
        canvasStatus(error.message || "Canvas file could not be imported.", true);
        showToast(error.message || "Canvas file could not be imported.");
      }
    });
  }

  function setupPluginEvents() {
    ui.pluginSearch.addEventListener("input", renderPluginManager);
    ui.pluginCategory.addEventListener("change", renderPluginManager);
    byId("import-plugin").addEventListener("click", () => ui.pluginFileInput.click());
    document.querySelectorAll(".plugin-tab").forEach((button) => {
      button.addEventListener("click", () => switchPluginTab(button.dataset.ptab));
    });
    byId("marketplace-dir-add").addEventListener("click", () => {
      const input = byId("marketplace-dir-input");
      const url = input.value.trim();
      if (!url) return;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        showToast("That is not a valid URL.");
        return;
      }
      if (parsed.protocol !== "https:") {
        showToast("Directory URLs must use https.");
        return;
      }
      const dirs = marketplaceDirList();
      if (dirs.includes(parsed.toString())) {
        showToast("That directory is already listed.");
        return;
      }
      input.value = "";
      setMarketplaceDirs([...dirs, parsed.toString()]);
      showToast("Directory added.");
    });
    byId("marketplace-refresh").addEventListener("click", () => renderMarketplace(true));
    byId("marketplace-search").addEventListener("input", () => renderMarketplace());
    ui.pluginFileInput.addEventListener("change", async () => {
      const [file] = ui.pluginFileInput.files ?? [];
      ui.pluginFileInput.value = "";
      if (!file) return;
      try {
        await importPluginFile(file);
      } catch (error) {
        console.error("Could not import plugin package.", error);
        showToast(error.message || "Plugin package could not be imported.");
      }
    });
    ui.pluginTrustCheckbox.addEventListener("change", () => {
      ui.allowPluginButton.disabled = !ui.pluginTrustCheckbox.checked;
    });
    byId("cancel-plugin-consent").addEventListener("click", closePluginConsent);
    byId("cancel-plugin-consent-footer").addEventListener("click", closePluginConsent);
    ui.allowPluginButton.addEventListener("click", approvePendingPlugin);
    byId("reject-plugin").addEventListener("click", () => {
      ui.pluginRejectRow.hidden = false;
      ui.pluginRejectReason.focus();
    });
    byId("confirm-reject-plugin").addEventListener("click", rejectPendingPlugin);
    ui.pluginConsentModal.addEventListener("click", (event) => {
      if (event.target === ui.pluginConsentModal) closePluginConsent();
    });
  }

  function setupEvents() {
    const isMac = navigator.platform.toLocaleLowerCase().includes("mac");
    byId("command-key").textContent = isMac ? "⌘" : "Ctrl";
    byId("palette-shortcut").textContent = isMac ? "⌘ P" : "Ctrl P";
    byId("open-commands").addEventListener("click", openCommandPalette);
    byId("open-plugins").addEventListener("click", openPluginManager);
    const shortcutsButton = document.createElement("button");
    shortcutsButton.type = "button";
    shortcutsButton.className = "topbar-tool";
    shortcutsButton.id = "open-shortcuts";
    shortcutsButton.innerHTML = '<span aria-hidden="true">?</span> Shortcuts';
    shortcutsButton.setAttribute("aria-label", "Open keyboard shortcuts reference");
    shortcutsButton.title = "Keyboard shortcuts (?)";
    shortcutsButton.addEventListener("click", openShortcutsDialog);
    document.querySelector(".topbar-actions .keyboard-hint")?.insertAdjacentElement("beforebegin", shortcutsButton);
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.closest(".modal-backdrop")));
    });
    document.addEventListener("click", (event) => {
      const deleteButton = event.target instanceof Element ? event.target.closest('[data-action="delete-synced-block"]') : null;
      if (!deleteButton) return;
      if (!window.confirm("Delete this shared block? Notes that reference it will show “This shared block is missing.” This cannot be undone.")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    [ui.pluginsModal, ui.commandsModal].forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) closeDialog(dialog);
      });
    });
    ui.commandSearch.addEventListener("input", () => {
      activeCommandIndex = 0;
      renderCommands();
    });
    byId("new-note").addEventListener("click", () => createNote());
    const todayButton = document.createElement("button");
    todayButton.type = "button";
    todayButton.className = "nav-item";
    todayButton.id = "today-note";
    todayButton.innerHTML = '<span class="nav-icon" aria-hidden="true">☀</span><span>Today</span>';
    todayButton.setAttribute("aria-label", "Open today's daily note");
    todayButton.title = "Open today's daily note";
    todayButton.addEventListener("click", () => openDailyNote());
    byId("canvas-nav")?.insertAdjacentElement("beforebegin", todayButton);
    ui.emptyCreate.addEventListener("click", () => createNote());
    byId("editor-create").addEventListener("click", () => createNote());
    byId("new-folder").addEventListener("click", createFolder);
    byId("list-menu").addEventListener("click", createFolder);
    ui.sort.value = state.sort;
    ui.sort.addEventListener("change", () => {
      state.sort = SORTS.includes(ui.sort.value) ? ui.sort.value : "modified-desc";
      renderList();
      persistWorkspace();
    });
    ui.search.addEventListener("input", renderList);
    document.querySelectorAll(".nav-item[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        setActiveFilter(button.dataset.filter);
        switchView("notes");
        render();
        persistWorkspace();
      });
    });
    ui.noteBody.addEventListener("keydown", handleCodeEditorKeydown);
    byId("insert-code-block").addEventListener("click", insertCodeBlock);
    // Phase 2 — attachments: file picker + drag-drop onto the editor.
    const attachButton = byId("attach-file");
    const attachInput = byId("attachment-file-input");
    if (attachButton && attachInput) {
      attachButton.addEventListener("click", () => attachInput.click());
      attachInput.addEventListener("change", () => {
        attachFiles(attachInput.files);
        attachInput.value = "";
      });
    }
    ui.noteBody.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types?.includes?.("Files")) event.preventDefault();
    });
    ui.noteBody.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      if (files?.length) {
        event.preventDefault();
        attachFiles(files);
      }
    });
    // Phase 2 — Capture & smarts nav (Read Later / Flashcards / Capture).
    document.querySelectorAll("[data-phase2-view]").forEach((button) => {
      button.addEventListener("click", () => openPhase2View(button.dataset.phase2View));
    });
    document.querySelectorAll("[data-phase3-view]").forEach((button) => {
      button.addEventListener("click", () => openPhase3View());
    });
    ui.togglePreview.addEventListener("click", () => setPreviewMode(!previewMode));
    ui.noteTitle.addEventListener("input", () => updateSelectedNote({ title: ui.noteTitle.value }));
    byId("export-note-markdown").addEventListener("click", () => exportNoteMarkdown());
    ui.noteBody.addEventListener("input", () => {
      updateSelectedNote({ body: ui.noteBody.value });
    });
    ui.noteFolder.addEventListener("change", () => {
      updateSelectedNote({ folderId: ui.noteFolder.value || null });
      renderEditor();
    });
    ui.noteParent.addEventListener("change", () => {
      const note = currentNote();
      if (!note) return;
      const parentId = ui.noteParent.value || null;
      if (parentId === note.id) {
        showToast("A page cannot be its own parent.");
        renderEditor();
        return;
      }
      const descendants = new Set();
      const collect = (id) => state.notes.filter((item) => item.parentNoteId === id).forEach((item) => {
        descendants.add(item.id);
        collect(item.id);
      });
      collect(note.id);
      if (parentId && descendants.has(parentId)) {
        showToast("A page cannot be moved inside one of its own sub-pages.");
        renderEditor();
        return;
      }
      updateSelectedNote({ parentNoteId: parentId });
    });
    ui.pinButton.addEventListener("click", () => {
      const note = currentNote();
      if (!note) return;
      note.pinned = !note.pinned;
      note.updatedAt = new Date().toISOString();
      render();
      persistWorkspace();
      pluginManager?.emit("note:updated", { ...note });
      showToast(note.pinned ? "Pinned for later." : "Pin removed.");
    });
    ui.deleteButton.addEventListener("click", deleteSelectedNote);
    document.addEventListener("keydown", (event) => {
      const command = isMac ? event.metaKey : event.ctrlKey;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
      const activeDialog = !ui.pluginConsentModal.hidden
        ? ui.pluginConsentModal
        : !ui.commandsModal.hidden ? ui.commandsModal : !ui.pluginsModal.hidden ? ui.pluginsModal
        : shortcutsDialog && !shortcutsDialog.hidden ? shortcutsDialog : null;
      if (event.key === "Tab" && activeDialog) {
        const focusable = [...activeDialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          .filter((element) => element.getClientRects().length > 0);
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !activeDialog.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !activeDialog.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
          }
        }
      }
      if (!ui.pluginConsentModal.hidden) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePluginConsent();
        }
        return;
      }
      if (!ui.commandsModal.hidden) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeDialog(ui.commandsModal);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const count = ui.commandList.querySelectorAll(".command-option").length;
          if (count) {
            activeCommandIndex = (activeCommandIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
            renderCommands();
          }
        } else if (event.key === "Enter") {
          event.preventDefault();
          const commands = availableCommands().filter((item) =>
            `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(ui.commandSearch.value.trim().toLocaleLowerCase())
          );
          if (commands[activeCommandIndex]) runCommand(commands[activeCommandIndex]);
        }
        return;
      }
      if (!ui.pluginsModal.hidden && event.key === "Escape") {
        event.preventDefault();
        closeDialog(ui.pluginsModal);
        return;
      }
      if (shortcutsDialog && !shortcutsDialog.hidden && event.key === "Escape") {
        event.preventDefault();
        closeShortcutsDialog();
        return;
      }
      if (command && event.shiftKey && event.key.toLocaleLowerCase() === "c") {
        event.preventDefault();
        openQuickCaptureDialog();
        return;
      }
      if (command && !event.shiftKey && event.key.toLocaleLowerCase() === "z" && !typing) {
        // M2 — undo for structural actions. Typing in an input/textarea keeps
        // the browser's own text undo; this only fires outside editable fields.
        event.preventDefault();
        undoLastAction();
        return;
      }
      if (command && event.key.toLocaleLowerCase() === "p") {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (command && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        ui.search.focus();
        ui.search.select();
      } else if (!command && event.key.toLocaleLowerCase() === "n" && !typing) {
        event.preventDefault();
        createNote();
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        ui.search.focus();
      } else if (event.key === "?" && !typing) {
        event.preventDefault();
        openShortcutsDialog();
      } else if (event.key === "Escape" && selectedCanvasEdgeId && !typing) {
        event.preventDefault();
        hideEdgeEditor();
        renderCanvas();
      } else if (state.view === "canvas" && event.key === "Delete" && selectedCanvasNodeId && !typing) {
        removeCanvasNode(selectedCanvasNodeId);
      }
    });
    window.addEventListener("pagehide", flushSave);
    window.addEventListener("pagehide", () => {
      if (canvasSaveTimer !== null) {
        window.clearTimeout(canvasSaveTimer);
        canvasSaveTimer = null;
        persistWorkspace();
      }
      for (const sandbox of activeExtensions.values()) sandbox.stop();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushSave();
        if (canvasSaveTimer !== null) {
          window.clearTimeout(canvasSaveTimer);
          canvasSaveTimer = null;
          persistWorkspace();
        }
      }
    });
    setupCanvasEvents();
    setupPluginEvents();
    setupSlashMenuKeyboard();
    setupLinkAutocomplete();
    observeCoreToolsSections();
    registerCoreCommands();
    featureSuite.setup();
  }

  const KNOWN_FEATURE_VIEWS = ["database", "graph", "settings"];
  const restoredFeatureView = KNOWN_FEATURE_VIEWS.includes(state.features.activeView) ? state.features.activeView : null;
  state.features.activeView = null;
  featureSuite = window.xPinFeatures.create({
    getState: () => state,
    currentNote,
    createNote,
    selectNote,
    persist: persistWorkspace,
    flushSave,
    notify: showToast,
    emit: (name, detail) => pluginManager?.emit(name, detail),
    render,
    extractTags,
    storageKey: STORAGE_KEY,
    storageInfo,
    renderMarkdown: markdownToHtml,
    exportNoteMarkdown,
    exportMarkdownZip,
    insertText(text) {
      if (!currentNote()) createNote();
      const start = ui.noteBody.selectionStart;
      const end = ui.noteBody.selectionEnd;
      ui.noteBody.setRangeText(text, start, end, "end");
      ui.noteBody.dispatchEvent(new Event("input", { bubbles: true }));
      ui.noteBody.focus();
    }
  });
  setActiveFilter(state.filter);
  pluginManager = window.xPinPluginSystem.create({
    definitions: window.xPinPlugins,
    savedState: state.plugins,
    host: createPluginHost(),
    onChange() {
      state.plugins = pluginManager.serialize();
      persistWorkspace();
      renderPluginManager();
      renderPluginPanels();
      renderEditorStatus();
    }
  });
  // Phase 1 — first-party domain surface for the fabriX adapter (spec §10)
  // and sync. First-party scripts only; plugins go through the host API /
  // sandboxed RPC and never see this object.
  window.xPinDomain = Object.freeze({
    getState: () => state,
    createNote,
    updateNote,
    deleteNote,
    selectNote,
    captureToInbox,
    exportNoteMarkdown,
    exportMarkdownZip,
    publishCurrentNote,
    on: (name, callback) => pluginManager?.on(name, callback)
  });
  // Phase 2 — Capture & smarts UI (voice, read-later, flashcards,
  // highlights, importers, AI). Guarded: a UI failure must never break boot.
  try {
    phase2UI = window.xPinPhase2?.createPhase2UI({
      getState: () => state,
      persist: persistWorkspace,
      render,
      toast: showToast,
      notify: showToast,
      createNote,
      selectNote,
      openDailyNote,
      currentNote,
      getAiKey,
      setAiKey,
      aiKeyPresent,
      credentialsUnlocked: () => window.xPinCredentials?.isUnlocked() ?? false,
      unlockCredentials: unlockPhase2Credentials
    }) ?? null;
    phase2UI?.renderDailyStrip();
  } catch (error) {
    console.error("Could not start Capture & smarts.", error);
  }
  // Phase 3 — Power & polish UI (scripts, typed blocks, queries, tasks +
  // calendar, sharing/comments, appearance, Android back button). Guarded:
  // a UI failure must never break boot.
  try {
    phase3UI = window.xPinPhase3?.createPhase3UI({
      getState: () => state,
      persist: persistWorkspace,
      render,
      toast: showToast,
      notify: showToast,
      createNote,
      updateNote,
      selectNote,
      currentNote,
      openDailyNote,
      captureToInbox,
      handleDeepLink,
      getDeviceId: () => state.sync.deviceId ?? "",
      emit: (name, detail) => pluginManager?.emit(name, detail),
      on: (name, callback) => pluginManager?.on(name, callback),
      openFeatureView: (view) => featureSuite?.open(view),
      setFeatureQuery: (query) => {
        state.features.query = String(query ?? "").slice(0, 500);
        featureSuite?.open("database");
      },
      showNotesView,
      renderPreview: (body) => renderMarkdownPreview(body),
      insertText(text) {
        if (!currentNote()) createNote();
        const start = ui.noteBody.selectionStart;
        const end = ui.noteBody.selectionEnd;
        ui.noteBody.setRangeText(text, start, end, "end");
        ui.noteBody.dispatchEvent(new Event("input", { bubbles: true }));
        ui.noteBody.focus();
      }
    }) ?? null;
  } catch (error) {
    console.error("Could not start Power & polish.", error);
  }
  setupEvents();
  render();
  switchView(state.view);
  reconcileIdbStore(); // M4: migrate to / reconcile with IndexedDB (async, no-op without it)
  setupDeepLinks(); // Phase 1: xpin:// links from the hash fallback + Capacitor App
  // Phase 2 — daily note is the landing page (default ON). Skipped when a
  // deep link already chose a destination (hash present).
  if (state.settings.dailyLanding && !(window.location?.hash ?? "")) {
    try {
      openDailyNote();
    } catch (error) {
      console.error("Could not open today's note.", error);
    }
  }
  if (restoredFeatureView) featureSuite.open(restoredFeatureView);
  pluginManager.start().then(() => {
    state.plugins = pluginManager.serialize();
    persistWorkspace();
    pluginManager.emit("note:opened", currentNote());
    renderPluginManager();
    render();
    return startSavedExtensions();
  }).catch((error) => {
    console.error("Could not start xPin plugins.", error);
    showToast("Some xPin features could not be started.");
  });
})();
