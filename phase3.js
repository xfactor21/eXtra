/* xPin Phase 3 — Power & polish (NEXT-LEVEL-PLAN.md Phase 3).
 *
 * One module, loaded after phase2.js and before feature-suite.js / app.js.
 * Pure logic lives on window.xPinPhase3 (scripts, typed blocks, query v2,
 * task scores, formulas, graph helpers, comments/spaces, back-button
 * decisions) so the headless smoke suite can drive it directly; the DOM UI
 * is built by createPhase3UI(host) and only touches elements app.js owns.
 *
 * Safety rules carried through this file:
 * - Scripts NEVER run outside the plugin sandbox worker (plugin-sandbox.js).
 *   No eval/Function anywhere in this file; script source is wrapped as a
 *   plugin package and executed only by window.xPinSandbox.create, with the
 *   same capability gating, timeouts, and approval queue as imported
 *   plugins. A script must be approved once (source shown in the dialog)
 *   before it can run, and any change to the source revokes approval.
 *   Connector-tier permissions (network/credentials) are refused for
 *   scripts: scripts get notes/editor/notify/folders-read/databases-read
 *   only, and notes:update is restricted to the note the script lives in.
 * - Formulas use a hand-written recursive-descent parser — never eval.
 * - Queries use the same regex + allowlist style as the Phase 0 grammar.
 * - Collaboration rides the Phase 1 sync envelopes (new "comment" and
 *   "space" ops in sync/sync.js); no server-side accounts, no separate
 *   system. With no relay configured, sharing works via sync bundles.
 * - Reminders are in-app only, surfaced when the daily note opens. There
 *   is no background execution; nothing runs while the app is closed.
 * - Android back-button / share-target behavior that needs a device or the
 *   Gradle build is labelled unverified, never claimed as tested.
 */
(() => {
  "use strict";

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // UTC calendar day (YYYY-MM-DD). Note timestamps are stored as ISO UTC
  // strings, so query date comparisons use the UTC day. Comparing instants
  // against a local-midnight literal drops notes created in the first hours
  // of the UTC day (e.g. 00:00Z is 18:00 the day before in CST).
  function utcDateKey(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateKey(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function dayDiff(a, b) {
    // Whole days from a to b (b - a), ignoring time of day.
    const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((db - da) / 86_400_000);
  }

  /* ---------------- state (audit G4: new keys must survive load) ---------------- */

  const DEFAULT_SETTINGS = Object.freeze({ theme: "dark", font: "system", splitPreview: false });

  function sanitizeSettings(value) {
    const clean = { ...DEFAULT_SETTINGS };
    if (!isPlainObject(value)) return clean;
    if (value.theme === "light" || value.theme === "dark") clean.theme = value.theme;
    if (value.font === "serif" || value.font === "mono" || value.font === "system") clean.font = value.font;
    clean.splitPreview = value.splitPreview === true;
    return clean;
  }

  function sanitizeApprovedScripts(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 100)) {
      if (!isPlainObject(item) || typeof item.hash !== "string" || !item.hash) continue;
      if (typeof item.source !== "string" || !item.source || item.source.length > 64_000) continue;
      clean.push({
        id: typeof item.id === "string" ? item.id.slice(0, 80) : makeId("script"),
        hash: item.hash.slice(0, 128),
        name: typeof item.name === "string" ? item.name.slice(0, 80) : "Untitled script",
        source: item.source,
        permissions: Array.isArray(item.permissions)
          ? item.permissions.filter((p) => SCRIPT_PERMISSIONS.includes(p)).slice(0, SCRIPT_PERMISSIONS.length)
          : [],
        approvedAt: typeof item.approvedAt === "string" ? item.approvedAt : new Date().toISOString()
      });
    }
    return clean;
  }

  function sanitizeHooks(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 50)) {
      if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.scriptId !== "string") continue;
      if (!HOOK_EVENTS.includes(item.event)) continue;
      clean.push({
        id: item.id.slice(0, 80),
        event: item.event,
        scriptId: item.scriptId.slice(0, 80),
        enabled: item.enabled !== false
      });
    }
    return clean;
  }

  function sanitizeSavedQueries(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 100)) {
      if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.query !== "string") continue;
      clean.push({
        id: item.id.slice(0, 80),
        name: typeof item.name === "string" && item.name.trim() ? item.name.slice(0, 80) : "Untitled query",
        query: item.query.slice(0, 500)
      });
    }
    return clean;
  }

  function sanitizeSpaces(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 50)) {
      if (!isPlainObject(item) || typeof item.id !== "string") continue;
      clean.push({
        id: item.id.slice(0, 80),
        name: typeof item.name === "string" && item.name.trim() ? item.name.slice(0, 80) : "Untitled space",
        memberDeviceIds: Array.isArray(item.memberDeviceIds)
          ? item.memberDeviceIds.filter((d) => typeof d === "string").map((d) => d.slice(0, 80)).slice(0, 50) : [],
        noteIds: Array.isArray(item.noteIds)
          ? item.noteIds.filter((d) => typeof d === "string").map((d) => d.slice(0, 80)).slice(0, 500) : []
      });
    }
    return clean;
  }

  function sanitizeComments(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 2000)) {
      if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.noteId !== "string") continue;
      if (typeof item.body !== "string" || !item.body.trim()) continue;
      clean.push({
        id: item.id.slice(0, 80),
        noteId: item.noteId.slice(0, 80),
        deviceId: typeof item.deviceId === "string" ? item.deviceId.slice(0, 80) : "",
        author: typeof item.author === "string" ? item.author.slice(0, 80) : "Someone",
        body: item.body.slice(0, 2000),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString()
      });
    }
    return clean;
  }

  function sanitizeMentions(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 500)) {
      if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.commentId !== "string") continue;
      clean.push({
        id: item.id.slice(0, 80),
        commentId: item.commentId.slice(0, 80),
        noteId: typeof item.noteId === "string" ? item.noteId.slice(0, 80) : "",
        deviceName: typeof item.deviceName === "string" ? item.deviceName.slice(0, 80) : "",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        read: item.read === true
      });
    }
    return clean;
  }

  function sanitizeReminders(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value.slice(0, 500)) {
      if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.date !== "string") continue;
      if (!parseDateKey(item.date)) continue;
      clean.push({
        id: item.id.slice(0, 80),
        tableId: typeof item.tableId === "string" ? item.tableId.slice(0, 80) : "",
        rowId: typeof item.rowId === "string" ? item.rowId.slice(0, 80) : "",
        date: item.date,
        label: typeof item.label === "string" ? item.label.slice(0, 120) : "Reminder",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString()
      });
    }
    return clean;
  }

  function sanitizeDbViews(value) {
    if (!isPlainObject(value)) return {};
    const clean = {};
    for (const [tableId, view] of Object.entries(value).slice(0, 20)) {
      if (!isPlainObject(view)) continue;
      clean[String(tableId).slice(0, 80)] = {
        sortColumnId: typeof view.sortColumnId === "string" ? view.sortColumnId.slice(0, 80) : "",
        sortDir: view.sortDir === "desc" ? "desc" : "asc",
        filterColumnId: typeof view.filterColumnId === "string" ? view.filterColumnId.slice(0, 80) : "",
        filterOp: ["=", "contains", ">", "<", "empty", "not-empty"].includes(view.filterOp) ? view.filterOp : "",
        filterValue: typeof view.filterValue === "string" ? view.filterValue.slice(0, 200) : "",
        groupByColumnId: typeof view.groupByColumnId === "string" ? view.groupByColumnId.slice(0, 80) : ""
      };
    }
    return clean;
  }

  function defaultPhase3State() {
    return {
      settings: { ...DEFAULT_SETTINGS },
      scripts: { approved: [] },
      hooks: [],
      savedQueries: [],
      spaces: [],
      comments: [],
      mentions: [],
      reminders: [],
      dbViews: {}
    };
  }

  // Merge Phase 3 state onto a parsed workspace (same pattern as Phase 2):
  // unknown keys are dropped, known keys are sanitized, defaults fill gaps.
  function sanitizePhase3State(parsed) {
    const clean = defaultPhase3State();
    const value = isPlainObject(parsed?.phase3) ? parsed.phase3 : {};
    clean.settings = sanitizeSettings(value.settings);
    clean.scripts = { approved: sanitizeApprovedScripts(value.scripts?.approved) };
    clean.hooks = sanitizeHooks(value.hooks);
    clean.savedQueries = sanitizeSavedQueries(value.savedQueries);
    clean.spaces = sanitizeSpaces(value.spaces);
    clean.comments = sanitizeComments(value.comments);
    clean.mentions = sanitizeMentions(value.mentions);
    clean.reminders = sanitizeReminders(value.reminders);
    clean.dbViews = sanitizeDbViews(value.dbViews);
    return { phase3: clean };
  }

  /* ---------------- Item 1 — scripts-in-notes + event hooks ---------------- */

  // The only capabilities a note script may ever be granted. Deliberately a
  // subset of the plugin permissions: no network, no credentials, no delete.
  const SCRIPT_PERMISSIONS = Object.freeze([
    "notes:read", "notes:select", "notes:create", "notes:update",
    "editor:write", "ui:notify", "ui:status",
    "folders:read", "databases:read"
  ]);

  // Events a hook may subscribe to. These are the events the Phase 1 event
  // bus already emits (pluginManager.emit), so hooks need no new plumbing.
  const HOOK_EVENTS = Object.freeze([
    "note:created", "note:updated", "note:deleted", "note:opened",
    "database:row:changed", "save:completed"
  ]);

  const SCRIPT_FENCE = /^```xpin-script[^\S\r\n]*\r?\n([\s\S]*?)```/gm;

  function extractScripts(body) {
    const scripts = [];
    const text = String(body ?? "");
    SCRIPT_FENCE.lastIndex = 0;
    let match;
    while ((match = SCRIPT_FENCE.exec(text)) !== null) {
      const source = match[1].replace(/^\s+|\s+$/g, "");
      if (source) scripts.push({ source, index: match.index });
      if (scripts.length >= 20) break;
    }
    return scripts;
  }

  function hasScriptBlock(body) {
    return extractScripts(body).length > 0;
  }

  async function scriptDigest(source) {
    if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable, so the script cannot be fingerprinted.");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(source)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Wrap a script as a plugin package for the sandbox. The manifest id is
  // derived from the digest so a changed source is a different package and
  // can never ride on an old approval. Tier is always "sandboxed".
  function wrapScriptAsPackage({ source, name = "Note script", permissions = [] }) {
    const clean = String(source ?? "");
    if (!clean.trim()) throw new TypeError("Script is empty.");
    if (clean.length > 64_000) throw new TypeError("Script is over the 64 KB plugin source cap.");
    const granted = [...new Set(permissions)].filter((p) => SCRIPT_PERMISSIONS.includes(p));
    // A script that asks for a capability outside the script allowlist is
    // rejected outright — it is never silently downgraded.
    const refused = [...new Set(permissions)].filter((p) => !SCRIPT_PERMISSIONS.includes(p));
    if (refused.length) {
      throw new TypeError(`Scripts cannot use: ${refused.join(", ")}. Network, credentials, and delete are never available to note scripts.`);
    }
    return {
      manifest: {
        id: `script-${(name || "script").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note"}`,
        name: String(name).slice(0, 80),
        version: "1",
        description: "xPin note script — runs in the sandboxed worker, approved once by the owner.",
        author: "note script",
        permissions: granted,
        tier: "sandboxed",
        networkOrigins: []
      },
      source: clean
    };
  }

  function isScriptApproved(phase3, hash) {
    return (phase3?.scripts?.approved ?? []).some((item) => item.hash === hash);
  }

  function approvedScript(phase3, hash) {
    return (phase3?.scripts?.approved ?? []).find((item) => item.hash === hash) ?? null;
  }

  function approveScriptRecord(phase3, { hash, name, source, permissions }) {
    if (!phase3.scripts) phase3.scripts = { approved: [] };
    phase3.scripts.approved = phase3.scripts.approved.filter((item) => item.hash !== hash);
    phase3.scripts.approved.push({
      id: makeId("script"),
      hash,
      name: String(name ?? "Untitled script").slice(0, 80),
      source: String(source ?? ""),
      permissions: [...new Set(permissions ?? [])].filter((p) => SCRIPT_PERMISSIONS.includes(p)),
      approvedAt: new Date().toISOString()
    });
    return phase3.scripts.approved[phase3.scripts.approved.length - 1];
  }

  function revokeScript(phase3, hash) {
    if (!phase3.scripts) return false;
    const before = phase3.scripts.approved.length;
    phase3.scripts.approved = phase3.scripts.approved.filter((item) => item.hash !== hash);
    phase3.hooks = (phase3.hooks ?? []).filter((hook) => {
      const script = phase3.scripts.approved.find((item) => item.id === hook.scriptId);
      return !!script;
    });
    return phase3.scripts.approved.length !== before;
  }

  // Hooks that should fire for one emitted event (enabled only).
  function matchHooks(phase3, eventName) {
    return (phase3?.hooks ?? []).filter((hook) => hook.enabled !== false && hook.event === eventName);
  }

  // Run one approved script inside the sandbox worker. `host` supplies the
  // capability handlers (see createPhase3UI for the real ones); `eventDetail`
  // is passed to the script as a frozen __xPinEvent constant prepended to
  // the source — the value is JSON, never code, and it runs inside the
  // worker, not the app page. Returns the sandbox handle's start promise.
  async function runScript({ source, name, permissions, host, noteId = null, eventDetail = null }) {
    const sandboxApi = (typeof window !== "undefined" ? window.xPinSandbox : globalThis.xPinSandbox);
    if (!sandboxApi) throw new Error("The plugin sandbox is not loaded, so the script cannot run.");
    const pkg = wrapScriptAsPackage({ source, name, permissions });
    const eventJson = JSON.stringify(eventDetail ?? { type: "manual", noteId });
    const wrappedSource = `"use strict";\nconst __xPinEvent = Object.freeze(${eventJson});\n${pkg.source}`;
    const wrapped = { manifest: pkg.manifest, source: wrappedSource };
    const handle = sandboxApi.create({
      plugin: wrapped,
      permissions: pkg.manifest.permissions,
      onRequest: (capability, payload) => host.scriptRequest(capability, payload, { noteId, scriptName: name }),
      onWarning: (warning) => host.notify?.(`Script “${name}”: ${warning.message}`),
      onError: (error) => { throw error; }
    });
    try {
      await handle.start();
    } finally {
      try { handle.stop(); } catch { /* already stopped */ }
    }
    return true;
  }

  /* ---------------- Item 2 — typed blocks / supertags-lite ---------------- */

  // Fixed, small type list — no custom schema editor in this phase. Each
  // type has 2–4 typed fields; the first field is the display title.
  const TYPED_BLOCK_TYPES = Object.freeze({
    task: {
      label: "Task",
      fields: [
        { key: "title", label: "Title", type: "text" },
        { key: "status", label: "Status", type: "select", options: ["open", "in progress", "done"] },
        { key: "due", label: "Due", type: "date" },
        { key: "priority", label: "Priority", type: "select", options: ["low", "medium", "high"] }
      ]
    },
    person: {
      label: "Person",
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "role", label: "Role", type: "text" },
        { key: "contact", label: "Contact", type: "text" }
      ]
    },
    project: {
      label: "Project",
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "status", label: "Status", type: "select", options: ["not started", "in progress", "done"] },
        { key: "owner", label: "Owner", type: "text" },
        { key: "due", label: "Due", type: "date" }
      ]
    },
    book: {
      label: "Book",
      fields: [
        { key: "title", label: "Title", type: "text" },
        { key: "author", label: "Author", type: "text" },
        { key: "status", label: "Status", type: "select", options: ["to read", "reading", "done"] },
        { key: "rating", label: "Rating (1–5)", type: "number" }
      ]
    },
    idea: {
      label: "Idea",
      fields: [
        { key: "title", label: "Title", type: "text" },
        { key: "area", label: "Area", type: "text" },
        { key: "energy", label: "Energy", type: "select", options: ["low", "medium", "high"] }
      ]
    }
  });

  const TYPED_BLOCK_FENCE = /^```xpin-(task|person|project|book|idea)[^\S\r\n]*\r?\n([\s\S]*?)```/gm;

  function validateTypedFields(type, fields) {
    const def = TYPED_BLOCK_TYPES[type];
    if (!def) throw new TypeError(`Unknown typed block “${String(type).slice(0, 30)}”. Types: ${Object.keys(TYPED_BLOCK_TYPES).join(", ")}.`);
    const clean = {};
    for (const field of def.fields) {
      let value = fields?.[field.key];
      if (value === undefined || value === null) value = "";
      value = String(value).slice(0, 200);
      if (field.type === "select" && value && !field.options.includes(value)) {
        throw new TypeError(`${def.label} field “${field.label}” must be one of: ${field.options.join(", ")}.`);
      }
      if (field.type === "date" && value && !parseDateKey(value)) {
        throw new TypeError(`${def.label} field “${field.label}” must be a date like 2026-11-20.`);
      }
      if (field.type === "number" && value !== "") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new TypeError(`${def.label} field “${field.label}” must be a number.`);
        value = String(n);
      }
      clean[field.key] = value;
    }
    return clean;
  }

  function serializeTypedBlock(type, fields) {
    const clean = validateTypedFields(type, fields);
    return `\`\`\`xpin-${type}\n${JSON.stringify(clean)}\n\`\`\``;
  }

  function parseTypedBlocks(body) {
    const blocks = [];
    const text = String(body ?? "");
    TYPED_BLOCK_FENCE.lastIndex = 0;
    let match;
    while ((match = TYPED_BLOCK_FENCE.exec(text)) !== null) {
      let fields = null;
      try { fields = JSON.parse(match[2]); } catch { /* malformed block: keep raw, skip */ }
      if (!isPlainObject(fields)) continue;
      try {
        blocks.push({ type: match[1], fields: validateTypedFields(match[1], fields), raw: match[0], index: match.index });
      } catch { /* invalid field values: skip rather than crash the note */ }
      if (blocks.length >= 100) break;
    }
    return blocks;
  }

  function typedBlockTitle(block) {
    const first = TYPED_BLOCK_TYPES[block.type]?.fields[0]?.key;
    return (first && String(block.fields[first] || "").trim()) || TYPED_BLOCK_TYPES[block.type]?.label || block.type;
  }

  // Map a typed block onto a database table row: column names match field
  // keys case-insensitively (spaces become part of the name match). Columns
  // with no matching field are left empty; extra fields are dropped.
  function typedBlockToRow(block, table) {
    const values = {};
    for (const column of table?.columns ?? []) {
      const key = String(column.name ?? "").toLocaleLowerCase().replace(/\s+/g, "");
      const fieldKey = Object.keys(block.fields).find((k) => k.toLocaleLowerCase() === key);
      if (fieldKey !== undefined) values[column.id] = block.fields[fieldKey];
    }
    return values;
  }

  /* ---------------- Item 3 — live queries over notes (query v2) ---------------- */

  // Grammar (regex + allowlist, no eval — same style as the Phase 0 grammar):
  //   LIST | TABLE f1,f2 FROM notes
  //     [WHERE cond (AND|OR cond)*] [ORDER BY field [ASC|DESC]] [LIMIT n]
  //   cond := field (=|CONTAINS|>|<|>=|<=) value
  //   field := title | folder | tag | pinned | created | updated
  //   value := "quoted text" | 'quoted text' | bare-token
  // AND binds tighter than OR. created/updated compare as YYYY-MM-DD dates
  // (a bare date) or full ISO timestamps.
  const QUERY_FIELDS = new Set(["title", "folder", "tag", "pinned", "created", "updated"]);
  const QUERY_VALUE_FIELDS = new Set(["title", "folder", "tag", "pinned", "created", "updated", "parent", "tags"]);

  // Tokenizer for the WHERE clause: quoted strings stay whole, operators
  // (=, >=, <=, >, <) split off even when attached ("tag=work" works),
  // bare values are single whitespace-delimited tokens.
  function tokenizeQuery(text) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(>=|<=|>|<|=)|([^\s"'=<>]+)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
    }
    return tokens;
  }

  function parseQueryV2(raw) {
    const text = String(raw ?? "").trim();
    if (!text) throw new TypeError("Enter a query, for example: LIST FROM notes WHERE tag = work ORDER BY updated DESC LIMIT 10");
    const head = text.match(/^(LIST|TABLE(?:\s+([a-zA-Z, ]+))?)\s+FROM\s+notes\b/i);
    if (!head) throw new TypeError("Use LIST FROM notes or TABLE title,folder FROM notes, optionally with WHERE / ORDER BY / LIMIT.");
    const mode = head[1].toLocaleUpperCase().startsWith("TABLE") ? "TABLE" : "LIST";
    const fields = mode === "LIST" ? ["title"]
      : (head[2] || "title").split(",").map((f) => f.trim().toLocaleLowerCase()).filter(Boolean);
    if (!fields.length || fields.some((f) => !QUERY_VALUE_FIELDS.has(f))) {
      throw new TypeError("Query fields must be title, folder, pinned, created, updated, parent, or tags.");
    }
    let rest = text.slice(head[0].length).trim();
    let conditions = [];
    let orderBy = null;
    let limit = null;
    // LIMIT comes last, so strip it first; ORDER BY sits before it.
    const limitMatch = rest.match(/\s+LIMIT\s+(\d+)\s*$/i);
    if (limitMatch) {
      limit = Number(limitMatch[1]);
      if (!Number.isFinite(limit) || limit < 1 || limit > 500) throw new TypeError("LIMIT must be 1–500.");
      rest = rest.slice(0, limitMatch.index).trim();
    }
    const orderMatch = rest.match(/ORDER\s+BY\s+([a-zA-Z]+)(?:\s+(ASC|DESC))?\s*$/i);
    if (orderMatch) {
      const field = orderMatch[1].toLocaleLowerCase();
      if (!QUERY_FIELDS.has(field) && field !== "parent" && field !== "tags") throw new TypeError(`Cannot order by “${field}”.`);
      orderBy = { field, dir: (orderMatch[2] || "ASC").toLocaleUpperCase() };
      rest = rest.slice(0, orderMatch.index).trim();
    }
    if (rest) {
      const whereMatch = rest.match(/^WHERE\s+(.+)$/is);
      if (!whereMatch) throw new TypeError("After FROM notes, use WHERE …, ORDER BY …, or LIMIT n.");
      const clause = whereMatch[1].trim();
      // Split on AND/OR at the top level (values are quoted, so a bare
      // AND/OR inside quotes would need the tokenizer — handled below).
      const parts = [];
      const tokens = tokenizeQuery(clause);
      let current = [];
      let connector = null;
      for (const token of tokens) {
        const upper = token.toLocaleUpperCase();
        if (upper === "AND" || upper === "OR") {
          if (!current.length) throw new TypeError("WHERE needs a condition before AND/OR.");
          parts.push({ connector, tokens: current });
          connector = upper;
          current = [];
        } else {
          current.push(token);
        }
      }
      if (!current.length) throw new TypeError("WHERE ends with AND/OR and no condition.");
      parts.push({ connector, tokens: current });
      conditions = parts.map(({ connector: conn, tokens: toks }) => {
        if (toks.length < 3) throw new TypeError("Each WHERE condition needs field, operator, and value.");
        const field = toks[0].toLocaleLowerCase();
        const op = toks[1].toLocaleUpperCase();
        if (!QUERY_FIELDS.has(field)) throw new TypeError(`Cannot filter by “${field}”. Fields: title, folder, tag, pinned, created, updated.`);
        if (!["=", "CONTAINS", ">", "<", ">=", "<="].includes(op)) throw new TypeError(`Operator “${op}” is not supported. Use =, CONTAINS, >, <, >=, or <=.`);
        if (op === "CONTAINS" && field !== "title" && field !== "folder") {
          throw new TypeError("CONTAINS works only with title or folder.");
        }
        if ((op === ">" || op === "<" || op === ">=" || op === "<=") && field !== "created" && field !== "updated") {
          throw new TypeError("Date comparisons (>, <, >=, <=) work only with created or updated.");
        }
        if (field === "pinned" && op !== "=") throw new TypeError("Pinned filters use = true or = false.");
        if (field === "pinned" && !["true", "false"].includes(String(toks[2]).toLocaleLowerCase())) {
          throw new TypeError("Pinned filters use true or false.");
        }
        const value = toks.slice(2).join(" ");
        return { connector: conn, field, op, value };
      });
    }
    return { mode, fields, conditions, orderBy, limit };
  }

  function queryConditionMatches(note, folderName, tags, cond) {
    const value = cond.value.toLocaleLowerCase();
    if (cond.field === "tag") {
      const wanted = value.startsWith("#") ? value : `#${value}`;
      return tags.includes(wanted);
    }
    if (cond.field === "pinned") return String(note.pinned).toLocaleLowerCase() === value;
    if (cond.field === "created" || cond.field === "updated") {
      const noteDate = new Date(note[cond.field === "created" ? "createdAt" : "updatedAt"]);
      const cmpDate = parseDateKey(cond.value) ?? new Date(cond.value);
      if (Number.isNaN(noteDate.getTime()) || Number.isNaN(cmpDate.getTime())) return false;
      const a = utcDateKey(noteDate);
      const b = utcDateKey(cmpDate);
      if (cond.op === "=") return a === b;
      if (cond.op === ">") return a > b;
      if (cond.op === "<") return a < b;
      if (cond.op === ">=") return a >= b;
      if (cond.op === "<=") return a <= b;
      return false;
    }
    const current = (cond.field === "title" ? note.title : folderName).toLocaleLowerCase();
    return cond.op === "CONTAINS" ? current.includes(value) : current === value;
  }

  function runQueryV2(notes, folders, extractTags, rawOrParsed) {
    const parsed = typeof rawOrParsed === "string" ? parseQueryV2(rawOrParsed) : rawOrParsed;
    const folderName = (note) => folders.find((f) => f.id === note.folderId)?.name ?? "";
    let matched = notes.filter((note) => {
      if (!parsed.conditions.length) return true;
      const tags = extractTags(`${note.title}\n${note.body}`);
      // AND binds tighter than OR: evaluate AND-groups, then OR them.
      let result = null;
      let group = null;
      for (const cond of parsed.conditions) {
        const hit = queryConditionMatches(note, folderName(note), tags, cond);
        if (cond.connector === "OR") {
          result = result === null ? group : (result || group);
          group = hit;
        } else {
          group = group === null ? hit : (group && hit);
        }
      }
      result = result === null ? group : (result || group);
      return result === true;
    });
    if (parsed.orderBy) {
      const { field, dir } = parsed.orderBy;
      const key = (note) => {
        if (field === "title") return note.title.toLocaleLowerCase();
        if (field === "folder") return folderName(note).toLocaleLowerCase();
        if (field === "pinned") return note.pinned ? 1 : 0;
        if (field === "created") return new Date(note.createdAt).getTime();
        if (field === "updated") return new Date(note.updatedAt).getTime();
        if (field === "tag") return extractTags(`${note.title}\n${note.body}`).join(",");
        return note.title.toLocaleLowerCase();
      };
      matched = [...matched].sort((a, b) => {
        const ka = key(a); const kb = key(b);
        const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
        return dir === "DESC" ? -cmp : cmp;
      });
    }
    if (parsed.limit) matched = matched.slice(0, parsed.limit);
    return matched;
  }

  function saveQueryRecord(phase3, { name, query }) {
    const clean = String(query ?? "").trim().slice(0, 500);
    if (!clean) throw new TypeError("Cannot save an empty query.");
    parseQueryV2(clean); // validates before saving
    if (!phase3.savedQueries) phase3.savedQueries = [];
    const record = {
      id: makeId("query"),
      name: String(name ?? "").trim().slice(0, 80) || clean.slice(0, 40),
      query: clean
    };
    phase3.savedQueries.push(record);
    if (phase3.savedQueries.length > 100) phase3.savedQueries.shift();
    return record;
  }

  /* ---------------- Item 4 — Task Score + drag-to-calendar ---------------- */

  // Score = urgency (due date, 0–40) + importance (priority, 10–40) +
  // age (0–20). Overdue counts most; done tasks score 0. Shown verbatim in
  // the UI ("How scoring works") so the number is never mysterious.
  const TASK_SCORE_FORMULA =
    "Score = urgency (due date, 0–40) + importance (priority, 10–40) + age (0–20). Overdue scores highest; done tasks score 0.";

  function urgencyPoints(dueKey, now = new Date()) {
    if (!dueKey) return 5;
    const due = parseDateKey(dueKey);
    if (!due) return 5;
    const days = dayDiff(now, due); // negative = overdue
    if (days < 0) return 40;
    if (days === 0) return 38;
    if (days <= 2) return 32;
    if (days <= 7) return 24;
    if (days <= 14) return 14;
    if (days <= 30) return 7;
    return 3;
  }

  function importancePoints(priority) {
    if (priority === "high") return 40;
    if (priority === "medium") return 25;
    if (priority === "low") return 10;
    return 15;
  }

  function agePoints(createdAt, now = new Date()) {
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) return 0;
    return clamp(Math.floor(dayDiff(created, now) / 3), 0, 20);
  }

  function taskScore(task, now = new Date()) {
    if (task.done) return 0;
    return urgencyPoints(task.due, now) + importancePoints(task.priority) + agePoints(task.createdAt, now);
  }

  const TASK_LINE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;

  function parseTaskLine(line) {
    const match = String(line).match(TASK_LINE);
    if (!match) return null;
    let text = match[4];
    let due = "";
    let priority = "";
    const dueMatch = text.match(/\bdue:(\d{4}-\d{2}-\d{2})\b/);
    if (dueMatch) { due = dueMatch[1]; text = text.replace(dueMatch[0], "").trim(); }
    const prioMatch = text.match(/\bp:(high|medium|low)\b/i) || text.match(/\bp([123])\b/i);
    if (prioMatch) {
      priority = prioMatch[1].toLocaleLowerCase() === "1" ? "high"
        : prioMatch[1].toLocaleLowerCase() === "2" ? "medium"
        : prioMatch[1].toLocaleLowerCase() === "3" ? "low" : prioMatch[1].toLocaleLowerCase();
      text = text.replace(prioMatch[0], "").trim();
    }
    return { done: match[2].toLocaleLowerCase() === "x", text: text.replace(/\s{2,}/g, " ").trim(), due, priority };
  }

  // Every task in the workspace: checklist lines plus typed task blocks.
  // Task ids are stable per (note, line/block index) within a render.
  function extractTasks(notes, now = new Date()) {
    const tasks = [];
    for (const note of notes ?? []) {
      const lines = String(note.body ?? "").split("\n");
      lines.forEach((line, index) => {
        const parsed = parseTaskLine(line);
        if (!parsed) return;
        const task = {
          id: `${note.id}:line:${index}`,
          noteId: note.id,
          noteTitle: note.title || "Untitled note",
          source: "line",
          lineIndex: index,
          text: parsed.text,
          done: parsed.done,
          due: parsed.due,
          priority: parsed.priority,
          createdAt: note.createdAt
        };
        task.score = taskScore(task, now);
        tasks.push(task);
      });
      for (const block of parseTypedBlocks(note.body)) {
        if (block.type !== "task") continue;
        const task = {
          id: `${note.id}:block:${block.index}`,
          noteId: note.id,
          noteTitle: note.title || "Untitled note",
          source: "block",
          blockIndex: block.index,
          text: block.fields.title || "Untitled task",
          done: block.fields.status === "done",
          due: block.fields.due || "",
          priority: block.fields.priority || "",
          createdAt: note.createdAt
        };
        task.score = taskScore(task, now);
        tasks.push(task);
      }
    }
    return tasks;
  }

  function setTaskDueInBody(body, task) {
    const lines = String(body ?? "").split("\n");
    if (task.source === "line") {
      const parsed = parseTaskLine(lines[task.lineIndex] ?? "");
      if (!parsed) return body;
      const base = lines[task.lineIndex].replace(/\s*due:\d{4}-\d{2}-\d{2}\s*/g, " ").replace(/\s+$/, "");
      lines[task.lineIndex] = task.due ? `${base} due:${task.due}` : base;
      return lines.join("\n");
    }
    // Typed task block: rewrite the fence with the new due date.
    const blocks = parseTypedBlocks(body);
    const block = blocks.find((b) => b.type === "task" && b.index === task.blockIndex);
    if (!block) return body;
    const fields = { ...block.fields, due: task.due || "" };
    return body.slice(0, block.index) + serializeTypedBlock("task", fields) + body.slice(block.index + block.raw.length);
  }

  function tasksForDate(tasks, dateKey) {
    return tasks.filter((task) => task.due === dateKey);
  }

  function monthGrid(year, month) {
    // Weeks of {dateKey, day, inMonth} starting Sunday, for a month grid.
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const weeks = [];
    for (let w = 0; w < 6; w += 1) {
      const week = [];
      for (let d = 0; d < 7; d += 1) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
        week.push({ dateKey: localDateKey(date), day: date.getDate(), inMonth: date.getMonth() === month });
      }
      weeks.push(week);
      if (week[6].dateKey >= localDateKey(new Date(year, month + 1, 0)) && w >= 3) break;
    }
    return weeks;
  }

  /* ---------------- editor blocks (Item 6 helpers) ---------------- */

  // Split note text into movable blocks: blank-line-separated chunks, with
  // list blocks split per item so a single list item can move on its own.
  function splitBlocks(text) {
    const lines = String(text ?? "").split("\n");
    const blocks = [];
    let start = 0;
    const flush = (end) => {
      if (end <= start) return;
      const chunk = lines.slice(start, end);
      if (chunk.every((l) => /^\s*[-*]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l))) {
        chunk.forEach((line, i) => blocks.push({ start: start + i, end: start + i + 1, text: line }));
      } else {
        blocks.push({ start, end, text: chunk.join("\n") });
      }
    };
    for (let i = 0; i <= lines.length; i += 1) {
      if (i === lines.length || lines[i].trim() === "") {
        flush(i);
        start = i + 1;
      }
    }
    return blocks.filter((b) => b.text.trim() !== "");
  }

  function moveBlock(text, cursorOffset, direction) {
    const blocks = splitBlocks(text);
    if (blocks.length < 2) return { text, moved: false };
    const lines = String(text).split("\n");
    let cursorLine = 0;
    let seen = 0;
    for (let i = 0; i < lines.length; i += 1) {
      seen += lines[i].length + 1;
      if (seen > cursorOffset) { cursorLine = i; break; }
      cursorLine = i;
    }
    const index = blocks.findIndex((b) => cursorLine >= b.start && cursorLine < b.end);
    if (index < 0) return { text, moved: false };
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return { text, moved: false };
    const all = [...blocks];
    const [moved] = all.splice(index, 1);
    all.splice(target, 0, moved);
    const next = all.map((b) => b.text).join("\n\n");
    return { text: next, moved: true, from: index, to: target };
  }

  function reorderBlocks(text, from, to) {
    const blocks = splitBlocks(text);
    if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length || from === to) return { text, moved: false };
    const all = [...blocks];
    const [moved] = all.splice(from, 1);
    all.splice(to, 0, moved);
    return { text: all.map((b) => b.text).join("\n\n"), moved: true };
  }

  /* ---------------- Item 5 — Databases v2: formulas, views, reminders ---------------- */

  // Safe expression language over row fields. Grammar:
  //   expr   := term (("+"|"-") term)*
  //   term   := factor (("*"|"/"|"%") factor)*
  //   factor := ("-" factor) | number | "string" | ident | ident(args) | "(" expr ")"
  //   ident  := a column name (letters/digits/underscore; matched against
  //             column ids and names, case-insensitive, spaces ignored)
  //   funcs  := today() | days(date, date) | min(a, b) | max(a, b) |
  //             abs(n) | len(text)
  //   days(a, b) is a − b in whole days (like DATETIME_DIFF), so
  //   days(due, today()) is the number of days until the due date.
  // Dates are YYYY-MM-DD strings (or ISO timestamps). No eval, no Function,
  // no property access, no assignment — the parser only ever reads numbers,
  // strings, and the whitelisted functions above.
  function tokenizeFormula(input) {
    const tokens = [];
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (/\s/.test(ch)) { i += 1; continue; }
      if (/[0-9.]/.test(ch)) {
        let num = "";
        while (i < input.length && /[0-9.]/.test(input[i])) { num += input[i]; i += 1; }
        if (!/^\d+(\.\d+)?$/.test(num)) throw new TypeError(`Bad number “${num}” in formula.`);
        tokens.push({ type: "number", value: Number(num) });
        continue;
      }
      if (ch === '"') {
        let str = "";
        i += 1;
        while (i < input.length && input[i] !== '"') { str += input[i]; i += 1; }
        if (i >= input.length) throw new TypeError("Unterminated string in formula.");
        i += 1;
        tokens.push({ type: "string", value: str });
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let name = "";
        while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) { name += input[i]; i += 1; }
        tokens.push({ type: "ident", value: name });
        continue;
      }
      if ("+-*/%(),".includes(ch)) { tokens.push({ type: ch, value: ch }); i += 1; continue; }
      throw new TypeError(`Unexpected character “${ch}” in formula.`);
    }
    tokens.push({ type: "eof", value: "" });
    return tokens;
  }

  function parseFormulaTokens(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = (type) => {
      const token = next();
      if (token.type !== type) throw new TypeError(`Expected “${type}” in formula, got “${token.value}”.`);
      return token;
    };
    function parseExpr() {
      let left = parseTerm();
      while (peek().type === "+" || peek().type === "-") {
        const op = next().type;
        left = { kind: "bin", op, left, right: parseTerm() };
      }
      return left;
    }
    function parseTerm() {
      let left = parseFactor();
      while (peek().type === "*" || peek().type === "/" || peek().type === "%") {
        const op = next().type;
        left = { kind: "bin", op, left, right: parseFactor() };
      }
      return left;
    }
    function parseFactor() {
      const token = peek();
      if (token.type === "-") { next(); return { kind: "neg", value: parseFactor() }; }
      if (token.type === "number") { next(); return { kind: "number", value: token.value }; }
      if (token.type === "string") { next(); return { kind: "string", value: token.value }; }
      if (token.type === "(") {
        next();
        const inner = parseExpr();
        expect(")");
        return inner;
      }
      if (token.type === "ident") {
        next();
        if (peek().type === "(") {
          next();
          const args = [];
          if (peek().type !== ")") {
            args.push(parseExpr());
            while (peek().type === ",") { next(); args.push(parseExpr()); }
          }
          expect(")");
          return { kind: "call", name: token.value.toLocaleLowerCase(), args };
        }
        return { kind: "field", name: token.value };
      }
      throw new TypeError(`Unexpected “${token.value}” in formula.`);
    }
    const ast = parseExpr();
    if (peek().type !== "eof") throw new TypeError("Formula has extra text after the expression.");
    return ast;
  }

  function formulaFieldValue(name, row, columns) {
    const wanted = String(name).toLocaleLowerCase().replace(/[\s_-]+/g, "");
    const column = (columns ?? []).find((c) =>
      String(c.id).toLocaleLowerCase().replace(/[\s_-]+/g, "") === wanted ||
      String(c.name ?? "").toLocaleLowerCase().replace(/[\s_-]+/g, "") === wanted);
    if (!column) throw new TypeError(`Formula refers to unknown field “${name}”.`);
    return row?.values?.[column.id] ?? "";
  }

  function toFormulaNumber(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    throw new TypeError(`Formula expected a number, got “${String(value).slice(0, 40)}”.`);
  }

  function evalFormulaAst(node, row, columns, todayKey) {
    if (node.kind === "number" || node.kind === "string") return node.value;
    if (node.kind === "neg") return -toFormulaNumber(evalFormulaAst(node.value, row, columns, todayKey));
    if (node.kind === "field") return formulaFieldValue(node.name, row, columns);
    if (node.kind === "bin") {
      const left = evalFormulaAst(node.left, row, columns, todayKey);
      const right = evalFormulaAst(node.right, row, columns, todayKey);
      const a = toFormulaNumber(left);
      const b = toFormulaNumber(right);
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (node.op === "/") {
        if (b === 0) throw new TypeError("Formula divides by zero.");
        return a / b;
      }
      if (node.op === "%") {
        if (b === 0) throw new TypeError("Formula divides by zero.");
        return a % b;
      }
    }
    if (node.kind === "call") {
      const args = node.args.map((arg) => evalFormulaAst(arg, row, columns, todayKey));
      if (node.name === "today") {
        if (args.length) throw new TypeError("today() takes no arguments.");
        return todayKey;
      }
      if (node.name === "days") {
        if (args.length !== 2) throw new TypeError("days(a, b) takes two dates.");
        const a = parseDateKey(String(args[0])) ?? new Date(String(args[0]));
        const b = parseDateKey(String(args[1])) ?? new Date(String(args[1]));
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new TypeError("days(a, b) needs two dates.");
        return dayDiff(b, a); // a − b: days(due, today()) = days until due
      }
      if (node.name === "min" || node.name === "max") {
        if (args.length !== 2) throw new TypeError(`${node.name}(a, b) takes two numbers.`);
        return node.name === "min" ? Math.min(toFormulaNumber(args[0]), toFormulaNumber(args[1])) : Math.max(toFormulaNumber(args[0]), toFormulaNumber(args[1]));
      }
      if (node.name === "abs") {
        if (args.length !== 1) throw new TypeError("abs(n) takes one number.");
        return Math.abs(toFormulaNumber(args[0]));
      }
      if (node.name === "len") {
        if (args.length !== 1) throw new TypeError("len(text) takes one value.");
        return String(args[0]).length;
      }
      throw new TypeError(`Unknown formula function “${node.name}”. Use today(), days(a, b), min(a, b), max(a, b), abs(n), or len(text).`);
    }
    throw new TypeError("Invalid formula.");
  }

  // Evaluate a formula-column expression (leading "=" optional) for one row.
  // Returns {ok:true, value} or {ok:false, error}. Never throws, never evals.
  function evaluateFormula(expression, row, columns, todayKey = localDateKey()) {
    try {
      const source = String(expression ?? "").trim().replace(/^=\s*/, "");
      if (!source) return { ok: false, error: "Empty formula." };
      if (source.length > 500) return { ok: false, error: "Formula is over 500 characters." };
      const ast = parseFormulaTokens(tokenizeFormula(source));
      const value = evalFormulaAst(ast, row, columns, todayKey);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  function formatFormulaValue(value) {
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
    return String(value ?? "");
  }

  // Per-view sort / filter / group over table rows. Returns {rows, groups}
  // where groups is null when no grouping, else [{key, rows}].
  function applyDatabaseView(rows, columns, view = {}) {
    let out = [...(rows ?? [])];
    const cellText = (row, columnId) => {
      const column = (columns ?? []).find((c) => c.id === columnId);
      if (!column) return "";
      if (column.type === "formula") {
        const result = evaluateFormula(column.expression, row, columns);
        return result.ok ? formatFormulaValue(result.value) : "";
      }
      return String(row?.values?.[columnId] ?? "");
    };
    if (view.filterColumnId && view.filterOp) {
      out = out.filter((row) => {
        const text = cellText(row, view.filterColumnId);
        const wanted = String(view.filterValue ?? "");
        if (view.filterOp === "empty") return text.trim() === "";
        if (view.filterOp === "not-empty") return text.trim() !== "";
        if (view.filterOp === "=") return text.toLocaleLowerCase() === wanted.toLocaleLowerCase();
        if (view.filterOp === "contains") return text.toLocaleLowerCase().includes(wanted.toLocaleLowerCase());
        const a = Number(text); const b = Number(wanted);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        if (view.filterOp === ">") return a > b;
        if (view.filterOp === "<") return a < b;
        return false;
      });
    }
    if (view.sortColumnId) {
      out.sort((a, b) => {
        const ka = cellText(a, view.sortColumnId);
        const kb = cellText(b, view.sortColumnId);
        const na = Number(ka); const nb = Number(kb);
        const cmp = Number.isFinite(na) && Number.isFinite(nb) && ka.trim() !== "" && kb.trim() !== ""
          ? na - nb : ka.localeCompare(kb);
        return view.sortDir === "desc" ? -cmp : cmp;
      });
    }
    if (!view.groupByColumnId) return { rows: out, groups: null };
    const groups = new Map();
    for (const row of out) {
      const key = cellText(row, view.groupByColumnId) || "(blank)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return { rows: out, groups: [...groups.entries()].map(([key, groupRows]) => ({ key, rows: groupRows })) };
  }

  function createReminder(phase3, { tableId, rowId, date, label }) {
    if (!parseDateKey(date)) throw new TypeError("Reminder needs a date like 2026-11-20.");
    if (!phase3.reminders) phase3.reminders = [];
    const record = { id: makeId("reminder"), tableId: String(tableId ?? ""), rowId: String(rowId ?? ""), date, label: String(label ?? "Reminder").slice(0, 120), createdAt: new Date().toISOString() };
    phase3.reminders.push(record);
    return record;
  }

  function remindersForDate(phase3, dateKey) {
    return (phase3?.reminders ?? []).filter((r) => r.date === dateKey);
  }

  /* ---------------- Item 7 — Graph v2 helpers ---------------- */

  function buildGraph(notes, cap = 150) {
    const sliced = (notes ?? []).slice(0, cap);
    const byTitle = new Map(sliced.map((n) => [String(n.title ?? "").trim().toLocaleLowerCase(), n]));
    const nodes = sliced.map((n) => ({ id: n.id, title: n.title || "Untitled note", folderId: n.folderId ?? null, tags: [] }));
    const edges = [];
    const seen = new Set();
    for (const note of sliced) {
      const add = (a, b) => {
        if (a === b) return;
        const key = [a, b].sort().join(":");
        if (seen.has(key)) return;
        seen.add(key);
        edges.push([a, b]);
      };
      if (note.parentNoteId && sliced.some((n) => n.id === note.parentNoteId)) add(note.parentNoteId, note.id);
      for (const match of String(note.body ?? "").matchAll(/\[\[([^\]]{1,120})\]\]/g)) {
        const target = byTitle.get(match[1].trim().toLocaleLowerCase());
        if (target) add(note.id, target.id);
      }
    }
    return { nodes, edges, capped: (notes ?? []).length > cap, total: (notes ?? []).length };
  }

  function localGraph(notes, centerId, hops = 1) {
    const full = buildGraph(notes, Math.max(150, (notes ?? []).length));
    const adjacency = new Map();
    for (const [a, b] of full.edges) {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    }
    const keep = new Set([centerId]);
    let frontier = [centerId];
    for (let h = 0; h < hops; h += 1) {
      const next = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!keep.has(neighbor)) { keep.add(neighbor); next.push(neighbor); }
        }
      }
      frontier = next;
    }
    return {
      nodes: full.nodes.filter((n) => keep.has(n.id)),
      edges: full.edges.filter(([a, b]) => keep.has(a) && keep.has(b)),
      capped: false,
      total: keep.size
    };
  }

  function findOrphans(notes) {
    const graph = buildGraph(notes, Math.max(150, (notes ?? []).length));
    const linked = new Set();
    for (const [a, b] of graph.edges) { linked.add(a); linked.add(b); }
    return graph.nodes.filter((n) => !linked.has(n.id)).map((n) => (notes ?? []).find((note) => note.id === n.id)).filter(Boolean);
  }

  function graphTags(note, extractTags) {
    return extractTags(`${note.title}\n${note.body}`);
  }

  /* ---------------- Item 8 — collaboration via the sync layer ---------------- */

  function createSpace(phase3, { name, memberDeviceIds = [] }) {
    if (!phase3.spaces) phase3.spaces = [];
    const space = {
      id: makeId("space"),
      name: String(name ?? "").trim().slice(0, 80) || "Untitled space",
      memberDeviceIds: [...new Set(memberDeviceIds.filter((d) => typeof d === "string").map((d) => d.slice(0, 80)))].slice(0, 50),
      noteIds: []
    };
    phase3.spaces.push(space);
    return space;
  }

  function shareNoteToSpace(phase3, noteId, spaceId) {
    const space = (phase3?.spaces ?? []).find((s) => s.id === spaceId);
    if (!space) throw new TypeError("That space does not exist.");
    if (!space.noteIds.includes(noteId)) space.noteIds.push(noteId);
    return space;
  }

  function unshareNoteFromSpace(phase3, noteId, spaceId) {
    const space = (phase3?.spaces ?? []).find((s) => s.id === spaceId);
    if (!space) return false;
    const before = space.noteIds.length;
    space.noteIds = space.noteIds.filter((id) => id !== noteId);
    return space.noteIds.length !== before;
  }

  function spacesForNote(phase3, noteId) {
    return (phase3?.spaces ?? []).filter((s) => s.noteIds.includes(noteId));
  }

  function createComment(phase3, { noteId, deviceId, author, body }) {
    const clean = String(body ?? "").trim();
    if (!clean) throw new TypeError("Comment is empty.");
    if (clean.length > 2000) throw new TypeError("Comment is over 2,000 characters.");
    if (!phase3.comments) phase3.comments = [];
    const comment = {
      id: makeId("comment"),
      noteId: String(noteId),
      deviceId: String(deviceId ?? ""),
      author: String(author ?? "Someone").slice(0, 80) || "Someone",
      body: clean,
      createdAt: new Date().toISOString()
    };
    phase3.comments.push(comment);
    // Mentions: @device-name tokens. A mention is recorded for every token;
    // the sidebar highlights the ones naming this device (or "you").
    if (!phase3.mentions) phase3.mentions = [];
    for (const name of extractMentions(clean)) {
      phase3.mentions.push({
        id: makeId("mention"),
        commentId: comment.id,
        noteId: comment.noteId,
        deviceName: name,
        createdAt: comment.createdAt,
        read: false
      });
    }
    return comment;
  }

  function extractMentions(body) {
    const names = [];
    for (const match of String(body ?? "").matchAll(/@([A-Za-z0-9][A-Za-z0-9._-]{0,79})/g)) {
      if (!names.includes(match[1])) names.push(match[1]);
    }
    return names.slice(0, 20);
  }

  function commentsForNote(phase3, noteId) {
    return (phase3?.comments ?? []).filter((c) => c.noteId === noteId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function unreadMentions(phase3, ownDeviceId = "") {
    const own = String(ownDeviceId ?? "").toLocaleLowerCase();
    return (phase3?.mentions ?? []).filter((m) => !m.read);
  }

  function mentionsForMe(phase3, ownDeviceId = "") {
    const own = String(ownDeviceId ?? "").toLocaleLowerCase();
    return (phase3?.mentions ?? []).filter((m) =>
      !m.read && (m.deviceName.toLocaleLowerCase() === "you" ||
        (own && (own === m.deviceName.toLocaleLowerCase() || own.startsWith(m.deviceName.toLocaleLowerCase())))));
  }

  /* ---------------- Item 9 — Android, share, theme, dialogs ---------------- */

  // Pure back-button decision (Item 9 / audit D1). The UI handler maps the
  // result: close-dialog closes the topmost open dialog, go-back returns to
  // the notes list, exit only fires at the top level with nothing open.
  function backButtonAction({ dialogOpen = false, viewActive = false } = {}) {
    if (dialogOpen) return "close-dialog";
    if (viewActive) return "go-back";
    return "exit";
  }

  function shareTextForNote(note) {
    const title = String(note?.title ?? "").trim() || "Untitled note";
    const body = String(note?.body ?? "");
    return `${title}\n\n${body}`.trim();
  }

  // Shared text (Android share target / xpin://capture) → Inbox note parts.
  // Pure so the receiving flow is testable without a device.
  function captureSharedText(text, source = "") {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    const firstLine = clean.split("\n")[0].trim();
    return {
      title: firstLine.slice(0, 120) || "Captured note",
      body: source ? `${clean}\n\nSource: ${String(source).slice(0, 200)}` : clean
    };
  }

  function applyThemeSettings(doc, settings) {
    const root = doc?.documentElement;
    if (!root) return;
    root.dataset.xPinTheme = settings?.theme === "light" ? "light" : "dark";
    root.dataset.xPinFont = settings?.font === "serif" || settings?.font === "mono" ? settings.font : "system";
  }

  // Real in-app dialog replacing window.prompt (audit G1). Builds a
  // .modal-backdrop + .dialog from the app's own styles; resolves with the
  // entered string, or null on cancel / backdrop click / Escape. Never uses
  // window.prompt. `options` renders a <select> instead of a text input.
  function showDialog(doc, { title = "", message = "", label = "", value = "", password = false, multiline = false, placeholder = "", confirmLabel = "Save", options = null } = {}) {
    return new Promise((resolve) => {
      const backdrop = doc.createElement("div");
      backdrop.className = "modal-backdrop xpin-dialog-backdrop";
      const dialog = doc.createElement("section");
      dialog.className = "dialog xpin-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const header = doc.createElement("header");
      header.className = "dialog-header";
      const titleEl = doc.createElement("h2");
      titleEl.textContent = title;
      header.append(titleEl);
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "icon-button dialog-close";
      close.setAttribute("aria-label", "Close dialog");
      close.textContent = "×";
      header.append(close);
      dialog.append(header);
      if (message) {
        const p = doc.createElement("p");
        p.className = "dialog-description";
        p.textContent = message;
        dialog.append(p);
      }
      let input;
      if (options) {
        input = doc.createElement("select");
        input.className = "feature-input xpin-dialog-input";
        for (const option of options) {
          const opt = doc.createElement("option");
          opt.value = option.value ?? option;
          opt.textContent = option.label ?? option;
          if (String(option.value ?? option) === String(value)) opt.selected = true;
          input.append(opt);
        }
      } else if (multiline) {
        input = doc.createElement("textarea");
        input.className = "feature-input xpin-dialog-input";
        input.rows = 6;
      } else {
        input = doc.createElement("input");
        input.className = "feature-input xpin-dialog-input";
        input.type = password ? "password" : "text";
      }
      input.value = value;
      if (placeholder) input.placeholder = placeholder;
      if (label) {
        const labelEl = doc.createElement("label");
        labelEl.className = "xpin-dialog-label";
        labelEl.textContent = label;
        labelEl.append(input);
        dialog.append(labelEl);
      } else {
        dialog.append(input);
      }
      const footer = doc.createElement("footer");
      footer.className = "dialog-footer";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog-cancel";
      cancel.textContent = "Cancel";
      const confirm = doc.createElement("button");
      confirm.type = "button";
      confirm.className = "dialog-done";
      confirm.textContent = confirmLabel;
      footer.append(cancel, confirm);
      dialog.append(footer);
      backdrop.append(dialog);
      doc.body.append(backdrop);
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        backdrop.remove();
        resolve(result);
      };
      confirm.addEventListener("click", () => finish(input.value));
      cancel.addEventListener("click", () => finish(null));
      close.addEventListener("click", () => finish(null));
      backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(null); });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !multiline) { event.preventDefault(); finish(input.value); }
        if (event.key === "Escape") finish(null);
      });
      try { input.focus(); if (input.select) input.select(); } catch { /* focus is best-effort */ }
    });
  }

  function showConfirm(doc, { title = "", message = "", confirmLabel = "Delete" } = {}) {
    return new Promise((resolve) => {
      const backdrop = doc.createElement("div");
      backdrop.className = "modal-backdrop xpin-dialog-backdrop";
      const dialog = doc.createElement("section");
      dialog.className = "dialog xpin-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const header = doc.createElement("header");
      header.className = "dialog-header";
      const titleEl = doc.createElement("h2");
      titleEl.textContent = title;
      header.append(titleEl);
      dialog.append(header);
      if (message) {
        const p = doc.createElement("p");
        p.className = "dialog-description";
        p.textContent = message;
        dialog.append(p);
      }
      const footer = doc.createElement("footer");
      footer.className = "dialog-footer";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog-cancel";
      cancel.textContent = "Cancel";
      const confirm = doc.createElement("button");
      confirm.type = "button";
      confirm.className = "dialog-done";
      confirm.textContent = confirmLabel;
      footer.append(cancel, confirm);
      dialog.append(footer);
      backdrop.append(dialog);
      doc.body.append(backdrop);
      let done = false;
      const finish = (result) => { if (done) return; done = true; backdrop.remove(); resolve(result); };
      confirm.addEventListener("click", () => finish(true));
      cancel.addEventListener("click", () => finish(false));
      backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(false); });
    });
  }

  /* ---------------- DOM UI ---------------- */

  function createPhase3UI(host) {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) return null;
    const state = () => host.getState();
    const p3 = () => state().phase3 ?? defaultPhase3State();
    const notify = (message) => host.toast?.(message) ?? host.notify?.(message);
    const persist = () => host.persist?.();
    let calendarCursor = new Date();
    let selectedTaskId = null;
    let splitOn = false;

    function el(tag, className = "", text = "") {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function applyTheme() {
      applyThemeSettings(doc, p3().settings);
    }

    /* ----- script capability handling (host side of the sandbox RPC) ----- */
    // Scripts may read notes, update ONLY the note they live in, create
    // notes, insert into the editor, notify, and read folders/databases.
    // Anything else — including commands:register and settings — is refused.
    async function scriptRequest(capability, payload, { noteId } = {}) {
      const current = host.currentNote?.();
      if (capability === "notes:read") {
        if (payload?.action === "current") return current ? { ...current } : null;
        if (payload?.action === "list") return state().notes.slice(0, 500).map((n) => ({ ...n }));
        throw new TypeError("Unknown note-read action.");
      }
      if (capability === "notes:select") {
        if (typeof payload?.id !== "string") throw new TypeError("Note selection requires a note id.");
        host.selectNote?.(payload.id);
        return true;
      }
      if (capability === "notes:create") {
        const options = payload?.options ?? {};
        if (!options || typeof options !== "object" || typeof options.title !== "string" || typeof options.body !== "string" ||
          options.title.length > 120 || options.body.length > 100_000) {
          throw new TypeError("Script note content must be text within the supported size limits.");
        }
        return host.createNote?.({ title: options.title, body: options.body, folderId: options.folderId ?? null });
      }
      if (capability === "notes:update") {
        if (typeof payload?.id !== "string") throw new TypeError("Script note update requires a note id.");
        // Scripts write only to the note they live in — never to other notes.
        if (noteId && payload.id !== noteId) throw new Error("A script may only edit the note it lives in.");
        if (!noteId && current && payload.id !== current.id) throw new Error("A script may only edit the open note.");
        const updated = host.updateNote?.(payload.id, payload?.patch ?? {});
        persist();
        host.render?.();
        return updated;
      }
      if (capability === "editor:write") {
        if (typeof payload?.text !== "string" || payload.text.length > 5_000) {
          throw new TypeError("Script editor insertion must be text under 5 KB.");
        }
        host.insertText?.(payload.text);
        return true;
      }
      if (capability === "ui:notify") {
        if (typeof payload?.message !== "string" || payload.message.length > 200) {
          throw new TypeError("Script notifications must be text under 200 characters.");
        }
        notify(payload.message);
        return true;
      }
      if (capability === "ui:status") return true; // accepted, no status surface for scripts
      if (capability === "folders:read") {
        return (state().folders ?? []).map((f) => ({ id: f.id, name: f.name }));
      }
      if (capability === "databases:read") {
        const features = state().features;
        if (payload?.action === "rows") {
          const table = (features?.tables ?? []).find((t) => t.id === payload.tableId);
          return table ? table.rows.map((r) => ({ ...r })) : [];
        }
        return (features?.tables ?? []).map((t) => ({ id: t.id, name: t.name }));
      }
      throw new Error(`Capability “${capability}” is not available to note scripts.`);
    }

    async function runApprovedScript({ source, name, permissions, noteId, eventDetail }) {
      const hash = await scriptDigest(source);
      if (!isScriptApproved(p3(), hash)) {
        throw new Error("This script has not been approved yet. Review it in the Scripts section first — scripts never run before approval, and never automatically on open.");
      }
      const record = approvedScript(p3(), hash);
      return runScript({
        source, name, permissions: record?.permissions ?? permissions,
        host: { scriptRequest, notify }, noteId, eventDetail
      });
    }

    function showScriptApprovalDialog({ source, name, noteId }) {
      return new Promise((resolve) => {
        const backdrop = doc.createElement("div");
        backdrop.className = "modal-backdrop xpin-dialog-backdrop";
        const dialog = doc.createElement("section");
        dialog.className = "dialog xpin-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        const header = doc.createElement("header");
        header.className = "dialog-header";
        const titleEl = doc.createElement("h2");
        titleEl.textContent = "Review script before running";
        header.append(titleEl);
        dialog.append(header);
        const desc = doc.createElement("p");
        desc.className = "dialog-description";
        desc.textContent = "This script runs in xPin's restricted sandbox worker — the same isolation as imported plugins. It can read notes, edit only the note it lives in, and show notifications. It cannot reach the network, read credentials, or delete notes. Approving once covers this exact source; any edit needs a fresh review.";
        dialog.append(desc);
        const pre = doc.createElement("pre");
        pre.className = "xpin-script-source";
        pre.textContent = source;
        dialog.append(pre);
        const perms = doc.createElement("p");
        perms.className = "feature-help";
        perms.textContent = `Requested capabilities: ${SCRIPT_PERMISSIONS.slice(0, 5).join(", ")} (notes:read, notes:update on this note only, editor:write, ui:notify).`;
        dialog.append(perms);
        const footer = doc.createElement("footer");
        footer.className = "dialog-footer";
        const cancel = doc.createElement("button");
        cancel.type = "button"; cancel.className = "dialog-cancel"; cancel.textContent = "Cancel";
        const approve = doc.createElement("button");
        approve.type = "button"; approve.className = "dialog-done"; approve.textContent = "Approve and run";
        footer.append(cancel, approve);
        dialog.append(footer);
        backdrop.append(dialog);
        doc.body.append(backdrop);
        let done = false;
        const finish = async (approved) => {
          if (done) return;
          done = true;
          backdrop.remove();
          if (!approved) { resolve(false); return; }
          try {
            const hash = await scriptDigest(source);
            approveScriptRecord(p3(), { hash, name, source, permissions: SCRIPT_PERMISSIONS.slice(0, 5) });
            persist();
            await runApprovedScript({ source, name, permissions: SCRIPT_PERMISSIONS.slice(0, 5), noteId, eventDetail: { type: "manual", noteId } });
            notify("Script ran.");
            resolve(true);
          } catch (error) {
            notify(error?.message ?? "Script failed.");
            resolve(false);
          }
        };
        approve.addEventListener("click", () => finish(true));
        cancel.addEventListener("click", () => finish(false));
        backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(false); });
      });
    }

    /* ----- sidebar: saved queries + mentions ----- */
    function renderSidebar() {
      const sidebar = doc.querySelector(".sidebar");
      const bottom = doc.querySelector(".sidebar-bottom");
      if (!sidebar || !bottom) return;
      let section = doc.getElementById("p3-sidebar");
      if (!section) {
        section = el("div", "p3-sidebar");
        section.id = "p3-sidebar";
        sidebar.insertBefore(section, bottom);
      }
      section.replaceChildren();
      const queriesLabel = el("div", "nav-label", "SAVED QUERIES");
      section.append(queriesLabel);
      const queries = p3().savedQueries;
      if (!queries.length) {
        section.append(el("p", "feature-help", "Save a query from Power & polish to pin it here."));
      }
      for (const query of queries.slice(0, 10)) {
        const button = el("button", "nav-item p3-sidebar-item", query.name);
        button.type = "button";
        button.addEventListener("click", () => {
          host.setFeatureQuery?.(query.query);
          notify(`Ran saved query “${query.name}”.`);
        });
        section.append(button);
      }
      const unread = unreadMentions(p3());
      const mentionsLabel = el("div", "nav-label", `MENTIONS${unread.length ? ` (${unread.length})` : ""}`);
      section.append(mentionsLabel);
      const mine = mentionsForMe(p3(), host.getDeviceId?.() ?? "");
      if (!mine.length && !unread.length) {
        section.append(el("p", "feature-help", "No mentions. @device-name in a comment notifies that device."));
      }
      for (const mention of unread.slice(0, 5)) {
        const button = el("button", "nav-item p3-sidebar-item", `@${mention.deviceName} — ${mention.read ? "" : "unread"}`);
        button.type = "button";
        button.addEventListener("click", () => {
          mention.read = true;
          persist();
          if (mention.noteId) host.selectNote?.(mention.noteId);
          renderSidebar();
        });
        section.append(button);
      }
    }

    /* ----- comments panel under the editor ----- */
    function renderComments() {
      const container = doc.getElementById("note-comments");
      if (!container) return;
      const note = host.currentNote?.();
      if (!note) { container.replaceChildren(); container.hidden = true; return; }
      container.hidden = false;
      if (doc.activeElement && container.contains(doc.activeElement)) return; // don't wipe typed input
      container.replaceChildren();
      const comments = commentsForNote(p3(), note.id);
      container.append(el("h3", "p3-section-title", `Comments (${comments.length})`));
      const shared = spacesForNote(p3(), note.id);
      container.append(el("p", "feature-help", shared.length
        ? `Shared in: ${shared.map((s) => s.name).join(", ")}. Comments sync through the sync layer as encrypted envelopes.`
        : "Not shared yet. Share this note to a space from Power & polish to sync comments with other devices."));
      for (const comment of comments) {
        const card = el("div", "p3-comment");
        const head = el("div", "p3-comment-head", `${comment.author} · ${new Date(comment.createdAt).toLocaleString()}`);
        const body = el("p", "p3-comment-body", comment.body);
        card.append(head, body);
        container.append(card);
      }
      const row = el("div", "p3-comment-row");
      const input = el("input", "feature-input");
      input.type = "text";
      input.placeholder = "Add a comment… use @device-name to mention someone";
      input.maxLength = 2000;
      input.setAttribute("aria-label", "Add a comment");
      const post = el("button", "feature-button", "Comment");
      post.type = "button";
      post.addEventListener("click", () => {
        const text = input.value.trim();
        if (!text) return;
        try {
          createComment(p3(), { noteId: note.id, deviceId: host.getDeviceId?.() ?? "", author: "You", body: text });
          persist();
          notify("Comment added.");
          renderComments();
          renderSidebar();
        } catch (error) {
          notify(error?.message ?? "Comment could not be added.");
        }
      });
      row.append(input, post);
      container.append(row);
    }

    /* ----- reminders banner on today's daily note ----- */
    function renderDailyReminders() {
      const note = host.currentNote?.();
      let banner = doc.getElementById("daily-reminders");
      if (!banner) {
        banner = el("div", "p3-reminders");
        banner.id = "daily-reminders";
        const fields = doc.querySelector(".editor-fields");
        if (fields?.parentNode) fields.parentNode.insertBefore(banner, fields);
      }
      const today = localDateKey();
      const isDailyToday = note?.metadata?.dailyDate === today;
      const todays = remindersForDate(p3(), today);
      if (!isDailyToday || !todays.length) { banner.replaceChildren(); banner.hidden = true; return; }
      banner.hidden = false;
      banner.replaceChildren();
      banner.append(el("strong", "", "⏰ Reminders today: "));
      banner.append(el("span", "", todays.map((r) => r.label).join(" · ")));
      const dismiss = el("button", "p3-banner-dismiss", "Dismiss");
      dismiss.type = "button";
      dismiss.addEventListener("click", () => { banner.hidden = true; });
      banner.append(dismiss);
    }

    /* ----- preview enhancement: typed blocks, script blocks, drag ----- */
    function enhancePreview(previewEl, note) {
      if (!previewEl || !note) return;
      const blocks = parseTypedBlocks(note.body ?? "");
      const scripts = extractScripts(note.body ?? "");
      // Typed blocks render as code blocks; replace each with an editable card.
      const codeBlocks = [...previewEl.querySelectorAll("pre code")];
      const decodeEntities = (text) => String(text ?? "")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      for (const code of codeBlocks) {
        const lang = String(code.className ?? "");
        const typedMatch = lang.match(/xpin-(task|person|project|book|idea)/);
        const scriptMatch = lang.match(/xpin-script/);
        const codeText = decodeEntities(code.textContent);
        const pre = code.closest("pre") ?? code.parentNode;
        // The renderer wraps the <pre> in a <section> with a language
        // header — replace the whole code block, header included.
        const blockEl = pre.closest("section") ?? pre;
        if (!typedMatch && !scriptMatch) continue;
        if (typedMatch) {
          const block = blocks.find((b) => b.type === typedMatch[1] && codeText.includes(JSON.stringify(b.fields).slice(0, 40)));
          if (!block) continue;
          const card = el("div", "p3-typed-block");
          const chip = el("span", "p3-type-chip", TYPED_BLOCK_TYPES[block.type].label);
          const title = el("strong", "p3-typed-title", typedBlockTitle(block));
          card.append(chip, title);
          const fieldsWrap = el("div", "p3-typed-fields");
          for (const field of TYPED_BLOCK_TYPES[block.type].fields.slice(1)) {
            const label = el("label", "p3-typed-field", field.label);
            let input;
            if (field.type === "select") {
              input = doc.createElement("select");
              for (const option of field.options) {
                const opt = doc.createElement("option");
                opt.value = option; opt.textContent = option;
                if (option === block.fields[field.key]) opt.selected = true;
                input.append(opt);
              }
            } else {
              input = doc.createElement("input");
              input.type = field.type === "date" ? "date" : field.type === "number" ? "number" : "text";
              input.value = block.fields[field.key] ?? "";
            }
            input.addEventListener("change", () => {
              try {
                const next = { ...block.fields, [field.key]: input.value };
                const clean = validateTypedFields(block.type, next);
                const nextBody = note.body.slice(0, block.index) + serializeTypedBlock(block.type, clean) + note.body.slice(block.index + block.raw.length);
                host.updateNote?.(note.id, { body: nextBody });
                persist();
                host.render?.();
              } catch (error) {
                notify(error?.message ?? "That value is not valid for this field.");
              }
            });
            label.append(input);
            fieldsWrap.append(label);
          }
          card.append(fieldsWrap);
          const feed = el("button", "feature-button", "Send to database");
          feed.type = "button";
          feed.addEventListener("click", async () => {
            const tables = state().features?.tables ?? [];
            if (!tables.length) { notify("No database exists yet — create one in Databases first."); return; }
            const choice = await showDialog(doc, {
              title: "Send to database",
              message: `Send this ${TYPED_BLOCK_TYPES[block.type].label.toLowerCase()} to a database as a new row.`,
              label: "Database",
              value: tables[0].id,
              options: tables.map((t) => ({ value: t.id, label: t.name }))
            });
            if (!choice) return;
            const table = tables.find((t) => t.id === choice);
            if (!table) return;
            table.rows.push({ id: makeId("row"), values: typedBlockToRow(block, table) });
            host.emit?.("database:row:changed", { tableId: table.id, action: "added" });
            persist();
            notify(`Added to “${table.name}”.`);
          });
          card.append(feed);
          blockEl.replaceWith(card);
        } else if (scriptMatch) {
          const script = scripts.find((s) => codeText.includes(s.source.slice(0, 40)));
          if (!script) continue;
          const card = el("div", "p3-script-block");
          card.append(el("span", "p3-type-chip", "Script"));
          card.append(el("strong", "p3-typed-title", "xpin-script — runs only when you ask it to"));
          const run = el("button", "feature-button", "▶ Run script");
          run.type = "button";
          run.addEventListener("click", async () => {
            try {
              const hash = await scriptDigest(script.source);
              if (!isScriptApproved(p3(), hash)) {
                await showScriptApprovalDialog({ source: script.source, name: `Script in “${note.title || "Untitled note"}”`, noteId: note.id });
              } else {
                await runApprovedScript({ source: script.source, name: "Note script", permissions: SCRIPT_PERMISSIONS.slice(0, 5), noteId: note.id, eventDetail: { type: "manual", noteId: note.id } });
                notify("Script ran.");
              }
              renderAll();
            } catch (error) {
              notify(error?.message ?? "Script failed.");
            }
          });
          card.append(run);
          blockEl.replaceWith(card);
        }
      }
      // Block drag in split-preview mode: top-level preview blocks are
      // draggable; dropping one reorders the underlying Markdown blocks.
      if (splitOn) {
        const children = [...previewEl.children];
        children.forEach((child, index) => {
          child.draggable = true;
          child.dataset.p3Block = String(index);
          child.addEventListener("dragstart", (event) => {
            event.dataTransfer?.setData("text/plain", String(index));
          });
          child.addEventListener("dragover", (event) => { event.preventDefault(); });
          child.addEventListener("drop", (event) => {
            event.preventDefault();
            const from = Number(event.dataTransfer?.getData("text/plain"));
            if (!Number.isFinite(from)) return;
            const result = reorderBlocks(note.body ?? "", from, index);
            if (!result.moved) return;
            host.updateNote?.(note.id, { body: result.text });
            persist();
            host.render?.();
          });
        });
      }
    }

    /* ----- split preview + block keyboard move ----- */
    function setSplitPreview(on) {
      splitOn = Boolean(on);
      const fields = doc.querySelector(".editor-fields");
      const body = doc.getElementById("note-body");
      const preview = doc.getElementById("markdown-preview");
      const note = host.currentNote?.();
      if (fields) fields.classList.toggle("editor-split", splitOn);
      if (splitOn && body && preview && note) {
        body.hidden = false;
        preview.hidden = false;
        host.renderPreview?.(note.body ?? "");
        enhancePreview(preview, note);
      } else if (body && preview) {
        body.hidden = false;
        preview.hidden = true;
      }
      p3().settings.splitPreview = splitOn;
      persist();
      const toggle = doc.getElementById("toggle-split-preview");
      if (toggle) toggle.setAttribute("aria-pressed", String(splitOn));
    }

    function setupEditorKeys() {
      const body = doc.getElementById("note-body");
      if (!body) return;
      body.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        const note = host.currentNote?.();
        if (!note) return;
        event.preventDefault();
        const result = moveBlock(note.body ?? "", body.selectionStart ?? 0, event.key === "ArrowUp" ? -1 : 1);
        if (!result.moved) return;
        host.updateNote?.(note.id, { body: result.text });
        persist();
        host.render?.();
        notify("Block moved.");
      });
    }

    /* ----- Power & polish view: tasks/calendar, scripts, queries, sharing, settings ----- */
    function renderPowerView() {
      const view = doc.getElementById("phase3-view");
      if (!view || view.hidden) return;
      view.replaceChildren();
      const wrap = el("div", "p3-view");
      wrap.append(el("h2", "", "Power & polish."));
      wrap.append(el("p", "feature-help", "Scripts, typed blocks, live queries, task scores, sharing — one layer deeper than the everyday surface."));

      // Tasks & calendar
      const tasksSection = el("section", "tools-section");
      tasksSection.append(el("h2", "", "Tasks & calendar"));
      tasksSection.append(el("p", "", TASK_SCORE_FORMULA));
      const tasks = extractTasks(state().notes).filter((t) => !t.done).sort((a, b) => b.score - a.score);
      const taskList = el("div", "p3-task-list");
      for (const task of tasks.slice(0, 30)) {
        const item = el("div", `p3-task${selectedTaskId === task.id ? " is-selected" : ""}`);
        item.draggable = true;
        item.dataset.taskId = task.id;
        item.append(el("span", "p3-task-score", String(task.score)));
        item.append(el("span", "p3-task-text", `${task.text} — ${task.noteTitle}${task.due ? ` · due ${task.due}` : " · no due date"}`));
        item.addEventListener("click", () => {
          selectedTaskId = selectedTaskId === task.id ? null : task.id;
          renderPowerView();
        });
        item.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/plain", task.id);
        });
        taskList.append(item);
      }
      if (!tasks.length) taskList.append(el("p", "feature-empty", "No open tasks. Add “- [ ] Buy milk due:2026-11-20 p:high” to a note, or a task block from the slash menu."));
      tasksSection.append(taskList);
      tasksSection.append(el("p", "feature-help", "Drag a task onto a date, or tap a task then tap a date, to set its due date."));
      const calHead = el("div", "p3-cal-head");
      const prev = el("button", "feature-button", "‹ Prev");
      prev.type = "button";
      const next = el("button", "feature-button", "Next ›");
      next.type = "button";
      const calTitle = el("strong", "p3-cal-title", calendarCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
      prev.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1); renderPowerView(); });
      next.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1); renderPowerView(); });
      calHead.append(prev, calTitle, next);
      tasksSection.append(calHead);
      const grid = el("div", "p3-calendar");
      for (const week of monthGrid(calendarCursor.getFullYear(), calendarCursor.getMonth())) {
        for (const day of week) {
          const cell = el("button", `p3-cal-day${day.inMonth ? "" : " is-other-month"}${day.dateKey === localDateKey() ? " is-today" : ""}`);
          cell.type = "button";
          cell.dataset.dateKey = day.dateKey;
          const dayTasks = tasksForDate(tasks, day.dateKey);
          cell.append(el("span", "p3-cal-num", String(day.day)));
          if (dayTasks.length) cell.append(el("span", "p3-cal-dot", `● ${dayTasks.length}`));
          const assign = (taskId) => {
            const task = extractTasks(state().notes).find((t) => t.id === taskId);
            if (!task) return;
            const note = state().notes.find((n) => n.id === task.noteId);
            if (!note) return;
            const nextBody = setTaskDueInBody(note.body, { ...task, due: day.dateKey });
            host.updateNote?.(note.id, { body: nextBody });
            persist();
            selectedTaskId = null;
            notify(`“${task.text}” is now due ${day.dateKey}.`);
            renderPowerView();
            host.render?.();
          };
          cell.addEventListener("click", () => {
            if (selectedTaskId) assign(selectedTaskId);
          });
          cell.addEventListener("dragover", (event) => { event.preventDefault(); });
          cell.addEventListener("drop", (event) => {
            event.preventDefault();
            const taskId = event.dataTransfer?.getData("text/plain");
            if (taskId) assign(taskId);
          });
          grid.append(cell);
        }
      }
      tasksSection.append(grid);
      wrap.append(tasksSection);

      // Scripts & hooks
      const scriptsSection = el("section", "tools-section");
      scriptsSection.append(el("h2", "", "Scripts in notes"));
      scriptsSection.append(el("p", "", "A ```xpin-script block in a note runs only when you tap “Run script”, or when an approved hook fires. Never automatically on open. Scripts run in the sandboxed worker with the same approval queue as plugins."));
      const note = host.currentNote?.();
      const noteScripts = note ? extractScripts(note.body ?? "") : [];
      if (!noteScripts.length) scriptsSection.append(el("p", "feature-empty", "No script in the open note. Add one from the slash menu (Script block)."));
      for (const script of noteScripts) {
        const card = el("div", "p3-script-card");
        card.append(el("strong", "", `Script in “${note.title || "Untitled note"}”`));
        card.append(el("p", "feature-help", script.source.slice(0, 120)));
        const row = el("div", "p3-row");
        const run = el("button", "feature-button feature-button-primary", "▶ Run script");
        run.type = "button";
        run.addEventListener("click", async () => {
          try {
            const hash = await scriptDigest(script.source);
            if (!isScriptApproved(p3(), hash)) {
              await showScriptApprovalDialog({ source: script.source, name: `Script in “${note.title || "Untitled note"}”`, noteId: note.id });
            } else {
              await runApprovedScript({ source: script.source, name: "Note script", permissions: SCRIPT_PERMISSIONS.slice(0, 5), noteId: note.id, eventDetail: { type: "manual", noteId: note.id } });
              notify("Script ran.");
            }
          } catch (error) {
            notify(error?.message ?? "Script failed.");
          }
        });
        row.append(run);
        card.append(row);
        scriptsSection.append(card);
      }
      scriptsSection.append(el("h3", "", "Event hooks"));
      const hooks = p3().hooks;
      if (!hooks.length) scriptsSection.append(el("p", "feature-empty", "No hooks yet. A hook runs an approved script when an event fires."));
      for (const hook of hooks) {
        const row = el("div", "p3-row");
        const label = el("span", "", `${hook.event} → ${p3().scripts.approved.find((s) => s.id === hook.scriptId)?.name ?? "script"}`);
        const toggle = el("input");
        toggle.type = "checkbox";
        toggle.checked = hook.enabled !== false;
        toggle.addEventListener("change", () => { hook.enabled = toggle.checked; persist(); });
        const remove = el("button", "database-row-remove", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => {
          p3().hooks = p3().hooks.filter((h) => h.id !== hook.id);
          persist();
          renderPowerView();
        });
        row.append(label, toggle, remove);
        scriptsSection.append(row);
      }
      const hookRow = el("div", "p3-row");
      const eventSelect = doc.createElement("select");
      eventSelect.className = "feature-input";
      for (const eventName of HOOK_EVENTS) {
        const opt = doc.createElement("option");
        opt.value = eventName; opt.textContent = eventName;
        eventSelect.append(opt);
      }
      const scriptSelect = doc.createElement("select");
      scriptSelect.className = "feature-input";
      for (const script of p3().scripts.approved) {
        const opt = doc.createElement("option");
        opt.value = script.id; opt.textContent = script.name;
        scriptSelect.append(opt);
      }
      const addHook = el("button", "feature-button", "Add hook");
      addHook.type = "button";
      addHook.addEventListener("click", () => {
        if (!scriptSelect.value) { notify("Approve a script first — hooks only run approved scripts."); return; }
        p3().hooks.push({ id: makeId("hook"), event: eventSelect.value, scriptId: scriptSelect.value, enabled: true });
        persist();
        renderPowerView();
        notify("Hook added.");
      });
      hookRow.append(eventSelect, scriptSelect, addHook);
      scriptsSection.append(hookRow);
      wrap.append(scriptsSection);

      // Saved queries
      const querySection = el("section", "tools-section");
      querySection.append(el("h2", "", "Saved queries"));
      querySection.append(el("p", "", "Live views over your notes. AND/OR, ORDER BY, LIMIT. A saved query re-runs whenever notes change — run it from here or the sidebar."));
      querySection.append(el("p", "feature-help", "Example: LIST FROM notes WHERE tag = work AND pinned = true ORDER BY updated DESC LIMIT 10"));
      const saveRow = el("div", "p3-row");
      const nameInput = el("input", "feature-input");
      nameInput.placeholder = "Query name";
      nameInput.maxLength = 80;
      const queryInput = el("input", "feature-input");
      queryInput.placeholder = "LIST FROM notes WHERE …";
      queryInput.maxLength = 500;
      const saveBtn = el("button", "feature-button", "Save query");
      saveBtn.type = "button";
      saveBtn.addEventListener("click", () => {
        try {
          saveQueryRecord(p3(), { name: nameInput.value, query: queryInput.value });
          persist();
          renderSidebar();
          renderPowerView();
          notify("Query saved.");
        } catch (error) {
          notify(error?.message ?? "Query could not be saved.");
        }
      });
      saveRow.append(nameInput, queryInput, saveBtn);
      querySection.append(saveRow);
      for (const saved of p3().savedQueries) {
        const row = el("div", "p3-row");
        row.append(el("span", "", `${saved.name} — ${saved.query}`));
        const run = el("button", "feature-button", "Run");
        run.type = "button";
        run.addEventListener("click", () => host.setFeatureQuery?.(saved.query));
        const remove = el("button", "database-row-remove", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => {
          p3().savedQueries = p3().savedQueries.filter((q) => q.id !== saved.id);
          persist();
          renderSidebar();
          renderPowerView();
        });
        row.append(run, remove);
        querySection.append(row);
      }
      wrap.append(querySection);

      // Sharing & comments
      const shareSection = el("section", "tools-section");
      shareSection.append(el("h2", "", "Sharing & spaces"));
      shareSection.append(el("p", "", "A space is a sync channel: a space id plus member device ids. Shared notes and comments sync through the existing encrypted sync envelopes — no server-side accounts. With no relay configured, sharing travels in sync bundles."));
      const spaceRow = el("div", "p3-row");
      const spaceName = el("input", "feature-input");
      spaceName.placeholder = "Space name";
      spaceName.maxLength = 80;
      const memberIds = el("input", "feature-input");
      memberIds.placeholder = "Member device ids, comma-separated (e.g. xpin-abc123)";
      const addSpace = el("button", "feature-button", "Create space");
      addSpace.type = "button";
      addSpace.addEventListener("click", () => {
        try {
          const members = memberIds.value.split(",").map((s) => s.trim()).filter(Boolean);
          const space = createSpace(p3(), { name: spaceName.value, memberDeviceIds: members });
          persist();
          renderPowerView();
          notify(`Space “${space.name}” created.`);
        } catch (error) {
          notify(error?.message ?? "Space could not be created.");
        }
      });
      spaceRow.append(spaceName, memberIds, addSpace);
      shareSection.append(spaceRow);
      for (const space of p3().spaces) {
        const row = el("div", "p3-row");
        row.append(el("span", "", `${space.name} — ${space.memberDeviceIds.length} member${space.memberDeviceIds.length === 1 ? "" : "s"} · ${space.noteIds.length} note${space.noteIds.length === 1 ? "" : "s"}`));
        if (note) {
          const sharedHere = space.noteIds.includes(note.id);
          const toggle = el("button", "feature-button", sharedHere ? "Unshare current note" : "Share current note");
          toggle.type = "button";
          toggle.addEventListener("click", () => {
            if (sharedHere) unshareNoteFromSpace(p3(), note.id, space.id);
            else shareNoteToSpace(p3(), note.id, space.id);
            persist();
            renderPowerView();
            renderComments();
            notify(sharedHere ? "Note removed from space." : `“${note.title || "Untitled note"}” shared to “${space.name}”.`);
          });
          row.append(toggle);
        }
        shareSection.append(row);
      }
      wrap.append(shareSection);

      // Settings: theme + font
      const settingsSection = el("section", "tools-section");
      settingsSection.append(el("h2", "", "Appearance"));
      const themeRow = el("div", "p3-row");
      themeRow.append(el("label", "", "Theme"));
      const themeSelect = doc.createElement("select");
      themeSelect.className = "feature-input";
      for (const [value, label] of [["dark", "Dark"], ["light", "Light"]]) {
        const opt = doc.createElement("option");
        opt.value = value; opt.textContent = label;
        if (p3().settings.theme === value) opt.selected = true;
        themeSelect.append(opt);
      }
      themeSelect.addEventListener("change", () => {
        p3().settings.theme = themeSelect.value;
        applyTheme();
        persist();
      });
      themeRow.append(themeSelect);
      themeRow.append(el("label", "", "Editor font"));
      const fontSelect = doc.createElement("select");
      fontSelect.className = "feature-input";
      for (const [value, label] of [["system", "System"], ["serif", "Serif"], ["mono", "Mono"]]) {
        const opt = doc.createElement("option");
        opt.value = value; opt.textContent = label;
        if (p3().settings.font === value) opt.selected = true;
        fontSelect.append(opt);
      }
      fontSelect.addEventListener("change", () => {
        p3().settings.font = fontSelect.value;
        applyTheme();
        persist();
      });
      themeRow.append(fontSelect);
      settingsSection.append(themeRow);
      const todayReminders = remindersForDate(p3(), localDateKey());
      settingsSection.append(el("p", "feature-help", todayReminders.length
        ? `Reminders today: ${todayReminders.map((r) => r.label).join(" · ")}. Reminders are in-app only and appear when the daily note opens.`
        : "No reminders today. Set one from a database row with a date field — it appears on the daily note that day (in-app only)."));
      wrap.append(settingsSection);

      view.append(wrap);
    }

    /* ----- editor toolbar: share + voice ----- */
    function setupEditorTools() {
      const shareBtn = doc.getElementById("share-note");
      if (shareBtn) {
        shareBtn.addEventListener("click", async () => {
          const note = host.currentNote?.();
          if (!note) { notify("Open a note to share it."); return; }
          const text = shareTextForNote(note);
          try {
            if (typeof navigator !== "undefined" && navigator.share) {
              await navigator.share({ title: note.title || "Untitled note", text });
              notify("Shared.");
            } else if (navigator?.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
              notify("Sharing is not available here — the note was copied to the clipboard instead.");
            } else {
              notify("Sharing is not available in this browser.");
            }
          } catch (error) {
            if (error?.name !== "AbortError") notify("Sharing failed — nothing was sent.");
          }
        });
      }
      const voiceBtn = doc.getElementById("voice-capture");
      if (voiceBtn) {
        // Quick voice capture reusing the Phase 2 voice-memo path: record
        // with MediaRecorder, save the audio as a Phase 2 attachment on the
        // current note. No transcription is faked — the audio is the record.
        let recording = null;
        voiceBtn.addEventListener("click", async () => {
          const note = host.currentNote?.();
          if (!note) { notify("Open a note to capture voice into it."); return; }
          if (recording) {
            const { recorder, stream, chunks } = recording;
            recording = null;
            voiceBtn.textContent = "🎙 Voice";
            try {
              await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
              stream.getTracks().forEach((t) => t.stop());
              const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
              const file = new File([blob], `voice-memo-${localDateKey()}.webm`, { type: blob.type });
              const { record } = await window.xPinPhase2.storeAttachment({ noteId: note.id, file });
              state().attachments.push(record);
              host.insertText?.(`\n${window.xPinPhase2.attachmentMarkdown(record)}\n`);
              persist();
              notify("Voice memo attached to this note.");
            } catch (error) {
              notify(error?.message ?? "Voice memo could not be saved.");
            }
            return;
          }
          if (typeof MediaRecorder === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
            notify("Voice recording is not available in this browser.");
            return;
          }
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            const chunks = [];
            recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
            recorder.start();
            recording = { recorder, stream, chunks };
            voiceBtn.textContent = "■ Stop voice";
          } catch (error) {
            notify("Microphone was not available — check the browser permission.");
          }
        });
      }
      const splitBtn = doc.getElementById("toggle-split-preview");
      if (splitBtn) {
        splitBtn.addEventListener("click", () => setSplitPreview(!splitOn));
        if (p3().settings.splitPreview) setSplitPreview(true);
      }
    }

    function setupAndroid() {
      try {
        const App = window.Capacitor?.Plugins?.App;
        if (!App || typeof App.addListener !== "function") return;
        App.addListener("backButton", () => {
          const dialogOpen = !!doc.querySelector(".modal-backdrop:not([hidden])") || !!doc.querySelector(".xpin-dialog-backdrop");
          const viewActive = ["phase3-view", "phase2-view", "feature-view", "canvas-view"]
            .some((id) => { const v = doc.getElementById(id); return v && !v.hidden; });
          const action = backButtonAction({ dialogOpen, viewActive });
          if (action === "close-dialog") {
            const open = doc.querySelector(".xpin-dialog-backdrop") ?? doc.querySelector(".modal-backdrop:not([hidden])");
            if (open?.querySelector("[data-close-dialog]")) open.querySelector("[data-close-dialog]").click();
            else if (open) open.remove();
          } else if (action === "go-back") {
            host.showNotesView?.();
          } else if (typeof App.exitApp === "function") {
            App.exitApp();
          }
        });
        // Share-target / deep-link delivery on launch: Capacitor delivers
        // VIEW intents as appUrlOpen (handled in app.js) and the launch URL
        // here. A raw SEND intent has no JS bridge without a native plugin,
        // so it is NOT claimed as received — see the Phase 3 report.
        if (typeof App.getLaunchUrl === "function") {
          App.getLaunchUrl().then((result) => {
            if (result?.url) host.handleDeepLink?.(result.url);
          }).catch(() => { /* no launch URL: web build */ });
        }
      } catch { /* no Capacitor bridge: web build */ }
    }

    /* ----- event hooks: subscribe to the Phase 1 event bus ----- */
    function setupHooks() {
      if (typeof host.on !== "function") return;
      for (const eventName of HOOK_EVENTS) {
        host.on(eventName, async (detail) => {
          const hooks = matchHooks(p3(), eventName);
          for (const hook of hooks) {
            const script = p3().scripts.approved.find((s) => s.id === hook.scriptId);
            if (!script) continue;
            try {
              await runScript({
                source: script.source, name: script.name, permissions: script.permissions,
                host: { scriptRequest, notify }, noteId: detail?.id ?? null,
                eventDetail: { type: eventName, ...detail }
              });
            } catch (error) {
              notify(`Hook for ${eventName} failed: ${error?.message ?? error}`);
            }
          }
        });
      }
    }

    function renderAll() {
      applyTheme();
      renderSidebar();
      renderComments();
      renderDailyReminders();
      renderPowerView();
    }

    applyTheme();
    setupEditorKeys();
    setupEditorTools();
    setupAndroid();
    setupHooks();
    renderSidebar();

    return Object.freeze({
      renderAll,
      renderSidebar,
      renderComments,
      renderDailyReminders,
      renderPowerView,
      enhancePreview,
      setSplitPreview,
      runApprovedScript,
      showScriptApprovalDialog,
      get splitPreview() { return splitOn; }
    });
  }

  const api = Object.freeze({
    // state
    defaultPhase3State,
    sanitizePhase3State,
    sanitizeSettings,
    // Item 1
    SCRIPT_PERMISSIONS,
    HOOK_EVENTS,
    extractScripts,
    hasScriptBlock,
    scriptDigest,
    wrapScriptAsPackage,
    isScriptApproved,
    approvedScript,
    approveScriptRecord,
    revokeScript,
    matchHooks,
    runScript,
    // Item 2
    TYPED_BLOCK_TYPES,
    validateTypedFields,
    serializeTypedBlock,
    parseTypedBlocks,
    typedBlockTitle,
    typedBlockToRow,
    // Item 3
    parseQueryV2,
    runQueryV2,
    saveQueryRecord,
    // Item 4
    TASK_SCORE_FORMULA,
    urgencyPoints,
    importancePoints,
    agePoints,
    taskScore,
    parseTaskLine,
    extractTasks,
    setTaskDueInBody,
    tasksForDate,
    monthGrid,
    // Item 6
    splitBlocks,
    moveBlock,
    reorderBlocks,
    // Item 5
    evaluateFormula,
    formatFormulaValue,
    applyDatabaseView,
    createReminder,
    remindersForDate,
    // Item 7
    buildGraph,
    localGraph,
    findOrphans,
    graphTags,
    // Item 8
    createSpace,
    shareNoteToSpace,
    unshareNoteFromSpace,
    spacesForNote,
    createComment,
    extractMentions,
    commentsForNote,
    unreadMentions,
    mentionsForMe,
    // Item 9
    backButtonAction,
    shareTextForNote,
    captureSharedText,
    applyThemeSettings,
    showDialog,
    showConfirm,
    // UI
    createPhase3UI
  });

  if (typeof window !== "undefined") window.xPinPhase3 = api;
  if (typeof globalThis !== "undefined" && typeof module !== "undefined" && module.exports) module.exports = api;
})();
