// Navigate magpie's frame to the board service.
//
// Prefer window.magpie.service: magpie web proxies the service on its own address, so the
// page stays under magpie's origin and magpie's own key/auth is the gate. A desktop window
// has no service; fall back to loopback on the port from the manifest options — the same
// value the service itself was started with, so they can never disagree.
//
// Do not probe the service: the page's CSP is connect-src 'none', so fetch/XHR is refused.
// The progress bar here is therefore driven by two real signals only — the bridge handshake
// (window.magpie.ready) and elapsed time. The meta refresh in index.html (8 s) is the last
// fallback if this script never runs.
(async () => {
  const DEFAULT_PORT = 3455;
  const words = {
    en: {
      title: "Usage Board",
      bridging: "Connecting to the host bridge…",
      slow: "Bridge is slow — opening the local board…",
      err: (m) => `Bridge did not respond: ${m} — opening the local board…`,
      nobridge: "No host bridge detected — opening the local board…",
      ready: "Board located, navigating…",
      readyLocal: "Ready — opening the local board…",
    },
    zh: {
      title: "用量看板",
      bridging: "正在连接宿主桥接…",
      slow: "桥接响应慢，即将直接打开本机看板…",
      err: (m) => `桥接未响应：${m} —— 将直接打开本机看板…`,
      nobridge: "未检测到宿主桥接，直接打开本机看板…",
      ready: "已定位看板服务，正在跳转…",
      readyLocal: "已就绪，正在打开本机看板…",
    },
  };
  let lang = String(navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  let port = DEFAULT_PORT;
  const bar = document.getElementById("bar");
  const msg = document.getElementById("msg");
  const say = (t, bad) => {
    if (!msg) return;
    msg.textContent = t;
    msg.classList.toggle("bad", !!bad);
  };
  const setBar = (pct, bad) => {
    if (!bar) return;
    bar.style.width = pct + "%";
    if (bar.parentElement) bar.parentElement.classList.toggle("bad", !!bad);
  };
  setBar(18);
  // 桥接慢时进度条缓慢爬行，6 秒后预告回退（meta refresh 8 秒兜底）
  const creep = setInterval(() => setBar(Math.min(38, (parseFloat(bar?.style.width) || 18) + 2.5)), 350);
  let service = "";
  let bridgeErr = "";
  const hasBridge = !!window.magpie;
  try {
    const current = await window.magpie?.ready;
    if (current) {
      if (typeof current.lang === "string" && current.lang) {
        lang = current.lang.toLowerCase().startsWith("zh") ? "zh" : "en";
      }
    }
  } catch (e) {
    bridgeErr = (e && e.message) || "bridge handshake failed";
  }
  try {
    const options = await window.magpie?.options?.get?.();
    const n = Number(options?.port);
    if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
  } catch {
    // Use the declared default.
  }
  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch {
    // Desktop windows navigate directly to loopback.
  }
  clearInterval(creep);
  const w = words[lang];
  document.title = w.title;
  const head = document.querySelector(".box b");
  if (head) head.textContent = w.title;
  if (bridgeErr) {
    // 桥接报错：如实展示原因，仍回退打开本机看板
    setBar(30, true);
    say(w.err(bridgeErr), true);
  } else if (!hasBridge) {
    setBar(72);
    say(w.nobridge);
  } else {
    setBar(72);
    say(service ? w.ready : w.readyLocal);
  }
  const target = service || `http://127.0.0.1:${port}/?lang=${lang}`;
  const go = document.getElementById("go");
  if (go) go.setAttribute("content", "0;url=" + target);
  setTimeout(() => {
    try {
      location.replace(target);
    } catch {
      // The meta refresh above still navigates.
    }
  }, 350); // 让用户看清最终状态再跳
})();
