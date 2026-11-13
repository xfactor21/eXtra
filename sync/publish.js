/* xPin publish bundle — Phase 1 (research #15).
 *
 * Builds on the Phase 0 M6 fix (static export renders Markdown): a
 * "Publish" flow produces a publish bundle — a self-contained HTML page
 * plus a publish manifest — with one-click download and a local preview.
 *
 * Honest scope: a publish TARGET is configured in settings (default: none).
 * With no target the bundle itself is the deliverable ("host this file
 * yourself, or configure a publish service"). No hosted publishing exists
 * and none is claimed. The bundle is built through the same transport
 * abstraction as sync: when a target is configured later, the bundle is
 * what gets sent; today the target list is empty by design.
 *
 * Pure builder: takes a note + a Markdown→HTML renderer, returns
 * {fileName, html, manifest}. The host (app.js) owns download/preview.
 */
(() => {
  "use strict";

  const XPIN_VERSION = "1.0.0";

  function slugifyFileName(value, fallback = "note") {
    const slug = String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || fallback;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function buildPublishBundle(note, renderMarkdown) {
    if (!note || typeof note.id !== "string" || typeof note.title !== "string" || typeof note.body !== "string") {
      throw new TypeError("Publish needs a note with an id, title, and body.");
    }
    if (typeof renderMarkdown !== "function") throw new TypeError("Publish needs a Markdown renderer.");
    const title = note.title.trim() || "Untitled note";
    const rendered = renderMarkdown(note.body);
    const publishedAt = new Date().toISOString();
    const manifest = {
      format: "xpin-publish-bundle",
      version: 1,
      noteId: note.id,
      title,
      publishedAt,
      xPinVersion: XPIN_VERSION,
      target: null // no publish target configured; the bundle is the deliverable
    };
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="A page published from xPin"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{max-width:760px;margin:12vh auto;padding:0 24px;background:#07151d;color:#e8f4f6;font:17px/1.8 system-ui,sans-serif}h1{font-size:clamp(2rem,7vw,3.8rem);letter-spacing:-.05em;line-height:1.05}h2{font-size:1.5rem;margin-top:2.2em}h3{font-size:1.2rem;margin-top:1.8em}article{color:#b8cbd0}article p{margin:1em 0}article a{color:#54dce8}article ul,article ol{padding-left:1.4em}article li{margin:.35em 0}article blockquote{margin:1.2em 0;padding-left:1em;border-left:3px solid #54dce8;color:#8da7ac}article pre{background:#0a1f28;padding:14px;border-radius:8px;overflow:auto}article code{font:14px/1.6 ui-monospace,monospace}article pre code{background:none;padding:0}article table{border-collapse:collapse}article th,article td{padding:6px 12px;border:1px solid #294650;text-align:left}footer{margin-top:4rem;color:#8299a1;font-size:.8rem}</style></head><body><main><h1>${escapeHtml(title)}</h1><article>${rendered}</article><footer>Published from xPin · ${escapeHtml(publishedAt.slice(0, 10))}</footer></main><script type="application/json" id="xpin-publish-manifest">${JSON.stringify(manifest).replace(/</g, "\\u003c")}</script></body></html>`;
    return {
      fileName: `${slugifyFileName(title)}.html`,
      html,
      manifest
    };
  }

  window.xPinPublish = Object.freeze({
    XPIN_VERSION,
    buildPublishBundle,
    slugifyFileName
  });
})();
