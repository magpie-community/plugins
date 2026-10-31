// The small script the preview proxy adds to HTML pages it serves (as /__agent_console__/preview.js, an external script
// so a dev app's CSP against inline scripts doesn't block it). Inside Magpie the preview frame is an opaque origin
// (sandbox="allow-scripts" is inherited), so:
//  1. localStorage / sessionStorage / document.cookie throw SecurityError → replace them with in-memory stand-ins
//     (lost on reload; the README says so);
//  2. navigation bridge: report {ac_preview:1, href, title} to the parent page, and take {ac_preview_cmd} back/forward/reload
//     from the parent only. Nothing else is accepted.
export const PREVIEW_SCRIPT_PATH = "/__agent_console__/preview.js";

export const PREVIEW_SCRIPT = `(function(){
  "use strict";
  if (window.__acPreview) return; window.__acPreview = 1;
  function mem(){ var m = new Map(); var s = {
    getItem: function(k){ k = String(k); return m.has(k) ? m.get(k) : null; },
    setItem: function(k, v){ m.set(String(k), String(v)); },
    removeItem: function(k){ m.delete(String(k)); },
    clear: function(){ m.clear(); },
    key: function(i){ var a = Array.from(m.keys()); return i >= 0 && i < a.length ? a[i] : null; }
  }; Object.defineProperty(s, "length", { get: function(){ return m.size; } }); return s; }
  ["localStorage", "sessionStorage"].forEach(function(n){
    var ok = true; try { var st = window[n]; st.getItem("__ac"); } catch (e) { ok = false; }
    if (!ok) { try { Object.defineProperty(window, n, { value: mem(), configurable: true }); } catch (e) {} }
  });
  try { void document.cookie; } catch (e) {
    var jar = {};
    try { Object.defineProperty(document, "cookie", { configurable: true,
      get: function(){ return Object.keys(jar).map(function(k){ return k + "=" + jar[k]; }).join("; "); },
      set: function(v){ var p = String(v).split(";")[0]; var i = p.indexOf("="); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
    }); } catch (e2) {}
  }
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  var last = "";
  function report(){ try {
    var msg = { ac_preview: 1, href: String(location.href), title: String(document.title || "") };
    var key = msg.href + "\\n" + msg.title; if (key === last) return; last = key;
    parentWin.postMessage(msg, "*");
  } catch (e) {} }
  ["pushState", "replaceState"].forEach(function(k){
    var orig = history[k]; if (typeof orig !== "function") return;
    history[k] = function(){ var r = orig.apply(this, arguments); setTimeout(report, 0); return r; };
  });
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  window.addEventListener("load", report);
  document.addEventListener("DOMContentLoaded", report);
  setInterval(report, 1000);
  window.addEventListener("message", function(e){
    if (e.source !== parentWin) return;
    var d = e.data; if (!d || typeof d !== "object") return;
    var c = d.ac_preview_cmd;
    if (c === "back") history.back();
    else if (c === "forward") history.forward();
    else if (c === "reload") location.reload();
    else if (c === "ping") { last = ""; report(); }
  });
  report();
})();
`;

/** Insert the script tag right after <head …> (else after <html …>, else after the doctype, else at the start). */
export function injectScriptTag(html: string): string {
  const tag = `<script src="${PREVIEW_SCRIPT_PATH}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}
