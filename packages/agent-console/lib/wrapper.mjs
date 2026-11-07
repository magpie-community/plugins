// 1.3 sleep/wake self-heal: a tiny page the gate serves at http://127.0.0.1:<gate port>/app#t=<token>&p=<daemon port>&b=<back>.
//
// Before 1.3 the plugin frame was navigated straight to the daemon's random port. When the computer slept and the daemon was
// gone afterwards (or the WebView reloaded the frame), the frame reloaded that dead address: "127.0.0.1 拒绝连接", and no
// script of ours was left to recover. Now the frame stays on the gate's stable port and shows the daemon page in a child
// iframe. A reload lands on the gate (alive as long as the plugin host is), and this page notices the child is not there:
//   - the child posts {ac_console:"alive"} every 2 s while its WebSocket is open and {ac_console:"lost",at} after 5 s without it;
//   - no "alive" within 12 s of loading (6 s after the child frame loaded), a "lost", or 15 s of silence (only while visible, and not counting time this page's
//     own timers were suspended by sleep) → go back through the Magpie plugin page (b), like 1.1's self-heal: boot.js reads the
//     fresh session.js and opens the gate, which restarts the daemon and sends the frame here again with the new port.
//   - at most 3 automatic tries in 2 minutes (counted in ?ac_try=<start>.<n>, carried through b → boot.js → gate → here);
//     then a button, so a daemon that can't start doesn't loop forever.
//   - coming back to the page (visibilitychange → visible, or window focus) checks at once instead of waiting out the timers
//     that were pushed back while hidden: if the child never said alive within bootMs of loading, or its last real alive is
//     older than silentMs, it gets probeMs (two heartbeats) to speak up, then recover(); a child that is still alive is
//     never refreshed. If an end state with Reconnect is showing, coming back counts as the user clicking it (also when
//     the 3 automatic tries are used up), so the user never returns to a dead button.
//   - every disconnect / invalid-link end state shows a Reconnect button. A missing #b= is filled from sessionStorage
//     (last safe Magpie back URL written when this page first saw a valid b; read/write re-run safeBack). With a stored
//     back, recover navigates via go(false). With none: if this page is framed by Magpie (window.parent !== window), it
//     posts { magpie: 1, method: "error", params: { message } } so the host shows its Try-again card and rebuilds the
//     plugin iframe; Reconnect does the same and falls back to location.reload() after 300 ms if the frame was not
//     unloaded. The copy tells the user to turn the Agent Console plugin off and on again in Magpie's Plugins page if
//     that is still not enough (switching Magpie top-bar tabs does not rebuild the iframe within IDLE_MS).
//
// Security: this page holds no secret of its own. The daemon token arrives only in its # fragment (as before, never sent to a
// server, not in Referer) and is handed to the child in the child's fragment; the gate key is never here. The child is always
// http://127.0.0.1:<integer port>/, b must pass the same Magpie-page check as everywhere else (http(s) on loopback only,
// path /_magpie/plugin/<id>/(page/)?index.html, no credentials — no open redirect; never the desktop window's
// wails://localhost or http://wails.localhost, which this frame can't navigate to: see gate.mjs safeBackUrl),
// and only the Magpie theme protocol is relayed (theme events / hello answers down, the hello call up). The page runs inside
// Magpie's sandboxed plugin frame (opaque origin) and is served with a nonce-only CSP.

/** Same check as safeBackUrl in gate.mjs / web/src/api/backToMagpie.ts, as source for the page: loopback Magpie pages only
 *  (magpie web). Never Magpie's desktop window (wails://localhost, http://wails.localhost): see gate.mjs safeBackUrl. */
const SAFE_BACK_SRC = String.raw`function safeBack(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  var u; try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  var h = u.hostname.toLowerCase();
  var loopback = h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  if (!loopback) return null;
  if (!/^\/_magpie\/plugin\/[A-Za-z0-9_-]{1,128}\/(?:page\/)?index\.html$/.test(u.pathname)) return null;
  return u.protocol + "//" + u.host + u.pathname + u.search;
}`;

/** ?ac_try=<start ms>.<n>: valid shape only */
export function parseTry(raw) {
  const m = /^(\d{10,15})\.([0-9])$/.exec(typeof raw === "string" ? raw : "");
  return m ? { start: Number(m[1]), n: Number(m[2]) } : null;
}

export const WRAP_TIMING = { bootMs: 12000, afterLoadMs: 6000, silentMs: 15000, maxTries: 3, triesWindowMs: 120000, probeMs: 4000 };

const SCRIPT = String.raw`(function () {
  "use strict";
  var T = __TIMING__;
  ${SAFE_BACK_SRC}
  var frag = new URLSearchParams(location.hash.slice(1));
  var token = frag.get("t") || "";
  var port = Number(frag.get("p"));
  var BACK_KEY = "ac_wrap_back";
  // A stored value that no longer passes safeBack (e.g. http://wails.localhost/… kept by 1.3.5 / 1.3.6) is never followed
  // and is dropped. (Inside Magpie's sandboxed frame this page has an opaque origin and sessionStorage throws: null.)
  function readStoredBack() {
    try {
      var raw = sessionStorage.getItem(BACK_KEY);
      var v = safeBack(raw);
      if (raw && !v) sessionStorage.removeItem(BACK_KEY);
      return v;
    } catch (e) { return null; }
  }
  function writeStoredBack(v) {
    if (!v) return;
    try { sessionStorage.setItem(BACK_KEY, v); } catch (e) {}
  }
  var back = safeBack(frag.get("b"));
  if (back) writeStoredBack(back);
  var q = new URLSearchParams(location.search);
  var lang = (q.get("lang") || "").toLowerCase();
  var zh = !lang || lang.indexOf("zh") === 0;
  if (q.get("theme") === "dark") document.documentElement.className = "dark";
  var f = document.getElementById("f");
  var box = document.getElementById("m");
  var said = document.getElementById("s");
  var btn = document.getElementById("r");
  var RECONNECT = ["重新连接", "Reconnect"];
  function onReturn(fn) {
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") fn(); });
    window.addEventListener("focus", function () { if (document.visibilityState !== "hidden") fn(); });
  }
  function msg(zhText, enText, button) {
    said.textContent = zh ? zhText : enText;
    box.hidden = false;
    if (button) { btn.textContent = zh ? button[0] : button[1]; btn.hidden = false; }
  }
  // Ask Magpie's parent frame to show its native "Try again" card: pluginpages.js broke(key) → kernel.js fail() replaces
  // #view-<key>'s children (this frame included) with the card at once, and Try again runs open(key) again, a fresh
  // <iframe sandbox=allow-scripts> on the Magpie page URL → boot.js → fresh session.js → new gate /open → new daemon.
  // Used whenever there is no loopback #b=: always in Magpie's desktop window (wails://localhost on macOS / Linux,
  // http://wails.localhost on Windows, neither reachable from this http page).
  function askMagpieRetry(why) {
    if (window.parent === window) return false;
    try {
      window.parent.postMessage({ magpie: 1, method: "error", params: { message: why || (zh ? "本地服务已断开" : "Local service disconnected") } }, "*");
      return true;
    } catch (e) { return false; }
  }
  // The Reconnect action of the end state on screen (null while none is): coming back to the page runs it once
  var ended = null;
  function wireReconnect(targetBack) {
    ended = btn.onclick = function () {
      if (btn.disabled) return;
      btn.disabled = true;
      if (targetBack) { location.replace(targetBack); return; }
      // Framed in Magpie: ask the host to rebuild the plugin iframe (Magpie removes this frame right away). The reload is
      // only a fallback for a parent that ignores the message; it reloads this same #t=/p= and doesn't get a new session.
      if (askMagpieRetry()) {
        setTimeout(function () { location.reload(); }, 300);
      } else {
        location.reload();
      }
    };
  }
  if (!/^[0-9a-f]{32,128}$/i.test(token) || !(port > 0 && port < 65536 && Math.floor(port) === port)) {
    msg(
      "链接已失效。请点重新连接；若仍不行，可在 Magpie「插件」页关闭再打开「Agent 控制台」。",
      "This link is no longer valid. Click Reconnect; if that fails, turn the Agent Console plugin off and on again in Magpie's Plugins page.",
      RECONNECT
    );
    var invalidBack = back || readStoredBack();
    wireReconnect(invalidBack);
    if (!invalidBack) askMagpieRetry(zh ? "链接已失效" : "This link is no longer valid");
    onReturn(function () { if (ended) ended(); });
    return;
  }

  // Child: the daemon page. Theme / language / colour tokens go along in its query, the token in its fragment; w=1 tells it
  // to report to this page instead of navigating itself.
  var cq = new URLSearchParams();
  ["theme", "lang", "tokens"].forEach(function (k) { if (q.has(k)) cq.set(k, q.get(k)); });
  f.src = "http://127.0.0.1:" + port + "/?" + cq.toString() + "#t=" + encodeURIComponent(token) + "&w=1";

  var everAlive = false, lastAlive = 0, recovering = false;
  var loadedAt = Date.now(), lastTick = Date.now();
  // Unlike lastAlive / loadedAt these are never pushed back while hidden or asleep: what the return check compares against
  var heardAt = 0, bootAt = loadedAt, probeFrom = 0, probeUntil = 0;
  msg("正在连接本地服务…", "Connecting to the local service…");
  // A dead port shows the browser's error page, which also fires load: once loaded, the child gets T.afterLoadMs to say alive
  f.addEventListener("load", function () {
    if (!everAlive) {
      loadedAt = Math.min(loadedAt, Date.now() - (T.bootMs - T.afterLoadMs));
      bootAt = Math.min(bootAt, Date.now() - (T.bootMs - T.afterLoadMs));
    }
  });

  function recover(at) {
    if (recovering) return;
    recovering = true;
    f.classList.remove("on");
    var now = Date.now();
    var t = (function (raw) { var m = /^(\d{10,15})\.([0-9])$/.exec(raw || ""); return m ? { start: +m[1], n: +m[2] } : null; })(q.get("ac_try"));
    if (!t || now - t.start > T.triesWindowMs || t.start > now) t = { start: now, n: 0 };
    // #b= missing (or unsafe): reuse the last safe Magpie back URL from this origin, then go(false) — not an auto try
    if (!back) {
      back = readStoredBack();
      if (back) {
        msg("本地服务已断开，正在重新连接…", "The local service disconnected. Reconnecting…");
        var uStored = new URL(back);
        if (at > 0) uStored.searchParams.set("ac_lost", String(Math.floor(at)));
        location.replace(uStored.toString());
        return;
      }
      msg(
        "本地服务已断开。请点重新连接；若仍不行，可在 Magpie「插件」页关闭再打开「Agent 控制台」。",
        "The local service disconnected. Click Reconnect; if that fails, turn the Agent Console plugin off and on again in Magpie's Plugins page.",
        RECONNECT
      );
      wireReconnect(null);
      // Magpie iframe with no usable #b=: notify the host immediately so its Try-again card appears (one click rebuilds the frame).
      askMagpieRetry(zh ? "本地服务已断开" : "Local service disconnected");
      return;
    }
    var go = function (auto) {
      var u = new URL(back);
      if (at > 0) u.searchParams.set("ac_lost", String(Math.floor(at)));
      if (auto) u.searchParams.set("ac_try", t.start + "." + (t.n + 1));
      location.replace(u.toString());
    };
    if (t.n >= T.maxTries) {
      msg("本地服务多次重连失败。", "Reconnecting to the local service failed several times.", RECONNECT);
      ended = btn.onclick = function () { if (btn.disabled) return; btn.disabled = true; go(false); };
      return;
    }
    msg("本地服务已断开，正在重新连接…", "The local service disconnected. Reconnecting…");
    go(true);
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (e.source === f.contentWindow) {
      if (d.ac_console === "alive") {
        lastAlive = heardAt = Date.now();
        probeUntil = 0;
        if (!everAlive) { everAlive = true; box.hidden = true; f.classList.add("on"); }
        return;
      }
      if (d.ac_console === "lost") { recover(Number(d.at) || Date.now()); return; }
      // The child's Magpie bridge "hello" (asks for the current theme) goes up as a fresh object, nothing else
      if (d.magpie === 1 && d.method === "hello" && typeof d.id === "number" && window.parent !== window) {
        window.parent.postMessage({ magpie: 1, id: d.id, method: "hello" }, "*");
      }
      return;
    }
    if (e.source === window.parent && d.magpie === 1 && f.contentWindow) {
      // Theme events and hello answers go down (rebuilt: only the fields the child reads)
      if (d.event === "theme") f.contentWindow.postMessage({ magpie: 1, event: "theme", data: d.data }, "*");
      else if (typeof d.id === "number" && "result" in d) f.contentWindow.postMessage({ magpie: 1, id: d.id, result: d.result }, "*");
    }
  });

  // The page is visible again: don't wait for the timers that were pushed back while hidden
  function checkOnReturn() {
    if (ended) { ended(); return; } // an end state is showing: same as clicking Reconnect (even with the auto tries used up)
    if (recovering || probeUntil) return;
    var now = Date.now();
    var stale = everAlive ? now - heardAt > T.silentMs : now - bootAt > T.bootMs;
    if (stale) { probeFrom = now; probeUntil = now + T.probeMs; } // a child that is still there answers with its next heartbeat
  }
  onReturn(checkOnReturn);

  setInterval(function () {
    var now = Date.now();
    var prevTick = lastTick, gap = now - lastTick;
    lastTick = now;
    if (probeUntil) {
      // Hidden or suspended again after the probe started: drop it (a gap that ended before it, e.g. the wake itself, is fine)
      if (document.visibilityState === "hidden" || (gap > 5000 && prevTick >= probeFrom)) probeUntil = 0;
      else if (now >= probeUntil) { probeUntil = 0; recover(everAlive ? heardAt : 0); return; }
    }
    // This page's own timers were held (sleep, a frozen or heavily throttled frame): give the child a fresh window
    if (gap > 5000 || document.visibilityState === "hidden") {
      if (everAlive) lastAlive = Math.max(lastAlive, now);
      else loadedAt = Math.max(loadedAt, now);
      return;
    }
    if (!everAlive) { if (now - loadedAt > T.bootMs) recover(0); return; }
    if (now - lastAlive > T.silentMs) recover(lastAlive);
  }, 1000);
})();`;

/** The wrapper page; nonce must be fresh per response (it is the only thing the CSP allows to run) */
export function wrapperHtml(nonce, timing = WRAP_TIMING) {
  const script = SCRIPT.replace("__TIMING__", JSON.stringify(timing));
  return (
    "<!doctype html><html><head><meta charset=utf-8><meta name=referrer content=no-referrer>" +
    "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Agent Console</title>" +
    `<style nonce="${nonce}">` +
    "html,body{margin:0;height:100%;overflow:hidden;background:#fff;color:#525252;font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif}" +
    "html.dark,html.dark body{background:#1a1a1a;color:#a3a3a3}" +
    "iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block;visibility:hidden}" +
    "iframe.on{visibility:visible}" +
    "#m{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}" +
    "#m[hidden]{display:none}" +
    "button{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid currentColor;background:none;color:inherit;cursor:pointer}" +
    "</style></head><body>" +
    "<iframe id=f allow=\"clipboard-read; clipboard-write\" referrerpolicy=no-referrer title=\"Agent Console\"></iframe>" +
    "<div id=m hidden><p id=s></p><button id=r type=button hidden></button></div>" +
    `<script nonce="${nonce}">${script}</script>` +
    "</body></html>"
  );
}

/**
 * Who may frame /app: the gate itself, a loopback page (Magpie's plugin page and `magpie web` on this computer) and
 * Magpie's desktop window, which is wails://localhost on macOS / Linux and http://wails.localhost on Windows (WebView2).
 * Any other site gets a blank frame. Keep in sync with the README's security section.
 */
export const WRAPPER_FRAME_ANCESTORS =
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://[::1]:* http://wails.localhost:* wails:";

export function wrapperCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "frame-src http://127.0.0.1:*",
    WRAPPER_FRAME_ANCESTORS,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
