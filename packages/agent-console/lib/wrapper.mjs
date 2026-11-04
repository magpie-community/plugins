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
//
// Security: this page holds no secret of its own. The daemon token arrives only in its # fragment (as before, never sent to a
// server, not in Referer) and is handed to the child in the child's fragment; the gate key is never here. The child is always
// http://127.0.0.1:<integer port>/, b must pass the same loopback Magpie-page check as everywhere else (no open redirect),
// and only the Magpie theme protocol is relayed (theme events / hello answers down, the hello call up). The page runs inside
// Magpie's sandboxed plugin frame (opaque origin) and is served with a nonce-only CSP.

/** Same check as safeBackUrl in gate.mjs / web/src/api/backToMagpie.ts, as source for the page */
const SAFE_BACK_SRC = String.raw`function safeBack(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  var u; try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  var h = u.hostname.toLowerCase();
  if (h !== "127.0.0.1" && h !== "localhost" && h !== "[::1]") return null;
  if (!/^\/_magpie\/plugin\/[A-Za-z0-9_-]{1,128}\/(?:page\/)?index\.html$/.test(u.pathname)) return null;
  return u.protocol + "//" + u.host + u.pathname + u.search;
}`;

/** ?ac_try=<start ms>.<n>: valid shape only */
export function parseTry(raw) {
  const m = /^(\d{10,15})\.([0-9])$/.exec(typeof raw === "string" ? raw : "");
  return m ? { start: Number(m[1]), n: Number(m[2]) } : null;
}

export const WRAP_TIMING = { bootMs: 12000, afterLoadMs: 6000, silentMs: 15000, maxTries: 3, triesWindowMs: 120000 };

const SCRIPT = String.raw`(function () {
  "use strict";
  var T = __TIMING__;
  ${SAFE_BACK_SRC}
  var frag = new URLSearchParams(location.hash.slice(1));
  var token = frag.get("t") || "";
  var port = Number(frag.get("p"));
  var back = safeBack(frag.get("b"));
  var q = new URLSearchParams(location.search);
  var lang = (q.get("lang") || "").toLowerCase();
  var zh = !lang || lang.indexOf("zh") === 0;
  if (q.get("theme") === "dark") document.documentElement.className = "dark";
  var f = document.getElementById("f");
  var box = document.getElementById("m");
  var said = document.getElementById("s");
  var btn = document.getElementById("r");
  function msg(zhText, enText, button) {
    said.textContent = zh ? zhText : enText;
    box.hidden = false;
    if (button) { btn.textContent = zh ? button[0] : button[1]; btn.hidden = false; }
  }
  if (!/^[0-9a-f]{32,128}$/i.test(token) || !(port > 0 && port < 65536 && Math.floor(port) === port)) {
    msg("链接已失效，请在 Magpie 里重新打开插件页。", "The link is no longer valid. Please reopen the Agent Console page in Magpie.");
    return;
  }

  // Child: the daemon page. Theme / language / colour tokens go along in its query, the token in its fragment; w=1 tells it
  // to report to this page instead of navigating itself.
  var cq = new URLSearchParams();
  ["theme", "lang", "tokens"].forEach(function (k) { if (q.has(k)) cq.set(k, q.get(k)); });
  f.src = "http://127.0.0.1:" + port + "/?" + cq.toString() + "#t=" + encodeURIComponent(token) + "&w=1";

  var everAlive = false, lastAlive = 0, recovering = false;
  var loadedAt = Date.now(), lastTick = Date.now();
  msg("正在连接本地服务…", "Connecting to the local service…");
  // A dead port shows the browser's error page, which also fires load: once loaded, the child gets T.afterLoadMs to say alive
  f.addEventListener("load", function () {
    if (!everAlive) loadedAt = Math.min(loadedAt, Date.now() - (T.bootMs - T.afterLoadMs));
  });

  function recover(at) {
    if (recovering) return;
    recovering = true;
    f.classList.remove("on");
    var now = Date.now();
    var t = (function (raw) { var m = /^(\d{10,15})\.([0-9])$/.exec(raw || ""); return m ? { start: +m[1], n: +m[2] } : null; })(q.get("ac_try"));
    if (!t || now - t.start > T.triesWindowMs || t.start > now) t = { start: now, n: 0 };
    if (!back) {
      msg("本地服务已断开。请在 Magpie 里重新打开插件页。", "The local service disconnected. Please reopen the Agent Console page in Magpie.");
      return;
    }
    var go = function (auto) {
      var u = new URL(back);
      if (at > 0) u.searchParams.set("ac_lost", String(Math.floor(at)));
      if (auto) u.searchParams.set("ac_try", t.start + "." + (t.n + 1));
      location.replace(u.toString());
    };
    if (t.n >= T.maxTries) {
      msg("本地服务多次重连失败。", "Reconnecting to the local service failed several times.", ["重新连接", "Reconnect"]);
      btn.onclick = function () { btn.disabled = true; go(false); };
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
        lastAlive = Date.now();
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

  setInterval(function () {
    var now = Date.now();
    var gap = now - lastTick;
    lastTick = now;
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

export function wrapperCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "frame-src http://127.0.0.1:*",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
