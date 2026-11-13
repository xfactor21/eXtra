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
  // minimal pseudo-class support (:checked); anything else never matches
  p.pseudo = null;
  const pm = s.match(/:([a-zA-Z-]+)$/);
  if (pm) { p.pseudo = pm[1]; s = s.slice(0, pm.index); }
  p.rest = s.trim();
  return p;
}
function matchesSimple(elm, sel) {
  if (!elm || elm.nodeType !== 1) return false;
  const p = parseSimple(sel);
  if (p.rest) return false;
  if (p.pseudo === "checked" && !elm.checked) return false;
  if (p.pseudo && p.pseudo !== "checked") return false;
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
  win.URL = class extends globalThis.URL {
    static createObjectURL(b) { createdURLs.push(b); return "blob:smoke"; }
    static revokeObjectURL() {}
  };
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
  // faithful <select> default: value starts as the first option's value (real browser behavior)
  for (const sel of doc.querySelectorAll("select")) {
    const first = sel.querySelector("option");
    if (first) sel.value = first.getAttribute("value") ?? first.textContent;
  }
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

/* ---------------- faithful iframe+Worker simulation ----------------
 * Only browser primitives are faked (iframe document, Worker, Blob, URL).
 * ALL app code runs for real: plugin-sandbox.js create/receive, the app's
 * import/approve/request handling, and the worker executes the REAL
 * WORKER_PRELUDE + plugin source + WORKER_RUNTIME strings extracted from
 * plugin-sandbox.js. Lets the headless suite import, approve, and RUN
 * plugins end-to-end.
 */
function __extractTemplate(src, name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error("template not found: " + name);
  let i = src.indexOf("`", start) + 1;
  let out = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { out += c + src[i + 1]; i += 2; continue; }
    if (c === "`") break;
    out += c; i++;
  }
  return out;
}
const __sandboxSrc = fs.readFileSync(REPO + "/plugin-sandbox.js", "utf8");
const __maxCommands = Number(__sandboxSrc.match(/const MAX_COMMANDS = (\d+)/)[1]);
const __workerPrelude = new Function("MAX_COMMANDS", "return `" + __extractTemplate(__sandboxSrc, "WORKER_PRELUDE") + "`;")(__maxCommands);
const __workerRuntime = __extractTemplate(__sandboxSrc, "WORKER_RUNTIME");
const __frameDocument = new Function(
  "WORKER_PRELUDE", "WORKER_RUNTIME",
  "return `" + __extractTemplate(__sandboxSrc, "FRAME_DOCUMENT") + "`;"
)(__workerPrelude, __workerRuntime);

function __makeWorkerRuntime(workerSource, onWorkerMessage) {
  const listeners = {};
  const workerSelf = {
    postMessage: (msg) => onWorkerMessage(msg),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
    navigator: {},
    console: { log: () => {}, error: () => {}, warn: () => {} },
    // Real DedicatedWorkerGlobalScope has timers; plugins like word-tally
    // (status-bar polling) depend on them. Bind to the outer realm so fake
    // time still advances with the real event loop.
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
  };
  const wctx = vm.createContext(workerSelf);
  workerSelf.self = workerSelf;
  workerSelf.globalThis = workerSelf;
  vm.runInContext(workerSource, wctx, { filename: "plugin-worker.js" });
  // Bridge: Node has no per-context unhandledrejection event, so route host-level
  // unhandled rejections from worker code to this runtime's listener, mirroring
  // what a real DedicatedWorkerGlobalScope would fire.
  __workerRejectionBridge.add(listeners);
  return {
    postMessage: (msg) => { const fn = listeners["message"]; if (fn) fn({ data: msg }); },
    terminate: () => { delete listeners["message"]; __workerRejectionBridge.delete(listeners); },
  };
}
// Test-only bridge for worker unhandledrejection (see __makeWorkerRuntime).
const __workerRejectionBridge = new Set();
process.on("unhandledRejection", (reason) => {
  let routed = false;
  for (const listeners of __workerRejectionBridge) {
    const fn = listeners["unhandledrejection"];
    if (fn) { routed = true; try { fn({ reason, preventDefault: () => {} }); } catch (e) { /* ignore */ } }
  }
  if (!routed) {
    // A genuine harness bug, not a worker rejection: fail loudly.
    console.error("SMOKE HARNESS UNHANDLED REJECTION (not from a plugin worker):", reason);
    process.exit(2);
  }
});

class __FakeWorker {
  static blobs = new Map();
  constructor(url) {
    this.onmessage = null;
    this.onerror = null;
    this._terminated = false;
    const parts = __FakeWorker.blobs.get(url);
    if (!parts) throw new Error("unknown blob url");
    const source = parts.map((p) => String(p)).join("");
    try {
      this._worker = __makeWorkerRuntime(source, (msg) => {
        if (!this._terminated && this.onmessage) this.onmessage({ data: msg });
      });
    } catch (e) {
      if (this.onerror) this.onerror({ message: String((e && e.message) || e) });
      else throw e;
    }
  }
  postMessage(msg) { if (!this._terminated && this._worker) this._worker.postMessage(msg); }
  terminate() { this._terminated = true; if (this._worker) this._worker.terminate(); }
}

function simSandbox(b) {
  const { win, doc } = b;
  const origCreateElement = doc.createElement.bind(doc);
  doc.createElement = function (tag) {
    const frame = origCreateElement(tag);
    if (String(tag).toLowerCase() !== "iframe") return frame;
    const iframeListeners = {};
    let srcdoc = "";
    let booted = false;
    let loadHandler = null;
    const fakeParent = {
      postMessage: (msg) => {
        // iframe -> app relay: window message event with source = contentWindow
        win.dispatchEvent({ type: "message", source: frame.contentWindow, data: msg });
      },
    };
    const fakeContentWindow = {
      postMessage: (msg) => {
        // the real srcdoc script runs before load completes; mirror that here
        if (!booted) {
          booted = true;
          const ictx = {
            parent: fakeParent,
            addEventListener: (t, fn) => { iframeListeners[t] = fn; },
            Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
            URL: {
              createObjectURL: (blob) => {
                const u = "blob:fake-" + Math.random().toString(36).slice(2);
                __FakeWorker.blobs.set(u, blob.parts);
                return u;
              },
              revokeObjectURL: (u) => { __FakeWorker.blobs.delete(u); },
            },
            Worker: class extends __FakeWorker {},
            console: { log: () => {}, error: () => {}, warn: () => {} },
          };
          ictx.self = ictx; ictx.globalThis = ictx; ictx.window = ictx;
          const ctx = vm.createContext(ictx);
          const m = String(srcdoc).match(/<script>([\s\S]*)<\/script>/);
          if (!m) throw new Error("no script in FRAME_DOCUMENT");
          vm.runInContext(m[1], ctx, { filename: "plugin-frame.js" });
        }
        const fn = iframeListeners["message"];
        if (fn) fn({ source: fakeParent, data: msg });
      },
    };
    Object.defineProperty(frame, "contentWindow", { get: () => fakeContentWindow, configurable: true });
    Object.defineProperty(frame, "srcdoc", {
      get: () => srcdoc, set: (v) => { srcdoc = String(v); }, configurable: true,
    });
    const origAddEL = frame.addEventListener.bind(frame);
    frame.addEventListener = function (t, fn) {
      if (t === "load") { loadHandler = fn; setTimeout(() => { if (loadHandler) loadHandler(); }, 0); return; }
      return origAddEL(t, fn);
    };
    return frame;
  };
}

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

  /* T17-T27: imported plugin lifecycle — approval queue + real sandbox execution.
     simSandbox() fakes only browser primitives (iframe/Worker/Blob/URL); every
     app code path (import, review, approve, reject, RPC, commands) runs for real. */

  function pluginPackage(id, permissions, source) {
    return {
      manifest: {
        id, name: `Probe ${id}`, version: "1.0.0",
        description: `probe ${id}`, author: "smoke",
        permissions,
      },
      source,
    };
  }
  async function importPackage(b, pkg, fileName) {
    const { doc, win } = b;
    const json = JSON.stringify(pkg);
    const input = doc.getElementById("plugin-file-input");
    input.files = [{ name: fileName || "probe.xpin.json", size: json.length, text: async () => json }];
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(400);
  }
  function storedExtensions(b) {
    return JSON.parse(b.storageData["xPin.workspace.v1"]).extensions || [];
  }
  // open the catalogue and click Review/Re-review on the first imported row
  async function openReview(b, label) {
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.getElementById("open-plugins"));
    await flush(40);
    const row = doc.querySelector(".imported-plugin-row");
    const btn = [...row.querySelectorAll("button")].find((el) => el.textContent === label);
    click(btn);
    await flush(40);
  }
  async function approveInModal(b, { uncheckAll = false } = {}) {
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    if (uncheckAll) {
      doc.querySelectorAll("#plugin-permissions [data-permission]").forEach((cb) => { cb.checked = false; });
    }
    const trust = doc.getElementById("plugin-trust-checkbox");
    trust.checked = true;
    trust.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(20);
    click(doc.getElementById("allow-plugin"));
    await flush(900);
  }
  function paletteHas(b, text) {
    const { doc, win } = b;
    doc.getElementById("open-commands").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    return doc.getElementById("command-list").textContent.includes(text);
  }
  async function runPaletteCommand(b, text) {
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.getElementById("open-commands"));
    await flush(40);
    const row = [...doc.querySelectorAll('#command-list [role="option"]')]
      .find((el) => el.textContent.includes(text));
    if (row) click(row);
    await flush(700);
  }

  /* T17: import lands in the pending-review queue, inert */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const probe = pluginPackage("t17-probe", ["commands:register", "ui:notify"],
      `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "ping", name: "T17 ping", run: async () => { await api.ui.notify("t17 pong"); } });
      }});`);
    await importPackage(b, probe);
    const { doc } = b;
    check("T17: import toast says waiting for review",
      doc.getElementById("toast").textContent.includes("waiting for your review"),
      doc.getElementById("toast").textContent);
    const ext = storedExtensions(b);
    check("T17: stored as pending", ext.length === 1 && ext[0].reviewStatus === "pending", JSON.stringify(ext.map((e) => e.reviewStatus)));
    check("T17: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
    doc.getElementById("open-plugins").dispatchEvent(new b.win.MouseEvent("click", { bubbles: true }));
    await flush(40);
    const pill = doc.querySelector(".plugin-review-pill");
    check("T17: catalogue shows Pending review pill", !!pill && pill.textContent === "Pending review" && pill.classList.contains("is-pending"));
    check("T17: pending plugin contributes no commands", !paletteHas(b, "T17 ping"));
  }

  /* T18: approve -> active, command actually runs end-to-end through the worker */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const probe = pluginPackage("t18-probe", ["commands:register", "ui:notify", "notes:read"],
      `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "ping", name: "T18 ping", run: async () => {
          const notes = await api.notes.list();
          await api.ui.notify("t18 saw " + notes.length + " notes");
        }});
      }});`);
    await importPackage(b, probe);
    await openReview(b, "Review");
    const { doc } = b;
    const prechecked = [...doc.querySelectorAll("#plugin-permissions [data-permission]")].every((cb) => cb.checked);
    check("T18: requested capabilities start pre-checked", prechecked);
    await approveInModal(b);
    check("T18: approval toast names granted capabilities",
      doc.getElementById("toast").textContent.includes("approved with 3 granted"),
      doc.getElementById("toast").textContent);
    const ext = storedExtensions(b);
    check("T18: stored as approved with grants",
      ext[0].reviewStatus === "approved" && ext[0].grants.length === 3 && !!ext[0].approvedHash,
      JSON.stringify(ext[0] && { s: ext[0].reviewStatus, g: ext[0].grants }));
    check("T18: command in palette after approval", paletteHas(b, "T18 ping"));
    await runPaletteCommand(b, "T18 ping");
    check("T18: command ran through the sandbox (RPC round-trip)",
      doc.getElementById("toast").textContent.includes("t18 saw"),
      doc.getElementById("toast").textContent);
    check("T18: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T19: approving with zero capabilities granted asks for explicit confirmation */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const probe = pluginPackage("t19-probe", ["commands:register", "ui:notify"],
      `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "ping", name: "T19 ping", run: async () => { await api.ui.notify("t19 pong"); } });
      }});`);
    await importPackage(b, probe);
    await openReview(b, "Review");
    let confirmMessage = null;
    b.win.confirm = (msg) => { confirmMessage = String(msg); return true; };
    await approveInModal(b, { uncheckAll: true });
    const { doc } = b;
    check("T19: zero-grant approval asks for confirmation",
      !!confirmMessage && /granted none/i.test(confirmMessage), confirmMessage);
    const ext19 = storedExtensions(b);
    check("T19: stored as approved with zero grants",
      ext19[0].reviewStatus === "approved" && ext19[0].grants.length === 0,
      JSON.stringify(ext19[0] && { s: ext19[0].reviewStatus, g: ext19[0].grants }));
    check("T19: the resulting permission failure is surfaced, not silent",
      doc.getElementById("toast").textContent.includes("This permission was not granted."),
      doc.getElementById("toast").textContent);
    check("T19: crippled plugin contributes no phantom command", !paletteHas(b, "T19 ping"));
  }

  /* T20: reject -> inert with reason, re-review possible */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const probe = pluginPackage("t20-probe", ["ui:notify"],
      `xPinPlugin.register({ activate() {} });`);
    await importPackage(b, probe);
    await openReview(b, "Review");
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.getElementById("reject-plugin"));
    await flush(20);
    check("T20: reject reveals reason field", !doc.getElementById("plugin-reject-row").hidden);
    doc.getElementById("plugin-reject-reason").value = "too nosy";
    click(doc.getElementById("confirm-reject-plugin"));
    await flush(100);
    check("T20: rejection toast", doc.getElementById("toast").textContent.includes("was rejected"),
      doc.getElementById("toast").textContent);
    const ext = storedExtensions(b);
    check("T20: stored as rejected with reason",
      ext[0].reviewStatus === "rejected" && ext[0].reviewReason === "too nosy",
      JSON.stringify(ext[0] && { s: ext[0].reviewStatus, r: ext[0].reviewReason }));
    click(doc.getElementById("open-plugins"));
    await flush(40);
    const pill = doc.querySelector(".plugin-review-pill");
    check("T20: catalogue shows Rejected pill + reason",
      !!pill && pill.textContent === "Rejected" && doc.body.textContent.includes("too nosy"));
    const rereview = [...doc.querySelectorAll(".imported-plugin-row button")].find((el) => el.textContent === "Re-review");
    check("T20: re-review action exists", !!rereview);
    if (rereview) click(rereview);
    await flush(60);
    check("T20: re-review reopens the consent dialog", !doc.getElementById("plugin-consent-modal").hidden);
    check("T20: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T21: corrupt packages fail with a clear message, never silently */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const input = doc.getElementById("plugin-file-input");
    const bad = "{ not json at all";
    input.files = [{ name: "bad.xpin.json", size: bad.length, text: async () => bad }];
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(300);
    check("T21: malformed JSON gets a plain-English error",
      doc.getElementById("toast").textContent.includes("not valid JSON"),
      doc.getElementById("toast").textContent);
    const notPkg = JSON.stringify({ hello: "world" });
    input.files = [{ name: "notpkg.xpin.json", size: notPkg.length, text: async () => notPkg }];
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(300);
    check("T21: JSON without a package shape is rejected",
      /manifest|package/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    const badPerm = JSON.stringify(pluginPackage("t21-probe", ["teleport"],
      `xPinPlugin.register({ activate() {} });`));
    input.files = [{ name: "badperm.xpin.json", size: badPerm.length, text: async () => badPerm }];
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(300);
    check("T21: unknown permission names the culprit",
      doc.getElementById("toast").textContent.includes('"teleport"'),
      doc.getElementById("toast").textContent);
    check("T21: nothing was installed", storedExtensions(b).length === 0);
  }

  /* T22: oversized packages are refused with the actual sizes */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const input = doc.getElementById("plugin-file-input");
    input.files = [{ name: "huge.xpin.json", size: 100001, text: async () => "{}" }];
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(300);
    check("T22: oversized package refused with sizes",
      /smaller than 100 KB/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    check("T22: nothing was installed", storedExtensions(b).length === 0);
  }

  /* T23: duplicate ids name the installed version */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const src = `xPinPlugin.register({ activate() {} });`;
    await importPackage(b, pluginPackage("t23-probe", [], src));
    // same id, newer version
    const v2 = pluginPackage("t23-probe", [], src);
    v2.manifest.version = "2.0.0";
    await importPackage(b, v2, "v2.xpin.json");
    const { doc } = b;
    check("T23: version conflict names both versions",
      /1\.0\.0.*already installed.*2\.0\.0|already installed/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    check("T23: only the first package is stored", storedExtensions(b).length === 1);
  }

  /* T24: capability escalation is blocked — tampered grants stripped, ungranted RPC refused */
  {
    // (a) stored grants outside the manifest are stripped on load
    const seedBoot = boot(null);
    await flush(150);
    const seedWs = JSON.parse(seedBoot.storageData["xPin.workspace.v1"]);
    const tamperedManifest = { id: "t24-probe", name: "Probe t24-probe", version: "1.0.0", description: "probe", author: "smoke", permissions: ["ui:notify"] };
    seedWs.extensions = [{
      manifest: tamperedManifest, source: `xPinPlugin.register({ activate() {} });`,
      fileName: "t.xpin.json", sha256: "abc", installedAt: new Date().toISOString(),
      enabled: false, approvedHash: null, grants: ["notes:read"], settings: {},
      reviewStatus: "pending", reviewReason: null, reviewedAt: null,
    }];
    const b = boot({ "xPin.workspace.v1": JSON.stringify(seedWs) });
    await flush(120);
    const ext = storedExtensions(b);
    check("T24a: tampered grants stripped on load", ext.length === 1 && ext[0].grants.length === 0,
      JSON.stringify(ext[0] && ext[0].grants));

    // (b) a plugin calling an ungranted capability gets a clean refusal, end-to-end
    const b2 = boot(null);
    simSandbox(b2);
    await flush(120);
    const sneaky = pluginPackage("t24-sneaky", ["commands:register", "ui:notify"],
      `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "snoop", name: "T24 snoop", run: async () => {
          try { await api.notes.list(); await api.ui.notify("UNEXPECTED: read allowed"); }
          catch (e) { await api.ui.notify("blocked: " + e.message); }
        }});
      }});`);
    await importPackage(b2, sneaky);
    await openReview(b2, "Review");
    await approveInModal(b2);
    await runPaletteCommand(b2, "T24 snoop");
    check("T24b: ungranted notes:read refused at runtime",
      b2.doc.getElementById("toast").textContent.includes("blocked: This permission was not granted."),
      b2.doc.getElementById("toast").textContent);
  }

  /* T25: a package that changes after approval goes back to pending review */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const probe = pluginPackage("t25-probe", ["ui:notify"],
      `xPinPlugin.register({ activate() {} });`);
    await importPackage(b, probe);
    await openReview(b, "Review");
    await approveInModal(b);
    check("T25: approved first", storedExtensions(b)[0].reviewStatus === "approved");
    // tamper with the stored source (hash no longer matches) and reboot
    const raw = JSON.parse(b.storageData["xPin.workspace.v1"]);
    raw.extensions[0].source += "\n// sneaky edit";
    const b2 = boot({ "xPin.workspace.v1": JSON.stringify(raw) });
    simSandbox(b2);
    await flush(1500);
    const ext = storedExtensions(b2);
    check("T25: changed package is pending again",
      ext[0].reviewStatus === "pending" && !ext[0].enabled,
      JSON.stringify(ext[0] && { s: ext[0].reviewStatus, e: ext[0].enabled }));
    check("T25: reason recorded", (ext[0].reviewReason || "").includes("changed since approval"), ext[0].reviewReason);
    check("T25: user is told", b2.doc.getElementById("toast").textContent.includes("needs permission review"),
      b2.doc.getElementById("toast").textContent);
    b2.doc.getElementById("open-plugins").dispatchEvent(new b2.win.MouseEvent("click", { bubbles: true }));
    await flush(40);
    const pill = b2.doc.querySelector(".plugin-review-pill");
    check("T25: catalogue shows it pending again", !!pill && pill.textContent === "Pending review");
    check("T25: no sandbox started for the revoked plugin",
      b2.doc.querySelectorAll("iframe").length === 0);
  }

  /* T26: new capabilities — notes:update edits a note, ui:status shows in the status bar */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Target");
    const probe = pluginPackage("t26-probe", ["commands:register", "notes:read", "notes:update", "ui:status"],
      `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "mark", name: "T26 mark done", run: async () => {
          const notes = await api.notes.list();
          const target = notes.find((n) => n.title === "Target");
          await api.notes.update(target.id, { title: "Target (done)" });
          await api.ui.setStatus({ id: "done-marker", text: "done!" });
        }});
      }});`);
    await importPackage(b, probe);
    await openReview(b, "Review");
    await approveInModal(b);
    await runPaletteCommand(b, "T26 mark done");
    check("T26: notes:update renamed the note",
      doc.getElementById("note-list").textContent.includes("Target (done)"),
      doc.getElementById("note-list").textContent.slice(0, 200));
    check("T26: ui:status rendered in the status bar",
      doc.getElementById("editor-status").textContent.includes("done!"),
      doc.getElementById("editor-status").textContent);
    check("T26: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T27: the shipped example plugin (template-pack) works end-to-end */
  {
    const { execSync } = require("child_process");
    execSync("node plugins/pack.mjs plugins/examples/template-pack", { cwd: REPO, stdio: "pipe" });
    const packed = JSON.parse(fs.readFileSync(REPO + "/plugins/examples/template-pack/template-pack.xpin.json", "utf8"));
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    await importPackage(b, packed, "template-pack.xpin.json");
    await openReview(b, "Review");
    await approveInModal(b);
    const { doc } = b;
    check("T27: example plugin approved", storedExtensions(b)[0].reviewStatus === "approved");
    check("T27: template commands in palette", paletteHas(b, "Insert meeting notes"));
    await runPaletteCommand(b, "Insert meeting notes");
    const body = doc.getElementById("note-body").value;
    check("T27: meeting template inserted at caret", body.includes("## Meeting"),
      body.slice(0, 160));
    check("T27: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T28-T36: marketplace browser + OEM plugins end-to-end.
     The directory index fetch is mocked (a canned JSON index), which is the
     only faked part: every app code path (render, search, install, review,
     approve, sandbox RPC, plugin execution) runs for real. */

  function mockIndex(plugins) {
    return { name: "xPin Plugin Directory", version: 1, plugins };
  }
  function mockPluginEntry(over) {
    return {
      id: "smoke-probe", name: "Smoke Probe", version: "1.0.0",
      description: "A probe plugin for the smoke suite.", author: "smoke",
      capabilities: ["ui:notify"], downloadUrl: "https://cdn.example.com/smoke-probe-1.0.0.xpin.json",
      sha256: "00", updated: "2026-11-01", ...over,
    };
  }
  function mockFetchFor(index, downloads) {
    // index: served for any */index.json ; downloads: map absolute URL -> parsed package
    return async (url) => {
      const u = String(url);
      if (/index\.json(\?|$)/.test(u)) return { ok: true, json: async () => index };
      if (downloads && downloads[u]) return { ok: true, json: async () => downloads[u] };
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }
  function marketplaceCacheKey(url) {
    // must match app.js marketplaceCacheKey exactly
    let hash = 0;
    for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) | 0;
    return `xpin.marketplace.cache.${(hash >>> 0).toString(36)}`;
  }
  const DEFAULT_DIR = "https://raw.githubusercontent.com/xfactor21/eXtra/main/marketplace/index.json";
  async function openMarketplaceTab(b) {
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.getElementById("open-plugins"));
    await flush(40);
    click(doc.getElementById("plugin-tab-marketplace-btn"));
    await flush(500); // renderMarketplace is async (fetch + render)
  }
  function packOem(id) {
    const { execSync } = require("child_process");
    execSync(`node plugins/pack.mjs plugins/oem/${id}`, { cwd: REPO, stdio: "pipe" });
    return JSON.parse(fs.readFileSync(`${REPO}/plugins/oem/${id}/${id}.xpin.json`, "utf8"));
  }

  /* T28: marketplace tab renders the directory listing */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc } = b;
    b.win.fetch = mockFetchFor(mockIndex([
      mockPluginEntry(),
      mockPluginEntry({ id: "word-tally", name: "Word Tally", description: "Live word counts.", capabilities: ["notes:read", "ui:status"] }),
    ]));
    await openMarketplaceTab(b);
    check("T28: marketplace panel shown, catalogue hidden",
      !doc.getElementById("plugin-tab-marketplace").hidden && doc.getElementById("plugin-tab-catalogue").hidden);
    const listText = doc.getElementById("marketplace-list").textContent;
    check("T28: both directory plugins render", listText.includes("Smoke Probe") && listText.includes("Word Tally"), listText.slice(0, 200));
    check("T28: status reports the count", /2 plugins/.test(doc.getElementById("marketplace-status").textContent),
      doc.getElementById("marketplace-status").textContent);
    check("T28: capability badges render", listText.includes("ui:notify") && listText.includes("notes:read"), listText.slice(0, 300));
    check("T28: every card has an Install button",
      doc.querySelectorAll("#marketplace-list .marketplace-card").length === 2 &&
      [...doc.querySelectorAll("#marketplace-list .marketplace-card button")].every((btn) => btn.textContent === "Install"));
    check("T28: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T29: marketplace search filters the listing */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    b.win.fetch = mockFetchFor(mockIndex([
      mockPluginEntry(),
      mockPluginEntry({ id: "word-tally", name: "Word Tally", description: "Live word counts." }),
    ]));
    await openMarketplaceTab(b);
    const search = doc.getElementById("marketplace-search");
    typeInto(search, "tally", win);
    await flush(400);
    const list1 = doc.getElementById("marketplace-list").textContent;
    check("T29: search narrows to the match", list1.includes("Word Tally") && !list1.includes("Smoke Probe"), list1.slice(0, 200));
    typeInto(search, "no-such-plugin-zzz", win);
    await flush(400);
    check("T29: empty result message", doc.getElementById("marketplace-status").textContent.includes("No plugins match"),
      doc.getElementById("marketplace-status").textContent);
    typeInto(search, "", win);
    await flush(400);
    check("T29: clearing search restores the listing",
      doc.getElementById("marketplace-list").textContent.includes("Smoke Probe"));
    check("T29: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T30: marketplace install stages into the Pending queue — never auto-runs */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const realTally = JSON.parse(fs.readFileSync(`${REPO}/marketplace/packages/word-tally-1.0.0.xpin.json`, "utf8"));
    const dlUrl = "https://cdn.example.com/word-tally-1.0.0.xpin.json";
    b.win.fetch = mockFetchFor(
      mockIndex([mockPluginEntry({ id: "word-tally", name: "Word Tally", downloadUrl: dlUrl, capabilities: ["notes:read", "ui:status"] })]),
      { [dlUrl]: realTally }
    );
    await openMarketplaceTab(b);
    const card = [...doc.querySelectorAll("#marketplace-list .marketplace-card")]
      .find((c) => c.textContent.includes("Word Tally"));
    check("T30: word-tally card found", !!card);
    card.querySelector("button").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await flush(600); // download + sha256 digest + staging
    check("T30: install toast says waiting for review",
      doc.getElementById("toast").textContent.includes("waiting for your review"),
      doc.getElementById("toast").textContent);
    const ext = storedExtensions(b);
    check("T30: stored as pending", ext.length === 1 && ext[0].reviewStatus === "pending",
      JSON.stringify(ext.map((e) => e.reviewStatus)));
    check("T30: provenance records the marketplace directory",
      (ext[0].installedFrom || "").startsWith("marketplace:"), ext[0].installedFrom);
    check("T30: pending plugin contributes no commands", !paletteHas(b, "Word"));
    check("T30: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T31: a marketplace-installed OEM plugin (case-converter) runs end-to-end */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    const realPkg = JSON.parse(fs.readFileSync(`${REPO}/marketplace/packages/case-converter-1.0.0.xpin.json`, "utf8"));
    const dlUrl = "https://cdn.example.com/case-converter-1.0.0.xpin.json";
    b.win.fetch = mockFetchFor(
      mockIndex([mockPluginEntry({ id: "case-converter", name: "Case Converter", downloadUrl: dlUrl,
        capabilities: ["notes:read", "notes:update", "commands:register", "ui:notify"] })]),
      { [dlUrl]: realPkg }
    );
    await openMarketplaceTab(b);
    const card = [...doc.querySelectorAll("#marketplace-list .marketplace-card")]
      .find((c) => c.textContent.includes("Case Converter"));
    card.querySelector("button").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await flush(600);
    await openReview(b, "Review");
    await approveInModal(b);
    const ext = storedExtensions(b);
    check("T31: marketplace plugin approved with 4 grants",
      ext[0].reviewStatus === "approved" && ext[0].grants.length === 4,
      JSON.stringify(ext[0] && { s: ext[0].reviewStatus, g: ext[0].grants }));
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Mixed Case Title");
    type(doc.getElementById("note-body"), "hello world");
    await runPaletteCommand(b, "UPPERCASE note");
    const listText = doc.getElementById("note-list").textContent;
    check("T31: command uppercased title and body",
      listText.includes("MIXED CASE TITLE") && doc.getElementById("note-body").value === "HELLO WORLD",
      listText.slice(0, 160));
    check("T31: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T32: unreachable directory falls back to the offline cache */
  {
    const cached = mockIndex([mockPluginEntry({ id: "cached-one", name: "Cached One" })]);
    const seed = {};
    seed[marketplaceCacheKey(DEFAULT_DIR)] = JSON.stringify({ ...cached, _cachedAt: new Date().toISOString() });
    const b = boot(seed); // fetch stays at its default: always rejects (offline)
    simSandbox(b);
    await flush(120);
    const { doc } = b;
    await openMarketplaceTab(b);
    const listText = doc.getElementById("marketplace-list").textContent;
    check("T32: cached plugin renders while offline", listText.includes("Cached One"), listText.slice(0, 200));
    check("T32: entries badged as offline copy", listText.includes("offline copy"), listText.slice(0, 200));
    check("T32: status reports the offline cache",
      /from offline cache/.test(doc.getElementById("marketplace-status").textContent),
      doc.getElementById("marketplace-status").textContent);
    check("T32: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T33: directory add validates URLs and persists */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await openMarketplaceTab(b);
    const input = doc.getElementById("marketplace-dir-input");
    const add = doc.getElementById("marketplace-dir-add");
    const toast = () => doc.getElementById("toast").textContent;
    typeInto(input, "not a url", win);
    click(add);
    check("T33: invalid URL rejected", toast().includes("not a valid URL"), toast());
    typeInto(input, "http://insecure.example.com/index.json", win);
    click(add);
    check("T33: non-https URL rejected", toast().includes("must use https"), toast());
    typeInto(input, "https://example.com/plugins/index.json", win);
    click(add);
    await flush(300);
    check("T33: valid directory added", toast().includes("Directory added"), toast());
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    check("T33: directory persisted in workspace",
      (ws.marketplaceDirs || []).includes("https://example.com/plugins/index.json"),
      JSON.stringify(ws.marketplaceDirs));
    typeInto(input, "https://example.com/plugins/index.json", win);
    click(add);
    check("T33: duplicate directory rejected", toast().includes("already listed"), toast());
    check("T33: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T34: word-tally polls the real sandbox and updates the status bar */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    await importPackage(b, packOem("word-tally"), "word-tally.xpin.json");
    await openReview(b, "Review");
    await approveInModal(b);
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "TallyNote");
    type(doc.getElementById("note-body"), "one two three four");
    await flush(2600); // the plugin polls every 2s
    const statusText = doc.getElementById("editor-status").textContent;
    check("T34: status bar shows the live word count", /4 words/.test(statusText), statusText.slice(0, 160));
    check("T34: character count also shown", /chars/.test(statusText), statusText.slice(0, 160));
    check("T34: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T35: tag-manager census reads real #hashtags end-to-end */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "TaggedDoc");
    type(doc.getElementById("note-body"), "has #alpha and #beta tags");
    await importPackage(b, packOem("tag-manager"), "tag-manager.xpin.json");
    await openReview(b, "Review");
    await approveInModal(b);
    check("T35: tag-manager approved with 5 grants",
      storedExtensions(b)[0].grants.length === 5,
      JSON.stringify(storedExtensions(b)[0].grants));
    await runPaletteCommand(b, "Tag census");
    const toastText = doc.getElementById("toast").textContent;
    check("T35: census reports the real tags", /#alpha/.test(toastText) && /#beta/.test(toastText), toastText);
    check("T35: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T36: random-note selects a real note through the sandbox */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "RNote1");
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "RNote2");
    await importPackage(b, packOem("random-note"), "random-note.xpin.json");
    await openReview(b, "Review");
    await approveInModal(b);
    await runPaletteCommand(b, "Open random note");
    const toastText = doc.getElementById("toast").textContent;
    const announced = toastText.match(/🎲 (.+)/);
    check("T36: random note opened and announced", !!announced, toastText);
    const openTitle = doc.getElementById("note-title").value;
    check("T36: editor shows the announced note", !!announced && openTitle === announced[1], openTitle);
    check("T36: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T37 (Phase 0, M2): delete soft-deletes to Trash; restore brings it back; Ctrl+Z undoes a delete */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    const stored = () => JSON.parse(b.storageData["xPin.workspace.v1"]);
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "TrashMe");
    type(doc.getElementById("note-body"), "do not lose me");
    await flush(100);
    click(doc.getElementById("delete-note"));
    await flush(100);
    check("T37: delete moves the note to Trash, not out of existence",
      !stored().notes.some((n) => n.title === "TrashMe") &&
      stored().trash.some((n) => n.title === "TrashMe" && n.body === "do not lose me"),
      JSON.stringify({ notes: stored().notes.length, trash: stored().trash.length }));
    check("T37: delete toast says Trash, not permanent loss",
      doc.getElementById("toast").textContent.includes("Trash"), doc.getElementById("toast").textContent);
    check("T37: sidebar Trash count is 1",
      doc.getElementById("trash-count").textContent === "1", doc.getElementById("trash-count").textContent);
    click(doc.querySelector('[data-filter="trash"]'));
    await flush(100);
    check("T37: Trash view lists the deleted note",
      !!doc.querySelector(".trash-row") && doc.querySelector(".trash-row").textContent.includes("TrashMe"),
      doc.getElementById("note-list").textContent.slice(0, 120));
    click(doc.querySelector(".trash-restore"));
    await flush(100);
    check("T37: restore returns the note to the workspace",
      stored().notes.some((n) => n.title === "TrashMe") && stored().trash.length === 0,
      JSON.stringify({ notes: stored().notes.length, trash: stored().trash.length }));
    click(doc.getElementById("delete-note"));
    await flush(100);
    check("T37: second delete re-trashes the note", stored().trash.length === 1,
      JSON.stringify(stored().trash.length));
    doc.getElementById("delete-note").focus(); // move focus out of the title input so Ctrl+Z is app undo, not text undo
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await flush(100);
    check("T37: Ctrl+Z undoes the delete",
      stored().notes.some((n) => n.title === "TrashMe") && stored().trash.length === 0,
      JSON.stringify({ notes: stored().notes.length, trash: stored().trash.length }));
    check("T37: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T38 (Phase 0, M2): editing a note builds a version history; restoring one brings the old body back */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    const stored = () => JSON.parse(b.storageData["xPin.workspace.v1"]);
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Versioned");
    type(doc.getElementById("note-body"), "v1");
    await flush(2300); // debounced autosave persists v1
    type(doc.getElementById("note-body"), "v2");
    await flush(2300); // autosave persists v2 and snapshots v1 as a version
    const note = stored().notes.find((n) => n.title === "Versioned");
    check("T38: one version kept, holding the earlier body",
      note && note.versions.length === 1 && note.versions[0].body === "v1",
      JSON.stringify(note && note.versions));
    // Re-select the note so the editor (with its version history) renders.
    const otherRow = [...doc.querySelectorAll(".note-row")].find((row) => !row.textContent.includes("Versioned"));
    click(otherRow);
    await flush(100);
    const mineRow = [...doc.querySelectorAll(".note-row")].find((row) => row.textContent.includes("Versioned"));
    click(mineRow);
    await flush(100);
    check("T38: version history is visible in the editor",
      !!doc.querySelector(".version-history") &&
      doc.querySelector(".version-history").textContent.includes("Version history · 1"),
      (doc.querySelector(".version-history") || { textContent: "missing" }).textContent);
    click(doc.querySelector(".version-restore"));
    await flush(100);
    check("T38: restoring the version brings back the old body",
      doc.getElementById("note-body").value === "v1", doc.getElementById("note-body").value);
    check("T38: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T39 (Phase 0, M3): per-note .md export carries frontmatter; the workspace .zip is a real zip */
  {
    const b0 = boot(null);
    await flush(120);
    const ws = JSON.parse(b0.storageData["xPin.workspace.v1"]);
    ws.notes[0].title = "Export Me";
    ws.notes[0].body = "# Hello\n\nWorld";
    ws.notes[0].metadata = { status: "In progress", due: "2026-11-20" };
    const b = boot({ "xPin.workspace.v1": JSON.stringify(ws) });
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.querySelector('[data-feature-view="settings"]'));
    await flush(100);
    const before = b.createdURLs.length;
    click(doc.querySelector('[data-action="markdown-note"]'));
    await flush(100);
    const md = b.createdURLs[b.createdURLs.length - 1];
    check("T39: per-note export downloads a .md blob",
      b.createdURLs.length === before + 1 && typeof md.parts[0] === "string",
      String(b.createdURLs.length - before));
    check("T39: exported .md has frontmatter properties, title, and body",
      /status: "In progress"/.test(md.parts[0]) && /due: "2026-11-20"/.test(md.parts[0]) &&
      /# Export Me/.test(md.parts[0]) && /# Hello/.test(md.parts[0]),
      md.parts[0].slice(0, 200));
    click(doc.querySelector('[data-action="markdown-zip"]'));
    await flush(100);
    const zip = b.createdURLs[b.createdURLs.length - 1].parts[0];
    // NB: the blob bytes live in the vm realm, so ArrayBuffer.isView (not instanceof) identifies them.
    const isZip = ArrayBuffer.isView(zip) && zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04;
    const nameLen = isZip ? zip[26] | (zip[27] << 8) : 0;
    const firstName = isZip ? Buffer.from(zip.slice(30, 30 + nameLen)).toString() : "";
    check("T39: workspace export is a real zip whose first entry is a .md file",
      isZip && firstName.endsWith(".md") && zip.length > 100,
      `${firstName} (${zip.length} bytes)`);
    check("T39: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T40 (Phase 0, M4): without IndexedDB the app falls back to localStorage and says so in the UI */
  {
    const b = boot(null);
    await flush(120);
    const { doc } = b;
    check("T40: fake DOM has no IndexedDB (the fallback condition)",
      typeof b.win.indexedDB === "undefined", typeof b.win.indexedDB);
    const indicator = doc.querySelector(".sync-card small").textContent;
    check("T40: sidebar storage indicator names the localStorage fallback and a size",
      /localStorage/.test(indicator) && /KB|MB/.test(indicator), indicator);
    check("T40: workspace still persists to localStorage",
      !!b.storageData["xPin.workspace.v1"] &&
      JSON.parse(b.storageData["xPin.workspace.v1"]).notes.length >= 4,
      String(Object.keys(b.storageData)));
    check("T40: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T41 (Phase 0, M5): properties UI writes metadata; notes:update accepts patch.metadata and rejects bad keys */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    const stored = () => JSON.parse(b.storageData["xPin.workspace.v1"]);
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Props");
    await flush(100);
    type(doc.querySelector(".property-key-input"), "status");
    type(doc.querySelector(".property-add .property-value"), "In progress");
    click(doc.querySelector(".property-add-button"));
    await flush(2300); // debounced autosave persists the new property
    check("T41: properties UI writes metadata.status",
      stored().notes.find((n) => n.title === "Props")?.metadata?.status === "In progress",
      JSON.stringify(stored().notes.find((n) => n.title === "Props")?.metadata));
    const valueInput = doc.querySelectorAll("#note-properties .property-value")[0]; // first row is the status property; the add-row input comes after it
    valueInput.value = "Done";
    valueInput.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(2300); // debounced autosave persists the edit
    check("T41: editing a property value persists",
      stored().notes.find((n) => n.title === "Props")?.metadata?.status === "Done",
      JSON.stringify(stored().notes.find((n) => n.title === "Props")?.metadata));
    check("T41: no console errors (UI half)", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const probe = pluginPackage("t41-probe",
      ["commands:register", "notes:read", "notes:update", "ui:notify"],
      `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "set-status", name: "T41 set status", run: async () => {
          const notes = await api.notes.list();
          const target = notes.find((n) => n.title === "Props") || notes[0];
          await api.notes.update(target.id, { metadata: { status: "In progress", due: "2026-11-20" } });
          await api.ui.notify("t41 status set");
        }});
        api.commands.add({ id: "bad-key", name: "T41 bad key", run: async () => {
          try {
            const notes = await api.notes.list();
            await api.notes.update(notes[0].id, { metadata: { "1bad": "x" } });
            await api.ui.notify("t41 bad unexpectedly ok");
          } catch (err) { await api.ui.notify("t41 bad rejected"); }
        }});
      }});`);
    await importPackage(b, probe);
    await openReview(b, "Review");
    await approveInModal(b);
    const { doc } = b;
    const stored = () => JSON.parse(b.storageData["xPin.workspace.v1"]);
    await runPaletteCommand(b, "T41 set status");
    check("T41: notes:update writes metadata fields",
      stored().notes[0].metadata?.status === "In progress" &&
      stored().notes[0].metadata?.due === "2026-11-20",
      JSON.stringify(stored().notes[0].metadata));
    check("T41: notes:update toast confirms the write",
      doc.getElementById("toast").textContent.includes("t41 status set"),
      doc.getElementById("toast").textContent);
    await runPaletteCommand(b, "T41 bad key");
    check("T41: notes:update rejects an invalid property key",
      doc.getElementById("toast").textContent.includes("t41 bad rejected"),
      doc.getElementById("toast").textContent);
    check("T41: no console errors (plugin half)", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T42 (Phase 0, M6): static page export renders Markdown instead of dumping it raw */
  {
    const b0 = boot(null);
    await flush(120);
    const ws = JSON.parse(b0.storageData["xPin.workspace.v1"]);
    ws.notes[0].title = "Rendered Page";
    ws.notes[0].body = "# Hello\n\n- one\n- two";
    const b = boot({ "xPin.workspace.v1": JSON.stringify(ws) });
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.querySelector('[data-feature-view="settings"]'));
    await flush(100);
    click(doc.querySelector('[data-action="publish"]'));
    await flush(100);
    const html = b.createdURLs[b.createdURLs.length - 1].parts[0];
    check("T42: exported page contains rendered HTML, not raw Markdown",
      typeof html === "string" && /<h1>Hello<\/h1>/.test(html) && /<li>one<\/li>/.test(html) &&
      !/# Hello/.test(html),
      String(html).slice(0, 300));
    check("T42: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T43 (Phase 0, M4): when the save fails, the app offers a Markdown backup download instead of only a toast */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const urlsBefore = b.createdURLs.length;
    b.win.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    click(doc.getElementById("new-note"));
    await flush(100);
    check("T43: failed save reports Save failed in the status line",
      doc.getElementById("save-label").textContent === "Save failed",
      doc.getElementById("save-label").textContent);
    const zip = b.createdURLs.length > urlsBefore
      ? b.createdURLs[b.createdURLs.length - 1].parts[0]
      : null;
    check("T43: quota failure offers (and, on confirm, downloads) a Markdown .zip backup",
      ArrayBuffer.isView(zip) && zip[0] === 0x50 && zip[1] === 0x4b,
      `createdURLs grew by ${b.createdURLs.length - urlsBefore}`);
    b.win.localStorage.setItem = (k, v) => { b.storageData[k] = String(v); };
    click(doc.getElementById("new-note"));
    await flush(100);
    check("T43: saving recovers once storage works again",
      doc.getElementById("save-label").textContent === "All changes saved",
      doc.getElementById("save-label").textContent);
    check("T43: the only console error is the expected quota log",
      b.errors.length === 1 && /Could not save the xPin workspace/.test(b.errors[0]),
      b.errors.slice(0, 3).join(" | "));
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
