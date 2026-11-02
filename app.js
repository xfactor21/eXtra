(() => {
  "use strict";

  const STORAGE_KEY = "xPin.workspace.v1";
  const LEGACY_STORAGE_KEYS = ["xpin.workspace.v1", "pinboard.workspace.v1"]; // pre-rename keys; migrated once on first run, newest first
  const SAVE_DELAY = 2000;
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
  let saveTimer = null;
  let toastTimer = null;
  let pluginManager = null;
  let featureSuite = null;
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
        if (!note || typeof note.id !== "string" || !note.id ||
          typeof note.title !== "string" || noteIds.has(note.id)) return [];
        noteIds.add(note.id);
        const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
          ? value
          : new Date(0).toISOString();
        return [{
          id: note.id,
          title: note.title,
          body: typeof note.body === "string" ? note.body : "",
          folderId: typeof note.folderId === "string" && folderIds.has(note.folderId) ? note.folderId : null,
          pinned: note.pinned === true,
          parentNoteId: typeof note.parentNoteId === "string" ? note.parentNoteId : null,
          createdAt: validDate(note.createdAt),
          updatedAt: validDate(note.updatedAt),
          metadata: note.metadata && typeof note.metadata === "object" && !Array.isArray(note.metadata)
            ? note.metadata
            : {}
        }];
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
        sort: SORTS.includes(parsed.sort) ? parsed.sort : "modified-desc",
        filter: ["all", "pinned", "recent"].includes(parsed.filter) ? parsed.filter : "all",
        view: parsed.view === "canvas" ? "canvas" : "notes",
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((id) => typeof id === "string") : [],
        tagFilter: typeof parsed.tagFilter === "string" ? parsed.tagFilter : null,
        selectedCanvasId: typeof parsed.selectedCanvasId === "string" ? parsed.selectedCanvasId : "canvas-main",
        canvases: sanitizeCanvases(parsed.canvases),
        extensions: sanitizeExtensions(parsed.extensions),
        templates: sanitizeTemplates(parsed.templates),
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

  function persistWorkspace() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveState("saved");
      return true;
    } catch (error) {
      console.error("Could not save the xPin workspace.", error);
      setSaveState("error");
      showToast("Could not save on this device. Check browser storage settings.");
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

  function visibleNotes() {
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
    } else {
      const query = rawQuery.toLocaleLowerCase();
      if (query) {
        notes = notes.filter((note) => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(query));
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
    row.addEventListener("click", () => selectNote(note.id));
    return row;
  }

  function renderList() {
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
    ui.listCount.textContent = `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
    if (empty) {
      ui.emptyTitle.textContent = ui.search.value ? "No matching notes" : state.tagFilter ? `Nothing tagged ${state.tagFilter}` : state.filter === "pinned" ? "Nothing pinned yet" : "No notes yet";
      ui.emptyDescription.textContent = ui.search.value ? "Try a different search." : state.tagFilter ? "Add this tag to a note to see it here." : "Start with one small thought.";
      ui.emptyCreate.hidden = Boolean(ui.search.value);
    }

    byId("all-count").textContent = String(state.notes.length);
    byId("pinned-count").textContent = String(state.notes.filter((note) => note.pinned).length);
    const labels = { all: ["All notes", "ALL NOTES"], pinned: ["Pinned", "PINNED"], recent: ["Recent notes", "RECENT NOTES"] };
    const [label, heading] = labels[state.filter];
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
    state.view = view === "canvas" ? "canvas" : "notes";
    const isCanvas = state.view === "canvas";
    ui.currentView.textContent = isCanvas ? "Canvas" : (state.tagFilter ? `Tagged ${state.tagFilter}` : state.filter === "all" ? "All notes" : state.filter === "pinned" ? "Pinned" : "Recent notes");
    byId("notes-toolbar").hidden = isCanvas;
    byId("notes-layout").hidden = isCanvas;
    ui.canvasView.hidden = !isCanvas;
    byId("new-folder").hidden = isCanvas;
    ui.pageTitle.innerHTML = `${isCanvas ? "Canvas" : (state.tagFilter ? `Tag ${escapeText(state.tagFilter)}` : state.filter === "all" ? "Your notes" : escapeText(state.filter === "pinned" ? "Pinned" : "Recent notes"))}<span class="title-period">.</span>`;
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

  function renameCanvasBoard() {
    const board = currentCanvas();
    if (!board) return;
    const name = window.prompt("Rename this board:", board.name);
    if (name === null) return;
    const cleanName = name.trim().slice(0, 100);
    if (!cleanName) return showToast("Board names cannot be empty.");
    board.name = cleanName;
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

  function appendInlineMarkdown(element, source) {
    const pattern = /(!\[[^\]]*\]\([^)]+\)|\[\[[^\]]+\]\]|`[^`]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?!\s)(.+?)\*|_(?!\s)(.+?)_)/g;
    let previous = 0;
    for (const match of source.matchAll(pattern)) {
      element.append(document.createTextNode(source.slice(previous, match.index)));
      const token = match[0];
      let rendered;
      if (token.startsWith("![")) {
        rendered = document.createTextNode(token);
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
  }

  function setPreviewMode(enabled) {
    previewMode = Boolean(enabled);
    ui.noteBody.hidden = previewMode;
    ui.markdownPreview.hidden = !previewMode || !currentNote();
    ui.togglePreview.setAttribute("aria-pressed", String(previewMode));
    ui.togglePreview.textContent = previewMode ? "Edit" : "Preview";
    if (previewMode) renderMarkdownPreview(currentNote()?.body ?? "");
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

  function availableCommands() {
    return [
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
      const patch = payload?.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("Plugin note update requires a patch object with title and/or body.");
      }
      const changes = {};
      if (patch.title !== undefined) {
        if (typeof patch.title !== "string" || patch.title.length > 120) {
          throw new TypeError("Plugin note title must be text under 120 characters.");
        }
        changes.title = patch.title;
      }
      if (patch.body !== undefined) {
        if (typeof patch.body !== "string" || patch.body.length > 100_000) {
          throw new TypeError("Plugin note body must be text under 100 KB.");
        }
        changes.body = patch.body;
      }
      if (!Object.keys(changes).length) throw new TypeError("Plugin note update changed nothing.");
      const note = state.notes.find((item) => item.id === payload.id);
      if (!note) throw new Error("The note no longer exists.");
      Object.assign(note, changes, { updatedAt: new Date().toISOString() });
      refreshNoteRow(note.id);
      if (note.id === selectedNoteId) renderEditor();
      pluginManager?.emit("note:updated", { ...note });
      renderPluginPanels();
      renderEditorStatus();
      persistWorkspace();
      return { ...note };
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
    throw new Error("Unknown plugin capability.");
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
  async function importPluginPackage(parsed, fileName, provenance) {
    const plugin = window.xPinSandbox.validatePackage(parsed);
    const clash = state.extensions.find((item) => item.manifest.id === plugin.manifest.id);
    if (pluginManager.plugins().some((item) => item.id === plugin.manifest.id)) {
      throw new Error(`"${plugin.manifest.name}" clashes with a built-in xPin feature id. Pick a different plugin id.`);
    }
    if (clash) {
      throw new Error(`"${clash.manifest.name}" v${clash.manifest.version} is already installed. Remove it first to import v${plugin.manifest.version}.`);
    }
    const sha256 = await window.xPinSandbox.digestPackage(plugin);
    if (!sha256) throw new Error("This browser cannot calculate a package fingerprint, so the plugin was not installed.");
    state.extensions.push({
      ...plugin,
      fileName,
      sha256,
      installedAt: new Date().toISOString(),
      installedFrom: provenance ?? "local file",
      enabled: false,
      approvedHash: null,
      grants: [],
      settings: {},
      reviewStatus: "pending",
      reviewReason: null,
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
  let marketplaceEntries = [];
  let marketplaceNotice = "";

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
        index = cachedIndex;
        cached = true;
      } else {
        try {
          index = await fetchMarketplaceIndex(dirUrl);
        } catch (error) {
          // Offline or unreachable: fall back to the last good index so the
          // directory stays browsable. The problem is reported in the status
          // line and each entry is badged as an offline copy.
          if (cachedIndex) {
            index = cachedIndex;
            cached = true;
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
      status.textContent = `Some directories could not be reached: ${problems.join("; ")}.`;
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
      if (installedVersion) {
        button.disabled = true;
        button.textContent = `Installed (v${installedVersion})`;
      } else {
        button.textContent = "Install";
        button.addEventListener("click", () => installMarketplacePlugin(entry));
      }
      actions.append(button);
      card.append(head, description, meta, caps, actions);
      list.append(card);
    }
    marketplaceNotice = problems.join("; ");
  }

  async function installMarketplacePlugin(entry) {
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
      await importPluginPackage(parsed, fileName, `marketplace: ${entry.dirUrl}`);
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
      `Local package: ${plugin.fileName} · SHA-256 ${plugin.sha256.slice(0, 16)}… · Author is self-reported; this fingerprint is not a signature.`;
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
      showToast(`${command.name} could not be completed.`);
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
    if (state.view === "canvas") renderCanvas();
    featureSuite?.render();
    renderCoreToolsSections();
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
    Object.assign(note, changes, { updatedAt: new Date().toISOString() });
    ui.editorDate.textContent = `EDITED ${formatRelative(note.updatedAt).toLocaleUpperCase()}`;
    refreshNoteRow(note.id);
    pluginManager?.emit("note:updated", { ...note });
    renderPluginPanels();
    renderEditorStatus();
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
    return { id: makeId("note"), title, body, folderId, parentNoteId, pinned: false, createdAt: now, updatedAt: now, metadata: { ...metadata } };
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
    wrap.append(templatesSection, renderImportSection());
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
          const title = (file.name ?? "note").replace(/\.md$/i, "").trim().slice(0, 120) || "Untitled note";
          const record = buildNoteRecord({ title, body: text.slice(0, 100_000) });
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

  function createFolder() {
    const name = window.prompt("Name your new folder:");
    if (name === null) return;
    const cleanName = name.trim().slice(0, 100);
    if (!cleanName) {
      showToast("Give your folder a name first.");
      return;
    }
    if (state.folders.some((folder) => folder.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      showToast("A folder with that name already exists.");
      return;
    }
    state.folders.push({ id: makeId("folder"), name: cleanName.slice(0, 100) });
    persistWorkspace();
    render();
    showToast(`“${cleanName}” is ready.`);
  }

  function renameFolder(folder) {
    const name = window.prompt("Rename this folder:", folder.name);
    if (name === null) return;
    const cleanName = name.trim().slice(0, 100);
    if (!cleanName) return showToast("Folder names cannot be empty.");
    if (state.folders.some((item) => item.id !== folder.id && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      return showToast("A folder with that name already exists.");
    }
    folder.name = cleanName.slice(0, 100);
    persistWorkspace();
    render();
    showToast("Folder renamed.");
  }

  function deleteFolder(folder) {
    const noteCount = state.notes.filter((note) => note.folderId === folder.id).length;
    const message = noteCount
      ? `Delete "${folder.name}"? ${noteCount} ${noteCount === 1 ? "note will" : "notes will"} move to Uncategorized.`
      : `Delete the empty "${folder.name}" folder?`;
    if (!window.confirm(message)) return;
    state.folders = state.folders.filter((item) => item.id !== folder.id);
    state.notes.forEach((note) => {
      if (note.folderId === folder.id) note.folderId = null;
    });
    state.collapsed = state.collapsed.filter((id) => id !== folder.id);
    persistWorkspace();
    render();
    showToast(noteCount ? `${noteCount} ${noteCount === 1 ? "note moved" : "notes moved"} to Uncategorized.` : "Folder deleted.");
  }

  function deleteSelectedNote() {
    const note = currentNote();
    if (!note) return;
    if (!window.confirm(`Delete “${note.title.trim() || "Untitled note"}”? This cannot be undone.`)) return;
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
    selectedNoteId = visibleNotes()[0]?.id ?? null;
    pluginManager?.emit("note:deleted", { ...note });
    render();
    persistWorkspace();
    showToast("Note deleted.");
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
        openDaily: openDailyNote
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
    newCanvasButton.addEventListener("click", () => {
      if (state.canvases.length >= MAX_CANVASES) {
        showToast(`This workspace can contain at most ${MAX_CANVASES} boards.`);
        return;
      }
      const name = window.prompt("Name your new board:");
      if (name === null) return;
      const cleanName = name.trim();
      if (!cleanName) return showToast("Give your board a name first.");
      const canvas = { id: makeId("canvas"), name: cleanName.slice(0, 100), nodes: [], edges: [] };
      state.canvases.push(canvas);
      state.selectedCanvasId = canvas.id;
      selectedCanvasNodeId = null;
      canvasViewportState = { x: 0, y: 0, zoom: 1 };
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
    byId("add-link-node").addEventListener("click", () => {
      const value = window.prompt("Enter an http or https link:");
      if (value === null) return;
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
    ui.togglePreview.addEventListener("click", () => setPreviewMode(!previewMode));
    ui.noteTitle.addEventListener("input", () => updateSelectedNote({ title: ui.noteTitle.value }));
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
    render,
    extractTags,
    storageKey: STORAGE_KEY,
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
  setupEvents();
  render();
  switchView(state.view);
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
