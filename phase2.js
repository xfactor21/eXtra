/* xPin Phase 2 — Capture & smarts (NEXT-LEVEL-PLAN.md Phase 2).
 *
 * One module, loaded before app.js. Pure logic lives on window.xPinPhase2
 * (ranked search, FSRS-4.5, APKG SQLite writer/reader, importers, AI
 * assists) so the headless smoke suite can drive it directly; the DOM UI
 * is built by createPhase2UI(host) and only touches elements app.js owns.
 *
 * Honesty rules carried through this file:
 * - Attachments > 1 MB never claim to sync (they stay device-local).
 * - Semantic search and cloud AI/transcription are BYOK + off by default;
 *   with no key they report honestly unavailable, never fake results.
 * - The APKG reader handles decks this writer produces (and other small
 *   single-page-table decks); overflow pages and huge Anki files are
 *   reported as unsupported, not silently misread.
 * - FSRS-4.5 follows the published algorithm (open-spaced-repetition /
 *   fsrs4anki wiki, "The Algorithm"): R(t,S) = (1 + (19/81)*t/S)^-0.5,
 *   S0(G) = w[G-1], D0(G) = w4 - (G-3)*w5,
 *   D' = w7*D0(3) + (1-w7)*(D - w6*(G-3)),
 *   success S' = S*(1 + e^w8*(11-D)*S^-w9*(e^(w10*(1-R))-1)*hard*w15/easy*w16),
 *   lapse  S' = min(w11*D^-w12*((S+1)^w13 - 1)*e^(w14*(1-R)), S).
 *   Same-day re-reviews use the standard update (FSRS-4.5 has no
 *   same-day special case; that arrived in FSRS-5).
 * - No API key is ever stored here: keys live only in the Phase 1
 *   credential store (sync/credentials.js, encrypted envelopes) and are
 *   held in memory only while a request runs.
 */
(() => {
  "use strict";

  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file
  const SYNCABLE_ATTACHMENT_BYTES = 1024 * 1024; // <= 1 MB travels in sync envelopes
  const MAX_ATTACHMENTS = 500;
  const MAX_READ_LATER = 500;
  const MAX_HIGHLIGHTS = 1000;
  const MAX_FLASHCARDS = 2000;
  const MAX_APKG_CARDS = 500; // 64 KiB pages, one leaf page per table
  const APKG_FIELD_CHARS = 1500; // per-field cap so a table fits one page
  const PHASE2_IDB_NAME = "xpin-phase2";
  const PHASE2_IDB_VERSION = 1;

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value ?? ""));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  function crc32(bytes) {
    let table = crc32.table;
    if (!table) {
      table = crc32.table = new Int32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text ?? ""));
  }

  function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  }

  /* ---------------- state sanitizers (audit G4: new keys must survive) ---------------- */

  const AI_PROVIDERS = ["claude", "openai", "gemini"];
  const DEFAULT_AI = Object.freeze({
    enabled: false,
    provider: "claude",
    baseUrl: "",
    embeddingsEnabled: false,
    embeddingsBaseUrl: ""
  });

  function sanitizeAiSettings(value) {
    const clean = { ...DEFAULT_AI };
    if (!isPlainObject(value)) return clean;
    clean.enabled = value.enabled === true;
    if (AI_PROVIDERS.includes(value.provider)) clean.provider = value.provider;
    if (typeof value.baseUrl === "string") clean.baseUrl = value.baseUrl.slice(0, 500);
    clean.embeddingsEnabled = value.embeddingsEnabled === true;
    if (typeof value.embeddingsBaseUrl === "string") clean.embeddingsBaseUrl = value.embeddingsBaseUrl.slice(0, 500);
    return clean;
  }

  function sanitizeSettings(value) {
    const clean = { dailyLanding: true, ai: sanitizeAiSettings(null) };
    if (!isPlainObject(value)) return clean;
    clean.dailyLanding = value.dailyLanding !== false; // default ON
    clean.ai = sanitizeAiSettings(value.ai);
    return clean;
  }

  function sanitizeAttachments(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value) {
      if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) continue;
      if (typeof item.noteId !== "string" || typeof item.name !== "string") continue;
      if (typeof item.mime !== "string" || !Number.isFinite(item.size)) continue;
      clean.push({
        id: item.id.slice(0, 120),
        noteId: item.noteId.slice(0, 120),
        name: item.name.slice(0, 200),
        mime: item.mime.slice(0, 120),
        size: Math.max(0, Math.min(MAX_ATTACHMENT_BYTES, Math.floor(item.size))),
        createdAt: typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
          ? item.createdAt : new Date(0).toISOString(),
        // data: base64 blob, present ONLY for <= 1 MB attachments that are
        // syncable (see syncableAttachments). Large attachments keep their
        // bytes in IndexedDB only and carry synced:false.
        data: typeof item.data === "string" && item.data.length <= 1_400_000 ? item.data : null,
        synced: item.synced === true
      });
      if (clean.length >= MAX_ATTACHMENTS) break;
    }
    return clean;
  }

  function sanitizeReadLater(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value) {
      if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) continue;
      clean.push({
        id: item.id.slice(0, 120),
        url: typeof item.url === "string" ? item.url.slice(0, 2000) : "",
        title: typeof item.title === "string" ? item.title.slice(0, 300) : "Untitled",
        text: typeof item.text === "string" ? item.text.slice(0, 100_000) : "",
        fetchedText: typeof item.fetchedText === "string" ? item.fetchedText.slice(0, 100_000) : "",
        fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
        fetchStatus: ["saved", "fetched", "fetch-failed"].includes(item.fetchStatus) ? item.fetchStatus : "saved",
        savedAt: typeof item.savedAt === "string" && Number.isFinite(Date.parse(item.savedAt))
          ? item.savedAt : new Date(0).toISOString(),
        read: item.read === true
      });
      if (clean.length >= MAX_READ_LATER) break;
    }
    return clean;
  }

  function sanitizeHighlights(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value) {
      if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) continue;
      if (typeof item.quote !== "string" || !item.quote.trim()) continue;
      clean.push({
        id: item.id.slice(0, 120),
        quote: item.quote.slice(0, 5000),
        sourceId: typeof item.sourceId === "string" ? item.sourceId.slice(0, 120) : null,
        sourceTitle: typeof item.sourceTitle === "string" ? item.sourceTitle.slice(0, 300) : "",
        sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl.slice(0, 2000) : "",
        createdAt: typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
          ? item.createdAt : new Date(0).toISOString(),
        dismissedAt: typeof item.dismissedAt === "string" ? item.dismissedAt : null,
        shownCount: Number.isFinite(item.shownCount) ? Math.max(0, Math.floor(item.shownCount)) : 0
      });
      if (clean.length >= MAX_HIGHLIGHTS) break;
    }
    return clean;
  }

  function sanitizeFlashcards(value) {
    if (!Array.isArray(value)) return [];
    const clean = [];
    for (const item of value) {
      if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) continue;
      if (typeof item.front !== "string" || typeof item.back !== "string") continue;
      clean.push({
        id: item.id.slice(0, 120),
        front: item.front.slice(0, 8000),
        back: item.back.slice(0, 8000),
        sourceNoteId: typeof item.sourceNoteId === "string" ? item.sourceNoteId.slice(0, 120) : null,
        kind: item.kind === "qa" ? "qa" : "cloze",
        clozeIndex: Number.isFinite(item.clozeIndex) ? Math.max(1, Math.floor(item.clozeIndex)) : 1,
        stability: Number.isFinite(item.stability) ? clamp(item.stability, 0.01, 36500) : null,
        difficulty: Number.isFinite(item.difficulty) ? clamp(item.difficulty, 1, 10) : null,
        dueAt: typeof item.dueAt === "string" && Number.isFinite(Date.parse(item.dueAt)) ? item.dueAt : null,
        lastReviewedAt: typeof item.lastReviewedAt === "string" ? item.lastReviewedAt : null,
        reviews: Number.isFinite(item.reviews) ? Math.max(0, Math.floor(item.reviews)) : 0,
        lapses: Number.isFinite(item.lapses) ? Math.max(0, Math.floor(item.lapses)) : 0
      });
      if (clean.length >= MAX_FLASHCARDS) break;
    }
    return clean;
  }

  // Sanitize the whole Phase 2 slice of a loaded workspace. app.js merges
  // the result into state; unknown keys are dropped, known ones survive.
  function sanitizePhase2State(value) {
    const input = isPlainObject(value) ? value : {};
    return {
      settings: sanitizeSettings(input.settings),
      attachments: sanitizeAttachments(input.attachments),
      readLater: sanitizeReadLater(input.readLater),
      highlights: sanitizeHighlights(input.highlights),
      flashcards: sanitizeFlashcards(input.flashcards)
    };
  }

  function defaultPhase2State() {
    return sanitizePhase2State({});
  }

  /* ---------------- Item 2 — ranked search ---------------- */

  const STOP_WORDS = new Set(("a an the and or of to in on for with is are was were be been it its this that at by from as").split(" "));

  function tokenize(text) {
    return String(text ?? "").toLocaleLowerCase()
      .split(/[^a-z0-9_#\/]+/i)
      .map((token) => token.replace(/^#+/, ""))
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  }

  function headingText(body) {
    const heads = [];
    for (const line of String(body ?? "").split("\n")) {
      const match = line.match(/^#{1,6}\s+(.*)$/);
      if (match) heads.push(match[1]);
    }
    return heads.join(" ");
  }

  // Score one note against query tokens. Title > headings > body frequency;
  // recency is a small tiebreak only (never outweighs a real match).
  function scoreNote(note, tokens) {
    const title = String(note.title ?? "");
    const body = String(note.body ?? "");
    const heads = headingText(body);
    const titleTokens = tokenize(title);
    const headTokens = tokenize(heads);
    const bodyTokens = tokenize(body);
    const bodyFreq = new Map();
    for (const token of bodyTokens) bodyFreq.set(token, (bodyFreq.get(token) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      const inTitle = titleTokens.some((t) => t === token || t.startsWith(token));
      const inHead = headTokens.some((t) => t === token || t.startsWith(token));
      const freq = bodyFreq.get(token) ?? (bodyTokens.some((t) => t.startsWith(token)) ? 1 : 0);
      if (inTitle) { score += 10; matched += 1; }
      if (inHead) { score += 5; matched += 1; }
      if (freq > 0) { score += 1 + Math.min(3, freq - 1) * 0.5; matched += 1; }
      // Exact-phrase bonus: the raw query appears verbatim in title/body.
      if (title.toLocaleLowerCase().includes(token)) score += 0.5;
    }
    if (matched === 0) return 0;
    // Small recency tiebreak: up to +1 for notes touched in the last 30 days.
    const ageDays = (Date.now() - Date.parse(note.updatedAt ?? note.createdAt ?? 0)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays >= 0) score += Math.max(0, 1 - ageDays / 30);
    return score;
  }

  function makeSnippet(note, tokens) {
    const text = `${note.title ?? ""}\n${note.body ?? ""}`.replace(/\s+/g, " ");
    const lower = text.toLocaleLowerCase();
    let bestIndex = -1;
    for (const token of tokens) {
      const index = lower.indexOf(token);
      if (index >= 0 && (bestIndex < 0 || index < bestIndex)) bestIndex = index;
    }
    if (bestIndex < 0) return { text: text.slice(0, 140), ranges: [] };
    const start = Math.max(0, bestIndex - 50);
    const end = Math.min(text.length, bestIndex + 110);
    const snippet = text.slice(start, end);
    const ranges = [];
    const snippetLower = snippet.toLocaleLowerCase();
    for (const token of tokens) {
      let from = 0;
      for (;;) {
        const at = snippetLower.indexOf(token, from);
        if (at < 0) break;
        ranges.push([at, at + token.length]);
        from = at + token.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    return { text: snippet, ranges, prefix: start > 0, suffix: end < text.length };
  }

  // Ranked search over notes. Returns [{note, score, snippet}] best first.
  // `notes` are full note records; ranking is deterministic (score, then
  // most recently updated, then id) so the list never shuffles on re-render.
  function rankNotes(notes, query) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const scored = [];
    for (const note of notes ?? []) {
      const score = scoreNote(note, tokens);
      if (score > 0) scored.push({ note, score, snippet: makeSnippet(note, tokens) });
    }
    scored.sort((a, b) => b.score - a.score
      || Date.parse(b.note.updatedAt ?? 0) - Date.parse(a.note.updatedAt ?? 0)
      || String(a.note.id).localeCompare(String(b.note.id)));
    return scored;
  }

  // Search the parts plain note search never reached: database row text and
  // canvas titles. Returns small typed extras for the list footer.
  function searchExtras(state, query) {
    const tokens = tokenize(query);
    const extras = [];
    if (!tokens.length || !isPlainObject(state)) return extras;
    const tables = state.features?.tables ?? [];
    for (const table of tables) {
      for (const row of table?.rows ?? []) {
        const text = Object.values(row?.values ?? {}).map(String).join(" ");
        if (tokens.some((t) => text.toLocaleLowerCase().includes(t))) {
          extras.push({ kind: "database", label: `${table.name ?? "Database"}: ${text.slice(0, 80)}`, tableId: table.id, rowId: row.id });
        }
      }
    }
    for (const canvas of state.canvases ?? []) {
      if (tokens.some((t) => String(canvas.name ?? "").toLocaleLowerCase().includes(t))) {
        extras.push({ kind: "canvas", label: `Canvas: ${canvas.name}`, canvasId: canvas.id });
      }
    }
    return extras.slice(0, 8);
  }

  /* ---------------- Item 2 — semantic search plumbing ---------------- */

  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // Blend keyword and semantic scores. Semantic is only ever an additive
  // boost on top of a real keyword signal or a standalone ranked list when
  // the caller explicitly asked for semantic-only results.
  function blendScores(keywordScore, semanticScore, weight = 0.5) {
    return keywordScore + clamp(semanticScore, -1, 1) * weight * Math.max(1, keywordScore * 0.25);
  }

  // BYOK embeddings call (OpenAI-compatible /embeddings endpoint). The key
  // comes from the credential store via the caller; it is never stored here.
  async function fetchEmbeddings({ baseUrl, apiKey, texts, model = "text-embedding-3-small" }) {
    if (typeof fetch !== "function") throw new Error("Embeddings need fetch, which is unavailable here.");
    if (!apiKey) throw new Error("Semantic search needs an embeddings API key — add one in Capture & smarts settings.");
    const url = String(baseUrl ?? "").replace(/\/+$/, "") || "https://api.openai.com/v1";
    const response = await fetch(`${url}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts })
    });
    if (!response.ok) throw new Error(`Embeddings request failed (${response.status}). Check the key and base URL.`);
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error("Embeddings endpoint returned an unexpected response.");
    return data.data.map((item) => item.embedding);
  }

  /* ---------------- Item 1 — attachments ---------------- */

  function attachmentRecord({ id, noteId, name, mime, size, createdAt, data = null, synced = false }) {
    return { id, noteId, name, mime, size, createdAt, data, synced };
  }

  function validateAttachmentFile(file) {
    if (!file || typeof file.name !== "string") throw new TypeError("Attachment needs a file.");
    if (typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`"${file.name}" is over the 25 MB per-file limit and was not attached.`);
    }
    return true;
  }

  function attachmentMarkdown(attachment) {
    const label = String(attachment.name ?? "file").replace(/[\[\]()]/g, "");
    const ref = `attachment:${attachment.id}`;
    return /^image\//.test(attachment.mime ?? "") || /\.(png|jpe?g|gif|webp|svg)$/i.test(attachment.name ?? "")
      ? `![${label}](${ref})`
      : `[${label}](${ref})`;
  }

  function attachmentUsage(attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    return {
      count: list.length,
      bytes: list.reduce((sum, item) => sum + (Number.isFinite(item.size) ? item.size : 0), 0),
      syncedBytes: list.filter((item) => item.synced).reduce((sum, item) => sum + (Number.isFinite(item.size) ? item.size : 0), 0),
      localOnly: list.filter((item) => !item.synced && (item.size ?? 0) > SYNCABLE_ATTACHMENT_BYTES)
    };
  }

  // Attachments small enough to travel inside a sync envelope (encrypted,
  // same as note bodies). Anything bigger stays device-local; the UI must
  // say so (see attachmentSyncNote).
  function syncableAttachments(attachments) {
    return sanitizeAttachments(attachments).filter((item) => item.size <= SYNCABLE_ATTACHMENT_BYTES && !!item.data);
  }

  function attachmentSyncNote(attachment) {
    if ((attachment?.size ?? 0) <= SYNCABLE_ATTACHMENT_BYTES) return "Synced with this note (encrypted).";
    return "Stored on this device only — not synced (over 1 MB).";
  }

  // Phase 2 IndexedDB: blobs + embedding vectors live outside the workspace
  // JSON so a 25 MB attachment never blows the localStorage backup copy.
  // Falls back to an in-memory Map when IndexedDB is unavailable (fake-DOM
  // smoke suite, old browsers); the fallback is session-only and honest.
  const memoryBlobStore = new Map();
  const memoryEmbeddingStore = new Map();
  let phase2DbPromise = null;

  function openPhase2Db() {
    if (phase2DbPromise) return phase2DbPromise;
    phase2DbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available."));
        return;
      }
      let request;
      try {
        request = indexedDB.open(PHASE2_IDB_NAME, PHASE2_IDB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("attachments")) {
          request.result.createObjectStore("attachments", { keyPath: "id" });
        }
        if (!request.result.objectStoreNames.contains("embeddings")) {
          request.result.createObjectStore("embeddings", { keyPath: "noteId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open the xPin attachments store."));
    }).catch((error) => {
      phase2DbPromise = null;
      throw error;
    });
    return phase2DbPromise;
  }

  function idbStoreOp(storeName, mode, run) {
    return openPhase2Db().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try {
        result = run(store);
      } catch (error) {
        reject(error);
        return;
      }
      const request = result;
      if (request && typeof request.onsuccess !== "undefined") {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error("Attachment store operation failed."));
      } else {
        resolve(result ?? null);
      }
      transaction.onerror = () => reject(transaction.error ?? new Error("Attachment store transaction failed."));
    }));
  }

  async function saveAttachmentBlob(id, blob) {
    try {
      await idbStoreOp("attachments", "readwrite", (store) => store.put({ id, blob, savedAt: new Date().toISOString() }));
      return "indexeddb";
    } catch {
      memoryBlobStore.set(id, blob);
      return "memory";
    }
  }

  async function getAttachmentBlob(id) {
    if (memoryBlobStore.has(id)) return memoryBlobStore.get(id);
    try {
      const record = await idbStoreOp("attachments", "readonly", (store) => store.get(id));
      return record?.blob ?? null;
    } catch {
      return memoryBlobStore.get(id) ?? null;
    }
  }

  async function deleteAttachmentBlob(id) {
    memoryBlobStore.delete(id);
    try {
      await idbStoreOp("attachments", "readwrite", (store) => store.delete(id));
    } catch { /* already gone from memory; nothing to do */ }
  }

  async function saveEmbedding(noteId, vector) {
    const clean = Array.isArray(vector) ? vector.filter(Number.isFinite).slice(0, 4096) : [];
    if (!clean.length) throw new TypeError("Embedding vector is empty.");
    try {
      await idbStoreOp("embeddings", "readwrite", (store) => store.put({ noteId, vector: clean, savedAt: new Date().toISOString() }));
      return "indexeddb";
    } catch {
      memoryEmbeddingStore.set(noteId, clean);
      return "memory";
    }
  }

  async function getEmbedding(noteId) {
    if (memoryEmbeddingStore.has(noteId)) return memoryEmbeddingStore.get(noteId);
    try {
      const record = await idbStoreOp("embeddings", "readonly", (store) => store.get(noteId));
      return record?.vector ?? null;
    } catch {
      return memoryEmbeddingStore.get(noteId) ?? null;
    }
  }

  // Build attachment metadata + store the blob. Returns the record to push
  // into state.attachments. Small blobs are ALSO base64'd into the record
  // (so they can travel inside sync envelopes); large ones are IDB-only.
  async function storeAttachment({ noteId, file }) {
    validateAttachmentFile(file);
    const id = makeId("attachment");
    const createdAt = new Date().toISOString();
    const blob = (typeof Blob !== "undefined" && file instanceof Blob)
      ? file : new Blob([file], { type: file.type ?? "application/octet-stream" });
    const backend = await saveAttachmentBlob(id, blob);
    let data = null;
    let synced = false;
    if (file.size <= SYNCABLE_ATTACHMENT_BYTES && typeof FileReader !== "undefined") {
      data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.startsWith("data:") ? result.split(",", 2)[1] ?? "" : result);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      synced = !!data;
    }
    return {
      record: attachmentRecord({ id, noteId, name: file.name.slice(0, 200), mime: file.type || "application/octet-stream", size: file.size, createdAt, data, synced }),
      backend
    };
  }

  // Resolve `attachment:<id>` references inside a rendered preview container:
  // images get an object URL, PDFs an <embed>, other files a download link.
  // Runs after render; elements carry data-attachment-id so a missing blob
  // still renders an honest "attachment unavailable on this device" line.
  async function resolveAttachmentRefs(container) {
    if (!container || typeof container.querySelectorAll !== "function") return 0;
    const refs = [...container.querySelectorAll("[data-attachment-id]")];
    let resolved = 0;
    for (const refEl of refs) {
      const id = refEl.getAttribute("data-attachment-id");
      const kind = refEl.getAttribute("data-attachment-kind") || "file";
      const name = refEl.getAttribute("data-attachment-name") || "file";
      const mime = refEl.getAttribute("data-attachment-mime") || "";
      const blob = await getAttachmentBlob(id);
      if (!blob) {
        refEl.textContent = `Attachment “${name}” is not on this device.`;
        continue;
      }
      if (kind === "image" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(blob);
        img.alt = name;
        img.loading = "lazy";
        img.className = "attachment-image";
        refEl.replaceChildren(img);
      } else if (kind === "pdf" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        const embed = document.createElement("embed");
        embed.src = URL.createObjectURL(blob);
        embed.type = "application/pdf";
        embed.className = "attachment-pdf";
        refEl.replaceChildren(embed);
      } else if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.textContent = `Download ${name}`;
        link.className = "attachment-download";
        refEl.replaceChildren(link);
      } else {
        refEl.textContent = `${name} (${mime || "file"}) — download is unavailable here.`;
      }
      resolved += 1;
    }
    return resolved;
  }

  /* ---------------- Item 5 — importers (Notion / Evernote / OneNote) ----------------
   * Real parsers, written dependency-free so they run in the app and in the
   * smoke suite (no DOMParser there). Each returns {notes, skipped} with
   * honest skip counts; nothing unparseable is silently dropped. */

  function decodeEntities(text) {
    return String(text ?? "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
  }

  function stripTagsToText(html) {
    return decodeEntities(String(html ?? "").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  }

  // Minimal HTML → Markdown for importer content: headings, lists, bold /
  // italic, links, paragraphs, line breaks. Anything else degrades to text.
  function htmlToMarkdown(html) {
    let text = String(html ?? "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/p>/gi, "\n\n").replace(/<\/div>/gi, "\n");
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => `\n${"#".repeat(Number(level))} ${stripTagsToText(inner)}\n`);
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${stripTagsToText(inner)}`);
    text = text.replace(/<\/(ul|ol)>/gi, "\n");
    text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => `[${stripTagsToText(inner)}](${href})`);
    text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, (_m, _t, inner) => `**${stripTagsToText(inner)}**`);
    text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_m, _t, inner) => `*${stripTagsToText(inner)}*`);
    text = text.replace(/<[^>]+>/g, "");
    return decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function parseEnex(xmlText) {
    const notes = [];
    let skipped = 0;
    const source = String(xmlText ?? "");
    if (!/<en-export[\s>]/.test(source) && !/<note[\s>]/.test(source)) {
      return { notes, skipped: 1, error: "This file does not look like an Evernote export (.enex)." };
    }
    const noteBlocks = [...source.matchAll(/<note>([\s\S]*?)<\/note>/gi)];
    if (!noteBlocks.length) return { notes, skipped: 1, error: "No <note> entries found in this .enex file." };
    for (const [, block] of noteBlocks) {
      try {
        const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
        const createdRaw = block.match(/<created>([\s\S]*?)<\/created>/i)?.[1]?.trim() ?? "";
        const contentRaw = block.match(/<content>([\s\S]*?)<\/content>/i)?.[1] ?? "";
        const content = contentRaw.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1");
        // ENML is XHTML: <en-note> wraps the body; <en-media> becomes a
        // placeholder line (the binary is not in the .enex text we parse).
        const withoutMedia = content
          .replace(/<en-media[^>]*\/>/gi, (m) => {
            const alt = m.match(/alt="([^"]*)"/i)?.[1] ?? "media";
            return `\n[Attached media: ${alt} — re-attach the original file in xPin.]\n`;
          })
          .replace(/<\/?en-note[^>]*>/gi, "");
        const body = htmlToMarkdown(withoutMedia);
        const tags = [...block.matchAll(/<tag>([\s\S]*?)<\/tag>/gi)]
          .map((m) => `#${decodeEntities(m[1].trim()).replace(/\s+/g, "-")}`)
          .filter(Boolean);
        const createdAt = Number.isFinite(Date.parse(createdRaw)) ? new Date(createdRaw).toISOString() : new Date().toISOString();
        if (!title && !body) { skipped += 1; continue; }
        notes.push({
          title: (title || "Untitled note").slice(0, 120),
          body: (tags.length ? `${tags.join(" ")}\n\n` : "") + body,
          createdAt,
          metadata: { importedFrom: "evernote" }
        });
      } catch {
        skipped += 1;
      }
    }
    return { notes, skipped };
  }

  function parseOneNoteHtml(htmlText, fileName = "onenote") {
    const source = String(htmlText ?? "");
    const titleFromTag = source.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const firstHeading = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    const title = decodeEntities(titleFromTag || stripTagsToText(firstHeading ?? "") || fileName.replace(/\.html?$/i, ""));
    const body = htmlToMarkdown(source);
    if (!title && !body) return { notes: [], skipped: 1, error: "This OneNote HTML export has no readable content." };
    return {
      notes: [{ title: title.slice(0, 120) || "Untitled note", body, createdAt: new Date().toISOString(), metadata: { importedFrom: "onenote" } }],
      skipped: 0
    };
  }

  // Notion HTML export: one file per page; nested pages arrive as separate
  // files whose path mirrors the page tree ("Parent/Child.html"). A file's
  // parent is its directory path; the body keeps Notion's own links.
  function parseNotionHtml(htmlText, fileName = "notion") {
    const source = String(htmlText ?? "");
    const titleFromTag = source.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const firstHeading = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    const title = decodeEntities(titleFromTag || stripTagsToText(firstHeading ?? "") || fileName.replace(/\.html?$/i, ""));
    let body = htmlToMarkdown(source);
    // Notion exports repeat the page title as the first heading; drop the
    // duplicate so the imported note is not "Title\n# Title".
    body = body.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n+`), "");
    if (!title && !body) return { notes: [], skipped: 1, error: "This Notion page has no readable content." };
    return {
      notes: [{ title: title.slice(0, 120) || "Untitled note", body, createdAt: new Date().toISOString(), metadata: { importedFrom: "notion" } }],
      skipped: 0
    };
  }

  // files: [{path, content}] — a Notion export (zip contents or picked
  // files). Nested pages become sub-pages via parentNoteId; the caller
  // creates records in order and fills in parent ids from the returned
  // `parentPath` on each note.
  function parseNotionFiles(files) {
    const notes = [];
    let skipped = 0;
    const errors = [];
    for (const file of files ?? []) {
      if (!file || typeof file.content !== "string") { skipped += 1; continue; }
      const path = String(file.path ?? file.name ?? "notion.html");
      if (!/\.html?$/i.test(path)) { skipped += 1; continue; }
      const parsed = parseNotionHtml(file.content, path.split("/").pop());
      if (!parsed.notes.length) {
        skipped += 1;
        if (parsed.error) errors.push(`${path}: ${parsed.error}`);
        continue;
      }
      const note = parsed.notes[0];
      const parts = path.split("/").filter(Boolean);
      note.parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
      note.path = path;
      notes.push(note);
    }
    return { notes, skipped, errors: errors.slice(0, 5) };
  }

  /* ---------------- Item 6 — read-it-later + highlights ---------------- */

  function createReadLaterItem({ url = "", title = "", text = "" }) {
    const cleanUrl = String(url ?? "").trim().slice(0, 2000);
    if (!cleanUrl && !String(text ?? "").trim()) {
      throw new TypeError("Read Later needs a URL or some pasted text.");
    }
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      throw new TypeError("Read Later URLs must start with http:// or https://.");
    }
    return {
      id: makeId("readlater"),
      url: cleanUrl,
      title: String(title ?? "").trim().slice(0, 300) || (cleanUrl ? cleanUrl.replace(/^https?:\/\//, "").split("/")[0] : "Pasted text"),
      text: String(text ?? "").slice(0, 100_000),
      fetchedText: "",
      fetchedAt: null,
      fetchStatus: "saved",
      savedAt: new Date().toISOString(),
      read: false
    };
  }

  // In-app fetch of the article text. CORS decides: most news sites block
  // cross-origin reads, so a failure keeps the URL + pasted text and says
  // so honestly — no proxy server is built for this.
  async function tryFetchArticle(item) {
    if (!item?.url || typeof fetch !== "function") {
      return { ...item, fetchStatus: "fetch-failed" };
    }
    try {
      const response = await fetch(item.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const article = htmlToMarkdown(html).slice(0, 100_000);
      if (!article.trim()) throw new Error("No readable text in the fetched page.");
      return { ...item, fetchedText: article, fetchedAt: new Date().toISOString(), fetchStatus: "fetched" };
    } catch {
      return { ...item, fetchStatus: "fetch-failed" };
    }
  }

  function createHighlight({ quote, sourceId = null, sourceTitle = "", sourceUrl = "" }) {
    const clean = String(quote ?? "").trim();
    if (!clean) throw new TypeError("A highlight needs selected text.");
    return {
      id: makeId("highlight"),
      quote: clean.slice(0, 5000),
      sourceId,
      sourceTitle: String(sourceTitle ?? "").slice(0, 300),
      sourceUrl: String(sourceUrl ?? "").slice(0, 2000),
      createdAt: new Date().toISOString(),
      dismissedAt: null,
      shownCount: 0
    };
  }

  // Daily digest: a few older highlights, spaced — prefer ones not shown
  // recently and older than a day, deterministic per date so the digest
  // does not reshuffle on every render. Dismissed highlights never return.
  function dailyDigest(highlights, dateKey = new Date().toISOString().slice(0, 10), count = 3) {
    // Only highlights from BEFORE the digest day (older highlights, spaced).
    const dayStart = Date.parse(`${dateKey}T00:00:00Z`);
    const pool = sanitizeHighlights(highlights)
      .filter((h) => !h.dismissedAt && Date.parse(h.createdAt) < dayStart);
    if (!pool.length) return [];
    // Deterministic rotation: seed from the date, walk the pool by age.
    let seed = 0;
    for (const ch of dateKey) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const ordered = [...pool].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const picked = [];
    for (let i = 0; i < Math.min(count, ordered.length); i += 1) {
      picked.push(ordered[(seed + i * 2) % ordered.length]);
    }
    return [...new Set(picked)];
  }

  /* ---------------- Item 4 — voice memo → structured note ---------------- */

  function buildVoiceMemoNote({ title = "", transcript = "", audioAttachmentId = null, audioName = "voice-memo", transcriptionStatus = "unavailable" }) {
    const stamp = new Date().toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
    const cleanTitle = String(title ?? "").trim().slice(0, 120)
      || (transcript ? transcript.split("\n")[0].trim().slice(0, 120) : "")
      || `Voice memo — ${stamp}`;
    const lines = [`# ${cleanTitle}`, "", `Recorded ${stamp}.`];
    if (audioAttachmentId) lines.push("", `🎙️ [Listen to the recording](attachment:${audioAttachmentId})`);
    if (transcript && transcript.trim()) {
      lines.push("", "## Transcript", "", transcript.trim());
    } else if (transcriptionStatus === "unavailable") {
      lines.push("", "_Transcription unavailable here — the audio above is saved; transcribe it where speech recognition is available._");
    } else if (transcriptionStatus === "failed") {
      lines.push("", "_Transcription was attempted but failed — the audio above is saved._");
    }
    return {
      title: cleanTitle,
      body: lines.join("\n"),
      metadata: {
        voiceMemo: true,
        transcription: transcriptionStatus, // "speech-api" | "whisper-byok" | "unavailable" | "failed"
        audioAttachmentId: audioAttachmentId ?? null,
        audioName
      }
    };
  }

  // BYOK cloud transcription (Whisper-compatible /audio/transcriptions).
  // The key comes from the credential store via the caller; never stored.
  async function transcribeWithWhisper({ baseUrl, apiKey, audioBlob, model = "whisper-1" }) {
    if (typeof fetch !== "function") throw new Error("Transcription needs fetch, which is unavailable here.");
    if (!apiKey) throw new Error("Cloud transcription needs an API key — add one in Capture & smarts settings.");
    if (typeof FormData === "undefined") throw new Error("Transcription needs FormData, which is unavailable here.");
    const url = String(baseUrl ?? "").replace(/\/+$/, "") || "https://api.openai.com/v1";
    const form = new FormData();
    form.append("file", audioBlob, "voice-memo.webm");
    form.append("model", model);
    const response = await fetch(`${url}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    if (!response.ok) throw new Error(`Transcription request failed (${response.status}). Check the key and base URL.`);
    const data = await response.json();
    if (typeof data?.text !== "string") throw new Error("Transcription endpoint returned an unexpected response.");
    return data.text;
  }

  function speechRecognitionAvailable() {
    return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /* ---------------- Item 7 — FSRS-4.5 flashcards ---------------- */

  // Published FSRS-4.5 default weights (open-spaced-repetition / fsrs4anki).
  const FSRS_WEIGHTS = Object.freeze([
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
    2.9898, 0.51655, 0.6621
  ]);
  const FSRS_FACTOR = 19 / 81;
  const FSRS_DECAY = -0.5;
  const FSRS_REQUEST_RETENTION = 0.9;
  const GRADES = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
  const GRADE_NAMES = Object.freeze({ 1: "again", 2: "hard", 3: "good", 4: "easy" });

  function fsrsRetrievability(elapsedDays, stability) {
    const s = Math.max(0.01, stability);
    const t = Math.max(0, elapsedDays);
    return Math.pow(1 + FSRS_FACTOR * (t / s), FSRS_DECAY);
  }

  function fsrsIntervalDays(stability, retention = FSRS_REQUEST_RETENTION) {
    const s = Math.max(0.01, stability);
    return (s / FSRS_FACTOR) * (Math.pow(retention, 1 / FSRS_DECAY) - 1);
  }

  function fsrsInitialStability(grade) {
    return FSRS_WEIGHTS[clamp(grade, 1, 4) - 1];
  }

  function fsrsInitialDifficulty(grade) {
    return clamp(FSRS_WEIGHTS[4] - (grade - 3) * FSRS_WEIGHTS[5], 1, 10);
  }

  // One review step. `card` carries {stability, difficulty, dueAt,
  // lastReviewedAt, reviews, lapses} (null stability/difficulty = new card).
  // Returns the updated card fields + the next interval in days.
  function fsrsReview(card, grade, nowMs = Date.now()) {
    const g = clamp(Math.round(grade) || 3, 1, 4);
    const w = FSRS_WEIGHTS;
    const isNew = !(Number.isFinite(card?.stability) && Number.isFinite(card?.difficulty));
    let stability;
    let difficulty;
    let intervalDays;
    if (isNew) {
      stability = fsrsInitialStability(g);
      difficulty = fsrsInitialDifficulty(g);
      intervalDays = g === 1 ? 0 : fsrsIntervalDays(stability);
    } else {
      const elapsedDays = Math.max(0, (nowMs - Date.parse(card.lastReviewedAt ?? card.dueAt ?? nowMs)) / 86_400_000);
      const retrievability = fsrsRetrievability(elapsedDays, card.stability);
      difficulty = clamp(
        w[7] * fsrsInitialDifficulty(3) + (1 - w[7]) * (card.difficulty - w[6] * (g - 3)),
        1, 10
      );
      if (g === 1) {
        const lapseStability = w[11] * Math.pow(difficulty, -w[12])
          * (Math.pow(card.stability + 1, w[13]) - 1)
          * Math.exp(w[14] * (1 - retrievability));
        stability = Math.min(lapseStability, card.stability);
      } else {
        const hardFactor = g === 2 ? w[15] : 1;
        const easyFactor = g === 4 ? w[16] : 1;
        const factor = 1 + Math.exp(w[8]) * (11 - difficulty)
          * Math.pow(card.stability, -w[9])
          * (Math.exp(w[10] * (1 - retrievability)) - 1)
          * hardFactor * easyFactor;
        stability = card.stability * Math.max(1, factor);
      }
      intervalDays = g === 1 ? 0 : fsrsIntervalDays(stability);
    }
    // "Again" is a learning step, not a day-scale interval: due in 10 min.
    const dueMs = g === 1
      ? nowMs + 10 * 60_000
      : nowMs + Math.max(1, Math.round(intervalDays * 100) / 100) * 86_400_000;
    return {
      stability: Math.round(stability * 10000) / 10000,
      difficulty: Math.round(difficulty * 10000) / 10000,
      dueAt: new Date(Math.min(dueMs, nowMs + 3650 * 86_400_000)).toISOString(),
      lastReviewedAt: new Date(nowMs).toISOString(),
      reviews: (card?.reviews ?? 0) + 1,
      lapses: (card?.lapses ?? 0) + (g === 1 ? 1 : 0),
      intervalDays: g === 1 ? 0 : Math.max(1, Math.round(intervalDays * 100) / 100),
      retrievabilityAtReview: isNew ? 1 : fsrsRetrievability(
        Math.max(0, (nowMs - Date.parse(card.lastReviewedAt ?? card.dueAt ?? nowMs)) / 86_400_000),
        card.stability
      )
    };
  }

  function dueCards(cards, nowMs = Date.now()) {
    return sanitizeFlashcards(cards)
      .filter((card) => !card.dueAt || Date.parse(card.dueAt) <= nowMs)
      .sort((a, b) => Date.parse(a.dueAt ?? 0) - Date.parse(b.dueAt ?? 0));
  }

  function flashcardCounts(cards, nowMs = Date.now()) {
    const all = sanitizeFlashcards(cards);
    return {
      total: all.length,
      due: all.filter((c) => !c.dueAt || Date.parse(c.dueAt) <= nowMs).length,
      new: all.filter((c) => !Number.isFinite(c.stability)).length,
      reviewed: all.filter((c) => Number.isFinite(c.stability)).length
    };
  }

  // Cards from notes: cloze {{c1::answer}} (context kept as the front) and
  // Q/A blocks ("Q: ...\nA: ..."). One card per cloze number; the source
  // note id stays on the card so review always links back to context.
  function extractCardsFromNote(note) {
    const cards = [];
    const body = String(note?.body ?? "");
    const clozePattern = /\{\{c(\d+)::((?:[^{}]|\{[^{}]*\})*?)\}\}/g;
    const byCloze = new Map();
    for (const match of body.matchAll(clozePattern)) {
      const index = Math.max(1, parseInt(match[1], 10));
      const answer = match[2].trim();
      if (!answer) continue;
      const front = body.replace(clozePattern, (_m, n, a) => (Number(n) === index ? "[...]" : a)).trim();
      const key = `${index}:${answer}`;
      if (byCloze.has(key)) continue;
      byCloze.set(key, true);
      cards.push({
        id: makeId("card"),
        front: front.slice(0, 8000),
        back: answer.slice(0, 8000),
        sourceNoteId: note?.id ?? null,
        kind: "cloze",
        clozeIndex: index,
        stability: null,
        difficulty: null,
        dueAt: null,
        lastReviewedAt: null,
        reviews: 0,
        lapses: 0
      });
    }
    const qaPattern = /^Q:\s*(.+)$\nA:\s*(.+)$/gim;
    for (const match of body.matchAll(qaPattern)) {
      const front = match[1].trim();
      const back = match[2].trim();
      if (!front || !back) continue;
      cards.push({
        id: makeId("card"),
        front: front.slice(0, 8000),
        back: back.slice(0, 8000),
        sourceNoteId: note?.id ?? null,
        kind: "qa",
        clozeIndex: 1,
        stability: null,
        difficulty: null,
        dueAt: null,
        lastReviewedAt: null,
        reviews: 0,
        lapses: 0
      });
    }
    return cards;
  }

  function extractCardsFromNotes(notes) {
    const cards = [];
    for (const note of notes ?? []) cards.push(...extractCardsFromNote(note));
    return cards.slice(0, MAX_FLASHCARDS);
  }

  /* ---------------- Item 7 — APKG export/import ----------------
   * Hand-rolled minimal SQLite writer + ZIP writer (stored entries) +
   * minimal SQLite reader. Page size is 64 KiB and each table fits one
   * leaf page (fields truncated, card count capped at 500) so no overflow
   * pages are ever needed on write. The reader walks leaf + interior
   * table b-tree pages and reports overflow pages as unsupported rather
   * than misreading them. Verified against python3 sqlite3 (see smoke
   * checks + the verification notes in the Phase 2 report). */

  function sqliteVarint(value) {
    let v = Math.floor(value);
    if (v < 0) throw new RangeError("SQLite varint cannot be negative here.");
    const bytes = [];
    do {
      bytes.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < bytes.length - 1; i += 1) bytes[i] |= 0x80;
    return bytes;
  }

  function readSqliteVarint(bytes, offset) {
    let result = 0;
    let i = offset;
    for (let n = 0; n < 9; n += 1) {
      const byte = bytes[i];
      if (n === 8) {
        result = result * 256 + byte;
        i += 1;
      } else {
        result = result * 128 + (byte & 0x7f);
        i += 1;
        if (!(byte & 0x80)) break;
      }
    }
    return { value: result, next: i };
  }

  function sqliteSerialType(value) {
    if (value === null || value === undefined) return { type: 0, size: 0 };
    if (typeof value === "number" && Number.isInteger(value)) {
      if (value === 0) return { type: 8, size: 0 };
      if (value === 1) return { type: 9, size: 0 };
      if (value >= -128 && value <= 127) return { type: 1, size: 1 };
      if (value >= -32768 && value <= 32767) return { type: 2, size: 2 };
      if (value >= -8388608 && value <= 8388607) return { type: 3, size: 3 };
      if (value >= -2147483648 && value <= 2147483647) return { type: 4, size: 4 };
      if (value >= -140737488355328 && value <= 140737488355327) return { type: 5, size: 6 };
      return { type: 6, size: 8 };
    }
    if (typeof value === "number") return { type: 7, size: 8 };
    const bytes = utf8Bytes(value);
    return { type: 13 + 2 * bytes.length, size: bytes.length, bytes };
  }

  function encodeSqliteRecord(values) {
    const header = [];
    const body = [];
    const types = values.map(sqliteSerialType);
    for (const t of types) header.push(...sqliteVarint(t.type));
    const headerSize = sqliteVarint(header.length + 1).length + header.length;
    // Header-size varint length can shift the total; recompute once.
    const headerVarintLen = sqliteVarint(headerSize).length;
    const totalHeader = headerVarintLen + header.length;
    const out = [...sqliteVarint(totalHeader), ...header];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      const t = types[i];
      if (t.type === 0 || t.type === 8 || t.type === 9) continue;
      if (t.type >= 1 && t.type <= 6) {
        let v = value;
        const buf = new DataView(new ArrayBuffer(8));
        buf.setBigInt64(0, BigInt(v));
        const bytes = new Uint8Array(buf.buffer);
        body.push(...bytes.slice(8 - t.size));
      } else if (t.type === 7) {
        const buf = new DataView(new ArrayBuffer(8));
        buf.setFloat64(0, value);
        body.push(...new Uint8Array(buf.buffer));
      } else if (t.type >= 13) {
        body.push(...t.bytes);
      } else if (t.type >= 12) {
        body.push(...t.bytes);
      }
    }
    return new Uint8Array([...out, ...body]);
  }

  function buildTableLeafPage(records, isPageOne) {
    const PAGE_SIZE = 65536;
    const usable = PAGE_SIZE - (isPageOne ? 100 : 0);
    const page = new Uint8Array(PAGE_SIZE);
    const base = isPageOne ? 100 : 0;
    const headerAt = base;
    const cells = [];
    let cellArea = usable;
    for (const { rowid, payload } of records) {
      const cell = [...sqliteVarint(payload.length), ...sqliteVarint(rowid), ...payload];
      if (cell.length > usable - 16) throw new Error("APKG record is too large for one SQLite page.");
      cellArea -= cell.length;
      cells.push({ cell, offset: (isPageOne ? 100 : 0) + cellArea });
    }
    page[headerAt] = 0x0d;
    const view = new DataView(page.buffer);
    view.setUint16(headerAt + 3, cells.length);
    view.setUint16(headerAt + 5, cellArea + (isPageOne ? 100 : 0));
    for (let i = 0; i < cells.length; i += 1) {
      view.setUint16(headerAt + 8 + i * 2, cells[i].offset);
      page.set(cells[i].cell, cells[i].offset);
    }
    return page;
  }

  // Index leaf page (0x0A) with real entries: each record is the indexed
  // columns plus the rowid, sorted by key. Real entries (not empty pages)
  // are what make `PRAGMA integrity_check` pass and what Anki expects.
  function buildIndexLeafPage(records, isPageOne) {
    const PAGE_SIZE = 65536;
    const usable = PAGE_SIZE - (isPageOne ? 100 : 0);
    const page = new Uint8Array(PAGE_SIZE);
    const base = isPageOne ? 100 : 0;
    const cells = [];
    let cellArea = usable;
    for (const payload of records) {
      const cell = [...sqliteVarint(payload.length), ...payload];
      if (cell.length > usable - 16) throw new Error("APKG index record is too large for one SQLite page.");
      cellArea -= cell.length;
      cells.push({ cell, offset: base + cellArea });
    }
    page[base] = 0x0a;
    const view = new DataView(page.buffer);
    view.setUint16(base + 3, cells.length);
    // Cell content area: 0 means 65536 (full page) when nothing is stored.
    view.setUint16(base + 5, cells.length ? base + cellArea : 0);
    for (let i = 0; i < cells.length; i += 1) {
      view.setUint16(base + 8 + i * 2, cells[i].offset);
      page.set(cells[i].cell, cells[i].offset);
    }
    return page;
  }

  // Compact synchronous SHA-1 (needed for Anki note checksums).
  function sha1Hex(text) {
    const bytes = utf8Bytes(text);
    const bitLen = bytes.length * 8;
    const padded = [];
    for (const b of bytes) padded.push(b);
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(bitLen));
    padded.push(...new Uint8Array(view.buffer));
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
    for (let block = 0; block < padded.length; block += 64) {
      const w = new Uint32Array(80);
      const dv = new DataView(new Uint8Array(padded.slice(block, block + 64)).buffer);
      for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(i * 4);
      for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      for (let i = 0; i < 80; i += 1) {
        let f;
        let k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = temp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
  }

  function ankiGuid() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    const random = globalThis.crypto?.getRandomValues?.(new Uint8Array(10)) ?? null;
    for (let i = 0; i < 10; i += 1) {
      out += chars[(random ? random[i] : Math.floor(Math.random() * chars.length)) % chars.length];
    }
    return out;
  }

  function stripHtmlForSearch(text) {
    return String(text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  function buildAnkiDb(cards, deckName = "xPin") {
    const cleanCards = sanitizeFlashcards(cards).slice(0, MAX_APKG_CARDS);
    const truncated = sanitizeFlashcards(cards).length > MAX_APKG_CARDS;
    const nowMs = Date.now();
    const modelId = nowMs;
    const deckId = nowMs + 1;
    const cleanDeck = String(deckName ?? "xPin").trim().slice(0, 120) || "xPin";
    const model = {
      id: modelId, name: "xPin Basic", type: 0, mod: Math.floor(nowMs / 1000),
      flds: [{ name: "Front", ord: 0 }, { name: "Back", ord: 1 }],
      tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" }],
      css: ".card { font-family: sans-serif; font-size: 20px; text-align: center; }",
      req: [[0, "any", [0]]]
    };
    const modelsJson = JSON.stringify({ [String(modelId)]: model });
    const decksJson = JSON.stringify({
      1: { id: 1, name: "Default", desc: "", mod: Math.floor(nowMs / 1000), collapsed: false, conf: 1 },
      [String(deckId)]: { id: deckId, name: cleanDeck, desc: "Exported from xPin", mod: Math.floor(nowMs / 1000), collapsed: false, conf: 1 }
    });
    const dconfJson = JSON.stringify({
      1: {
        name: "Default", maxTaken: 60, autoplay: false, timer: 0, replayq: true,
        new: { perDay: 20, delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, bury: false, separate: true },
        lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 },
        rev: { perDay: 200, fuzz: 1, ivlFct: 1, maxIvl: 36500, ease4: 1.3, hardFactor: 1.2, bury: false, minSpace: 1 }
      }
    });
    const colRow = [
      1, nowMs, nowMs, nowMs, 11, dconfJson, modelsJson, decksJson, dconfJson, decksJson, "{}"
    ];
    const noteRows = [];
    const cardRows = [];
    const noteKeys = []; // [usn, rowid] and [mid, rowid] per note
    const cardKeys = []; // [usn/nid/did+queue+due, rowid] per card
    let idCounter = nowMs - cleanCards.length * 2 - 10;
    for (let i = 0; i < cleanCards.length; i += 1) {
      const card = cleanCards[i];
      const noteId = idCounter;
      idCounter += 1;
      const cardId = idCounter;
      idCounter += 1;
      const front = String(card.front ?? "").slice(0, APKG_FIELD_CHARS);
      const back = String(card.back ?? "").slice(0, APKG_FIELD_CHARS);
      const sfld = stripHtmlForSearch(front);
      const csum = parseInt(sha1Hex(sfld).slice(0, 8), 16);
      noteRows.push({
        rowid: noteId,
        payload: encodeSqliteRecord([
          noteId, ankiGuid(), modelId, Math.floor(nowMs / 1000), -1, "",
          `${front}\x1f${back}`, sfld, csum, 0, ""
        ])
      });
      cardRows.push({
        rowid: cardId,
        payload: encodeSqliteRecord([
          cardId, noteId, deckId, 0, Math.floor(nowMs / 1000), -1, 0, 0,
          i + 1, 0, 0, 0, 0, 0, 0, 0, 0, ""
        ])
      });
      noteKeys.push({ usn: -1, mid: modelId, rowid: noteId });
      cardKeys.push({ usn: -1, nid: noteId, did: deckId, queue: 0, due: i + 1, rowid: cardId });
    }

    const SCHEMA = [
      { type: "table", name: "col", rootpage: 2, sql: "CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dconf text not null, models text not null, decks text not null, dconf_json text not null, decks_json text not null, tags text not null)" },
      { type: "table", name: "notes", rootpage: 3, sql: "CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld text not null, csum integer not null, flags integer not null, data text not null)" },
      { type: "table", name: "cards", rootpage: 4, sql: "CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)" },
      { type: "table", name: "revlog", rootpage: 5, sql: "CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)" },
      { type: "table", name: "graves", rootpage: 6, sql: "CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)" },
      { type: "index", name: "ix_notes_usn", rootpage: 7, sql: "CREATE INDEX ix_notes_usn on notes (usn)" },
      { type: "index", name: "ix_cards_usn", rootpage: 8, sql: "CREATE INDEX ix_cards_usn on cards (usn)" },
      { type: "index", name: "ix_cards_note", rootpage: 9, sql: "CREATE INDEX ix_cards_note on cards (nid)" },
      { type: "index", name: "ix_cards_sched", rootpage: 10, sql: "CREATE INDEX ix_cards_sched on cards (did, queue, due)" },
      { type: "index", name: "ix_revlog_usn", rootpage: 11, sql: "CREATE INDEX ix_revlog_usn on revlog (usn)" },
      { type: "index", name: "ix_graves_usn", rootpage: 12, sql: "CREATE INDEX ix_graves_usn on graves (usn)" },
      { type: "index", name: "ix_notes_mid", rootpage: 13, sql: "CREATE INDEX ix_notes_mid on notes (mid)" }
    ];
    const masterFixed = SCHEMA.map((entry, index) => {
      const tblName = entry.type === "index"
        ? (entry.name.startsWith("ix_notes") ? "notes" : entry.name.startsWith("ix_cards") ? "cards" : entry.name.startsWith("ix_revlog") ? "revlog" : "graves")
        : entry.name;
      return {
        rowid: index + 1,
        payload: encodeSqliteRecord([entry.type, entry.name, tblName, entry.rootpage, entry.sql])
      };
    });

    const PAGE_SIZE = 65536;
    const totalPages = 13;
    const file = new Uint8Array(PAGE_SIZE * totalPages);
    // Pages first: page 1's b-tree content starts at offset 100, and the
    // 100-byte file header is written LAST so it is not overwritten.
    file.set(buildTableLeafPage(masterFixed, true), 0);
    file.set(buildTableLeafPage([{ rowid: 1, payload: encodeSqliteRecord(colRow) }], false), PAGE_SIZE);
    file.set(buildTableLeafPage(noteRows, false), PAGE_SIZE * 2);
    file.set(buildTableLeafPage(cardRows, false), PAGE_SIZE * 3);
    file.set(buildTableLeafPage([], false), PAGE_SIZE * 4);
    file.set(buildTableLeafPage([], false), PAGE_SIZE * 5);
    // Real index entries (Anki + integrity_check). Key order is already
    // sorted: rowids increase monotonically with every key in these
    // indexes (usn/mid are constant, nid and due increase with rowid).
    const indexPages = [
      noteKeys.map((k) => encodeSqliteRecord([k.usn, k.rowid])), // ix_notes_usn
      cardKeys.map((k) => encodeSqliteRecord([k.usn, k.rowid])), // ix_cards_usn
      cardKeys.map((k) => encodeSqliteRecord([k.nid, k.rowid])), // ix_cards_note
      cardKeys.map((k) => encodeSqliteRecord([k.did, k.queue, k.due, k.rowid])), // ix_cards_sched
      [], // ix_revlog_usn — empty table
      [], // ix_graves_usn — empty table
      noteKeys.map((k) => encodeSqliteRecord([k.mid, k.rowid])) // ix_notes_mid
    ];
    for (let p = 0; p < indexPages.length; p += 1) {
      file.set(buildIndexLeafPage(indexPages[p], false), PAGE_SIZE * (6 + p));
    }
    const header = new DataView(file.buffer, 0, 100);
    const magic = utf8Bytes("SQLite format 3\0");
    file.set(magic, 0);
    header.setUint16(16, 1); // page size 65536 is stored as 1
    header.setUint8(18, 1); // file format write version
    header.setUint8(19, 1); // file format read version
    header.setUint8(21, 64); // max embedded payload fraction
    header.setUint8(22, 32); // min embedded payload fraction
    header.setUint8(23, 32); // leaf payload fraction
    header.setUint32(24, 1); // file change counter
    header.setUint32(28, totalPages); // database size in pages
    header.setUint32(40, 1); // schema cookie
    header.setUint32(44, 4); // schema format
    header.setUint32(56, 1); // text encoding UTF-8
    header.setUint32(92, 1); // version-valid-for
    header.setUint32(96, 3046001); // SQLite version number

    return { bytes: file, cardCount: cleanCards.length, truncated, deckName: cleanDeck };
  }

  /* ----- minimal ZIP writer (stored) + reader ----- */

  function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const dosDate = 0x21; // DOS date 1980-01-01: (0 << 9) | (1 << 5) | 1
    const dosTime = 0;
    for (const { name, data } of files) {
      const nameBytes = utf8Bytes(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filenames
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, 0, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      chunks.push(local);
      const entry = new Uint8Array(46 + nameBytes.length);
      const ev = new DataView(entry.buffer);
      ev.setUint32(0, 0x02014b50, true);
      ev.setUint16(4, 20, true);
      ev.setUint16(6, 20, true);
      ev.setUint16(8, 0x0800, true);
      ev.setUint16(10, 0, true);
      ev.setUint16(12, 0, true);
      ev.setUint16(14, dosDate, true);
      ev.setUint32(16, crc, true);
      ev.setUint32(20, data.length, true);
      ev.setUint32(24, data.length, true);
      ev.setUint16(28, nameBytes.length, true);
      ev.setUint32(42, offset, true);
      entry.set(nameBytes, 46);
      central.push(entry);
      offset += local.length;
    }
    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
    const end = new Uint8Array(22);
    const env = new DataView(end.buffer);
    env.setUint32(0, 0x06054b50, true);
    env.setUint16(8, files.length, true);
    env.setUint16(10, files.length, true);
    env.setUint32(12, centralSize, true);
    env.setUint32(16, offset, true);
    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    for (const entry of central) { out.set(entry, at); at += entry.length; }
    out.set(end, at);
    return out;
  }

  async function unzipEntries(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Find the end-of-central-directory record (search the last 64 KiB).
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new TypeError("This file is not a valid .apkg (zip) file.");
    const count = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    const entries = [];
    let at = centralOffset;
    for (let n = 0; n < count; n += 1) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new TypeError("This .apkg file has a damaged central directory.");
      const flags = view.getUint16(at + 8, true);
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const nameLen = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const commentLen = view.getUint16(at + 32, true);
      const localOffset = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(data.slice(at + 46, at + 46 + nameLen));
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const payloadStart = localOffset + 30 + localNameLen + localExtraLen;
      const payload = data.slice(payloadStart, payloadStart + compressedSize);
      let content;
      if (method === 0) {
        content = payload;
      } else if (method === 8) {
        if (typeof DecompressionStream === "undefined") {
          throw new Error(`Zip entry "${name}" is deflated and this environment cannot inflate it.`);
        }
        const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        content = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error(`Zip entry "${name}" uses compression method ${method}, which xPin cannot read.`);
      }
      entries.push({ name, data: content, flags });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* ----- minimal SQLite reader (table b-trees; no overflow support) ----- */

  function decodeSqliteRecord(payload, offset) {
    const headerInfo = readSqliteVarint(payload, offset);
    const headerEnd = offset + headerInfo.value;
    const serialTypes = [];
    let at = headerInfo.next;
    while (at < headerEnd) {
      const parsed = readSqliteVarint(payload, at);
      serialTypes.push(parsed.value);
      at = parsed.next;
    }
    const values = [];
    let bodyAt = headerEnd;
    for (const type of serialTypes) {
      if (type === 0) { values.push(null); continue; }
      if (type === 8) { values.push(0); continue; }
      if (type === 9) { values.push(1); continue; }
      if (type >= 1 && type <= 6) {
        const size = [1, 2, 3, 4, 6, 8][type - 1];
        let num = 0n;
        for (let i = 0; i < size; i += 1) num = (num << 8n) | BigInt(payload[bodyAt + i]);
        if (size < 8 && num >= (1n << BigInt(size * 8 - 1))) num -= 1n << BigInt(size * 8);
        values.push(Number(num));
        bodyAt += size;
        continue;
      }
      if (type === 7) {
        const dv = new DataView(payload.buffer, payload.byteOffset + bodyAt, 8);
        values.push(dv.getFloat64(0));
        bodyAt += 8;
        continue;
      }
      if (type >= 12) {
        const size = Math.floor((type - 12) / 2);
        const slice = payload.slice(bodyAt, bodyAt + size);
        values.push(type % 2 === 0 ? slice : new TextDecoder().decode(slice));
        bodyAt += size;
        continue;
      }
      throw new Error(`Unsupported SQLite serial type ${type}.`);
    }
    return values;
  }

  function readTableBTree(bytes, pageSize, pageNo, out, depth = 0) {
    if (depth > 10) throw new Error("SQLite b-tree is too deep for xPin's minimal reader.");
    const start = (pageNo - 1) * pageSize;
    const headerAt = pageNo === 1 ? start + 100 : start;
    const type = bytes[headerAt];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cellCount = view.getUint16(headerAt + 3);
    const usable = pageSize - (pageNo === 1 ? 100 : 0);
    if (type === 0x0d) {
      for (let i = 0; i < cellCount; i += 1) {
        const cellPtr = view.getUint16(headerAt + 8 + i * 2);
        // Cell pointers are relative to the start of the page.
        const cellAt = (pageNo - 1) * pageSize + cellPtr;
        const lenInfo = readSqliteVarint(bytes, cellAt);
        const payloadLen = lenInfo.value;
        const rowidInfo = readSqliteVarint(bytes, lenInfo.next);
        const payloadStart = rowidInfo.next;
        const localMax = usable - 35;
        if (payloadLen > localMax) {
          throw new Error("SQLite overflow pages are not supported by xPin's minimal APKG reader.");
        }
        const payload = bytes.slice(payloadStart, payloadStart + payloadLen);
        out.push({ rowid: rowidInfo.value, values: decodeSqliteRecord(payload, 0) });
      }
      return;
    }
    if (type === 0x05) {
      const rightmost = view.getUint32(headerAt + 8);
      for (let i = 0; i < cellCount; i += 1) {
        const cellPtr = view.getUint16(headerAt + 12 + i * 2);
        const cellAt = (pageNo - 1) * pageSize + cellPtr;
        const child = view.getUint32(cellAt);
        readTableBTree(bytes, pageSize, child, out, depth + 1);
      }
      readTableBTree(bytes, pageSize, rightmost, out, depth + 1);
      return;
    }
    throw new Error(`Unexpected SQLite b-tree page type 0x${type.toString(16)}.`);
  }

  function readSqliteTables(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (new TextDecoder().decode(data.slice(0, 16)) !== "SQLite format 3\0") {
      throw new TypeError("This file is not a SQLite database.");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pageSizeRaw = view.getUint16(16);
    const pageSize = pageSizeRaw === 1 ? 65536 : pageSizeRaw;
    const pageCount = view.getUint32(28);
    if (!pageSize || pageSize < 512 || data.length < pageSize) {
      throw new TypeError("This SQLite file is truncated or has an unsupported page size.");
    }
    void pageCount;
    const masterRows = [];
    readTableBTree(data, pageSize, 1, masterRows);
    const tables = {};
    for (const row of masterRows) {
      const [type, name, tblName, rootpage] = row.values;
      if (type === "table" && Number.isFinite(rootpage) && rootpage >= 1) {
        const rows = [];
        readTableBTree(data, pageSize, rootpage, rows);
        tables[name] = { tblName, rootpage, rows };
      }
    }
    return tables;
  }

  // APKG export: zip of collection.anki2 + media manifest (no media files —
  // xPin cards are text-only).
  function buildApkg(cards, deckName = "xPin") {
    const db = buildAnkiDb(cards, deckName);
    const zip = zipStore([
      { name: "collection.anki2", data: db.bytes },
      { name: "media", data: utf8Bytes("{}") }
    ]);
    return { bytes: zip, cardCount: db.cardCount, truncated: db.truncated, deckName: db.deckName };
  }

  // APKG import (minimal reader). Returns xPin flashcard records rebuilt
  // from the Anki notes table. Throws a plain-language error when the file
  // is outside what the reader supports.
  async function importApkg(bytes) {
    const entries = await unzipEntries(bytes);
    const dbEntry = entries.find((e) => e.name === "collection.anki2" || e.name.endsWith(".anki2"));
    if (!dbEntry) throw new TypeError("This .apkg file has no Anki collection inside it.");
    const tables = readSqliteTables(dbEntry.data);
    const notesTable = tables.notes;
    const cardsTable = tables.cards;
    if (!notesTable || !cardsTable) {
      throw new TypeError("This Anki collection is missing the notes or cards table.");
    }
    const noteById = new Map();
    for (const row of notesTable.rows) {
      const values = row.values;
      const flds = String(values[6] ?? "");
      const [front = "", back = ""] = flds.split("\x1f");
      noteById.set(values[0], { front: stripHtmlForSearch(front), back: stripHtmlForSearch(back) });
    }
    const cards = [];
    let skipped = 0;
    for (const row of cardsTable.rows) {
      const nid = row.values[1];
      const note = noteById.get(nid);
      if (!note || !note.front) { skipped += 1; continue; }
      cards.push({
        id: makeId("card"),
        front: String(note.front).slice(0, 8000),
        back: String(note.back ?? "").slice(0, 8000),
        sourceNoteId: null,
        kind: "qa",
        clozeIndex: 1,
        stability: null,
        difficulty: null,
        dueAt: null,
        lastReviewedAt: null,
        reviews: 0,
        lapses: 0
      });
    }
    return { cards, skipped, noteCount: noteById.size };
  }

  // CSV / JSON card interchange (the honest fallback if APKG import is cut).
  function exportCardsCsv(cards) {
    const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = ["front,back,sourceNoteId"];
    for (const card of sanitizeFlashcards(cards)) {
      lines.push([cell(card.front), cell(card.back), cell(card.sourceNoteId ?? "")].join(","));
    }
    return lines.join("\n");
  }

  function importCardsJson(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text ?? ""));
    } catch {
      throw new TypeError("This file is not valid JSON.");
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.cards;
    if (!Array.isArray(list)) throw new TypeError("JSON import needs an array of cards (or {\"cards\": [...]}).");
    const cards = [];
    let skipped = 0;
    for (const item of list) {
      if (!isPlainObject(item) || typeof item.front !== "string" || typeof item.back !== "string") { skipped += 1; continue; }
      cards.push({
        id: makeId("card"), front: item.front.slice(0, 8000), back: item.back.slice(0, 8000),
        sourceNoteId: typeof item.sourceNoteId === "string" ? item.sourceNoteId : null,
        kind: "qa", clozeIndex: 1, stability: null, difficulty: null,
        dueAt: null, lastReviewedAt: null, reviews: 0, lapses: 0
      });
    }
    return { cards, skipped };
  }

  /* ---------------- Item 8 — cloud AI assists (BYOK, OFF by default) ----------------
   * Keys live ONLY in the Phase 1 credential store (encrypted envelopes,
   * plugin id "ai-assists"); this module only ever receives a key in memory
   * for one request. Every feature checks enabled + key first and says so
   * when either is missing. */

  const AI_CREDENTIAL_PLUGIN_ID = "ai-assists";
  const AI_DEFAULT_MODELS = Object.freeze({
    claude: "claude-sonnet-4-5-20250929",
    openai: "gpt-4o-mini",
    gemini: "gemini-2.5-flash"
  });

  function aiStatus(settings, keyPresent) {
    if (!settings?.ai?.enabled) return { available: false, reason: "AI assists are off. Enable them in Capture & smarts settings." };
    if (!keyPresent) return { available: false, reason: "No API key is stored for this provider. Add one in Capture & smarts settings — it stays encrypted on this device." };
    return { available: true, reason: "" };
  }

  function aiChatEndpoint(provider, baseUrl) {
    const base = String(baseUrl ?? "").replace(/\/+$/, "");
    if (provider === "claude") {
      return { url: base ? `${base}/messages` : "https://api.anthropic.com/v1/messages", kind: "claude" };
    }
    if (provider === "gemini") {
      return { url: base || "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", kind: "gemini" };
    }
    return { url: base ? `${base}/chat/completions` : "https://api.openai.com/v1/chat/completions", kind: "openai" };
  }

  async function aiChat({ provider, baseUrl, apiKey, prompt, model, maxTokens = 1024 }) {
    if (typeof fetch !== "function") throw new Error("AI assists need fetch, which is unavailable here.");
    if (!apiKey) throw new Error("AI assists need an API key — add one in Capture & smarts settings.");
    const endpoint = aiChatEndpoint(provider, baseUrl);
    const chosenModel = model || AI_DEFAULT_MODELS[provider] || AI_DEFAULT_MODELS.openai;
    let response;
    if (endpoint.kind === "claude") {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({ model: chosenModel, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
      });
    } else if (endpoint.kind === "gemini") {
      const url = endpoint.url.includes("?") ? `${endpoint.url}&key=${encodeURIComponent(apiKey)}` : `${endpoint.url}?key=${encodeURIComponent(apiKey)}`;
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } })
      });
    } else {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: chosenModel, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`AI request failed (${response.status}). ${detail.slice(0, 200) || "Check the key, provider, and base URL."}`);
    }
    const data = await response.json();
    if (endpoint.kind === "claude") {
      const text = data?.content?.map((part) => part?.text ?? "").join("");
      if (!text) throw new Error("The AI provider returned an empty reply.");
      return text;
    }
    if (endpoint.kind === "gemini") {
      const text = data?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? "").join("");
      if (!text) throw new Error("The AI provider returned an empty reply.");
      return text;
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text) throw new Error("The AI provider returned an empty reply.");
    return text;
  }

  // Keyword-based related notes: shared distinctive tokens, labelled as
  // keyword matching (never presented as semantic/AI results).
  function relatedNotesKeyword(note, notes, limit = 5) {
    const mine = new Set(tokenize(`${note?.title ?? ""}\n${note?.body ?? ""}`));
    const scored = [];
    for (const other of notes ?? []) {
      if (!other || other.id === note?.id) continue;
      const theirs = new Set(tokenize(`${other.title ?? ""}\n${other.body ?? ""}`));
      let shared = 0;
      for (const token of mine) if (theirs.has(token)) shared += 1;
      const titleOverlap = tokenize(other.title ?? "").filter((t) => mine.has(t)).length;
      const score = shared + titleOverlap * 2;
      if (score > 0) scored.push({ note: other, score, sharedTokens: shared, source: "keyword" });
    }
    scored.sort((a, b) => b.score - a.score || String(a.note.id).localeCompare(String(b.note.id)));
    return scored.slice(0, limit);
  }

  // Semantic blend: cosine similarity against stored note vectors, added
  // to the keyword score (see blendScores). `vectors` is a Map of
  // noteId -> vector; `queryVector` is the embedding of the current note.
  // Results are labelled "keyword+semantic" (or "semantic" when only the
  // vector matched) — never presented as pure keyword results.
  function relatedNotesBlended(note, notes, vectors, queryVector, limit = 5) {
    const keyword = relatedNotesKeyword(note, notes, limit * 2);
    const byId = new Map(keyword.map((result) => [result.note.id, result]));
    for (const other of notes ?? []) {
      if (!other || other.id === note?.id) continue;
      const vector = vectors?.get?.(other.id);
      if (!vector || !queryVector) continue;
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity <= 0.05) continue;
      const existing = byId.get(other.id);
      if (existing) {
        existing.score = blendScores(existing.score, similarity);
        existing.source = "keyword+semantic";
        existing.semantic = Math.round(similarity * 100) / 100;
      } else {
        byId.set(other.id, {
          note: other, score: similarity, sharedTokens: 0,
          source: "semantic", semantic: Math.round(similarity * 100) / 100
        });
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Keyword fallback for auto-organize: match folder names against the
  // note text, and reuse tags already in the workspace. Labelled "keyword".
  function suggestOrganizationKeyword(note, state) {
    const text = `${note?.title ?? ""}\n${note?.body ?? ""}`.toLocaleLowerCase();
    let folder = null;
    for (const candidate of state?.folders ?? []) {
      const name = String(candidate?.name ?? "").toLocaleLowerCase();
      if (name && text.includes(name)) { folder = candidate; break; }
    }
    const tagCounts = new Map();
    for (const other of state?.notes ?? []) {
      for (const tag of (other?.body ?? "").match(/#[a-z0-9][a-z0-9/_-]*/gi) ?? []) {
        tagCounts.set(tag.toLocaleLowerCase(), (tagCounts.get(tag.toLocaleLowerCase()) ?? 0) + 1);
      }
    }
    const tags = [...tagCounts.entries()]
      .filter(([tag]) => text.includes(tag))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);
    return { folder: folder ? { id: folder.id, name: folder.name } : null, tags, source: "keyword" };
  }

  // Extractive summary (no key, no AI): first meaningful lines, clearly
  // labelled as extractive so it is never mistaken for an AI brief.
  function extractiveSummary(note, maxSentences = 3) {
    const body = String(note?.body ?? "").replace(/^#+\s.*$/gm, "").trim();
    const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const picked = sentences.slice(0, maxSentences);
    return { text: picked.join(" ") || "(This note is empty.)", source: "extractive" };
  }

  async function summarizeNoteWithAi({ settings, apiKey, note }) {
    const status = aiStatus(settings, !!apiKey);
    if (!status.available) return { ...extractiveSummary(note), note: status.reason };
    const text = await aiChat({
      provider: settings.ai.provider, baseUrl: settings.ai.baseUrl, apiKey,
      prompt: `Summarize this note into a short brief (3-5 sentences, plain text, no preamble):\n\nTitle: ${note.title}\n\n${String(note.body ?? "").slice(0, 8000)}`
    });
    return { text: text.trim(), source: "ai" };
  }

  async function suggestOrganizationWithAi({ settings, apiKey, note, state }) {
    const status = aiStatus(settings, !!apiKey);
    if (!status.available) return { ...suggestOrganizationKeyword(note, state), note: status.reason };
    const folders = (state?.folders ?? []).map((f) => f.name).join(", ");
    const text = await aiChat({
      provider: settings.ai.provider, baseUrl: settings.ai.baseUrl, apiKey,
      prompt: `For this note, suggest ONE folder (from: ${folders || "none"}) and up to 5 short tags. Reply with JSON only: {"folder": "<name or null>", "tags": ["..."]}.\n\nTitle: ${note.title}\n\n${String(note.body ?? "").slice(0, 4000)}`
    });
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
    } catch {
      return { ...suggestOrganizationKeyword(note, state), note: "The AI reply was not valid JSON — showing the keyword suggestion instead." };
    }
    const folder = (state?.folders ?? []).find((f) => f.name === parsed.folder) ?? null;
    return {
      folder: folder ? { id: folder.id, name: folder.name } : null,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 5) : [],
      source: "ai"
    };
  }

  /* ---------------- daily note helpers (Item 3) ---------------- */

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function weekDates(anchor = new Date(), startDay = 1) {
    // Monday-first week containing `anchor` (startDay 1 = Monday).
    const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    const offset = (date.getDay() - startDay + 7) % 7;
    date.setDate(date.getDate() - offset);
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(date);
      day.setDate(date.getDate() + i);
      days.push({ key: localDateKey(day), date: day, isToday: localDateKey(day) === localDateKey() });
    }
    return days;
  }

  function buildMeetingNote({ title = "", dateKey = localDateKey(), time = "", attendees = "" }) {
    const cleanTitle = String(title ?? "").trim().slice(0, 120) || "Meeting notes";
    const body = `# ${cleanTitle} — ${dateKey}\n\nAttendees: ${attendees}\n\n## Notes\n\n- \n\n## Actions\n\n- [ ] `;
    return {
      title: cleanTitle,
      body,
      metadata: {
        meetingDate: dateKey,
        meetingTime: String(time ?? "").slice(0, 20),
        attendees: String(attendees ?? "").slice(0, 500),
        dailyDate: dateKey
      }
    };
  }

  /* ---------------- UI controller ---------------- */

  function createPhase2UI(host) {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) return null;
    const state = () => host.getState();
    const notify = (message) => host.toast?.(message) ?? host.notify?.(message);
    const persist = () => host.persist?.();

    function el(tag, className = "", text = "") {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function renderDailyStrip() {
      const strip = doc.getElementById("daily-strip");
      if (!strip) return;
      const weekOffset = Number(strip.dataset.weekOffset ?? 0);
      const anchor = new Date();
      anchor.setDate(anchor.getDate() + weekOffset * 7);
      const days = weekDates(anchor);
      strip.replaceChildren();
      const prev = el("button", "daily-strip-nav", "‹");
      prev.type = "button";
      prev.setAttribute("aria-label", "Previous week");
      prev.addEventListener("click", () => {
        strip.dataset.weekOffset = String(weekOffset - 1);
        renderDailyStrip();
      });
      strip.append(prev);
      const todayKey = localDateKey();
      for (const day of days) {
        const hasNote = state().notes.some((n) => n.metadata?.dailyDate === day.key);
        const button = el("button", `daily-strip-day${day.isToday ? " is-today" : ""}${hasNote ? " has-note" : ""}`);
        button.type = "button";
        button.dataset.dateKey = day.key;
        button.title = `${day.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${hasNote ? " — daily note exists" : ""}`;
        const dow = el("span", "daily-strip-dow", day.date.toLocaleDateString(undefined, { weekday: "narrow" }));
        const num = el("span", "daily-strip-num", String(day.date.getDate()));
        button.append(dow, num);
        button.addEventListener("click", () => host.openDailyNote?.(day.key));
        strip.append(button);
      }
      const next = el("button", "daily-strip-nav", "›");
      next.type = "button";
      next.setAttribute("aria-label", "Next week");
      next.addEventListener("click", () => {
        strip.dataset.weekOffset = String(weekOffset + 1);
        renderDailyStrip();
      });
      strip.append(next);
      const today = el("button", "daily-strip-today", "Today");
      today.type = "button";
      today.addEventListener("click", () => {
        strip.dataset.weekOffset = "0";
        host.openDailyNote?.(todayKey);
      });
      strip.append(today);
    }

    let currentTab = "capture";
    let reviewSession = null; // {queue, index, revealed}

    function renderPanel() {
      const view = doc.getElementById("phase2-view");
      if (!view) return;
      const settings = state().settings;
      const counts = flashcardCounts(state().flashcards);
      const due = dueCards(state().flashcards);
      const digest = dailyDigest(state().highlights);
      view.replaceChildren();
      const header = el("div", "phase2-header");
      header.append(el("h2", "", "Capture & smarts"));
      header.append(el("p", "", "Voice memos, read-later, flashcards, imports, and AI assists — all local-first, AI off unless you enable it."));
      view.append(header);
      const tabs = el("div", "phase2-tabs");
      const tabDefs = [
        ["capture", "Capture"],
        ["readlater", `Read later (${state().readLater.filter((i) => !i.read).length})`],
        ["flashcards", `Flashcards (${counts.due} due)`],
        ["highlights", "Highlights"],
        ["import", "Import"],
        ["ai", "AI assists"]
      ];
      for (const [id, label] of tabDefs) {
        const button = el("button", `phase2-tab${currentTab === id ? " is-active" : ""}`, label);
        button.type = "button";
        button.addEventListener("click", () => { currentTab = id; renderPanel(); });
        tabs.append(button);
      }
      view.append(tabs);
      const body = el("div", "phase2-body");
      if (currentTab === "capture") renderCaptureTab(body);
      else if (currentTab === "readlater") renderReadLaterTab(body);
      else if (currentTab === "flashcards") renderFlashcardsTab(body, counts, due);
      else if (currentTab === "highlights") renderHighlightsTab(body, digest);
      else if (currentTab === "import") renderImportTab(body);
      else renderAiTab(body, settings);
      view.append(body);
    }

    function renderCaptureTab(body) {
      const section = el("section", "phase2-section");
      section.append(el("h3", "", "Voice memo"));
      section.append(el("p", "", "Record, transcribe, and save as a structured note. Transcription uses your browser's speech recognition where available, or your own Whisper-compatible key. If neither is available the audio is still saved — never a fake transcript."));
      const recRow = el("div", "phase2-row");
      const recButton = el("button", "feature-button feature-button-primary", "● Record voice memo");
      recButton.type = "button";
      const recStatus = el("span", "phase2-status", "");
      recRow.append(recButton, recStatus);
      section.append(recRow);
      const memo = { recorder: null, chunks: [], liveTranscript: "", recognition: null, startedAt: 0 };
      recButton.addEventListener("click", async () => {
        if (memo.recorder) {
          memo.recorder.stop();
          return;
        }
        if (typeof MediaRecorder === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
          recStatus.textContent = "Voice recording is not available in this browser.";
          return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (speechRecognitionAvailable()) {
            const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            const recognition = new Recognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.onresult = (event) => {
              let text = "";
              for (let i = event.resultIndex; i < event.results.length; i += 1) text += event.results[i][0].transcript;
              memo.liveTranscript = text;
              recStatus.textContent = `Listening… ${text.slice(-60)}`;
            };
            recognition.onerror = () => { /* live transcript is best-effort */ };
            recognition.start();
            memo.recognition = recognition;
          }
          memo.chunks = [];
          memo.startedAt = Date.now();
          memo.recorder = new MediaRecorder(stream);
          memo.recorder.ondataavailable = (event) => { if (event.data?.size) memo.chunks.push(event.data); };
          memo.recorder.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop());
            try { memo.recognition?.stop(); } catch { /* already stopped */ }
            memo.recorder = null;
            recButton.textContent = "● Record voice memo";
            recStatus.textContent = "Saving memo…";
            const blob = new Blob(memo.chunks, { type: memo.chunks[0]?.type || "audio/webm" });
            const file = (() => {
              try {
                return new File([blob], `voice-memo-${localDateKey()}.webm`, { type: blob.type });
              } catch {
                blob.name = `voice-memo-${localDateKey()}.webm`;
                return blob;
              }
            })();
            const { record } = await storeAttachment({ noteId: null, file });
            state().attachments.push(record);
            let transcript = memo.liveTranscript.trim();
            let status = transcript ? "speech-api" : "unavailable";
            if (!transcript) {
              const key = await host.getAiKey?.().catch(() => null);
              if (key && state().settings.ai.enabled) {
                try {
                  transcript = await transcribeWithWhisper({
                    baseUrl: state().settings.ai.baseUrl, apiKey: key, audioBlob: blob
                  });
                  status = transcript.trim() ? "whisper-byok" : "failed";
                } catch (error) {
                  status = "failed";
                  notify(`Cloud transcription failed: ${error.message}`);
                }
              }
            }
            const built = buildVoiceMemoNote({
              transcript, audioAttachmentId: record.id, audioName: record.name, transcriptionStatus: status
            });
            const note = host.createNote?.(built);
            if (note) {
              record.noteId = note.id;
              persist();
              host.selectNote?.(note.id);
              notify(transcript ? "Voice memo saved with transcript." : "Voice memo saved — transcription unavailable here, audio kept.");
            }
            recStatus.textContent = "";
          };
          memo.recorder.start();
          recButton.textContent = "■ Stop recording";
          recStatus.textContent = "Recording…";
        } catch (error) {
          recStatus.textContent = `Could not start recording: ${error.message}`;
        }
      });
      body.append(section);
      const rl = el("section", "phase2-section");
      rl.append(el("h3", "", "Save to Read Later"));
      rl.append(el("p", "", "Save a URL (or pasted text) into the Read Later inbox. xPin tries to fetch the article text in-app where the site allows it; otherwise it keeps your URL and text."));
      const urlInput = el("input", "feature-input");
      urlInput.placeholder = "https://example.com/article";
      urlInput.setAttribute("aria-label", "Article URL");
      const textInput = el("textarea", "feature-input");
      textInput.placeholder = "Or paste article text here…";
      textInput.rows = 3;
      const saveButton = el("button", "feature-button feature-button-primary", "Save to Read Later");
      saveButton.type = "button";
      const saveStatus = el("span", "phase2-status", "");
      saveButton.addEventListener("click", async () => {
        try {
          const item = createReadLaterItem({ url: urlInput.value, text: textInput.value });
          state().readLater.push(item);
          persist();
          saveStatus.textContent = "Saved. Trying to fetch the article text…";
          const fetched = await tryFetchArticle(item);
          Object.assign(item, fetched);
          persist();
          saveStatus.textContent = fetched.fetchStatus === "fetched"
            ? "Saved — article text fetched."
            : "Saved — the site did not allow an in-app fetch, so the URL and your text are kept as-is.";
          urlInput.value = "";
          textInput.value = "";
        } catch (error) {
          saveStatus.textContent = error.message;
        }
      });
      rl.append(urlInput, textInput, saveButton, saveStatus);
      body.append(rl);
    }

    function renderReadLaterTab(body) {
      const items = state().readLater;
      if (!items.length) {
        body.append(el("p", "feature-empty", "Nothing saved yet. Save a URL from the Capture tab."));
        return;
      }
      for (const item of [...items].reverse()) {
        const card = el("article", "phase2-card");
        const title = el("a", "phase2-card-title", item.title);
        if (item.url) {
          title.href = item.url;
          title.target = "_blank";
          title.rel = "noopener noreferrer";
        }
        card.append(title);
        card.append(el("p", "phase2-card-meta",
          `${item.fetchStatus === "fetched" ? "Article text fetched" : item.fetchStatus === "fetch-failed" ? "Fetch not allowed by the site — URL kept" : "Saved"} · ${new Date(item.savedAt).toLocaleDateString()}${item.read ? " · Read" : ""}`));
        const text = item.fetchedText || item.text;
        if (text) {
          const preview = el("p", "phase2-card-text", text.slice(0, 400));
          preview.addEventListener("mouseup", () => {
            const selection = window.getSelection?.()?.toString().trim();
            if (selection) {
              const button = el("button", "feature-button", "Save highlight");
              button.type = "button";
              button.addEventListener("click", () => {
                state().highlights.push(createHighlight({ quote: selection, sourceId: null, sourceTitle: item.title, sourceUrl: item.url }));
                persist();
                notify("Highlight saved.");
                button.remove();
              });
              card.append(button);
            }
          });
          card.append(preview);
        }
        const row = el("div", "phase2-row");
        const readButton = el("button", "feature-button", item.read ? "Mark unread" : "Mark read");
        readButton.type = "button";
        readButton.addEventListener("click", () => { item.read = !item.read; persist(); renderPanel(); });
        const noteButton = el("button", "feature-button", "Save as note");
        noteButton.type = "button";
        noteButton.addEventListener("click", () => {
          const note = host.createNote?.({
            title: item.title,
            body: `${text ? `${text}\n\n` : ""}Source: ${item.url || "pasted text"}`,
            metadata: { sourceUrl: item.url || "", readLaterId: item.id }
          });
          if (note) { host.selectNote?.(note.id); notify("Saved as a note."); }
        });
        const remove = el("button", "feature-button", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => {
          state().readLater = state().readLater.filter((i) => i.id !== item.id);
          persist();
          renderPanel();
        });
        row.append(readButton, noteButton, remove);
        card.append(row);
        body.append(card);
      }
    }

    function renderFlashcardsTab(body, counts, due) {
      const summary = el("p", "", `${counts.total} cards · ${counts.due} due · ${counts.new} new. Cards come from cloze {{c1::…}} and Q:/A: blocks in your notes.`);
      body.append(summary);
      const genButton = el("button", "feature-button", "Generate cards from notes");
      genButton.type = "button";
      genButton.addEventListener("click", () => {
        const fresh = extractCardsFromNotes(state().notes);
        const existing = new Set(state().flashcards.map((c) => `${c.front}‖${c.back}`));
        const added = fresh.filter((c) => !existing.has(`${c.front}‖${c.back}`));
        state().flashcards.push(...added);
        persist();
        notify(added.length ? `${added.length} new cards added.` : "No new cards found in your notes.");
        renderPanel();
      });
      const exportButton = el("button", "feature-button", "Export .apkg (Anki)");
      exportButton.type = "button";
      exportButton.addEventListener("click", () => {
        try {
          const apkg = buildApkg(state().flashcards, "xPin");
          const blob = new Blob([apkg.bytes], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const link = doc.createElement("a");
          link.href = url;
          link.download = "xpin-flashcards.apkg";
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          notify(`Exported ${apkg.cardCount} cards${apkg.truncated ? " (capped at 500 for this export)" : ""}.`);
        } catch (error) {
          notify(`APKG export failed: ${error.message}`);
        }
      });
      const importLabel = el("label", "feature-button", "Import .apkg / .json");
      const importInput = el("input");
      importInput.type = "file";
      importInput.accept = ".apkg,.json";
      importInput.hidden = true;
      importInput.addEventListener("change", async () => {
        const [file] = importInput.files ?? [];
        importInput.value = "";
        if (!file) return;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let result;
          if (/\.apkg$/i.test(file.name)) result = await importApkg(bytes);
          else result = importCardsJson(new TextDecoder().decode(bytes));
          state().flashcards.push(...result.cards);
          persist();
          notify(`Imported ${result.cards.length} cards${result.skipped ? ` (${result.skipped} skipped)` : ""}.`);
          renderPanel();
        } catch (error) {
          notify(`Import failed: ${error.message}`);
        }
      });
      importLabel.append(importInput);
      const row = el("div", "phase2-row");
      row.append(genButton, exportButton, importLabel);
      body.append(row);
      if (reviewSession) {
        renderReviewSession(body);
        return;
      }
      if (!due.length) {
        body.append(el("p", "feature-empty", "Nothing due right now. Come back later — or generate cards from your notes."));
        return;
      }
      const startButton = el("button", "feature-button feature-button-primary", `Review ${due.length} due cards`);
      startButton.type = "button";
      startButton.addEventListener("click", () => {
        reviewSession = { queue: due.map((c) => c.id), index: 0, revealed: false };
        renderPanel();
      });
      body.append(startButton);
      const list = el("div", "phase2-list");
      for (const card of due.slice(0, 10)) {
        list.append(el("p", "phase2-card-text", `• ${card.front.slice(0, 120)}`));
      }
      body.append(list);
    }

    function renderReviewSession(body) {
      const card = state().flashcards.find((c) => c.id === reviewSession.queue[reviewSession.index]);
      if (!card) {
        reviewSession = null;
        body.append(el("p", "", "Review complete."));
        const again = el("button", "feature-button", "Back to flashcards");
        again.type = "button";
        again.addEventListener("click", renderPanel);
        body.append(again);
        return;
      }
      body.append(el("p", "", `Card ${reviewSession.index + 1} of ${reviewSession.queue.length} · FSRS-4.5 scheduling`));
      const front = el("div", "phase2-flashcard", card.front);
      body.append(front);
      if (!reviewSession.revealed) {
        const show = el("button", "feature-button feature-button-primary", "Show answer");
        show.type = "button";
        show.addEventListener("click", () => { reviewSession.revealed = true; renderPanel(); });
        body.append(show);
      } else {
        body.append(el("div", "phase2-flashcard phase2-flashcard-back", card.back));
        const grades = el("div", "phase2-row");
        for (const [label, grade] of [["Again", 1], ["Hard", 2], ["Good", 3], ["Easy", 4]]) {
          const button = el("button", "feature-button", label);
          button.type = "button";
          button.addEventListener("click", () => {
            const updated = fsrsReview(card, grade);
            Object.assign(card, updated);
            persist();
            reviewSession.index += 1;
            reviewSession.revealed = false;
            renderPanel();
          });
          grades.append(button);
        }
        body.append(grades);
        if (card.sourceNoteId) {
          const link = el("button", "feature-button", "Open source note");
          link.type = "button";
          link.addEventListener("click", () => host.selectNote?.(card.sourceNoteId));
          body.append(link);
        }
      }
    }

    function renderHighlightsTab(body, digest) {
      if (digest.length) {
        const digestSection = el("section", "phase2-section");
        digestSection.append(el("h3", "", "From your highlights"));
        digestSection.append(el("p", "", "A few older highlights, resurfaced — dismiss any you don't want to see again."));
        for (const highlight of digest) {
          const card = el("article", "phase2-card");
          card.append(el("p", "phase2-card-text", `“${highlight.quote}”`));
          card.append(el("p", "phase2-card-meta", `${highlight.sourceTitle || highlight.sourceUrl || "Saved highlight"} · ${new Date(highlight.createdAt).toLocaleDateString()}`));
          const dismiss = el("button", "feature-button", "Dismiss");
          dismiss.type = "button";
          dismiss.addEventListener("click", () => {
            highlight.dismissedAt = new Date().toISOString();
            persist();
            renderPanel();
          });
          card.append(dismiss);
          highlight.shownCount += 1;
          digestSection.append(card);
        }
        persist();
        body.append(digestSection);
      }
      const all = state().highlights;
      if (!all.length) {
        body.append(el("p", "feature-empty", "No highlights yet. Select text in a Read Later item and save it as a highlight."));
        return;
      }
      body.append(el("h3", "", "All highlights"));
      for (const highlight of [...all].reverse().slice(0, 30)) {
        const card = el("article", "phase2-card");
        card.append(el("p", "phase2-card-text", `“${highlight.quote}”`));
        card.append(el("p", "phase2-card-meta", `${highlight.sourceTitle || highlight.sourceUrl || ""} · ${new Date(highlight.createdAt).toLocaleDateString()}`));
        body.append(card);
      }
    }

    function renderImportTab(body) {
      const section = el("section", "phase2-section");
      section.append(el("h3", "", "One-click importers"));
      section.append(el("p", "", "Import from Evernote (.enex), OneNote (exported HTML), or Notion (exported HTML files — nested pages become sub-pages). Anything unparseable is counted as skipped, never silently dropped."));
      const status = el("p", "phase2-status", "");
      const makeImporter = (label, accept, multiple, handler) => {
        const wrap = el("div", "phase2-row");
        const button = el("button", "feature-button", label);
        button.type = "button";
        const input = el("input");
        input.type = "file";
        input.accept = accept;
        input.multiple = multiple;
        input.hidden = true;
        input.addEventListener("change", async () => {
          const files = [...(input.files ?? [])];
          input.value = "";
          if (!files.length) return;
          status.textContent = "Importing…";
          try {
            const result = await handler(files);
            status.textContent = `Imported ${result.created} notes${result.skipped ? `, ${result.skipped} skipped` : ""}${result.errors?.length ? ` — ${result.errors.join("; ")}` : ""}.`;
            renderPanel();
          } catch (error) {
            status.textContent = `Import failed: ${error.message}`;
          }
        });
        button.addEventListener("click", () => input.click());
        wrap.append(button);
        return wrap;
      };
      const createImportedNotes = (parsed) => {
        let created = 0;
        const byPath = new Map();
        for (const note of parsed.notes) {
          const record = host.createNote?.({
            title: note.title, body: note.body, metadata: note.metadata ?? {}
          });
          if (!record) continue;
          created += 1;
          if (note.path) byPath.set(note.path, record.id);
        }
        // Notion nesting: link sub-pages to their parent by path.
        for (const note of parsed.notes) {
          if (!note.parentPath || !note.path) continue;
          const childId = byPath.get(note.path);
          const parentPath = [...byPath.keys()].find((p) => p.replace(/\.html?$/i, "") === note.parentPath);
          const parentId = parentPath ? byPath.get(parentPath) : null;
          if (childId && parentId) {
            const child = state().notes.find((n) => n.id === childId);
            if (child) child.parentNoteId = parentId;
          }
        }
        if (created) persist();
        return { created, skipped: parsed.skipped ?? 0, errors: parsed.errors ?? [] };
      };
      body.append(section);
      body.append(makeImporter("Import Evernote (.enex)", ".enex", false, async (files) => {
        const text = await files[0].text();
        return createImportedNotes(parseEnex(text));
      }));
      body.append(makeImporter("Import OneNote (HTML export)", ".html,.htm", true, async (files) => {
        let created = 0;
        let skipped = 0;
        const errors = [];
        for (const file of files) {
          const parsed = parseOneNoteHtml(await file.text(), file.name);
          const result = createImportedNotes(parsed);
          created += result.created;
          skipped += result.skipped;
          if (parsed.error) errors.push(parsed.error);
        }
        return { created, skipped, errors };
      }));
      body.append(makeImporter("Import Notion (HTML export)", ".html,.htm", true, async (files) => {
        const loaded = [];
        for (const file of files) loaded.push({ path: file.webkitRelativePath || file.name, content: await file.text() });
        return createImportedNotes(parseNotionFiles(loaded));
      }));
      body.append(status);
    }

    function renderAiTab(body, settings) {
      const ai = settings.ai;
      const section = el("section", "phase2-section");
      section.append(el("h3", "", "Cloud AI assists — BYOK, off by default"));
      section.append(el("p", "", "No hosted AI. Your key is encrypted on this device (Phase 1 credential store) and sent only to the provider you choose. Nothing is sent anywhere until you run an assist."));
      const keyPresent = host.aiKeyPresent?.() ?? false;
      const unlocked = host.credentialsUnlocked?.() ?? false;
      const status = el("p", "phase2-status", ai.enabled
        ? (keyPresent ? `Enabled · provider ${ai.provider} · key stored.` : "Enabled, but no API key is stored yet — add one below.")
        : "Disabled. Assists stay hidden until you enable them and add a key.");
      section.append(status);
      if (!unlocked) {
        section.append(el("p", "", "Credential storage is locked. Unlock it with your sync passphrase (set in Workspace tools → Sync) to store an AI key."));
        const passInput = el("input", "feature-input");
        passInput.type = "password";
        passInput.placeholder = "Sync passphrase (12+ characters)";
        passInput.setAttribute("aria-label", "Sync passphrase to unlock credential storage");
        const unlockButton = el("button", "feature-button", "Unlock credential storage");
        unlockButton.type = "button";
        unlockButton.addEventListener("click", async () => {
          try {
            await host.unlockCredentials?.(passInput.value);
            notify("Credential storage unlocked.");
            renderPanel();
          } catch (error) {
            notify(error.message);
          }
        });
        section.append(passInput, unlockButton);
      } else {
        const enableLabel = el("label", "phase2-check");
        const enableBox = el("input");
        enableBox.type = "checkbox";
        enableBox.checked = ai.enabled;
        enableBox.addEventListener("change", () => {
          state().settings.ai.enabled = enableBox.checked;
          persist();
          renderPanel();
        });
        enableLabel.append(enableBox, doc.createTextNode(" Enable AI assists"));
        section.append(enableLabel);
        const providerLabel = el("label", "", "Provider");
        const providerSelect = el("select", "feature-select");
        for (const provider of AI_PROVIDERS) {
          const option = el("option", "", provider[0].toLocaleUpperCase() + provider.slice(1));
          option.value = provider;
          providerSelect.append(option);
        }
        providerSelect.value = ai.provider;
        providerSelect.addEventListener("change", () => {
          state().settings.ai.provider = providerSelect.value;
          persist();
          renderPanel();
        });
        providerLabel.append(providerSelect);
        section.append(providerLabel);
        const baseInput = el("input", "feature-input");
        baseInput.placeholder = "Base URL (optional — leave blank for the provider default)";
        baseInput.value = ai.baseUrl;
        baseInput.setAttribute("aria-label", "Provider base URL");
        baseInput.addEventListener("change", () => {
          state().settings.ai.baseUrl = baseInput.value.trim();
          persist();
        });
        section.append(baseInput);
        const keyInput = el("input", "feature-input");
        keyInput.type = "password";
        keyInput.placeholder = "API key (stored encrypted, never shown again)";
        keyInput.setAttribute("aria-label", "API key");
        const saveKey = el("button", "feature-button", keyPresent ? "Replace stored key" : "Save key");
        saveKey.type = "button";
        saveKey.addEventListener("click", async () => {
          if (!keyInput.value.trim()) { notify("Paste an API key first."); return; }
          try {
            await host.setAiKey?.(keyInput.value.trim());
            keyInput.value = "";
            notify("API key stored (encrypted on this device).");
            renderPanel();
          } catch (error) {
            notify(error.message);
          }
        });
        const clearKey = el("button", "feature-button", "Remove key");
        clearKey.type = "button";
        clearKey.addEventListener("click", async () => {
          await host.setAiKey?.("");
          notify("API key removed.");
          renderPanel();
        });
        section.append(keyInput, saveKey, clearKey);
        const embLabel = el("label", "phase2-check");
        const embBox = el("input");
        embBox.type = "checkbox";
        embBox.checked = ai.embeddingsEnabled;
        embBox.addEventListener("change", () => {
          state().settings.ai.embeddingsEnabled = embBox.checked;
          persist();
          renderPanel();
        });
        embLabel.append(embBox, doc.createTextNode(" Enable semantic search (BYOK embeddings — off by default; without a key it stays honestly unavailable)"));
        section.append(embLabel);
        const indexButton = el("button", "feature-button", "Index notes for semantic search");
        indexButton.type = "button";
        const indexStatus = el("span", "phase2-status", "");
        indexButton.addEventListener("click", async () => {
          indexStatus.textContent = "Embedding notes…";
          try {
            const key = await host.getAiKey?.().catch(() => null);
            if (!key) { indexStatus.textContent = "Add an API key first."; return; }
            const notes = state().notes.filter((n) => String(n.title ?? n.body ?? "").trim());
            let indexed = 0;
            for (let i = 0; i < notes.length; i += 50) {
              const batch = notes.slice(i, i + 50);
              const vectors = await fetchEmbeddings({
                baseUrl: ai.embeddingsBaseUrl || ai.baseUrl, apiKey: key,
                texts: batch.map((n) => `${n.title ?? ""}\n${n.body ?? ""}`.slice(0, 8000))
              });
              for (let j = 0; j < batch.length; j += 1) {
                await saveEmbedding(batch[j].id, vectors[j]);
                indexed += 1;
              }
            }
            indexStatus.textContent = `Indexed ${indexed} note${indexed === 1 ? "" : "s"} for semantic search.`;
          } catch (error) {
            indexStatus.textContent = `Indexing failed: ${error.message}`;
          }
        });
        section.append(indexButton, indexStatus);
      }
      body.append(section);
      const assists = el("section", "phase2-section");
      assists.append(el("h3", "", "Assists on the current note"));
      const current = host.currentNote?.();
      if (!current) {
        assists.append(el("p", "", "Open a note to run an assist on it."));
      } else {
        assists.append(el("p", "", `Current note: ${current.title || "Untitled note"}`));
        const out = el("div", "phase2-assist-out");
        const runButton = (label, run) => {
          const button = el("button", "feature-button", label);
          button.type = "button";
          button.addEventListener("click", async () => {
            out.textContent = "Working…";
            try {
              out.textContent = await run();
            } catch (error) {
              out.textContent = `Could not run that assist: ${error.message}`;
            }
          });
          return button;
        };
        const row = el("div", "phase2-row");
        row.append(runButton("Summarize", async () => {
          const key = await host.getAiKey?.().catch(() => null);
          const result = await summarizeNoteWithAi({ settings: state().settings, apiKey: key, note: current });
          return `Brief (${result.source === "ai" ? "AI" : "extractive — no AI key set"}):\n${result.text}${result.note ? `\n${result.note}` : ""}`;
        }));
        row.append(runButton("Auto-organize", async () => {
          const key = await host.getAiKey?.().catch(() => null);
          const result = await suggestOrganizationWithAi({ settings: state().settings, apiKey: key, note: current, state: state() });
          const folderLine = result.folder ? `Suggested folder: ${result.folder.name}` : "No folder suggestion.";
          const tagsLine = result.tags.length ? `Suggested tags: ${result.tags.join(", ")}` : "No tag suggestions.";
          const apply = el("button", "feature-button", "Apply suggestion");
          apply.type = "button";
          apply.addEventListener("click", () => {
            if (result.folder) current.folderId = result.folder.id;
            if (result.tags.length) {
              const existing = current.body;
              current.body = `${result.tags.join(" ")}${existing ? `\n\n${existing}` : ""}`;
            }
            current.updatedAt = new Date().toISOString();
            persist();
            host.render?.();
            notify("Suggestion applied.");
          });
          out.replaceChildren();
          out.append(doc.createTextNode(`${folderLine}\n${tagsLine}\nSource: ${result.source}${result.note ? `\n${result.note}` : ""}\n`));
          out.append(apply);
          return "";
        }));
        row.append(runButton("Related notes", async () => {
          const ai = state().settings.ai;
          if (ai.enabled && ai.embeddingsEnabled) {
            try {
              const key = await host.getAiKey?.().catch(() => null);
              if (key) {
                let queryVector = await getEmbedding(current.id);
                if (!queryVector) {
                  [queryVector] = await fetchEmbeddings({
                    baseUrl: ai.embeddingsBaseUrl || ai.baseUrl, apiKey: key,
                    texts: [`${current.title ?? ""}\n${current.body ?? ""}`.slice(0, 8000)]
                  });
                }
                const vectors = new Map();
                for (const other of state().notes) {
                  if (other.id === current.id) continue;
                  const vector = await getEmbedding(other.id);
                  if (vector) vectors.set(other.id, vector);
                }
                if (vectors.size) {
                  const blended = relatedNotesBlended(current, state().notes, vectors, queryVector);
                  if (blended.length) {
                    return `Related notes (keyword + semantic blend):\n${blended.map((r) => `• ${r.note.title || "Untitled note"} (${r.source}${r.semantic !== undefined ? `, similarity ${r.semantic}` : ""})`).join("\n")}`;
                  }
                }
              }
            } catch (error) {
              // Fall through to the keyword list with an honest note.
              const related = relatedNotesKeyword(current, state().notes);
              if (!related.length) return "No related notes found (keyword match). Semantic search was attempted but failed — see above.";
              return `Related notes (keyword match — semantic search unavailable: ${error.message}):\n${related.map((r) => `• ${r.note.title || "Untitled note"} (${r.score} shared terms)`).join("\n")}`;
            }
          }
          const related = relatedNotesKeyword(current, state().notes);
          if (!related.length) return "No related notes found (keyword match).";
          return `Related notes (keyword match, not AI):\n${related.map((r) => `• ${r.note.title || "Untitled note"} (${r.score} shared terms)`).join("\n")}`;
        }));
        assists.append(row, out);
      }
      body.append(assists);
    }

    return {
      renderPanel,
      renderDailyStrip,
      setTab(tab) {
        currentTab = tab;
        renderPanel();
      }
    };
  }

  /* ---------------- public surface ---------------- */

  const api = {
    MAX_ATTACHMENT_BYTES,
    SYNCABLE_ATTACHMENT_BYTES,
    MAX_APKG_CARDS,
    APKG_FIELD_CHARS,
    AI_PROVIDERS,
    DEFAULT_AI,
    GRADES,
    GRADE_NAMES,
    FSRS_WEIGHTS,
    FSRS_FACTOR,
    FSRS_DECAY,
    FSRS_REQUEST_RETENTION,
    AI_CREDENTIAL_PLUGIN_ID,
    sanitizePhase2State,
    defaultPhase2State,
    sanitizeSettings,
    sanitizeAiSettings,
    sanitizeAttachments,
    sanitizeReadLater,
    sanitizeHighlights,
    sanitizeFlashcards,
    tokenize,
    scoreNote,
    makeSnippet,
    rankNotes,
    searchExtras,
    cosineSimilarity,
    blendScores,
    fetchEmbeddings,
    attachmentRecord,
    validateAttachmentFile,
    attachmentMarkdown,
    attachmentUsage,
    syncableAttachments,
    attachmentSyncNote,
    saveAttachmentBlob,
    getAttachmentBlob,
    deleteAttachmentBlob,
    saveEmbedding,
    getEmbedding,
    storeAttachment,
    resolveAttachmentRefs,
    decodeEntities,
    stripTagsToText,
    htmlToMarkdown,
    parseEnex,
    parseOneNoteHtml,
    parseNotionHtml,
    parseNotionFiles,
    createReadLaterItem,
    tryFetchArticle,
    createHighlight,
    dailyDigest,
    buildVoiceMemoNote,
    transcribeWithWhisper,
    speechRecognitionAvailable,
    fsrsRetrievability,
    fsrsIntervalDays,
    fsrsInitialStability,
    fsrsInitialDifficulty,
    fsrsReview,
    dueCards,
    flashcardCounts,
    extractCardsFromNote,
    extractCardsFromNotes,
    sha1Hex,
    encodeSqliteRecord,
    buildAnkiDb,
    zipStore,
    unzipEntries,
    readSqliteTables,
    buildApkg,
    importApkg,
    exportCardsCsv,
    importCardsJson,
    aiStatus,
    aiChatEndpoint,
    aiChat,
    relatedNotesKeyword,
    relatedNotesBlended,
    suggestOrganizationKeyword,
    extractiveSummary,
    summarizeNoteWithAi,
    suggestOrganizationWithAi,
    localDateKey,
    weekDates,
    buildMeetingNote,
    createPhase2UI
  };

  if (typeof window !== "undefined") window.xPinPhase2 = Object.freeze(api);
  if (typeof globalThis !== "undefined" && typeof module !== "undefined" && module.exports) module.exports = api;
})();
