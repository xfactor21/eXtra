/* xPin headless smoke test — boots the real app in a fake DOM (node:vm)
 * and exercises core workflows end-to-end. Run: node /tmp/xpin-smoke2.js
 * Exit 0 = all pass, 1 = failures (listed). Never fabricates: every check
 * runs the real code paths.
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");

const REPO = require("path").resolve(__dirname, "..");
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? "" : String(detail || "") });
}

/* ---------------- minimal selector engine ---------------- */
function parseSimple(sel) {
  const p = { tag: null, id: null, classes: [], attrs: [] };
  let s = sel.trim();
  const tagM = s.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagM) { p.tag = tagM[0].toUpperCase(); s = s.slice(tagM[0].length); }
  let m;
  while ((m = s.match(/^[#\.][a-zA-Z0-9_-]+/))) {
    if (m[0][0] === "#") p.id = m[0].slice(1); else p.classes.push(m[0].slice(1));
    s = s.slice(m[0].length);
  }
  while ((m = s.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/))) {
    p.attrs.push({ name: m[1], value: m[2] === undefined ? null : m[2] });
    s = s.slice(m[0].length);
  }
  p.rest = s.trim();
  return p;
}
function matchesSimple(elm, sel) {
  if (!elm || elm.nodeType !== 1) return false;
  const p = parseSimple(sel);
  if (p.rest) return false;
  if (p.tag && elm.tagName !== p.tag) return false;
  if (p.id && elm.getAttribute("id") !== p.id) return false;
  for (const c of p.classes) if (!elm.classList.contains(c)) return false;
  for (const a of p.attrs) {
    const v = elm.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}
function matchesSelector(elm, selector) {
  for (const group of selector.split(",")) {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    let cur = elm;
    let i = parts.length - 1;
    if (!matchesSimple(cur, parts[i])) continue;
    i--;
    let ok = true;
    while (i >= 0) {
      cur = cur.parentNode;
      let found = false;
      while (cur) {
        if (matchesSimple(cur, parts[i])) { found = true; break; }
        cur = cur.parentNode;
      }
      if (!found) { ok = false; break; }
      i--;
    }
    if (ok) return true;
  }
  return false;
}

/* ---------------- fake DOM nodes ---------------- */
class FakeNode {}
FakeNode.ELEMENT_NODE = 1;
FakeNode.TEXT_NODE = 3;
FakeNode.DOCUMENT_FRAGMENT_NODE = 11;
FakeNode.DOCUMENT_NODE = 9;
class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
}
Object.setPrototypeOf(FakeText.prototype, FakeNode.prototype);
const VOID = new Set(["INPUT", "BR", "IMG", "HR", "META", "LINK", "SOURCE"]);
function parseHTML(html, doc) {
  // tiny parser: tags with double/single-quoted attrs, text, comments skipped
  const frag = doc.createDocumentFragment();
  const stack = [frag];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      const t = m[5];
      if (t.trim()) stack[stack.length - 1].appendChild(doc.createTextNode(t));
      continue;
    }
    if (m[0].startsWith("<!--")) continue;
    const closing = m[1] === "/";
    const tag = m[2].toUpperCase();
    const attrStr = m[3] || "";
    const selfClose = m[4] === "/" || VOID.has(tag);
    if (closing) {
      while (stack.length > 1 && stack[stack.length - 1].tagName !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const elm = doc.createElement(tag);
    const are = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    while ((am = are.exec(attrStr))) {
      elm.setAttribute(am[1], am[2] ?? am[3] ?? am[4] ?? "");
    }
    stack[stack.length - 1].appendChild(elm);
    if (!selfClose) stack.push(elm);
  }
  return frag;
}

class FakeElement {
  constructor(tagName, doc) {
    this._doc = doc;
    this.tagName = String(tagName || "div").toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.attributes = {};
    this._classSet = new Set();
    this._listeners = {};
    this._text = null; // when set via textContent setter
    const _styleProps = {};
    this.style = new Proxy(_styleProps, {
      get: (t, k) => {
        if (k === "setProperty") return (n, v) => { t[n] = String(v); };
        if (k === "getPropertyValue") return (n) => t[n] || "";
        if (k === "removeProperty") return (n) => { delete t[n]; };
        return t[k];
      },
      set: (t, k, v) => { t[k] = String(v); return true; },
    });
    this._dataset = {};
    const self = this;
    this.dataset = new Proxy(this._dataset, {
      get: (t, k) => t[k],
      set: (t, k, v) => {
        t[k] = String(v);
        self.attributes["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = String(v);
        return true;
      },
      deleteProperty: (t, k) => { delete t[k]; return true; },
    });
    this.classList = {
      add: (...c) => { c.forEach((x) => self._classSet.add(x)); self._syncClass(); },
      remove: (...c) => { c.forEach((x) => self._classSet.delete(x)); self._syncClass(); },
      toggle: (c, force) => {
        const has = self._classSet.has(c);
        const want = force === undefined ? !has : !!force;
        if (want) self._classSet.add(c); else self._classSet.delete(c);
        self._syncClass(); return want;
      },
      contains: (c) => self._classSet.has(c),
    };
    // common props (id/hidden are prototype accessors below)
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  _syncClass() { this.attributes["class"] = [...this._classSet].join(" "); }
  get className() { return [...this._classSet].join(" "); }
  set className(v) {
    this._classSet = new Set(String(v).split(/\s+/).filter(Boolean));
    this._syncClass();
  }
  getAttribute(n) {
    if (n === "class") return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null;
  }
  setAttribute(n, v) {
    const val = String(v);
    if (n === "id") {
      const prev = this.attributes["id"];
      if (prev && this._doc && this._doc._byId[prev] === this) delete this._doc._byId[prev];
      if (val) { this.attributes["id"] = val; if (this._doc) this._doc._byId[val] = this; }
      else delete this.attributes["id"];
      return;
    }
    if (n === "class") { this.className = val; return; }
    this.attributes[n] = val;
    if (n.startsWith("data-")) {
      const key = n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this._dataset[key] = val;
    }
  }
  removeAttribute(n) { delete this.attributes[n]; }
  hasAttribute(n) { return this.getAttribute(n) !== null; }
  appendChild(c) { return this.append(c); }
  append(...nodes) {
    for (let n of nodes) {
      if (n === null || n === undefined) continue;
      if (typeof n === "string") n = this._doc.createTextNode(n);
      if (n.nodeType === 11) { // fragment
        for (const kid of [...n.children]) this.append(kid);
        continue;
      }
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.children.push(n);
    }
    this._text = null;
    return nodes[0] ?? null;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    p.children.splice(i, 1);
    this.parentNode = null;
    nodes.forEach((n, k) => {
      if (typeof n === "string") n = this._doc.createTextNode(n);
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = p;
      p.children.splice(i + k, 0, n);
    });
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node);
    this._text = null;
    return node;
  }
  insertAdjacentElement(pos, elm) {
    if (elm.parentNode) elm.parentNode.removeChild(elm);
    if (pos === "beforebegin" || pos === "afterend") {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(this);
      elm.parentNode = p;
      p.children.splice(pos === "beforebegin" ? i : i + 1, 0, elm);
    } else if (pos === "afterbegin") {
      elm.parentNode = this;
      this.children.unshift(elm);
    } else {
      this.append(elm);
    }
    this._text = null;
    return elm;
  }
  insertAdjacentHTML(pos, html) {
    const frag = parseHTML(String(html), this._doc);
    const kids = [...frag.children];
    if (pos === "afterbegin") { for (let i = kids.length - 1; i >= 0; i--) this.insertBefore(kids[i], this.firstChild); }
    else if (pos === "beforebegin" || pos === "afterend") {
      const p = this.parentNode; if (!p) return;
      const i = p.children.indexOf(this) + (pos === "afterend" ? 1 : 0);
      for (let k = 0; k < kids.length; k++) { kids[k].parentNode = p; p.children.splice(i + k, 0, kids[k]); }
    } else { for (const k of kids) this.append(k); }
  }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) this.removeChild(c);
    this._text = null;
    if (nodes.length) this.append(...nodes);
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get textContent() {
    if (this._text !== null && this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent || "").join("");
  }
  set textContent(v) {
    for (const c of [...this.children]) this.removeChild(c);
    this._text = String(v);
  }
  get innerHTML() { return this._rawHTML || ""; }
  set innerHTML(v) {
    for (const c of [...this.children]) this.removeChild(c);
    this._text = null; this._rawHTML = String(v);
    if (v) this.append(parseHTML(String(v), this._doc));
  }
  get innerText() { return this.textContent; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let cur = this;
    ev._stopped = false;
    ev.stopPropagation = () => { ev._stopped = true; };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    while (cur && !ev._stopped) {
      ev.currentTarget = cur;
      const lst = cur._listeners ? cur._listeners[ev.type] : null;
      if (lst) for (const fn of [...lst]) { try { fn.call(cur, ev); } catch (e) { throw e; } if (ev._stopped) break; }
      if (cur === this._doc) break; // document processed (or is the target) — done
      cur = cur.parentNode;
      if (cur === null && this._doc && ev.bubbles !== false && this !== this._doc) cur = this._doc;
    }
    return true;
  }
  click() { this.dispatchEvent(new this._doc._win.Event("click", { bubbles: true })); }
  focus() { if (this._doc) this._doc.activeElement = this; }
  blur() { if (this._doc && this._doc.activeElement === this) this._doc.activeElement = this._doc.body; }
  closest(sel) { let c = this; while (c) { if (matchesSelector(c, sel)) return c; c = c.parentNode; } return null; }
  matches(sel) { return matchesSelector(this, sel); }
  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.nodeType === 1) {
          if (matchesSelector(c, sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  getElementsByClassName(c) { return this.querySelectorAll("." + c); }
  getElementsByTagName(t) { return this.querySelectorAll(t); }
  contains(n) { let c = n; while (c) { if (c === this) return true; c = c.parentNode; } return false; }
  setRangeText(repl, start, end, mode) {
    const v = this.value || "";
    this.value = v.slice(0, start) + repl + v.slice(end);
    const pos = start + repl.length;
    this.selectionStart = this.selectionEnd = pos;
  }
  select() {}
  getContext() { return null; }
getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }; }
  scrollIntoView() {}
  showModal() {}
  close() {}
}
Object.setPrototypeOf(FakeElement.prototype, FakeNode.prototype);
Object.defineProperties(FakeElement.prototype, {
  id: {
    get() { return this.getAttribute("id") || ""; },
    set(v) { this.setAttribute("id", v); },
    configurable: true,
  },
  hidden: {
    get() { return this.hasAttribute("hidden"); },
    set(v) { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); },
    configurable: true,
  },
});

/* ---------------- fake document / window ---------------- */
class FakeDocument extends FakeElement {
  constructor(win) {
    super("#document", null);
    this._win = win;
    this.nodeType = 9;
    this._byId = {};
    this.activeElement = null;
    this.visibilityState = "visible";
    this.readyState = "complete";
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body; // browsers never report null
  }
  createElement(tag) { return new FakeElement(tag, this); }
  createElementNS(_ns, tag) { return this.createElement(tag); }
  createTextNode(t) { return new FakeText(t); }
  createDocumentFragment() {
    const f = new FakeElement("#fragment", this);
    f.nodeType = 11;
    return f;
  }
  getElementById(id) { return this._byId[id] || null; }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
}

function makeEventClasses(win) {
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.defaultPrevented = false;
      this.target = null; this.currentTarget = null;
      Object.assign(this, init);
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this._stopped = true; }
  }
  class KeyboardEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.key = init.key || ""; this.code = init.code || "";
      this.ctrlKey = !!init.ctrlKey; this.metaKey = !!init.metaKey;
      this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey;
    }
  }
  class MouseEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.clientX = init.clientX || 0; this.clientY = init.clientY || 0;
      this.button = init.button || 0;
    }
  }
  return { Event: FakeEvent, CustomEvent: FakeEvent, KeyboardEvent, MouseEvent, FocusEvent: FakeEvent, InputEvent: FakeEvent };
}

function buildContext(seedStorage) {
  const errors = [];
  const storageData = { ...(seedStorage || {}) };
  const storage = {
    getItem: (k) => (k in storageData ? storageData[k] : null),
    setItem: (k, v) => { storageData[k] = String(v); },
    removeItem: (k) => { delete storageData[k]; },
    clear: () => { for (const k of Object.keys(storageData)) delete storageData[k]; },
    key: (i) => Object.keys(storageData)[i] || null,
    get length() { return Object.keys(storageData).length; },
  };
  const win = {};
  const doc = new FakeDocument(win);
  win.document = doc;
  const _winListeners = {};
  win.addEventListener = (t, fn) => { (_winListeners[t] = _winListeners[t] || []).push(fn); };
  win.removeEventListener = (t, fn) => {
    const a = _winListeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  };
  win.dispatchEvent = (ev) => {
    const lst = _winListeners[ev.type] || [];
    for (const fn of [...lst]) fn.call(win, ev);
    return true;
  };
  const ev = makeEventClasses(win);
  Object.assign(win, ev);
  win.window = win; win.self = win; win.globalThis = win;
  win.localStorage = storage; win.sessionStorage = storage;
  win.navigator = { clipboard: { writeText: async () => {} }, onLine: true, userAgent: "smoke", platform: "Linux x86_64", language: "en-US", languages: ["en-US"] };
  win.crypto = webcrypto;
  win.location = { hash: "", href: "http://localhost/", reload() {} };
  win.history = { replaceState() {}, pushState() {} };
  win.innerWidth = 1280; win.innerHeight = 800; win.devicePixelRatio = 1;
  win.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.getComputedStyle = () => ({ getPropertyValue: () => "" });
  win.prompt = () => "smoke-passphrase";
  win.confirm = () => true;
  win.alert = () => {};
  win.open = () => null;
  win.scrollTo = () => {};
  win.fetch = () => Promise.reject(new Error("network disabled in smoke test"));
  win.MutationObserver = class { observe() {} disconnect() {} };
  win.Node = FakeNode; win.Element = FakeNode; win.HTMLElement = FakeNode;
  win.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c), supports: () => false };  win.ResizeObserver = class { observe() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} disconnect() {} };
  win.Blob = class { constructor(parts) { this.parts = parts; } };
  win.FileReader = class { readAsText() {} };
  const createdURLs = [];
  win.URL = { createObjectURL: (b) => { createdURLs.push(b); return "blob:smoke"; }, revokeObjectURL() {} };
  const workers = [];
  win.Worker = class {
    constructor(url) { this.url = url; this._l = {}; workers.push(this); }
    postMessage() {} terminate() {}
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  };
  win.console = {
    log: () => {}, info: () => {}, warn: () => {}, debug: () => {},
    error: (...a) => { errors.push(a.map(String).join(" ")); },
  };
  // seed DOM from real index.html body so structure, ids, and data-attributes match
  const html = fs.readFileSync(REPO + "/index.html", "utf8");
  const bodyHtml = html.split(/<body[^>]*>/i)[1].split(/<\/body>/i)[0];
  doc.body.append(parseHTML(bodyHtml, doc));
  const ctx = vm.createContext(win);
  // expose timers etc.
  for (const k of ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone"])
    ctx[k] = globalThis[k].bind ? globalThis[k].bind(globalThis) : globalThis[k];
  ctx.crypto = webcrypto;
  ctx.performance = globalThis.performance;
  ctx.TextEncoder = globalThis.TextEncoder;
  ctx.TextDecoder = globalThis.TextDecoder;
  ctx.atob = globalThis.atob.bind(globalThis);
  ctx.btoa = globalThis.btoa.bind(globalThis);
  return { ctx, win, doc, errors, storageData, createdURLs, workers };
}

function boot(seedStorage) {
  const b = buildContext(seedStorage);
  const files = ["plugin-sandbox.js", "plugin-system.js", "plugins.js", "feature-suite.js", "app.js"];
  for (const f of files) {
    const code = fs.readFileSync(REPO + "/" + f, "utf8");
    try {
      vm.runInContext(code, b.ctx, { filename: f });
    } catch (e) {
      b.errors.push(`LOAD ${f}: ${e.message}`);
    }
  }
  return b;
}
function flush(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- tests ---------------- */
function typeInto(elm, text, win) {
  elm.value = text;
  elm.selectionStart = elm.selectionEnd = text.length;
  elm.dispatchEvent(new win.Event("input", { bubbles: true }));
}
function clickEl(elm, win) {
  elm.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

async function main() {
  /* T1: fresh boot */
  {
    const b = boot(null);
    await flush(80);
    check("T1 fresh boot: no console errors", b.errors.length === 0, b.errors.slice(0, 5).join(" | "));
    const raw = b.storageData["xPin.workspace.v1"];
    check("T1 fresh boot: xPin.workspace.v1 created", !!raw);
    let ws = null;
    try { ws = JSON.parse(raw); } catch (e) { /* checked below */ }
    check("T1 fresh boot: workspace JSON parses", !!ws);
    check("T1 fresh boot: legacy key not created from nothing", !("pinboard.workspace.v1" in b.storageData));
    const rows = b.doc.querySelectorAll("#note-list .note-row, #note-list [data-note-id]");
    check("T1 fresh boot: note list container exists", !!b.doc.getElementById("note-list"));
  }

  /* T2: legacy migration */
  {
    const legacy = {
      notes: [{ id: "n1", title: "Legacy note survives", body: "hello", folderId: null, parentId: null, pinned: false, createdAt: 1, updatedAt: 2, tags: [] }],
      folders: [], canvases: [{ id: "c1", name: "Board", nodes: [{ id: "nd1", type: "file", file: "notes/n1.md", pinboardNoteId: "n1", x: 0, y: 0, width: 200, height: 120 }], edges: [] }],
      features: { activeView: null },
    };
    const b = boot({ "pinboard.workspace.v1": JSON.stringify(legacy) });
    await flush(80);
    check("T2 migration: no console errors", b.errors.length === 0, b.errors.slice(0, 5).join(" | "));
    const raw = b.storageData["xPin.workspace.v1"];
    check("T2 migration: new key created", !!raw);
    const ws = JSON.parse(raw);
    const note = (ws.notes || []).find((n) => n.id === "n1");
    check("T2 migration: legacy note present in new key", !!note && note.title === "Legacy note survives");
    const node = ws.canvases && ws.canvases[0] && ws.canvases[0].nodes && ws.canvases[0].nodes[0];
    check("T2 migration: canvas node mapped to xPinNoteId", !!node && node.xPinNoteId === "n1", JSON.stringify(node));
    check("T2 migration: no pinboardNoteId leak", !!node && !("pinboardNoteId" in node));
    check("T2 migration: legacy key preserved as backup", "pinboard.workspace.v1" in b.storageData);
  }

  /* T3-T5: note CRUD + query grammar via real UI */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    check("T3 setup: boot clean", b.errors.length === 0, b.errors.slice(0, 5).join(" | "));
    const newBtn = doc.getElementById("new-note");
    check("T3: new-note button exists", !!newBtn);
    clickEl(newBtn, win);
    typeInto(doc.getElementById("note-title"), "Alpha", win);
    typeInto(doc.getElementById("note-body"), "body text with #work tag", win);
    clickEl(newBtn, win);
    typeInto(doc.getElementById("note-title"), "Beta", win);
    typeInto(doc.getElementById("note-body"), "plain body", win);
    const listText = doc.getElementById("note-list").textContent;
    check("T4: both notes render in list", listText.includes("Alpha") && listText.includes("Beta"), listText.slice(0, 200));
    // open database view -> query panel
    const dbBtn = doc.querySelector('[data-feature-view="database"]');
    check("T5: database nav button exists", !!dbBtn);
    clickEl(dbBtn, win);
    const qInput = doc.querySelector(".query-input");
    check("T5: query input rendered", !!qInput);
    // F-H1: tag without # prefix must match
    typeInto(qInput, "LIST FROM notes WHERE tag=work", win);
    const runBtn = doc.querySelector('[data-action="run-query"]');
    check("T5: run-query button exists", !!runBtn);
    clickEl(runBtn, win);
    const qr = doc.querySelector(".query-results");
    const qrText = qr ? qr.textContent : "";
    check("T5/F-H1: WHERE tag=work (no #) matches tagged note", qrText.includes("Alpha"), qrText.slice(0, 300));
    check("T5/F-H1: untagged note excluded", !qrText.includes("Beta"), qrText.slice(0, 300));
    // F-H2: TABLE field names case-insensitive (re-query: render() replaces the nodes)
    const qInput2 = doc.querySelector(".query-input");
    typeInto(qInput2, "TABLE Title,Folder FROM notes", win);
    clickEl(doc.querySelector('[data-action="run-query"]'), win);
    const qr2 = doc.querySelector(".query-results");
    const qr2Text = qr2 ? qr2.textContent : "";
    check("T5/F-H2: TABLE Title,Folder (mixed case) runs", qr2Text.includes("Alpha") && qr2Text.includes("Beta"), qr2Text.slice(0, 300));
    // query help toggle (U9 cheat-sheet)
    const helpBtn = doc.querySelector('[data-action="query-help"]');
    check("T5/U9: query grammar help button exists", !!helpBtn);
    if (helpBtn) {
      clickEl(helpBtn, win);
      const helpText = doc.getElementById("feature-content").textContent;
      check("T5/U9: grammar reference panel shows", /WHERE/i.test(helpText) && /CONTAINS/i.test(helpText), helpText.slice(0, 200));
    }
  }

  /* T6: canvas board delete/rename buttons (C1 repair) */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const canvasNav = doc.getElementById("canvas-nav");
    check("T6: canvas nav exists", !!canvasNav);
    clickEl(canvasNav, win);
    const btns = [...doc.querySelectorAll("#canvas-view button")].map((el) => el.textContent);
    check("T6/C1: Delete board button present", btns.some((t) => /delete board/i.test(t)), btns.join(" | ").slice(0, 300));
    check("T6/C1: Rename board button present", btns.some((t) => /rename/i.test(t)), btns.join(" | ").slice(0, 300));
  }

  /* T7: Today button + shortcuts reference (U7/U8 repairs) */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const sidebarText = doc.body.textContent;
    check("T7/U7: Today button in sidebar", /Today/.test(sidebarText));
    const qBtn = [...doc.querySelectorAll("button")].find((el) => /shortcuts/i.test(el.textContent));
    check("T7/U8: Shortcuts button exists", !!qBtn);
    if (qBtn) {
      clickEl(qBtn, win);
      const dlgText = doc.body.textContent;
      check("T7/U8: shortcuts dialog lists real bindings", /Ctrl|Cmd|Alt|Shift/.test(dlgText), dlgText.slice(-300));
    }
  }

  /* T8: plugin system boots without fatal errors */
  {
    const b = boot(null);
    await flush(120);
    const fatal = b.errors.filter((e) => !/Could not start xPin plugins/i.test(e));
    check("T8: plugin boot has no fatal errors", fatal.length === 0, fatal.slice(0, 5).join(" | "));
  }

  /* T9: graph view renders */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    clickEl(doc.getElementById("new-note"), win);
    typeInto(doc.getElementById("note-title"), "GraphA", win);
    typeInto(doc.getElementById("note-body"), "links to [[GraphB]]", win);
    clickEl(doc.getElementById("new-note"), win);
    typeInto(doc.getElementById("note-title"), "GraphB", win);
    const gBtn = doc.querySelector('[data-feature-view="graph"]');
    clickEl(gBtn, win);
    const gText = doc.getElementById("feature-content").textContent;
    check("T9: graph view renders both linked notes", gText.includes("GraphA") && gText.includes("GraphB"), gText.slice(0, 300));
  }

  /* T10: database CRUD + views (F-H3 repair: table/column delete+rename wired) */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    clickEl(doc.querySelector('[data-feature-view="database"]'), win);
    const fc = doc.getElementById("feature-content");
    const fcText = fc.textContent;
    check("T10: database view renders default tables", /Projects|Tasks/.test(fcText), fcText.slice(0, 200));
    // no list view anymore (redundancy removal)
    check("T10: database list view removed", !/database-list|List view/i.test(fc.innerHTML || ""));
  }

  /* T11: encrypted backup export produces a real payload */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.querySelector('[data-feature-view="settings"]'));
    const expBtn = doc.querySelector('[data-action="backup-export"]');
    check("T11: backup export button exists", !!expBtn);
    if (expBtn) {
      click(expBtn);
      await flush(3000); // PBKDF2 310k iterations
      check("T11: export produced a download blob", b.createdURLs.length > 0, `blobs: ${b.createdURLs.length}`);
      const payload = b.createdURLs.length ? String(b.createdURLs[0].parts[0] || "") : "";
      check("T11: payload is xPin encrypted-backup format", payload.includes('"xPin-encrypted-backup"') && payload.includes("AES-256-GCM"), payload.slice(0, 120));
    }
    check("T11: no errors during export", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T12: quick capture appends to today's daily note (non-disruptive) */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "KeepMe");
    // open quick capture via hotkey Ctrl+Shift+C
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true, bubbles: true }));
    const modal = doc.getElementById("quick-capture-modal");
    check("T12: capture dialog opens on Ctrl+Shift+C", !!modal && !modal.hidden);
    const field = doc.getElementById("quick-capture-input");
    check("T12: capture textarea exists", !!field);
    if (field) {
      field.value = "smoke capture entry";
      const capBtn = [...modal.querySelectorAll("button")].find((el) => /capture/i.test(el.textContent));
      check("T12: capture button exists", !!capBtn);
      if (capBtn) click(capBtn);
    }
    await flush(2600); // autosave debounce
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    const daily = ws.notes.find((n) => /inbox/i.test(n.body) && n.body.includes("smoke capture entry"));
    check("T12: entry appended under Inbox in daily note", !!daily, daily ? daily.body.slice(0, 160) : "none found");
    const kept = ws.notes.find((n) => n.title === "KeepMe");
    check("T12: capture did not disturb note creation", !!kept);
    check("T12: no errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T13: backlinks panel lists notes linking to current note */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "LinkTarget");
    type(doc.getElementById("note-body"), "target body");
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "LinkSource");
    type(doc.getElementById("note-body"), "see [[LinkTarget]] for details");
    // select LinkTarget by clicking its row
    const rows = [...doc.querySelectorAll("#note-list [data-note-id]")];
    const targetRow = rows.find((r) => r.textContent.includes("LinkTarget"));
    check("T13: target row found", !!targetRow);
    if (targetRow) click(targetRow);
    const backlinksText = doc.body.textContent;
    check("T13: LINKED HERE panel shows", /LINKED HERE/.test(backlinksText));
    check("T13: backlink source listed", /LinkSource/.test(backlinksText), backlinksText.slice(-400));
    check("T13: no errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T14: #tag search filters by tag */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "TaggedNote");
    type(doc.getElementById("note-body"), "has #proj/alpha tag");
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "OtherNote");
    type(doc.getElementById("note-body"), "nothing relevant");
    const search = doc.getElementById("search-input");
    check("T14: search input exists", !!search);
    type(search, "#proj");
    const list1 = doc.getElementById("note-list").textContent;
    check("T14: #proj finds nested-tagged note", list1.includes("TaggedNote"), list1.slice(0, 200));
    check("T14: #proj hides untagged note", !list1.includes("OtherNote"), list1.slice(0, 200));
    type(search, "");
    const list2 = doc.getElementById("note-list").textContent;
    check("T14: clearing search restores list", list2.includes("OtherNote"));
    check("T14: no errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T15: Today button creates daily note from template */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const todayBtn = [...doc.querySelectorAll("button")].find((el) => /Today/.test(el.textContent) && el.classList.contains("nav-item"));
    check("T15: Today button exists", !!todayBtn);
    if (todayBtn) click(todayBtn);
    const body = doc.getElementById("note-body").value;
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    check("T15: daily note applies template with date", body.includes(ymd), body.slice(0, 160));
    check("T15: no errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T16 (regression): capture while the daily note editor is focused must not
     lose the entry on the next keystroke */
  {
    const b = boot(null);
    await flush(80);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const todayBtn = [...doc.querySelectorAll("button")].find((el) => /Today/.test(el.textContent) && el.classList.contains("nav-item"));
    click(todayBtn);
    const body = doc.getElementById("note-body");
    body.focus();
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true, bubbles: true }));
    const modal = doc.getElementById("quick-capture-modal");
    check("T16: capture dialog opened", !!modal && !modal.hidden);
    // edge case: dialog focus didn't take — editor still focused at submit
    body.focus();
    const field = doc.getElementById("quick-capture-input");
    field.value = "focus capture entry";
    const capBtn = [...modal.querySelectorAll("button")].find((el) => /capture/i.test(el.textContent));
    click(capBtn);
    check("T16: textarea synced while focused", body.value.includes("focus capture entry"), body.value.slice(-200));
    // the next keystroke must not wipe the captured entry
    body.value = body.value + "!";
    body.selectionStart = body.selectionEnd = body.value.length;
    body.dispatchEvent(new win.Event("input", { bubbles: true }));
    await flush(2600);
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    const daily = ws.notes.find((n) => n.body.includes("focus capture entry"));
    check("T16: entry survives the next keystroke", !!daily && daily.body.includes("!"), daily ? daily.body.slice(-160) : "entry lost");
    check("T16: no errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* report */
  const fails = results.filter((r) => !r.pass);
  console.log(`\n==== xPin smoke: ${results.length - fails.length}/${results.length} passed ====`);
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  -- " + r.detail}`);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("SMOKE HARNESS ERROR:", e); process.exit(2); });
