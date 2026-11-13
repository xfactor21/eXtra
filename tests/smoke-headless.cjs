/* xPin headless smoke test — boots the real app in a fake DOM (node:vm)
 * and exercises core workflows end-to-end. Run: node /tmp/xpin-smoke2.js
 * Exit 0 = all pass, 1 = failures (listed). Never fabricates: every check
 * runs the real code paths.
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { execSync } = require("child_process");

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
function splitSelectorParts(group) {
  // Split on whitespace, but not inside [...] or quoted attribute values
  const parts = [];
  let cur = "", depth = 0, quote = null;
  for (const ch of group.trim()) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) { parts.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}
function matchesSelector(elm, selector) {
  for (const group of selector.split(",")) {
    const parts = splitSelectorParts(group);
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
    if (this._doc && this._doc._notifyMutation) this._doc._notifyMutation(this);
    return nodes[0] ?? null;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    if (this._doc && this._doc._notifyMutation) this._doc._notifyMutation(this);
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
    if (this._doc && this._doc._notifyMutation) this._doc._notifyMutation(p);
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

function buildContext(seedStorage, opts) {
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
  win.location = { hash: (opts && opts.locationHash) || "", href: "http://localhost/", reload() {} };
  // Phase 1: test-only marketplace public-key override (lets the suite sign
  // mock indexes with its own keypair); the app never sets this itself.
  if (opts && opts.marketplacePublicKey) win.__xPinMarketplacePublicKey = opts.marketplacePublicKey;
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
  // Minimal functional MutationObserver (childList only): the app keeps its
  // settings sections in place with one, so the suite must deliver
  // notifications like a real browser (batched via microtask).
  const mutationObservers = [];
  let mutationFlushScheduled = false;
  doc._mutationObservers = mutationObservers;
  doc._notifyMutation = (target) => {
    const interested = mutationObservers.filter((o) => o.target === target && o.options && o.options.childList);
    if (!interested.length) return;
    if (mutationFlushScheduled) return;
    mutationFlushScheduled = true;
    queueMicrotask(() => {
      mutationFlushScheduled = false;
      for (const o of [...interested]) {
        try { o.cb([{ type: "childList", target }]); } catch { /* observer errors must not break the app */ }
      }
    });
  };
  win.MutationObserver = class {
    constructor(cb) { this._cb = cb; }
    observe(target, options) { mutationObservers.push({ target, cb: this._cb, options }); }
    disconnect() { for (let i = mutationObservers.length - 1; i >= 0; i--) if (mutationObservers[i].cb === this._cb) mutationObservers.splice(i, 1); }
    takeRecords() { return []; }
  };
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
  ctx.AbortController = globalThis.AbortController;
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

function boot(seedStorage, opts) {
  const b = buildContext(seedStorage, opts);
  const files = ["plugin-sandbox.js", "plugin-system.js", "plugins.js",
    "sync/sync.js", "sync/transports.js", "sync/credentials.js", "sync/publish.js",
    "phase2.js", "phase3.js", "feature-suite.js", "app.js"];
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

// fabriX boot: same as boot(), but the adapter scripts load before app.js
// (the order in index.html) so app.js can attach the domain at boot.
function bootFabrix(seedStorage) {
  const b = buildContext(seedStorage);
  const files = [
    "plugin-sandbox.js", "plugin-system.js", "plugins.js", "feature-suite.js",
    "integrations/fabrix/state.js", "integrations/fabrix/crypto.js",
    "integrations/fabrix/permissions.js", "integrations/fabrix/transport.js",
    "integrations/fabrix/mock-transport.js", "integrations/fabrix/domain.js",
    "integrations/fabrix/capabilities.js", "integrations/fabrix/adapter.js",
    "integrations/fabrix/settings.js", "app.js"
  ];
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

// Runs an expression inside the vm context and awaits it (adapter calls
// return promises). Rejections surface as errors with a .code property.
function fabrixEval(b, expr) {
  return vm.runInContext(expr, b.ctx);
}

// Seeded workspace for fabriX tests: two folders, three notes (one per
// folder + one unfiled), built from a real fresh boot so the shape is the
// app's own.
function fabrixSeed() {
  const seedBoot = bootFabrix(null);
  const ws = JSON.parse(seedBoot.storageData["xPin.workspace.v1"]);
  ws.folders = [
    { id: "folder-a", name: "Folder A" },
    { id: "folder-b", name: "Folder B" }
  ];
  const now = new Date().toISOString();
  ws.notes = [
    { id: "note-a", title: "Alpha note", body: "alpha body with #work tag", folderId: "folder-a", parentNoteId: null, pinned: false, createdAt: now, updatedAt: now, metadata: {} },
    { id: "note-b", title: "Beta note", body: "beta body with #home tag", folderId: "folder-b", parentNoteId: null, pinned: false, createdAt: now, updatedAt: now, metadata: {} },
    { id: "note-c", title: "Gamma note", body: "gamma body links [[Alpha note]]", folderId: null, parentNoteId: null, pinned: false, createdAt: now, updatedAt: now, metadata: {} }
  ];
  return { "xPin.workspace.v1": JSON.stringify(ws) };
}

// Enables the adapter and grants read+write in a booted context.
async function fabrixEnableAll(b) {
  await fabrixEval(b, `window.xPinFabrix.setEnabled(true)`);
  await fabrixEval(b, `window.xPinFabrix.grant("read")`);
  await fabrixEval(b, `window.xPinFabrix.grant("write")`);
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
      await flush(100);
      // Phase 3: the passphrase now comes from the app's own dialog, not
      // window.prompt — fill it and confirm like a user would.
      const passInput = doc.querySelector(".xpin-dialog-input");
      if (passInput) passInput.value = "smoke-passphrase";
      const done = doc.querySelector(".xpin-dialog .dialog-done");
      if (done) click(done);
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
     approve, sandbox RPC, plugin execution) runs for real.
     Phase 1: mock indexes are Ed25519-signed with a suite-local keypair
     (the app verifies signatures and fails closed on unsigned indexes). */
  const { generateKeyPairSync, sign: edSign, createPublicKey } = require("crypto");
  const MARKETPLACE_TEST_KEYS = generateKeyPairSync("ed25519");
  const MARKETPLACE_TEST_PUBLIC_B64 = MARKETPLACE_TEST_KEYS.publicKey
    .export({ type: "spki", format: "der" }).toString("base64");
  function signMockIndex(index) {
    const signature = edSign(null, Buffer.from(JSON.stringify(index), "utf8"),
      MARKETPLACE_TEST_KEYS.privateKey).toString("base64");
    return { ...index, signature, signatureKeyId: "xpin-marketplace-1" };
  }
  const bootSigned = (seed, opts) => boot(seed, { ...(opts || {}), marketplacePublicKey: MARKETPLACE_TEST_PUBLIC_B64 });

  function mockIndex(plugins) {
    return signMockIndex({ name: "xPin Plugin Directory", version: 1, plugins });
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
    const b = bootSigned(null);
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
    const b = bootSigned(null);
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
    const b = bootSigned(null);
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
    const b = bootSigned(null);
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
    const b = bootSigned(seed); // fetch stays at its default: always rejects (offline)
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
    const b = bootSigned(null);
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
    // Phase 2: boot lands on today's note, so select the seeded note first.
    const exportRow = [...doc.querySelectorAll("#note-list [data-note-id]")].find((r) => r.textContent.includes("Export Me"));
    check("T39: seeded note row found", !!exportRow);
    if (exportRow) click(exportRow);
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
    // Phase 2: boot lands on today's note, so select the seeded note first.
    const pageRow = [...doc.querySelectorAll("#note-list [data-note-id]")].find((r) => r.textContent.includes("Rendered Page"));
    check("T42: seeded note row found", !!pageRow);
    if (pageRow) click(pageRow);
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

  /* T44 (Phase 1): sync envelope round-trip, merge, conflict-to-history, idempotency, tombstone, bundle */
  {
    const b = boot(null);
    await flush(120);
    const S = b.win.xPinSync;
    const pass = "sync-passphrase-123";
    const salt = S.newSalt();
    const key = await S.deriveSyncKey(pass, salt);
    const deviceA = "xpin-aaaa";
    const deviceB = "xpin-bbbb";
    const base = { id: "note-sync-1", title: "Sync note", body: "hello", folderId: null, parentNoteId: null, pinned: false, metadata: {}, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z", versions: [], syncVersion: { lamport: 0, deviceId: "" } };
    const localA = { notes: [{ ...base }], trash: [] };
    const env1 = await S.makeEnvelope({ key, deviceId: deviceA, lamport: 1, note: localA.notes[0], op: "upsert" });
    check("T44: envelope carries version + op", env1.envelopeVersion === 1 && env1.op === "upsert" && env1.noteId === "note-sync-1");
    check("T44: envelope payload is ciphertext, not plaintext", !JSON.stringify(env1.payload).includes("hello"));
    const localB = { notes: [], trash: [] };
    const r1 = await S.applyEnvelopes([env1], localB, key, []);
    check("T44: envelope inserts the note on the other device",
      r1.results[0].outcome === "inserted" && localB.notes[0].body === "hello",
      JSON.stringify(r1.results));
    const r2 = await S.applyEnvelopes([env1], localB, key, r1.seen);
    check("T44: re-applying the same envelope is a no-op (idempotency)",
      r2.results[0].outcome === "duplicate" && localB.notes.length === 1,
      JSON.stringify(r2.results));
    localB.notes[0].body = "B wins";
    localB.notes[0].syncVersion = { lamport: 5, deviceId: deviceB };
    const envOld = await S.makeEnvelope({ key, deviceId: deviceA, lamport: 3, note: { ...base, body: "A older" }, op: "upsert" });
    const r3 = await S.applyEnvelopes([envOld], localB, key, r2.seen);
    check("T44: older envelope loses but is preserved in version history",
      r3.results[0].outcome === "ignored-newer" && localB.notes[0].body === "B wins" &&
      localB.notes[0].versions.some((v) => v.body === "A older"),
      JSON.stringify(r3.results));
    const envNew = await S.makeEnvelope({ key, deviceId: deviceA, lamport: 9, note: { ...base, body: "A newer" }, op: "upsert" });
    const r4 = await S.applyEnvelopes([envNew], localB, key, r3.seen);
    check("T44: newer envelope wins and the local version joins history",
      r4.results[0].outcome === "updated" && localB.notes[0].body === "A newer" &&
      localB.notes[0].versions.some((v) => v.body === "B wins"),
      JSON.stringify(r4.results));
    const envTomb = await S.makeEnvelope({ key, deviceId: deviceA, lamport: 10, note: localB.notes[0], op: "tombstone" });
    const r5 = await S.applyEnvelopes([envTomb], localB, key, r4.seen);
    check("T44: tombstone removes the note",
      r5.results[0].outcome === "tombstoned" && localB.notes.length === 0,
      JSON.stringify(r5.results));
    const bundle = S.exportBundle([env1], deviceA);
    const parsedBundle = S.importBundle(bundle);
    check("T44: bundle round-trips envelopes",
      parsedBundle.format === "xpin-sync-bundle" && parsedBundle.envelopes.length === 1 &&
      parsedBundle.envelopes[0].id === env1.id);
    const wrongKey = await S.deriveSyncKey("different-passphrase-123", salt);
    const r6 = await S.applyEnvelopes([env1], { notes: [], trash: [] }, wrongKey, []);
    check("T44: an envelope from another passphrase fails structured, not silent",
      r6.results[0].outcome === "error", JSON.stringify(r6.results));
    check("T44: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T45 (Phase 1): connector tier — validation, allowlisted fetch, credential encryption, sandbox stays offline */
  {
    const b = boot(null);
    await flush(120);
    const SB = b.win.xPinSandbox;
    let threw = "";
    try {
      SB.validatePackage({ manifest: { id: "bad-conn", name: "Bad", version: "1.0.0", description: "x", author: "t", permissions: ["network:fetch"] }, source: "xPinPlugin.register({ activate() {} });" });
    } catch (e) { threw = e.message; }
    check("T45: sandboxed plugin cannot declare network:fetch", /connector tier/.test(threw), threw);
    const conn = SB.validatePackage({ manifest: { id: "good-conn", name: "Good", version: "1.0.0", description: "x", author: "t", tier: "connector", networkOrigins: ["https://api.example.com"], permissions: ["network:fetch", "credentials:get"] }, source: "xPinPlugin.register({ activate() {} });" });
    check("T45: connector manifest validates with tier + origins",
      conn.manifest.tier === "connector" && conn.manifest.networkOrigins[0] === "https://api.example.com");
    const C = b.win.xPinCredentials;
    const saltB64 = b.win.xPinSync.bytesToBase64(b.win.xPinSync.newSalt());
    await C.unlock("credential-passphrase-123", saltB64, null);
    const env = await C.encryptSecret("api-key-123");
    check("T45: credential ciphertext differs from plaintext", !JSON.stringify(env).includes("api-key-123"));
    check("T45: credential decrypts back", (await C.decryptSecret(env)) === "api-key-123");
    check("T45: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    win.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => new TextEncoder().encode('{"hello":1}'),
    });
    const pkg = {
      manifest: {
        id: "t45-conn", name: "T45 conn", version: "1.0.0", description: "connector probe", author: "smoke",
        tier: "connector", networkOrigins: ["https://api.example.com"],
        permissions: ["commands:register", "network:fetch", "credentials:set", "credentials:get", "ui:notify"],
      },
      source: `xPinPlugin.register({ activate(api) {
        api.commands.add({ id: "fetch-ok", name: "T45 fetch ok", run: async () => { const r = await api.network.fetch("https://api.example.com/data"); await api.ui.notify("fetch:" + r.status + ":" + r.body); } });
        api.commands.add({ id: "fetch-evil", name: "T45 fetch evil", run: async () => { await api.network.fetch("https://evil.example.com/data"); } });
        api.commands.add({ id: "cred", name: "T45 cred", run: async () => { await api.credentials.set("token", "secret-xyz"); const v = await api.credentials.get("token"); await api.ui.notify("cred:" + v); } });
      }});`,
    };
    await importPackage(b, pkg);
    await openReview(b, "Review");
    await approveInModal(b);
    const ext = storedExtensions(b);
    check("T45: connector approved with its origin",
      ext[0].approvedOrigins.includes("https://api.example.com"),
      JSON.stringify(ext[0].approvedOrigins));
    const saltB64 = b.win.xPinSync.bytesToBase64(b.win.xPinSync.newSalt());
    await b.win.xPinCredentials.unlock("connector-passphrase-123", saltB64, null);
    await runPaletteCommand(b, "T45 fetch ok");
    check("T45: connector fetch to an allowed origin works",
      doc.getElementById("toast").textContent.includes('fetch:200:{"hello":1}'),
      doc.getElementById("toast").textContent);
    await runPaletteCommand(b, "T45 cred");
    check("T45: credential round-trip through the sandbox",
      doc.getElementById("toast").textContent.includes("cred:secret-xyz"),
      doc.getElementById("toast").textContent);
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    // The test plugin's own source code legitimately contains the literal
    // "secret-xyz" (it is the value the plugin passes to credentials:set),
    // so the leak scan excludes the installed-plugin records and checks
    // everything else — above all the credential store itself.
    const { extensions, ...wsWithoutPlugins } = ws;
    check("T45: secret never lands in the plaintext workspace blob",
      !JSON.stringify(wsWithoutPlugins).includes("secret-xyz") &&
      !JSON.stringify(ws.connectorCredentials).includes("secret-xyz"),
      "secret leaked into workspace JSON");
    await runPaletteCommand(b, "T45 fetch evil");
    await flush(300);
    check("T45: fetch to a non-allowlisted origin is rejected",
      doc.getElementById("toast").textContent.includes("not approved"),
      doc.getElementById("toast").textContent);
    check("T45: the only console error is the expected command failure",
      b.errors.length === 1 && /not approved/.test(b.errors[0]),
      b.errors.slice(0, 3).join(" | "));
  }

  /* T46 (Phase 1): new events fire from the real mutation sites */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    const seen = [];
    b.win.xPinDomain.on("folder:created", (d) => seen.push(`folder:created:${d.name}`));
    b.win.xPinDomain.on("database:created", (d) => seen.push(`database:created:${d.name}`));
    b.win.xPinDomain.on("template:created", (d) => seen.push(`template:created:${d.name}`));
    b.win.xPinDomain.on("tag:changed", (d) => seen.push(`tag:changed:${d.tags.join(",")}`));
    b.win.xPinDomain.on("settings:changed", (d) => seen.push(`settings:changed:${d.section}`));
    b.win.xPinDomain.on("save:completed", () => seen.push("save:completed"));
    b.win.xPinDomain.on("canvas:created", (d) => seen.push(`canvas:created:${d.name}`));
    // folder via the sidebar button (Phase 3: the name comes from the
    // app's own dialog — fill it and confirm like a user would)
    const confirmDialog = (value) => {
      const input = doc.querySelector(".xpin-dialog-input");
      if (input) input.value = value;
      const done = doc.querySelector(".xpin-dialog .dialog-done");
      if (done) click(done);
    };
    click(doc.getElementById("new-folder"));
    await flush(100);
    confirmDialog("smoke-passphrase");
    await flush(100);
    check("T46: folder:created fires", seen.some((s) => s === "folder:created:smoke-passphrase"), seen.join(" | "));
    // database via the Databases view (dialog names the table)
    click(doc.querySelector('[data-feature-view="database"]'));
    await flush(100);
    const addTable = [...doc.querySelectorAll("[data-action]")].find((el) => el.dataset.action === "add-table");
    click(addTable);
    await flush(100);
    confirmDialog("smoke-passphrase");
    await flush(100);
    check("T46: database:created fires", seen.some((s) => s === "database:created:smoke-passphrase"), seen.join(" | "));
    // template via the settings view form
    click(doc.querySelector('[data-feature-view="settings"]'));
    await flush(150);
    const nameInput = doc.querySelector(".template-name-input");
    const contentInput = doc.querySelector(".template-content-input");
    type(nameInput, "T46 template");
    type(contentInput, "hello");
    const addTemplate = [...doc.querySelectorAll("button")].find((el) => el.textContent === "Add template");
    click(addTemplate);
    await flush(100);
    check("T46: template:created fires", seen.some((s) => s === "template:created:T46 template"), seen.join(" | "));
    // settings:changed via the accent picker
    const accent = doc.querySelector('[data-action="accent"]');
    accent.value = "violet";
    accent.dispatchEvent(new win.Event("change", { bubbles: true }));
    await flush(100);
    check("T46: settings:changed fires", seen.some((s) => s === "settings:changed:appearance"), seen.join(" | "));
    // tag:changed by typing a hashtag into a note
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-body"), "has #t46tag here");
    await flush(100);
    check("T46: tag:changed fires", seen.some((s) => s.startsWith("tag:changed:") && s.includes("#t46tag")), seen.join(" | "));
    check("T46: save:completed fires on persist", seen.includes("save:completed"), seen.join(" | "));
    // canvas via the Canvas view (dialog names the board)
    click(doc.getElementById("canvas-nav"));
    await flush(100);
    click(doc.getElementById("new-canvas"));
    await flush(100);
    confirmDialog("smoke-passphrase");
    await flush(100);
    check("T46: canvas:created fires", seen.some((s) => s === "canvas:created:smoke-passphrase"), seen.join(" | "));
    check("T46: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T47 (Phase 1): relay transport — push/pull against a stubbed relay, and not-configured stays off */
  {
    const b = boot(null);
    await flush(120);
    const T = b.win.xPinSyncTransports;
    const S = b.win.xPinSync;
    let threw = "";
    try {
      await T.createHttpRelayTransport("").push([]);
    } catch (e) { threw = `${e.code}:${e.message}`; }
    check("T47: no relay URL means not configured, never a connection attempt",
      threw.startsWith("not_configured:"), threw);
    const freshState = b.win.xPinDomain.getState();
    check("T47: fresh workspace defaults to the xPin hosted relay",
      freshState.sync?.relayUrl === "https://xpin-sync-relay.vercel.app/api",
      String(freshState.sync?.relayUrl));
    const store = [];
    b.win.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/sync/push")) {
        const body = JSON.parse(opts.body);
        store.push(...body.envelopes);
        return { ok: true, json: async () => ({ ok: true, accepted: body.envelopes.length, serverLamport: 1 }) };
      }
      if (u.includes("/v1/sync/pull")) {
        const since = Number(new URL(u).searchParams.get("since") || "0");
        return { ok: true, json: async () => ({ envelopes: store.filter((e) => e.lamport > since), serverLamport: 1 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const relay = T.createHttpRelayTransport("http://127.0.0.1:8787");
    const key = await S.deriveSyncKey("relay-passphrase-123", S.newSalt());
    const note = { id: "note-relay-1", title: "Relay note", body: "via relay", folderId: null, parentNoteId: null, pinned: false, metadata: {}, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z", versions: [], syncVersion: { lamport: 0, deviceId: "" } };
    const env = await S.makeEnvelope({ key, deviceId: "xpin-relay", lamport: 1, note, op: "upsert" });
    const push = await relay.push([env]);
    check("T47: relay push accepted", push.ok === true && push.accepted === 1, JSON.stringify(push));
    const pulled = await relay.pull(0);
    check("T47: relay pull returns the envelope", pulled.length === 1 && pulled[0].id === env.id);
    const local = { notes: [], trash: [] };
    const applied = await S.applyEnvelopes(pulled, local, key, []);
    check("T47: pulled envelope merges", applied.results[0].outcome === "inserted" && local.notes[0].body === "via relay");
    check("T47: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T48 (Phase 1): capture token generate/revoke + xpin:// deep links */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.querySelector('[data-feature-view="settings"]'));
    await flush(150);
    const gen = doc.querySelector('[data-action="capture-generate-token"]');
    check("T48: capture token button exists in Sync settings", !!gen);
    click(gen);
    await flush(100);
    const tokenInput = doc.querySelector('#sync-section input[aria-label="Capture token (shown once)"]');
    check("T48: token generated and shown once",
      !!tokenInput && tokenInput.value.startsWith("xpin_cap_") && tokenInput.value.length > 20,
      tokenInput ? tokenInput.value.slice(0, 20) : "no token field");
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    check("T48: token persisted in sync state", ws.sync.captureToken === tokenInput.value);
    click(doc.querySelector('[data-action="capture-revoke-token"]'));
    await flush(100);
    const ws2 = JSON.parse(b.storageData["xPin.workspace.v1"]);
    check("T48: token revoked", ws2.sync.captureToken === null);
    check("T48: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }
  {
    // Deep link: boot with a capture hash → Inbox note created
    const b = boot(null, { locationHash: "#xpin/capture?text=hello%20deep&title=Deep%20capture&source=Browser" });
    await flush(120);
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    const inbox = ws.folders.find((f) => f.name === "Inbox");
    const note = ws.notes.find((n) => n.title === "Deep capture");
    check("T48: xpin://capture creates the Inbox folder", !!inbox);
    check("T48: captured note lands in Inbox with source + marker",
      !!note && note.folderId === inbox?.id && note.body.includes("hello deep") &&
      note.body.includes("Source: Browser") && note.metadata?.captured === "true",
      note ? JSON.stringify(note).slice(0, 200) : "no note");
    check("T48: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T49 (Phase 1): marketplace — unsigned index fails closed; update check offers re-review */
  {
    const b = bootSigned(null);
    simSandbox(b);
    await flush(120);
    const { doc } = b;
    b.win.fetch = mockFetchFor({ name: "xPin Plugin Directory", version: 1, plugins: [mockPluginEntry()] });
    await openMarketplaceTab(b);
    const listText = doc.getElementById("marketplace-list").textContent;
    const statusText = doc.getElementById("marketplace-status").textContent;
    check("T49: unsigned index lists nothing",
      !listText.includes("Smoke Probe"), listText.slice(0, 200));
    check("T49: status says unverified — installed plugins only",
      /unverified/i.test(statusText) && /installed plugins only/i.test(statusText), statusText);
    check("T49: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }
  {
    const b = bootSigned(null);
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
    card.querySelector("button").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await flush(600);
    check("T49: v1.0.0 installed (pending)", storedExtensions(b)[0].manifest.version === "1.0.0");
    // A newer index version appears, with a changelog line.
    const v11 = JSON.parse(JSON.stringify(realTally));
    v11.manifest.version = "1.1.0";
    const dl11 = "https://cdn.example.com/word-tally-1.1.0.xpin.json";
    b.win.fetch = mockFetchFor(
      mockIndex([mockPluginEntry({ id: "word-tally", name: "Word Tally", version: "1.1.0", downloadUrl: dl11, changelog: "Faster counting, fewer words missed." })]),
      { [dl11]: v11 }
    );
    await openMarketplaceTab(b);
    // Force a refresh: otherwise the cached v1.0.0 index is reused.
    doc.getElementById("marketplace-refresh").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await flush(600);
    const card2 = [...doc.querySelectorAll("#marketplace-list .marketplace-card")]
      .find((c) => c.textContent.includes("Word Tally"));
    const btn = card2.querySelector("button");
    check("T49: update available with the new version",
      btn.textContent.includes("Update available (v1.1.0)"), btn.textContent);
    check("T49: changelog line shown", card2.textContent.includes("Faster counting"), card2.textContent.slice(0, 300));
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await flush(700);
    const ext = storedExtensions(b);
    check("T49: update stages the new version as pending re-review",
      ext.length === 1 && ext[0].manifest.version === "1.1.0" && ext[0].reviewStatus === "pending",
      JSON.stringify(ext.map((e) => ({ v: e.manifest.version, s: e.reviewStatus }))));
    check("T49: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T50 (Phase 1): publish bundle — rendered HTML + manifest */
  {
    const b = boot(null);
    await flush(120);
    const P = b.win.xPinPublish;
    const bundle = P.buildPublishBundle(
      { id: "note-pub-1", title: "Pub Note", body: "# Hello\n\n- one" },
      (md) => `<h1>Hello</h1><ul><li>one</li></ul>`
    );
    check("T50: bundle HTML renders Markdown, not raw text",
      bundle.html.includes("<h1>Hello</h1>") && bundle.html.includes("<li>one</li>") && !bundle.html.includes("# Hello"));
    check("T50: manifest carries note id, title, publishedAt, xPin version",
      bundle.manifest.format === "xpin-publish-bundle" && bundle.manifest.noteId === "note-pub-1" &&
      bundle.manifest.title === "Pub Note" && typeof bundle.manifest.publishedAt === "string" &&
      bundle.manifest.xPinVersion === "1.0.0",
      JSON.stringify(bundle.manifest));
    check("T50: manifest is embedded in the page", bundle.html.includes("xpin-publish-manifest"));
    // End-to-end through the app: publish the open note with the real renderer.
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Pub Note");
    type(doc.getElementById("note-body"), "# Hello\n\n- one");
    await flush(100);
    const published = b.win.xPinDomain.publishCurrentNote();
    const html = b.createdURLs[b.createdURLs.length - 1].parts[0];
    check("T50: app publish downloads rendered HTML",
      !!published && typeof html === "string" && /<h1>Hello<\/h1>/.test(html) && /<li>one<\/li>/.test(html),
      String(html).slice(0, 200));
    check("T50: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T51 (Phase 1, audit G4): new state keys survive a save/load round-trip */
  {
    const b = boot(null);
    await flush(120);
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    ws.integrations = { fabrix: { enabled: true, mystery: "keep-me" }, unknownTop: "drop-me" };
    ws.sync.deviceId = "xpin-roundtrip";
    ws.sync.relayUrl = "http://127.0.0.1:8787";
    ws.connectorCredentials = { "some-plugin": { token: { iv: "aGVsbG8=", ciphertext: "d29ybGQ=" } } };
    const b2 = boot({ "xPin.workspace.v1": JSON.stringify(ws) });
    await flush(120);
    const ws2 = JSON.parse(b2.storageData["xPin.workspace.v1"]);
    check("T51: integrations.fabrix survives round-trip",
      ws2.integrations?.fabrix?.enabled === true, JSON.stringify(ws2.integrations));
    check("T51: unknown integrations sub-keys are dropped, not trusted",
      !("unknownTop" in (ws2.integrations ?? {})), JSON.stringify(ws2.integrations));
    check("T51: sync state survives round-trip",
      ws2.sync?.deviceId === "xpin-roundtrip" && ws2.sync?.relayUrl === "http://127.0.0.1:8787",
      JSON.stringify(ws2.sync));
    check("T51: connector credential envelopes survive round-trip",
      ws2.connectorCredentials?.["some-plugin"]?.token?.ciphertext === "d29ybGQ=",
      JSON.stringify(ws2.connectorCredentials));
    check("T51: no console errors", b2.errors.length === 0, b2.errors.slice(0, 3).join(" | "));
  }

  /* T52 (Phase 2): boot clean with phase2; daily note is the landing page */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    check("T52: phase2 module loaded", !!win.xPinPhase2, typeof win.xPinPhase2);
    const state = win.xPinDomain.getState();
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const daily = state.notes.find((n) => n.metadata?.dailyDate === key);
    check("T52: daily landing opened today's note", !!daily, `dailyDate=${key}, notes=${state.notes.map((n) => n.metadata?.dailyDate ?? n.title).join(",")}`);
    check("T52: daily landing is on by default", state.settings?.dailyLanding === true, JSON.stringify(state.settings));
    const stripDays = doc.querySelectorAll(".daily-strip-day");
    check("T52: week strip shows 7 days", stripDays.length === 7, `days=${stripDays.length}`);
    check("T52: phase2 nav buttons exist", !!doc.querySelector('[data-phase2-view="flashcards"]') && !!doc.querySelector('[data-phase2-view="readlater"]'));
    check("T52: attach button exists", !!doc.getElementById("attach-file"));
    check("T52: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T53 (Phase 2, Item 2): ranked search orders title matches first + snippets */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Shopping list");
    type(doc.getElementById("note-body"), "buy bananas and bread and milk");
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Banana bread");
    type(doc.getElementById("note-body"), "bake banana bread on Sunday");
    const search = doc.getElementById("search-input");
    type(search, "banana bread");
    const listText = doc.getElementById("note-list").textContent;
    const bananaPos = listText.indexOf("Banana bread");
    const shopPos = listText.indexOf("Shopping list");
    check("T53: title match ranks above body match", bananaPos >= 0 && shopPos >= 0 && bananaPos < shopPos, listText.slice(0, 300));
    const snippet = doc.getElementById("note-list").querySelector(".note-search-snippet");
    check("T53: snippet shown with highlighted match", !!snippet && snippet.textContent.toLocaleLowerCase().includes("banana") && !!snippet.querySelector("mark"), snippet ? snippet.textContent.slice(0, 120) : "no snippet");
    type(search, "");
    const list2 = doc.getElementById("note-list").textContent;
    check("T53: clearing search restores list", list2.includes("Shopping list") && list2.includes("Banana bread"));
    check("T53: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T54 (Phase 2, Item 1): attachment store round-trip + caps + sync rule */
  {
    const b = boot(null);
    await flush(120);
    const { win } = b;
    const P = win.xPinPhase2;
    const blob = await P.saveAttachmentBlob("att-smoke-1", { type: "image/png", size: 5 });
    const back = await P.getAttachmentBlob("att-smoke-1");
    check("T54: attachment blob round-trips (IDB/memory fallback)", !!back && back.size === 5, JSON.stringify(back));
    const missing = await P.getAttachmentBlob("att-nope");
    check("T54: missing attachment returns null", missing === null, String(missing));
    let overLimit = false;
    try { P.validateAttachmentFile({ name: "big.bin", size: 26 * 1024 * 1024 }); } catch { overLimit = true; }
    check("T54: >25 MB file rejected honestly", overLimit);
    const small = { id: "a1", noteId: "n1", name: "s.png", mime: "image/png", size: 100, createdAt: new Date().toISOString(), data: "aGVsbG8=", synced: true };
    const big = { id: "a2", noteId: "n1", name: "b.pdf", mime: "application/pdf", size: 2 * 1024 * 1024, createdAt: new Date().toISOString(), data: null, synced: false };
    check("T54: <=1 MB attachment is syncable", P.syncableAttachments([small, big]).length === 1, JSON.stringify(P.syncableAttachments([small, big])));
    check("T54: large attachment labelled device-only", /not synced/.test(P.attachmentSyncNote(big)), P.attachmentSyncNote(big));
    check("T54: attachment markdown syntax", P.attachmentMarkdown(small) === "![s.png](attachment:a1)" && P.attachmentMarkdown(big) === "[b.pdf](attachment:a2)");
    check("T54: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T55 (Phase 2, Item 1): attachment references render as markers in preview */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    const state = win.xPinDomain.getState();
    state.attachments.push({
      id: "att-preview-1", noteId: null, name: "pic.png", mime: "image/png", size: 10,
      createdAt: new Date().toISOString(), data: null, synced: false
    });
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "With attachment");
    type(doc.getElementById("note-body"), "See this: ![pic.png](attachment:att-preview-1)");
    const previewBtn = doc.getElementById("toggle-preview");
    click(previewBtn);
    await flush(50);
    const preview = doc.getElementById("markdown-preview");
    const ref = preview.querySelector('[data-attachment-id="att-preview-1"]');
    check("T55: attachment ref renders in preview", !!ref, preview.textContent.slice(0, 200));
    check("T55: missing blob stays honest (not a broken image)", /not on this device/.test(preview.textContent), preview.textContent.slice(0, 200));
    check("T55: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T56 (Phase 2, Item 5): importers parse the sample files correctly */
  {
    const P = boot(null).win.xPinPhase2;
    const enex = fs.readFileSync(REPO + "/tests/fixtures/sample.enex", "utf8");
    const parsedEnex = P.parseEnex(enex);
    check("T56: .enex imports 1 note, skips 1 empty", parsedEnex.notes.length === 1 && parsedEnex.skipped === 1, JSON.stringify(parsedEnex));
    check("T56: .enex keeps title/body/tags", parsedEnex.notes[0].title === "Trip ideas" && /coast in spring/.test(parsedEnex.notes[0].body) && /#travel/.test(parsedEnex.notes[0].body), parsedEnex.notes[0].body.slice(0, 200));
    const one = P.parseOneNoteHtml(fs.readFileSync(REPO + "/tests/fixtures/onenote-sample.html", "utf8"), "page.html");
    check("T56: OneNote HTML imports with list", one.notes.length === 1 && /Ship the beta/.test(one.notes[0].body), one.notes[0]?.body?.slice(0, 200) ?? "");
    const notion = P.parseNotionFiles([
      { path: "Project Atlas.html", content: fs.readFileSync(REPO + "/tests/fixtures/notion-parent.html", "utf8") },
      { path: "Project Atlas/Atlas notes.html", content: fs.readFileSync(REPO + "/tests/fixtures/notion-child.html", "utf8") },
      { path: "image.png", content: "binary" }
    ]);
    check("T56: Notion nested page keeps parent path", notion.notes.length === 2 && notion.notes[1].parentPath === "Project Atlas" && notion.skipped === 1, JSON.stringify(notion.notes.map((n) => n.parentPath)));
  }

  /* T57 (Phase 2, Item 4): voice memo note structure (transcription mocked) */
  {
    const P = boot(null).win.xPinPhase2;
    const withTranscript = P.buildVoiceMemoNote({ transcript: "Buy milk tomorrow\nCall Ana", audioAttachmentId: "att-vm-1", transcriptionStatus: "speech-api" });
    check("T57: voice memo title from first transcript line", withTranscript.title === "Buy milk tomorrow", withTranscript.title);
    check("T57: voice memo keeps transcript + audio link + provenance",
      /Buy milk tomorrow/.test(withTranscript.body) && /attachment:att-vm-1/.test(withTranscript.body) && withTranscript.metadata.voiceMemo === true && withTranscript.metadata.transcription === "speech-api",
      withTranscript.body.slice(0, 200));
    const noTranscript = P.buildVoiceMemoNote({ transcript: "", audioAttachmentId: "att-vm-2", transcriptionStatus: "unavailable" });
    check("T57: no transcript stays honest, audio kept", /unavailable/.test(noTranscript.body) && /attachment:att-vm-2/.test(noTranscript.body), noTranscript.body.slice(0, 200));
  }

  /* T58 (Phase 2, Item 6): read-later + highlight + digest flows */
  {
    const P = boot(null).win.xPinPhase2;
    const item = P.createReadLaterItem({ url: "https://example.com/article", title: "An article" });
    check("T58: read-later item saved with source + date", item.url === "https://example.com/article" && item.fetchStatus === "saved" && !!item.savedAt, JSON.stringify(item));
    let badUrl = false;
    try { P.createReadLaterItem({ url: "not-a-url" }); } catch { badUrl = true; }
    check("T58: read-later rejects non-http URLs", badUrl);
    const highlight = P.createHighlight({ quote: "The quick brown fox", sourceTitle: "An article", sourceUrl: "https://example.com/article" });
    check("T58: highlight stores quote + source", highlight.quote === "The quick brown fox" && highlight.sourceUrl === "https://example.com/article");
    const digest = P.dailyDigest([
      { ...highlight, id: "h-old", createdAt: "2026-11-01T00:00:00.000Z" },
      { ...highlight, id: "h-new", createdAt: "2026-11-13T00:00:00.000Z" },
      { ...highlight, id: "h-dismissed", createdAt: "2026-11-01T00:00:00.000Z", dismissedAt: "2026-11-12T00:00:00.000Z" }
    ], "2026-11-13", 3);
    check("T58: digest resurfaces older highlight, never dismissed ones",
      digest.some((h) => h.id === "h-old") && !digest.some((h) => h.id === "h-dismissed") && !digest.some((h) => h.id === "h-new"),
      JSON.stringify(digest.map((h) => h.id)));
  }

  /* T59 (Phase 2, Item 7): FSRS-4.5 known vectors */
  {
    const P = boot(null).win.xPinPhase2;
    check("T59: R(S,S)=0.9", Math.abs(P.fsrsRetrievability(3.173, 3.173) - 0.9) < 1e-9, String(P.fsrsRetrievability(3.173, 3.173)));
    check("T59: S0(Good)=3.173, D0(Good)=7.1949",
      P.fsrsInitialStability(3) === 3.173 && Math.abs(P.fsrsInitialDifficulty(3) - 7.1949) < 1e-9,
      `${P.fsrsInitialStability(3)} / ${P.fsrsInitialDifficulty(3)}`);
    const firstGood = P.fsrsReview({ stability: null, difficulty: null, reviews: 0, lapses: 0 }, 3);
    check("T59: first Good keeps S=3.173, interval ~3.17d",
      Math.abs(firstGood.stability - 3.173) < 1e-9 && Math.abs(firstGood.intervalDays - 3.17) < 0.05,
      JSON.stringify(firstGood));
    const mature = { stability: 3.173, difficulty: 7.1949, lastReviewedAt: new Date(Date.now() - 3.173 * 864e5).toISOString(), dueAt: new Date().toISOString(), reviews: 1, lapses: 0 };
    const good = P.fsrsReview(mature, 3);
    check("T59: mature Good S~8.47", Math.abs(good.stability - 8.467) < 0.05, JSON.stringify(good));
    const again = P.fsrsReview(mature, 1);
    check("T59: mature Again S~1.03, due in 10 min",
      Math.abs(again.stability - 1.0312) < 0.05 && Date.parse(again.dueAt) - Date.now() < 11 * 60 * 1000,
      JSON.stringify(again));
    const cards = P.extractCardsFromNotes([
      { id: "n1", body: "The capital of France is {{c1::Paris}}.\nQ: What is 2+2?\nA: 4" }
    ]);
    check("T59: cloze + Q/A cards extracted with source link",
      cards.length === 2 && cards.some((c) => c.kind === "cloze" && c.back === "Paris") && cards.every((c) => c.sourceNoteId === "n1"),
      JSON.stringify(cards.map((c) => [c.kind, c.front.slice(0, 30)])));
  }

  /* T60 (Phase 2, Item 7): APKG export is a valid zip + SQLite DB */
  {
    const P = boot(null).win.xPinPhase2;
    const cards = [
      { id: "c1", front: "Capital of France?", back: "Paris", sourceNoteId: null, kind: "qa", clozeIndex: 1, stability: null, difficulty: null, dueAt: null, lastReviewedAt: null, reviews: 0, lapses: 0 },
      { id: "c2", front: "The mitochondria is the [...] of the cell", back: "powerhouse", sourceNoteId: null, kind: "cloze", clozeIndex: 1, stability: null, difficulty: null, dueAt: null, lastReviewedAt: null, reviews: 0, lapses: 0 }
    ];
    const apkg = P.buildApkg(cards, "Smoke Deck");
    check("T60: .apkg is a zip (PK magic)", apkg.bytes[0] === 0x50 && apkg.bytes[1] === 0x4b && apkg.cardCount === 2, `bytes=${apkg.bytes.length}`);
    const entries = await P.unzipEntries(apkg.bytes);
    check("T60: zip holds collection.anki2 + media", entries.length === 2 && entries.some((e) => e.name === "collection.anki2") && entries.some((e) => e.name === "media"), entries.map((e) => e.name).join(","));
    const dbEntry = entries.find((e) => e.name === "collection.anki2");
    check("T60: SQLite magic present", new TextDecoder().decode(dbEntry.data.slice(0, 16)) === "SQLite format 3\0");
    const tables = P.readSqliteTables(dbEntry.data);
    check("T60: notes/cards tables exist with rows",
      tables.notes?.rows.length === 2 && tables.cards?.rows.length === 2 && tables.col?.rows.length === 1,
      Object.keys(tables).join(","));
    const imported = await P.importApkg(apkg.bytes);
    check("T60: APKG round-trips back into cards",
      imported.cards.length === 2 && imported.cards.some((c) => c.front === "Capital of France?" && c.back === "Paris"),
      JSON.stringify(imported.cards.map((c) => c.front)));
    check("T60: CSV export + JSON import interchange works",
      P.importCardsJson(JSON.stringify({ cards: [{ front: "Q", back: "A" }] })).cards.length === 1
      && P.exportCardsCsv(cards).includes("Capital of France?"));
  }

  /* T61 (Phase 2, Item 8): AI assists gated off without key; work with one */
  {
    const P = boot(null).win.xPinPhase2;
    check("T61: AI disabled -> unavailable", P.aiStatus({ ai: { enabled: false } }, true).available === false);
    check("T61: AI enabled without key -> unavailable", P.aiStatus({ ai: { enabled: true } }, false).available === false);
    check("T61: AI enabled + key -> available", P.aiStatus({ ai: { enabled: true } }, true).available === true);
    const note = { id: "n1", title: "Cats", body: "Cats sleep all day. Dogs bark at the mail." };
    const extractive = P.extractiveSummary(note);
    check("T61: no-key summary is labelled extractive", extractive.source === "extractive" && /Cats sleep/.test(extractive.text), JSON.stringify(extractive));
    const related = P.relatedNotesKeyword(note, [
      { id: "n2", title: "Dogs", body: "Dogs bark loudly" },
      { id: "n3", title: "Cars", body: "Engines and wheels" }
    ]);
    check("T61: related notes are keyword-labelled", related.length === 1 && related[0].note.id === "n2" && related[0].source === "keyword", JSON.stringify(related));
    const blended = P.relatedNotesBlended(note, [
      { id: "n2", title: "Dogs", body: "Dogs bark loudly" },
      { id: "n3", title: "Cars", body: "Engines and wheels" }
    ], new Map([["n3", [1, 0]], ["n2", [0, 1]]]), [1, 0]);
    check("T61: semantic blend surfaces vector-similar note",
      blended.some((r) => r.note.id === "n3" && r.source === "semantic") && P.cosineSimilarity([1, 0], [1, 0]) === 1 && P.cosineSimilarity([1, 0], [0, 1]) === 0,
      JSON.stringify(blended.map((r) => [r.note.id, r.source])));
    const b = boot(null);
    b.win.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "AI brief text" } }] }) });
    const withKey = await b.win.xPinPhase2.summarizeNoteWithAi({
      settings: { ai: { enabled: true, provider: "openai", baseUrl: "" } },
      apiKey: "test-key", note
    });
    check("T61: enabled-with-key path returns AI summary", withKey.source === "ai" && withKey.text === "AI brief text", JSON.stringify(withKey));
    check("T61: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T62 (Phase 2): new state keys survive a save/load round-trip */
  {
    const b = boot(null);
    await flush(120);
    const ws = JSON.parse(b.storageData["xPin.workspace.v1"]);
    ws.settings = { dailyLanding: false, ai: { enabled: true, provider: "openai", baseUrl: "https://example.com/v1", embeddingsEnabled: true, embeddingsBaseUrl: "" } };
    ws.attachments = [{ id: "att-rt", noteId: "n1", name: "f.png", mime: "image/png", size: 10, createdAt: new Date().toISOString(), data: null, synced: false }];
    ws.readLater = [{ id: "rl-1", url: "https://example.com", title: "X", text: "", fetchedText: "", fetchedAt: null, fetchStatus: "saved", savedAt: new Date().toISOString(), read: false }];
    ws.highlights = [{ id: "hl-1", quote: "keep me", sourceId: null, sourceTitle: "", sourceUrl: "", createdAt: new Date().toISOString(), dismissedAt: null, shownCount: 0 }];
    ws.flashcards = [{ id: "fc-1", front: "Q", back: "A", sourceNoteId: null, kind: "qa", clozeIndex: 1, stability: null, difficulty: null, dueAt: null, lastReviewedAt: null, reviews: 0, lapses: 0 }];
    ws.unknownPhase2 = "drop-me";
    const b2 = boot({ "xPin.workspace.v1": JSON.stringify(ws) });
    await flush(120);
    const ws2 = JSON.parse(b2.storageData["xPin.workspace.v1"]);
    check("T62: settings survive round-trip (dailyLanding off kept)",
      ws2.settings?.dailyLanding === false && ws2.settings?.ai?.provider === "openai", JSON.stringify(ws2.settings));
    check("T62: attachments/read-later/highlights/flashcards survive",
      ws2.attachments?.length === 1 && ws2.readLater?.length === 1 && ws2.highlights?.length === 1 && ws2.flashcards?.length === 1,
      JSON.stringify({ a: ws2.attachments?.length, r: ws2.readLater?.length, h: ws2.highlights?.length, f: ws2.flashcards?.length }));
    check("T62: unknown top-level keys still dropped", !("unknownPhase2" in ws2), Object.keys(ws2).join(","));
    check("T62: no console errors", b2.errors.length === 0, b2.errors.slice(0, 3).join(" | "));
  }

  /* T63 (Phase 2, Item 3): calendar strip navigates to past daily notes */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const days = [...doc.querySelectorAll(".daily-strip-day")];
    const other = days.find((d) => !d.classList.contains("is-today"));
    check("T63: strip has a non-today day to click", !!other, `days=${days.length}`);
    if (other) {
      click(other);
      await flush(50);
      const state = win.xPinDomain.getState();
      const key = other.dataset.dateKey;
      const note = state.notes.find((n) => n.metadata?.dailyDate === key);
      check("T63: clicking a past day opens/creates that daily note", !!note, `dateKey=${key}`);
    }
    const meeting = win.xPinPhase2.buildMeetingNote({ title: "Sync", attendees: "Ana, Bo", time: "14:30" });
    check("T63: meeting note carries date/time/attendees properties",
      meeting.metadata.meetingDate && meeting.metadata.meetingTime === "14:30" && /Ana/.test(meeting.metadata.attendees) && !!meeting.metadata.dailyDate,
      JSON.stringify(meeting.metadata));
    check("T63: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T64 (Phase 3): module loads; phase3 state survives round-trip, unknown keys dropped */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    check("T64: phase3 module loaded", !!win.xPinPhase3, typeof win.xPinPhase3);
    const state = win.xPinDomain.getState();
    check("T64: phase3 state exists with defaults", !!state.phase3 && state.phase3.settings.theme === "dark" && state.phase3.settings.font === "system", JSON.stringify(state.phase3?.settings));
    check("T64: power nav button exists", !!doc.querySelector('[data-phase3-view="power"]'));
    check("T64: split/share/voice buttons exist", !!doc.getElementById("toggle-split-preview") && !!doc.getElementById("share-note") && !!doc.getElementById("voice-capture"));
    check("T64: comments container exists", !!doc.getElementById("note-comments"));
    state.phase3.settings.theme = "light";
    state.phase3.settings.font = "serif";
    state.phase3.unknownKey = "drop-me";
    const raw = JSON.parse(b.storageData["xPin.workspace.v1"]);
    raw.phase3 = state.phase3;
    const b2 = boot({ "xPin.workspace.v1": JSON.stringify(raw) });
    await flush(120);
    const state2 = b2.win.xPinDomain.getState();
    check("T64: theme + font survive round-trip", state2.phase3.settings.theme === "light" && state2.phase3.settings.font === "serif", JSON.stringify(state2.phase3.settings));
    check("T64: unknown phase3 keys dropped", !("unknownKey" in state2.phase3), Object.keys(state2.phase3).join(","));
    check("T64: no console errors", b.errors.length === 0 && b2.errors.length === 0, [...b.errors, ...b2.errors].slice(0, 3).join(" | "));
  }

  /* T65 (Phase 3, Item 1): scripts need approval; approved scripts run in the sandbox worker */
  {
    const b = boot(null);
    simSandbox(b);
    await flush(120);
    const { doc, win } = b;
    const P = win.xPinPhase3;
    const body = "Intro\n\n```xpin-script\n// hello\n```\n\nDone";
    const scripts = P.extractScripts(body);
    check("T65: script block extracted", scripts.length === 1 && scripts[0].source === "// hello", JSON.stringify(scripts));
    check("T65: no script in plain note", P.extractScripts("just text").length === 0);
    let refused = "";
    try { P.wrapScriptAsPackage({ source: "x", name: "bad", permissions: ["network:fetch"] }); } catch (e) { refused = e.message; }
    check("T65: connector permission refused for scripts", /cannot use/.test(refused) && /Network/.test(refused), refused);
    const hash = await P.scriptDigest("// hello");
    const phase3 = win.xPinDomain.getState().phase3;
    check("T65: unapproved script is not approved", !P.isScriptApproved(phase3, hash));
    P.approveScriptRecord(phase3, { hash, name: "T65", source: "// hello", permissions: ["ui:notify"] });
    check("T65: approval recorded", P.isScriptApproved(phase3, hash));
    check("T65: changed source is not covered by the old approval", !P.isScriptApproved(phase3, await P.scriptDigest("// hello!")));
    check("T65: revoke removes approval", P.revokeScript(phase3, hash) && !P.isScriptApproved(phase3, hash));
    // Real sandboxed execution: the script notifies through the host RPC.
    const notified = [];
    const host = {
      scriptRequest: async (capability, payload) => {
        if (capability === "ui:notify") { notified.push(payload.message); return true; }
        throw new Error(`not granted: ${capability}`);
      },
      notify: (m) => notified.push(m)
    };
    await P.runScript({
      source: `xPinPlugin.register({ activate: async (api) => { await api.ui.notify("script-hello"); } });`,
      name: "T65 run", permissions: ["ui:notify"], host, noteId: null, eventDetail: { type: "manual", noteId: null }
    });
    check("T65: approved script ran in the sandbox worker and notified", notified.includes("script-hello"), notified.join(" | "));
    check("T65: hooks match by event only", P.matchHooks({ hooks: [{ id: "h1", event: "note:created", scriptId: "s1", enabled: true }] }, "note:created").length === 1
      && P.matchHooks({ hooks: [{ id: "h1", event: "note:created", scriptId: "s1", enabled: true }] }, "note:deleted").length === 0);
    check("T65: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T66 (Phase 3, Item 2): typed blocks parse, validate, and feed a database */
  {
    const b = boot(null);
    await flush(120);
    const P = b.win.xPinPhase3;
    const body = "```xpin-task\n{\"title\":\"Ship it\",\"status\":\"open\",\"due\":\"2026-11-20\",\"priority\":\"high\"}\n```";
    const blocks = P.parseTypedBlocks(body);
    check("T66: task block parsed", blocks.length === 1 && blocks[0].fields.title === "Ship it" && blocks[0].fields.priority === "high", JSON.stringify(blocks));
    check("T66: unknown type rejected at serialize", (() => { try { P.serializeTypedBlock("widget", {}); return false; } catch { return true; } })());
    check("T66: bad status rejected", (() => { try { P.serializeTypedBlock("task", { title: "x", status: "banana" }); return false; } catch { return true; } })());
    check("T66: bad date rejected", (() => { try { P.serializeTypedBlock("task", { title: "x", due: "tomorrow" }); return false; } catch { return true; } })());
    const round = P.serializeTypedBlock("person", { name: "Ada", role: "Dev", contact: "ada@x.co" });
    check("T66: serialize round-trips", P.parseTypedBlocks(round)[0].fields.name === "Ada", round);
    const table = { id: "t1", columns: [{ id: "c1", name: "Title" }, { id: "c2", name: "Due" }, { id: "c3", name: "Unrelated" }] };
    const row = P.typedBlockToRow(blocks[0], table);
    check("T66: block feeds a database row by column name", row.c1 === "Ship it" && row.c2 === "2026-11-20" && !("c3" in row), JSON.stringify(row));
    check("T66: five fixed types only", Object.keys(P.TYPED_BLOCK_TYPES).join(",") === "task,person,project,book,idea");
    check("T66: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T67 (Phase 3, Item 3): query v2 — AND/OR, ORDER BY, LIMIT, saved views */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const P = win.xPinPhase3;
    const state = win.xPinDomain.getState();
    const extractTags = (t) => (t.match(/#[A-Za-z0-9_-]+/g) || []);
    const notes = [
      { id: "q1", title: "Alpha", body: "#work stuff", folderId: null, pinned: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
      { id: "q2", title: "Beta", body: "plain", folderId: null, pinned: false, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "q3", title: "Gamma", body: "#work more", folderId: null, pinned: false, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
    ];
    const run = (q) => P.runQueryV2(notes, [], extractTags, q).map((n) => n.title);
    check("T67: AND narrows", JSON.stringify(run("LIST FROM notes WHERE tag = work AND pinned = true")) === JSON.stringify(["Alpha"]), run("LIST FROM notes WHERE tag = work AND pinned = true").join(","));
    check("T67: OR widens", run("LIST FROM notes WHERE tag = work OR title = Beta").length === 3);
    check("T67: ORDER BY + LIMIT", JSON.stringify(run("LIST FROM notes ORDER BY updated DESC LIMIT 2")) === JSON.stringify(["Alpha", "Beta"]), run("LIST FROM notes ORDER BY updated DESC LIMIT 2").join(","));
    check("T67: date comparison", JSON.stringify(run("LIST FROM notes WHERE created >= 2026-01-02")) === JSON.stringify(["Beta", "Gamma"]));
    check("T67: attached operator (tag=work) parses", run("LIST FROM notes WHERE tag=work").length === 2);
    check("T67: invalid query rejected, not eval'd", (() => { try { P.parseQueryV2("DROP TABLE notes"); return false; } catch { return true; } })());
    const saved = P.saveQueryRecord(state.phase3, { name: "Work notes", query: "LIST FROM notes WHERE tag = work" });
    check("T67: query saved", state.phase3.savedQueries.length === 1 && saved.query.includes("tag = work"));
    // Saving from the power view re-renders the sidebar on the next render;
    // creating a note triggers one.
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.getElementById("new-note"));
    await flush(80);
    check("T67: saved query shows in the sidebar", !!doc.querySelector("#p3-sidebar") && doc.querySelector("#p3-sidebar").textContent.includes("Work notes"), doc.querySelector("#p3-sidebar")?.textContent.slice(0, 120));
    check("T67: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T68 (Phase 3, Item 4): task scores + calendar assignment */
  {
    const b = boot(null);
    await flush(120);
    const P = b.win.xPinPhase3;
    const now = new Date("2026-11-13T12:00:00.000Z");
    const overdue = { done: false, due: "2026-11-10", priority: "high", createdAt: "2026-10-01T00:00:00.000Z" };
    const future = { done: false, due: "2027-06-01", priority: "low", createdAt: "2026-11-13T00:00:00.000Z" };
    const done = { done: true, due: "2026-11-10", priority: "high", createdAt: "2026-10-01T00:00:00.000Z" };
    check("T68: overdue high-priority outscores distant low-priority", P.taskScore(overdue, now) > P.taskScore(future, now), `${P.taskScore(overdue, now)} vs ${P.taskScore(future, now)}`);
    check("T68: done tasks score 0", P.taskScore(done, now) === 0);
    check("T68: score is bounded 0–100", P.taskScore(overdue, now) <= 100 && P.taskScore(future, now) >= 0);
    check("T68: formula is documented in the UI", P.TASK_SCORE_FORMULA.includes("urgency") && P.TASK_SCORE_FORMULA.includes("importance"));
    const notes = [{ id: "n1", title: "Day", body: "- [ ] Buy milk due:2026-11-14 p:high\n- [x] Done thing\n- [ ] No date task", createdAt: "2026-11-01T00:00:00.000Z" }];
    const tasks = P.extractTasks(notes, now);
    check("T68: checklist tasks extracted with due + priority", tasks.length === 3 && tasks[0].due === "2026-11-14" && tasks[0].priority === "high", JSON.stringify(tasks.map((t) => [t.text, t.due, t.priority])));
    check("T68: tasks sort by score", tasks.filter((t) => !t.done).sort((a, c) => c.score - a.score)[0].text === "Buy milk");
    const task = tasks[0];
    const moved = P.setTaskDueInBody(notes[0].body, { ...task, due: "2026-11-20" });
    check("T68: drag-to-calendar rewrites the due date", moved.includes("due:2026-11-20") && !moved.includes("due:2026-11-14"), moved);
    const grid = P.monthGrid(2026, 10);
    check("T68: month grid covers November 2026", grid.flat().some((d) => d.dateKey === "2026-11-13") && grid.flat().some((d) => d.dateKey === "2026-11-30"));
    check("T68: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T69 (Phase 3, Item 5): formulas + per-view sort/filter/group */
  {
    const b = boot(null);
    await flush(120);
    const P = b.win.xPinPhase3;
    const columns = [
      { id: "price", name: "Price", type: "number" },
      { id: "qty", name: "Qty", type: "number" },
      { id: "due", name: "Due", type: "date" },
      { id: "total", name: "Total", type: "formula", expression: "= price * qty" }
    ];
    const row = { values: { price: 3, qty: 4 } };
    const total = P.evaluateFormula("= price * qty", row, columns);
    check("T69: formula multiplies fields", total.ok && total.value === 12, JSON.stringify(total));
    check("T69: days(due, today()) works", P.evaluateFormula("= days(due, today())", { values: { due: "2026-11-20" } }, columns, "2026-11-13").value === 7);
    check("T69: formula never evals — injection rejected", !P.evaluateFormula("= price; alert(1)", row, columns).ok);
    check("T69: unknown field is an error, not a crash", !P.evaluateFormula("= nope * 2", row, columns).ok);
    check("T69: divide by zero is an error", !P.evaluateFormula("= price / 0", row, columns).ok);
    const rows = [
      { id: "r1", values: { price: 10, qty: 1, due: "2026-11-20" } },
      { id: "r2", values: { price: 5, qty: 3, due: "2026-11-21" } },
      { id: "r3", values: { price: 20, qty: 1, due: "2026-11-22" } }
    ];
    const sorted = P.applyDatabaseView(rows, columns, { sortColumnId: "total", sortDir: "desc" });
    check("T69: view sorts by formula column", sorted.rows[0].id === "r3" && sorted.rows[1].id === "r2" && sorted.rows[2].id === "r1", sorted.rows.map((r) => r.id).join(","));
    const filtered = P.applyDatabaseView(rows, columns, { filterColumnId: "price", filterOp: ">", filterValue: "9" });
    check("T69: view filters rows", filtered.rows.length === 2 && filtered.rows.every((r) => Number(r.values.price) > 9));
    const grouped = P.applyDatabaseView(rows, columns, { groupByColumnId: "qty" });
    check("T69: view groups rows", grouped.groups.length === 2 && grouped.groups.find((g) => g.key === "1").rows.length === 2, JSON.stringify(grouped.groups.map((g) => [g.key, g.rows.length])));
    const phase3 = b.win.xPinDomain.getState().phase3;
    const reminder = P.createReminder(phase3, { tableId: "t1", rowId: "r1", date: "2026-11-20", label: "Ship it" });
    check("T69: reminder created + surfaces on its day", P.remindersForDate(phase3, "2026-11-20").length === 1 && P.remindersForDate(phase3, "2026-11-21").length === 0, JSON.stringify(reminder));
    check("T69: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T70 (Phase 3, Item 6): side-by-side preview + block move */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const P = win.xPinPhase3;
    const text = "First para.\n\nSecond para.\n\n- one\n- two\n- three";
    const blocks = P.splitBlocks(text);
    check("T70: blocks split (paras + list items)", blocks.length === 5, JSON.stringify(blocks.map((x) => x.text)));
    const moved = P.moveBlock(text, 2, 1);
    check("T70: Alt+Arrow moves the current block down", moved.moved && moved.text.startsWith("Second para."), moved.text.slice(0, 60));
    const reordered = P.reorderBlocks(text, 0, 2);
    check("T70: drag reorder moves a block", reordered.moved && reordered.text.split("\n\n")[2].startsWith("First"), reordered.text.slice(0, 80));
    check("T70: moving past the edge is a no-op", !P.moveBlock(text, 2, -1).moved);
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.getElementById("toggle-split-preview"));
    const fields = doc.querySelector(".editor-fields");
    check("T70: split toggle adds the split layout", !!fields && fields.classList.contains("editor-split"));
    check("T70: split shows editor and preview together", !doc.getElementById("note-body").hidden && !doc.getElementById("markdown-preview").hidden);
    click(doc.getElementById("toggle-split-preview"));
    check("T70: split toggle exits back to edit", !fields.classList.contains("editor-split"));
    check("T70: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T71 (Phase 3, Item 7): graph v2 — local graph, orphans, controls */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const P = win.xPinPhase3;
    const notes = [
      { id: "g1", title: "A", body: "see [[B]]", folderId: null, parentNoteId: null },
      { id: "g2", title: "B", body: "see [[C]]", folderId: null, parentNoteId: null },
      { id: "g3", title: "C", body: "", folderId: null, parentNoteId: null },
      { id: "g4", title: "Lonely", body: "nothing links here", folderId: null, parentNoteId: null }
    ];
    const full = P.buildGraph(notes);
    check("T71: full graph has edges", full.edges.length === 2, JSON.stringify(full.edges));
    const local = P.localGraph(notes, "g1", 1);
    check("T71: local graph 1 hop is just A+B", local.nodes.length === 2 && local.edges.length === 1, JSON.stringify(local.nodes.map((n) => n.id)));
    const local2 = P.localGraph(notes, "g1", 2);
    check("T71: local graph 2 hops reaches C", local2.nodes.length === 3, JSON.stringify(local2.nodes.map((n) => n.id)));
    const orphans = P.findOrphans(notes);
    check("T71: orphan detection finds the unlinked note", orphans.length === 1 && orphans[0].id === "g4", JSON.stringify(orphans.map((n) => n.id)));
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.querySelector('[data-feature-view="graph"]'));
    await flush(80);
    const content = doc.getElementById("feature-content");
    check("T71: graph controls render (scope, zoom, filters, orphans)", !!content.querySelector(".graph-controls") && content.textContent.includes("Local graph") && content.textContent.includes("Orphans only"), content.textContent.slice(0, 200));
    check("T71: zoom label present", !!content.querySelector(".graph-zoom"));
    check("T71: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T72 (Phase 3, Item 8): comments sync round-trip + mention notification */
  {
    const b = boot(null);
    await flush(120);
    const P = b.win.xPinPhase3;
    const S = b.win.xPinSync;
    const phase3 = b.win.xPinDomain.getState().phase3;
    const comment = P.createComment(phase3, { noteId: "n1", deviceId: "xpin-aaa", author: "You", body: "Nice note @xpin-bbb, see you soon" });
    check("T72: comment created", phase3.comments.length === 1 && comment.body.includes("@xpin-bbb"));
    check("T72: mention extracted", P.extractMentions(comment.body).join(",") === "xpin-bbb");
    check("T72: mention recorded unread", P.unreadMentions(phase3).length === 1);
    const space = P.createSpace(phase3, { name: "Team", memberDeviceIds: ["xpin-aaa", "xpin-bbb"] });
    P.shareNoteToSpace(phase3, "n1", space.id);
    check("T72: note shared to space", P.spacesForNote(phase3, "n1").length === 1);
    const key = await S.deriveSyncKey("comment-passphrase-123", S.newSalt());
    const env = await S.makeRecordEnvelope({ key, deviceId: "xpin-aaa", lamport: 1, record: comment, op: "comment" });
    check("T72: comment envelope validates", S.validateEnvelope(env).op === "comment");
    const local = { notes: [], trash: [], comments: [], spaces: [] };
    const applied = await S.applyEnvelope(env, local, key, []);
    check("T72: comment envelope applies on another device", applied.applied && local.comments.length === 1 && local.comments[0].body === comment.body, JSON.stringify(applied));
    const again = await S.applyEnvelope(env, local, key, [env.id]);
    check("T72: re-applying the same envelope is a no-op (idempotent)", !again.applied, JSON.stringify(again));
    const spaceEnv = await S.makeRecordEnvelope({ key, deviceId: "xpin-aaa", lamport: 2, record: space, op: "space" });
    const appliedSpace = await S.applyEnvelope(spaceEnv, local, key, []);
    check("T72: space envelope applies", appliedSpace.applied && local.spaces.length === 1 && local.spaces[0].name === "Team", JSON.stringify(appliedSpace));
    let wrongKeyThrows = false;
    const otherKey = await S.deriveSyncKey("different-passphrase-1", S.newSalt());
    try { await S.applyEnvelope(env, { notes: [], trash: [], comments: [], spaces: [] }, otherKey, []); } catch { wrongKeyThrows = true; }
    check("T72: comment from another key cannot be decrypted", wrongKeyThrows);
    check("T72: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T73 (Phase 3, Item 9): back-button logic, theme/font, real dialogs, share text */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const P = win.xPinPhase3;
    check("T73: back closes a dialog first", P.backButtonAction({ dialogOpen: true, viewActive: true }) === "close-dialog");
    check("T73: back goes back from a view", P.backButtonAction({ dialogOpen: false, viewActive: true }) === "go-back");
    check("T73: back exits only at the top level", P.backButtonAction({ dialogOpen: false, viewActive: false }) === "exit");
    P.applyThemeSettings(doc, { theme: "light", font: "mono" });
    check("T73: light theme + mono font applied to the document", doc.documentElement.dataset.xPinTheme === "light" && doc.documentElement.dataset.xPinFont === "mono");
    P.applyThemeSettings(doc, { theme: "dark", font: "system" });
    check("T73: theme resets to dark/system", doc.documentElement.dataset.xPinTheme === "dark" && doc.documentElement.dataset.xPinFont === "system");
    check("T73: share text is title + body", P.shareTextForNote({ title: "Hi", body: "there" }) === "Hi\n\nthere");
    check("T73: shared text captures to an Inbox note", JSON.stringify(P.captureSharedText("hello world\nsecond line", "Other app")).includes("hello world"));
    check("T73: empty shared text captures nothing", P.captureSharedText("   ") === null);
    // Real dialog: resolves with the typed value, no window.prompt involved.
    const pending = P.showDialog(doc, { title: "Test dialog", label: "Name", value: "initial" });
    const input = doc.querySelector(".xpin-dialog-input");
    check("T73: dialog renders with the initial value", !!input && input.value === "initial");
    if (input) input.value = "typed-name";
    const doneBtn = doc.querySelector(".xpin-dialog .dialog-done");
    if (doneBtn) doneBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const resolved = await pending;
    check("T73: dialog resolves with the typed value", resolved === "typed-name", String(resolved));
    check("T73: dialog is removed after confirm", !doc.querySelector(".xpin-dialog"));
    check("T73: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T74 (Phase 3, Item 9): storage display stays accurate with attachments; no window.prompt remains */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const state = win.xPinDomain.getState();
    state.attachments.push({ id: "att-t74", noteId: null, name: "pic.png", mime: "image/png", size: 2048, createdAt: new Date().toISOString(), data: null, synced: false });
    const info = win.xPinDomain.getState();
    check("T74: attachment counted in state", info.attachments.length === 1 && info.attachments[0].size === 2048);
    // The Workspace tools storage section must show the attachment bytes.
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(doc.querySelector('[data-feature-view="settings"]'));
    await flush(80);
    const settingsText = doc.getElementById("feature-content").textContent;
    check("T74: storage display includes the attachment", /1 attachment/.test(settingsText), settingsText.slice(0, 300));
    const fs = require("fs");
    const appSrc = fs.readFileSync(REPO + "/app.js", "utf8");
    const featSrc = fs.readFileSync(REPO + "/feature-suite.js", "utf8");
    check("T74: no window.prompt left in app.js", !appSrc.includes("window.prompt"));
    check("T74: no window.prompt left in feature-suite.js", !featSrc.includes("window.prompt"));
    check("T74: no eval/Function in phase3.js", !/[^a-zA-Z]eval\s*\(|new Function/.test(fs.readFileSync(REPO + "/phase3.js", "utf8")));
    check("T74: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T75 (Phase 3): power view opens clean; tasks + calendar render */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Task note");
    type(doc.getElementById("note-body"), "- [ ] Buy milk due:2026-11-20 p:high\n\n```xpin-task\n{\"title\":\"Ship it\",\"status\":\"open\",\"due\":\"2026-11-20\",\"priority\":\"high\"}\n```");
    click(doc.querySelector('[data-phase3-view="power"]'));
    await flush(80);
    const view = doc.getElementById("phase3-view");
    check("T75: power view opens", !view.hidden, `hidden=${view.hidden}`);
    check("T75: task list shows the scored task", view.textContent.includes("Buy milk"), view.textContent.slice(0, 300));
    check("T75: scoring formula is shown", view.textContent.includes("Score = urgency"));
    check("T75: calendar grid renders", !!view.querySelector(".p3-calendar") && view.querySelectorAll(".p3-cal-day").length >= 28, `days=${view.querySelectorAll(".p3-cal-day").length}`);
    check("T75: scripts section renders", view.textContent.includes("Scripts in notes"));
    check("T75: saved queries section renders", view.textContent.includes("Saved queries"));
    check("T75: sharing section renders", view.textContent.includes("Sharing & spaces"));
    check("T75: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* T76 (Phase 3, Items 1–2): typed + script blocks render as cards in preview */
  {
    const b = boot(null);
    await flush(120);
    const { doc, win } = b;
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (el, t) => { el.value = t; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
    click(doc.getElementById("new-note"));
    type(doc.getElementById("note-title"), "Blocks note");
    type(doc.getElementById("note-body"), "```xpin-task\n{\"title\":\"Ship it\",\"status\":\"open\",\"due\":\"2026-11-20\",\"priority\":\"high\"}\n```\n\n```xpin-script\n// do nothing\n```");
    click(doc.getElementById("toggle-preview"));
    await flush(80);
    const preview = doc.getElementById("markdown-preview");
    check("T76: typed block renders as an editable card", !!preview.querySelector(".p3-typed-block") && preview.textContent.includes("Ship it"), preview.textContent.slice(0, 200));
    check("T76: typed block shows its type chip", !!preview.querySelector(".p3-type-chip"));
    check("T76: script block renders with a Run button", !!preview.querySelector(".p3-script-block") && preview.textContent.includes("Run script"), preview.textContent.slice(0, 200));
    check("T76: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }
  /* F1: manifest parses, matches the Bridge registration shape, and the
   * embedded fallback matches manifest.json */
  {
    const fileManifest = JSON.parse(fs.readFileSync(REPO + "/integrations/fabrix/manifest.json", "utf8"));
    const expectedCaps = ["notes.search", "notes.read", "notes.create", "notes.update", "notes.export", "projects.list", "artifacts.publish"];
    check("F1: manifest id is xpin", fileManifest.id === "xpin", fileManifest.id);
    check("F1: manifest schemaVersion/version are 1.0/1.0.0", fileManifest.schemaVersion === "1.0" && fileManifest.version === "1.0.0");
    check("F1: manifest has the Bridge registration fields",
      ["name", "type", "category", "description", "mcp", "licensing"].every((k) => k in fileManifest),
      Object.keys(fileManifest).join(","));
    check("F1: manifest licensing is product authority, not required",
      fileManifest.licensing && fileManifest.licensing.authority === "product" && fileManifest.licensing.required === false);
    check("F1: manifest declares the seven capabilities",
      JSON.stringify(fileManifest.fabrix.capabilities.map((c) => c.name)) === JSON.stringify(expectedCaps));
    check("F1: manifest risk groups match the permission model",
      fileManifest.fabrix.capabilities.filter((c) => c.risk === "read").map((c) => c.name).join(",") === "notes.search,notes.read,notes.export,projects.list" &&
      fileManifest.fabrix.capabilities.filter((c) => c.risk === "write").map((c) => c.name).join(",") === "notes.create,notes.update,artifacts.publish");

    // getManifest() with a fetch that serves the file returns the file.
    const b = bootFabrix(null);
    await flush(80);
    b.win.fetch = async (url) => {
      if (String(url).includes("manifest.json")) {
        return { ok: true, status: 200, text: async () => JSON.stringify(fileManifest), json: async () => fileManifest };
      }
      return { ok: false, status: 404, text: async () => "not found", json: async () => null };
    };
    const fetched = await fabrixEval(b, `window.xPinFabrix.getManifest()`);
    check("F1: getManifest returns the file manifest", JSON.stringify(fetched) === JSON.stringify(fileManifest));
    check("F1: boot with adapter is clean", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));

    // getManifest() with a dead fetch falls back to the embedded copy — and
    // the embedded capabilities match the file exactly (compared
    // field-by-field: the file's keys are alphabetical, the embedded copy's
    // are name/risk/description, so a raw stringify would differ).
    const b2 = bootFabrix(null);
    await flush(80);
    const embedded = await fabrixEval(b2, `window.xPinFabrix.getManifest()`);
    const capTuple = (caps) => JSON.stringify(caps.map((c) => [c.name, c.risk, c.description]));
    check("F1: embedded manifest matches the file manifest",
      capTuple(embedded.fabrix.capabilities) === capTuple(fileManifest.fabrix.capabilities),
      JSON.stringify(embedded.fabrix.capabilities));
    check("F1: adapter attached but disabled by default",
      (await fabrixEval(b2, `window.xPinFabrix.getStatus()`)).enabled === false);
  }

  /* F2: disabled mode — no network, no timers, handlers reject */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    let fetchCalls = 0;
    b.win.fetch = () => { fetchCalls += 1; return Promise.reject(new Error("network disabled in smoke test")); };
    let err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", {})`); } catch (e) { err = e; }
    check("F2: disabled invoke rejects permission_denied", err && err.code === "permission_denied", err && (err.code + ": " + err.message));
    check("F2: disabled invoke makes no network calls", fetchCalls === 0, "fetch calls: " + fetchCalls);
    check("F2: no polling timer while disabled",
      (await fabrixEval(b, `window.xPinFabrix.getStatus()`)).polling === false);
    check("F2: disabled boot has no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F3: permission boundaries — read != write, revocation takes effect */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEval(b, `window.xPinFabrix.setEnabled(true)`);
    await fabrixEval(b, `window.xPinFabrix.grant("read")`);
    const search = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { query: "alpha body" })`);
    check("F3: read grant allows notes.search", search.status === "ok" && search.result.notes.length === 1);
    let err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "x", body: "y" })`); } catch (e) { err = e; }
    check("F3: read grant does NOT allow notes.create", err && err.code === "permission_denied", err && err.code);
    await fabrixEval(b, `window.xPinFabrix.grant("write", { reason: "test approval" })`);
    const created = await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "WriteNote", body: "written" })`);
    check("F3: write grant allows notes.create", created.status === "ok" && created.result.note.title === "WriteNote");
    const grants = await fabrixEval(b, `window.xPinFabrix.getState()`);
    check("F3: grant records grantedAt/grantedBy/reason",
      !!grants.grants.write.grantedAt && grants.grants.write.grantedBy === "user" && grants.grants.write.reason === "test approval",
      JSON.stringify(grants.grants.write));
    await fabrixEval(b, `window.xPinFabrix.revoke("read")`);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" })`); } catch (e) { err = e; }
    check("F3: revoking read blocks notes.read", err && err.code === "permission_denied", err && err.code);
    const stillWrite = await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "StillWrite", body: "ok" })`);
    check("F3: revoking read leaves write intact", stillWrite.status === "ok");
    await fabrixEval(b, `window.xPinFabrix.setReason("write", "recorded first")`);
    const afterReason = await fabrixEval(b, `window.xPinFabrix.getState()`);
    check("F3: setReason records a reason without granting",
      afterReason.grants.write.reason === "recorded first" && afterReason.grants.write.granted === true,
      JSON.stringify(afterReason.grants.write));
    await fabrixEval(b, `window.xPinFabrix.setEnabled(false)`);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "z", body: "z" })`); } catch (e) { err = e; }
    check("F3: disabling blocks even granted capabilities", err && err.code === "permission_denied", err && err.code);
    check("F3: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F4: folder scoping — search filters, out-of-scope reads as not_found */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEval(b, `window.xPinFabrix.setEnabled(true)`);
    await fabrixEval(b, `window.xPinFabrix.grant("read", { folderIds: ["folder-a"] })`);
    const scoped = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", {})`);
    check("F4: scoped search returns only in-scope notes",
      scoped.result.notes.length === 1 && scoped.result.notes[0].id === "note-a",
      JSON.stringify(scoped.result.notes.map((n) => n.id)));
    let err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { folderId: "folder-b" })`); } catch (e) { err = e; }
    check("F4: explicitly out-of-scope folder is permission_denied", err && err.code === "permission_denied", err && err.code);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-b" })`); } catch (e) { err = e; }
    check("F4: out-of-scope read is not_found (no existence leak)", err && err.code === "not_found", err && err.code);
    const inScope = await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" })`);
    check("F4: in-scope read works", inScope.status === "ok" && inScope.result.note.id === "note-a");
    await fabrixEval(b, `window.xPinFabrix.grant("write", { folderIds: ["folder-a"] })`);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "t", body: "b", folderId: "folder-b" })`); } catch (e) { err = e; }
    check("F4: scoped write rejects the other folder", err && err.code === "permission_denied", err && err.code);
    await fabrixEval(b, `window.xPinFabrix.setScope("read", [])`);
    const wide = await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-b" })`);
    check("F4: clearing the scope restores workspace-wide read", wide.status === "ok");
    check("F4: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F5: the seven handlers against the seeded workspace */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEnableAll(b);
    const search = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { query: "alpha body" })`);
    check("F5: search finds by text", search.result.notes.length === 1 && search.result.notes[0].id === "note-a");
    check("F5: search returns snippets, not bodies",
      !("body" in search.result.notes[0]) && (search.result.notes[0].snippet || "").includes("alpha"),
      JSON.stringify(search.result.notes[0]));
    const byTag = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { tag: "#work" })`);
    check("F5: search finds by tag", byTag.result.notes.length === 1 && byTag.result.notes[0].id === "note-a");
    const read = await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" })`);
    check("F5: read returns the full note", read.result.note.body === "alpha body with #work tag");
    check("F5: read extracts tags", (read.result.note.tags || []).includes("#work"), JSON.stringify(read.result.note.tags));
    const readLinks = await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-c" })`);
    check("F5: read resolves [[links]] to note ids",
      (readLinks.result.note.links || []).some((l) => l.target === "Alpha note" && l.noteId === "note-a"),
      JSON.stringify(readLinks.result.note.links));
    let err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-nope" })`); } catch (e) { err = e; }
    check("F5: read of a missing note is not_found", err && err.code === "not_found", err && err.code);
    const created = await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "Created", body: "fresh body", folderId: "folder-a", tags: ["#new"] })`);
    check("F5: create appends missing tags to the body",
      created.result.note.body.includes("#new"), created.result.note.body);
    check("F5: create stamps fabriX provenance",
      created.result.note.provenance && created.result.note.provenance.source === "fabrix",
      JSON.stringify(created.result.note.provenance));
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "t", body: "b", folderId: "folder-nope" })`); } catch (e) { err = e; }
    check("F5: create with an unknown folder is validation_error", err && err.code === "validation_error", err && err.code);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "t", body: "b", parentNoteId: "note-nope" })`); } catch (e) { err = e; }
    check("F5: create with an unknown parent is validation_error", err && err.code === "validation_error", err && err.code);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "t", body: "b", tags: [null] })`); } catch (e) { err = e; }
    check("F5: tags [null] is validation_error, not a TypeError", err && err.code === "validation_error", err && (err.code + ": " + err.message));
    const before = await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" })`);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.update", { id: "note-a", title: "Changed", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" })`); } catch (e) { err = e; }
    check("F5: stale expectedUpdatedAt is a conflict", err && err.code === "conflict" && !!err.currentUpdatedAt, err && err.code);
    const afterConflict = await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" })`);
    check("F5: conflict performs no write", afterConflict.result.note.title === before.result.note.title);
    const updated = await fabrixEval(b, `(async () => {
      const read = await window.xPinFabrix.invoke("notes.read", { id: "note-a" });
      return window.xPinFabrix.invoke("notes.update", { id: "note-a", title: "Alpha renamed", tags: ["#extra"], expectedUpdatedAt: read.result.note.updatedAt });
    })()`);
    check("F5: update with the current expectedUpdatedAt succeeds",
      updated.status === "ok" && updated.result.note.title === "Alpha renamed", JSON.stringify(updated));
    check("F5: update appends new tags", updated.result.note.body.includes("#extra"), updated.result.note.body);
    const exported = await fabrixEval(b, `window.xPinFabrix.invoke("notes.export", { id: "note-a", format: "markdown" })`);
    check("F5: export returns Markdown content",
      exported.result.files.length === 1 && exported.result.files[0].name.endsWith(".md") && exported.result.files[0].content.includes("alpha body"),
      JSON.stringify(exported.result.files[0]).slice(0, 120));
    const exportedHtml = await fabrixEval(b, `window.xPinFabrix.invoke("notes.export", { id: "note-a", format: "html" })`);
    check("F5: export renders HTML through the Markdown renderer",
      exportedHtml.result.files[0].content.includes("<h1>Alpha renamed</h1>"),
      exportedHtml.result.files[0].content.slice(0, 200));
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.export", { id: "note-a", ids: Array.from({ length: 100 }, (_, i) => "note-" + i) })`); } catch (e) { err = e; }
    check("F5: export of 101 notes is validation_error (combined cap)", err && err.code === "validation_error", err && err.code);
    const projects = await fabrixEval(b, `window.xPinFabrix.invoke("projects.list", {})`);
    check("F5: projects.list returns metadata only",
      Array.isArray(projects.result.projects) && projects.result.projects.length > 0 &&
      projects.result.projects.every((p) => "rowCount" in p && !("rows" in p)),
      JSON.stringify(projects.result.projects).slice(0, 200));
    const published = await fabrixEval(b, `window.xPinFabrix.invoke("artifacts.publish", { id: "note-a" })`);
    check("F5: artifacts.publish records a local artifact with no URL",
      published.result.artifact && published.result.artifact.noteId === "note-a" && published.result.artifact.url === null,
      JSON.stringify(published.result.artifact));
    const storedWs = JSON.parse(b.storageData["xPin.workspace.v1"]);
    check("F5: published artifact HTML is not persisted (regenerable on demand)",
      (storedWs.integrations.fabrix.artifacts || []).length === 1 &&
      (storedWs.integrations.fabrix.artifacts || []).every((a) => a.html === ""),
      JSON.stringify((storedWs.integrations.fabrix.artifacts || []).map((a) => (a.html || "").length)));
    // The publish record must survive a later adapter persist: the adapter
    // replaces state.integrations.fabrix with its in-memory copy on every
    // call, so persistFabrixState must merge (not clobber) the app-side
    // artifacts list.
    await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { query: "alpha" })`);
    const storedWs2 = JSON.parse(b.storageData["xPin.workspace.v1"]);
    check("F5: published artifact survives a later adapter call",
      (storedWs2.integrations.fabrix.artifacts || []).length === 1,
      JSON.stringify(storedWs2.integrations.fabrix.artifacts));
    check("F5: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F6: idempotency — replay serves the redacted stored result, and only
   * while the grant and the enabled flag still hold */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEnableAll(b);
    const first = await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "Idem note", body: "idem body" }, { requestId: "request_idem_1" })`);
    const second = await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "Idem note", body: "idem body" }, { requestId: "request_idem_1" })`);
    check("F6: replay returns the same note id", second.replayed === true && second.result.note.id === first.result.note.id);
    check("F6: replay returns a redacted summary, not the body",
      second.result.note.body === "[redacted]", JSON.stringify(second.result.note));
    const found = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { query: "Idem note" })`);
    check("F6: replay executed once (one note created)", found.result.notes.length === 1);
    const stored = await fabrixEval(b, `window.xPinFabrix.getState()`);
    check("F6: stored idempotency entry has no real body",
      stored.idempotency["request_idem_1"] && stored.idempotency["request_idem_1"].result.note.body === "[redacted]");
    check("F6: a replay records a receipt", stored.receipts.length >= 2, "receipts: " + stored.receipts.length);
    check("F6: receipts carry an action", stored.receipts.every((r) => r.action === "invoke"), JSON.stringify(stored.receipts[0]));
    // Export and search replays must not return body text either: export
    // results carry the full body under files[].content, search results
    // under notes[].snippet. (Phase 3 audit B1: redacting only `body`
    // missed both.)
    const expFirst = await fabrixEval(b, `window.xPinFabrix.invoke("notes.export", { id: "note-a", format: "markdown" }, { requestId: "request_exp_1" })`);
    check("F6: live export still returns the body", expFirst.result.files[0].content.includes("alpha body"));
    const expSecond = await fabrixEval(b, `window.xPinFabrix.invoke("notes.export", { id: "note-a", format: "markdown" }, { requestId: "request_exp_1" })`);
    check("F6: export replay returns redacted content, not the body",
      expSecond.replayed === true && expSecond.result.files[0].content === "[redacted]" && expSecond.result.files[0].name === expFirst.result.files[0].name,
      JSON.stringify(expSecond.result.files[0]));
    const searchFirst = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { query: "alpha body" }, { requestId: "request_search_1" })`);
    check("F6: live search still returns snippets", (searchFirst.result.notes[0].snippet || "").includes("alpha"));
    const searchSecond = await fabrixEval(b, `window.xPinFabrix.invoke("notes.search", { query: "alpha body" }, { requestId: "request_search_1" })`);
    check("F6: search replay returns redacted snippets, not body text",
      searchSecond.replayed === true && searchSecond.result.notes[0].snippet === "[redacted]",
      JSON.stringify(searchSecond.result.notes[0]));
    const stored2 = await fabrixEval(b, `window.xPinFabrix.getState()`);
    check("F6: stored export/search entries contain no body text",
      JSON.stringify(stored2.idempotency["request_exp_1"]).indexOf("alpha body") === -1 &&
      JSON.stringify(stored2.idempotency["request_search_1"]).indexOf("alpha body") === -1);
    await fabrixEval(b, `window.xPinFabrix.revoke("write")`);
    let err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "Idem note", body: "idem body" }, { requestId: "request_idem_1" })`); } catch (e) { err = e; }
    check("F6: replay after revocation is denied, not served", err && err.code === "permission_denied", err && err.code);
    await fabrixEval(b, `window.xPinFabrix.grant("write")`);
    await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" }, { requestId: "request_idem_2" })`);
    await fabrixEval(b, `window.xPinFabrix.setEnabled(false)`);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.read", { id: "note-a" }, { requestId: "request_idem_2" })`); } catch (e) { err = e; }
    check("F6: replay after disabling is denied", err && err.code === "permission_denied", err && err.code);
    await fabrixEval(b, `window.xPinFabrix.setEnabled(true)`);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "t", body: "b", apiKey: "secret-key" })`); } catch (e) { err = e; }
    check("F6: credential-shaped input field is rejected", err && err.code === "validation_error", err && err.code);
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.invoke("notes.create", { title: "t", body: "b", accessToken: "secret-key" })`); } catch (e) { err = e; }
    check("F6: camelCase credential field (accessToken) is rejected", err && err.code === "validation_error", err && err.code);
    check("F6: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F7: mock transport round-trip — status/contract/register/request/receipt */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEval(b, `window.xPinFabrix.setEnabled(true)`);
    await fabrixEval(b, `window.xPinFabrix.grant("read")`);
    await fabrixEval(b, `window.xPinFabrix.setTransport("mock", {})`);
    const status = await fabrixEval(b, `window.xPinFabrix.connect()`);
    check("F7: mock connect returns a mock status",
      status && status.ok === true && status.mock === true && status.build_id === "mock-rc19.8", JSON.stringify(status));
    check("F7: mock status capability_routes is an object",
      status.capability_routes && typeof status.capability_routes === "object" && status.capability_routes.requests === true,
      JSON.stringify(status.capability_routes));
    const reg = await fabrixEval(b, `window.xPinFabrix.register()`);
    check("F7: mock register accepts the manifest", reg && reg.ok === true && reg.registered === "xpin", JSON.stringify(reg));
    const snake = await fabrixEval(b, `window.xPinFabrixMock.createMockBridge({}).postReceipt({ request_id: "req-snake-1", receipt_id: "rc-1", capability: "notes.read", status: "ok" })`);
    check("F7: mock accepts snake_case receipts", snake && snake.ok === true, JSON.stringify(snake));
    await fabrixEval(b, `window.xPinFabrix.getTransport().enqueueRequest({ requestId: "request_mock_1", capability: "notes.search", inputs: { query: "alpha" } })`);
    const polled = await fabrixEval(b, `window.xPinFabrix.pollOnce()`);
    check("F7: pollOnce handles a queued Bridge request",
      polled.handled === 1 && polled.outcomes[0].status === "ok", JSON.stringify(polled));
    const internals = await fabrixEval(b, `window.xPinFabrix.getTransport()._internals()`);
    check("F7: the Bridge receipt was recorded",
      internals.receipts.length === 1 && internals.receipts[0].requestId === "request_mock_1",
      JSON.stringify(internals.receipts));
    check("F7: Bridge receipts carry no result or body",
      !("result" in internals.receipts[0]) && JSON.stringify(internals.receipts[0]).indexOf("alpha body") === -1,
      JSON.stringify(internals.receipts[0]));
    await fabrixEval(b, `window.xPinFabrix.getTransport().pollRequests = () => Promise.resolve({ routing: "advertised", requests: [{ capability: "notes.search", inputs: {} }] })`);
    const skipped = await fabrixEval(b, `window.xPinFabrix.pollOnce()`);
    check("F7: a malformed Bridge request is skipped, not executed",
      skipped.handled === 1 && skipped.outcomes[0].status === "skipped", JSON.stringify(skipped));
    check("F7: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F8: offline operation + version negotiation (fail closed) */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEval(b, `window.xPinFabrix.setEnabled(true)`);
    let err = null;
    try { await fabrixEval(b, `window.xPinFabrix.connect()`); } catch (e) { err = e; }
    check("F8: connect with no port/token is transport_unavailable", err && err.code === "transport_unavailable", err && err.code);
    await fabrixEval(b, `window.xPinFabrix.setTransport("local", { port: "51234", token: "x".repeat(20) })`);
    // Bridge answers status but the contract fetch 404s -> fail closed.
    b.win.fetch = async (url) => {
      const u = String(url);
      if (u.includes("__fabrix/v1/bridge/contract")) return { ok: false, status: 404, text: async () => "not found" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, build_id: "rc19.8", protocol_1_2: "1.0", manifest_schema: "fabrix.manifest/1" }) };
    };
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.connect()`); } catch (e) { err = e; }
    check("F8: unreadable contract fails closed (transport_unavailable)", err && err.code === "transport_unavailable", err && err.code);
    // Contract with a version-2 schema -> protocol_mismatch, no retry.
    b.win.fetch = async (url) => {
      const u = String(url);
      if (u.includes("__fabrix/v1/bridge/contract")) return { ok: true, status: 200, text: async () => JSON.stringify({ manifest_schema: "fabrix.manifest/2", schemaVersion: "2.0" }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, build_id: "rc19.8", protocol_1_2: "1.0", manifest_schema: "fabrix.manifest/2" }) };
    };
    err = null;
    try { await fabrixEval(b, `window.xPinFabrix.connect()`); } catch (e) { err = e; }
    check("F8: incompatible manifest_schema is protocol_mismatch", err && err.code === "protocol_mismatch", err && err.code);
    // Compatible contract -> connects.
    b.win.fetch = async (url) => {
      const u = String(url);
      if (u.includes("__fabrix/v1/bridge/contract")) return { ok: true, status: 200, text: async () => JSON.stringify({ manifest_schema: "fabrix.manifest/1", schemaVersion: "1.0", capability_routes: { requests: true, receipts: true } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, build_id: "rc19.8", protocol_1_2: "1.0", manifest_schema: "fabrix.manifest/1" }) };
    };
    const status = await fabrixEval(b, `window.xPinFabrix.connect()`);
    check("F8: compatible contract connects", status && status.ok === true && status.build_id === "rc19.8", JSON.stringify(status));
    // The app itself is unaffected by transport trouble.
    const { doc, win } = b;
    clickEl(doc.getElementById("new-note"), win);
    typeInto(doc.getElementById("note-title"), "Offline note", win);
    const listText = doc.getElementById("note-list").textContent;
    check("F8: the app still creates notes while the transport is down", listText.includes("Offline note"), listText.slice(0, 200));
    check("F8: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F9: state sanitizer — drops unknowns, migrates the flat grant shape,
   * redacts stored bodies; enabled + grants survive save/load */
  {
    const b = bootFabrix(null);
    await flush(80);
    const clean = await fabrixEval(b, `window.xPinFabrixState.sanitize({ enabled: true, transport: "mock", unknownField: 1, grants: { read: true, write: false, grantedAt: "2026-01-01T00:00:00.000Z", scope: { folderIds: ["folder-a"] } }, receipts: [{ receiptId: "r1", requestId: "q1", capability: "notes.read", status: "ok" }], idempotency: { k1: { result: { note: { id: "n1", body: "SECRET BODY" } }, at: "2026-01-01T00:00:00.000Z" } } })`);
    check("F9: sanitizer drops unknown fields", !("unknownField" in clean));
    check("F9: sanitizer migrates the flat Phase 2 grant shape",
      clean.grants.read.granted === true && clean.grants.read.grantedAt === "2026-01-01T00:00:00.000Z" && clean.grants.read.scope.folderIds[0] === "folder-a",
      JSON.stringify(clean.grants));
    check("F9: sanitizer defaults a missing receipt action to invoke",
      clean.receipts[0].action === "invoke", JSON.stringify(clean.receipts[0]));
    check("F9: sanitizer redacts bodies in stored idempotency entries",
      clean.idempotency.k1.result.note.body === "[redacted]", JSON.stringify(clean.idempotency.k1));
    const big = await fabrixEval(b, `(function () { var o = {}; for (var i = 0; i < 30; i++) o["k" + i] = new Array(301).join("x"); return window.xPinFabrixState.redactResult(o); })()`);
    check("F9: redactResult caps an oversized result",
      big && big.redacted === true && Array.isArray(big.keys) && big.keys.length === 30,
      JSON.stringify(big).slice(0, 120));
    const b2 = bootFabrix(fabrixSeed());
    await flush(80);
    await fabrixEval(b2, `window.xPinFabrix.setEnabled(true)`);
    await fabrixEval(b2, `window.xPinFabrix.grant("read", { folderIds: ["folder-a"] })`);
    const saved = b2.storageData["xPin.workspace.v1"];
    const b3 = bootFabrix({ "xPin.workspace.v1": saved });
    await flush(80);
    const status3 = await fabrixEval(b3, `window.xPinFabrix.getStatus()`);
    check("F9: enabled + grant survive save/load",
      status3.enabled === true && status3.grants.read === true && status3.scopes.read[0] === "folder-a",
      JSON.stringify(status3));
    check("F9: no console errors", b.errors.length === 0 && b3.errors.length === 0,
      (b.errors.concat(b3.errors)).slice(0, 3).join(" | "));
  }

  /* F10: crypto helpers — probe, canonical JSON, Ed25519 round-trip */
  {
    const b = bootFabrix(null);
    await flush(80);
    const probe = await fabrixEval(b, `window.xPinFabrixCrypto.probeEd25519()`);
    check("F10: Ed25519 probe succeeds in this runtime", probe === true);
    check("F10: canonical JSON sorts keys recursively",
      (await fabrixEval(b, `window.xPinFabrixCrypto.canonical({ b: 1, a: { d: 4, c: 3 } })`)) === '{"a":{"c":3,"d":4},"b":1}');
    const roundTrip = await fabrixEval(b, `(async () => {
      const pair = await window.xPinFabrixCrypto.generateKeyPair();
      const pub = await window.xPinFabrixCrypto.importPublicKey(pair.publicKey);
      const sig = await window.xPinFabrixCrypto.sign(pair.privateKey, { capability: "notes.read" });
      return window.xPinFabrixCrypto.verify(pub, { capability: "notes.read" }, sig);
    })()`);
    check("F10: Ed25519 sign/verify round-trips", roundTrip === true);
    check("F10: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F11: settings panel renders in the fake DOM — enable, scope, reason */
  {
    const b = bootFabrix(fabrixSeed());
    await flush(80);
    const { doc, win } = b;
    await fabrixEval(b, `document.body.append(window.xPinFabrix.renderSettingsSection(document))`);
    let section = doc.getElementById("fabrix-settings");
    check("F11: settings panel renders", !!section && section.textContent.includes("fabriX integration"));
    const enableBtn = [...section.querySelectorAll("button")].find((el) => /Enable fabriX/.test(el.textContent));
    check("F11: enable button is present", !!enableBtn);
    clickEl(enableBtn, win);
    check("F11: clicking Enable enables the adapter",
      (await fabrixEval(b, `window.xPinFabrix.getStatus()`)).enabled === true);
    section = doc.getElementById("fabrix-settings");
    const scopeBoxes = [...doc.querySelectorAll("input")].filter((el) => (el.getAttribute("aria-label") || "").startsWith("Scope fabriX read to folder "));
    check("F11: panel re-renders with a scope checkbox per folder",
      scopeBoxes.length === 2 &&
      scopeBoxes.some((el) => el.getAttribute("aria-label").includes("Folder A")) &&
      scopeBoxes.some((el) => el.getAttribute("aria-label").includes("Folder B")),
      scopeBoxes.map((el) => el.getAttribute("aria-label")).join(" | "));
    const scopeBox = [...doc.querySelectorAll("input")].find((el) => el.getAttribute("aria-label") === "Scope fabriX read to folder Folder A");
    check("F11: read scope checkbox exists per folder", !!scopeBox);
    scopeBox.checked = true;
    scopeBox.dispatchEvent(new win.Event("change", { bubbles: true }));
    const scopes = (await fabrixEval(b, `window.xPinFabrix.getStatus()`)).scopes;
    check("F11: checking a scope box limits the read scope", (scopes.read || []).includes("folder-a"), JSON.stringify(scopes));
    const reasonInput = [...doc.querySelectorAll("input")].find((el) => el.getAttribute("aria-label") === "Write approval reason");
    check("F11: write reason field exists", !!reasonInput);
    reasonInput.value = "Hub filing";
    reasonInput.dispatchEvent(new win.Event("change", { bubbles: true }));
    const state = await fabrixEval(b, `window.xPinFabrix.getState()`);
    check("F11: reason is recorded without granting write",
      state.grants.write.reason === "Hub filing" && state.grants.write.granted === false,
      JSON.stringify(state.grants.write));
    check("F11: no console errors", b.errors.length === 0, b.errors.slice(0, 3).join(" | "));
  }

  /* F12: prepare-web copies all 10 adapter files (incl. manifest.json) */
  {
    const fileManifest = JSON.parse(fs.readFileSync(REPO + "/integrations/fabrix/manifest.json", "utf8"));
    execSync("node scripts/prepare-web.mjs", { cwd: REPO, stdio: "pipe" });
    const built = JSON.parse(fs.readFileSync(REPO + "/www/integrations/fabrix/manifest.json", "utf8"));
    check("F12: prepare-web copies manifest.json to www/",
      JSON.stringify(built) === JSON.stringify(fileManifest));
    const expected = ["state.js", "crypto.js", "permissions.js", "transport.js", "mock-transport.js", "domain.js", "capabilities.js", "adapter.js", "settings.js", "manifest.json"];
    check("F12: all 10 adapter files land in www/integrations/fabrix/",
      expected.every((f) => fs.existsSync(REPO + "/www/integrations/fabrix/" + f)),
      expected.filter((f) => !fs.existsSync(REPO + "/www/integrations/fabrix/" + f)).join(","));
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
