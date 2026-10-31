// Bootstrap page: the only network action of this sandboxed page (no allow-same-origin, connect-src 'none') is navigating itself elsewhere.
//
// Handoff: once the plugin host binds the gate port, it writes {port, key} into session.js in this directory.
// key is only the gate key, not the daemon token: Magpie serves this directory at /_magpie/plugin/<path that changes every launch>/
// without checking the origin, so any page that knows the path can read session.js via <script src>; nothing that unlocks the daemon goes there.
// This page navigates to the gate at http://127.0.0.1:<port>/open?k=<key>; the gate starts the daemon and 302s to the daemon page,
// with the daemon token only in the #t= fragment.
// The window's theme, language and color tokens are passed along too, so that page matches magpie.
(async () => {
  let theme = "";
  let lang = "";
  let tokens = null;

  try {
    const t = await window.magpie?.ready;
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (typeof t.lang === "string") lang = t.lang;
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch { /* no bridge: use defaults */ }

  const zh = !lang || lang.toLowerCase().startsWith("zh");
  const said = document.getElementById("said");
  const brand = document.querySelector(".box b");
  const retry = document.getElementById("retry");
  if (said) said.textContent = zh ? "正在启动本地服务…" : "Starting local service…";
  if (brand) brand.textContent = zh ? "Agent 控制台" : "Agent Console";

  function validSession(s) {
    return (
      s &&
      typeof s === "object" &&
      Number.isInteger(s.port) &&
      s.port > 0 &&
      s.port <= 65535 &&
      typeof s.key === "string" &&
      /^[0-9a-f]{64}$/.test(s.key)
    );
  }

  // Reload an uncached copy of session.js (the key changes after the plugin host restarts).
  // Returns null when the file doesn't exist (the host isn't up yet or the port isn't bound yet).
  function loadFreshSession(attempt) {
    return new Promise((resolve) => {
      globalThis.AgentConsoleSession = undefined;
      const script = document.createElement("script");
      script.src = `session.js?r=${Date.now()}-${attempt}`;
      script.onload = () => {
        script.remove();
        resolve(validSession(globalThis.AgentConsoleSession) ? globalThis.AgentConsoleSession : null);
      };
      script.onerror = () => {
        script.remove();
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }

  // The copy loaded statically by index.html (possibly cached) is only a fallback
  const preloaded = validSession(globalThis.AgentConsoleSession) ? globalThis.AgentConsoleSession : null;
  let session = await loadFreshSession(0);
  if (!session && preloaded) session = preloaded;
  // Right after the host starts the file may not be written yet: retry every 500ms for about 10 seconds
  for (let attempt = 1; !session && attempt <= 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    session = await loadFreshSession(attempt);
  }

  if (!session) {
    if (said) {
      said.textContent = zh
        ? "本地服务还没有就绪。请稍后重试；如果一直这样，请在 Magpie 里重新加载插件。"
        : "The local service is not ready yet. Try again in a moment; if this persists, reload the plugin in Magpie.";
    }
    if (retry) {
      retry.textContent = zh ? "重试" : "Retry";
      retry.hidden = false;
      retry.onclick = () => location.reload();
    }
    return;
  }

  const q = new URLSearchParams();
  q.set("k", session.key);
  if (theme) q.set("theme", theme);
  if (lang) q.set("lang", lang);
  const slim = {};
  for (const [k, v] of Object.entries(tokens || {})) {
    const s = String(v ?? "").trim();
    if (s) slim[k] = s;
  }
  if (Object.keys(slim).length) {
    try { q.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim))))); } catch { /* fine if it can't be passed along */ }
  }

  location.replace("http://127.0.0.1:" + session.port + "/open?" + q.toString());
})();
