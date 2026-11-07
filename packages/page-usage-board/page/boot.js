// Navigate magpie's frame to the board service.
//
// Prefer window.magpie.service: magpie web proxies the service on its own address, so the
// page stays under magpie's origin and magpie's own key/auth is the gate. A desktop window
// has no service; fall back to loopback.
//
// Do not probe the service: the page's CSP is connect-src 'none', so fetch/XHR is refused.
// The progress bar here is therefore driven by two real signals only — the bridge handshake
// (window.magpie.ready) and elapsed time. The meta refresh in index.html (8 s) is the last
// fallback if this script never runs.
(async () => {
  const FALLBACK = "http://127.0.0.1:3455/";
  const bar = document.getElementById("bar");
  const msg = document.getElementById("msg");
  const setBar = (pct, bad) => {
    if (!bar) return;
    bar.style.width = pct + "%";
    if (bar.parentElement) bar.parentElement.classList.toggle("bad", !!bad);
  };
  const say = (t, bad) => {
    if (!msg) return;
    msg.textContent = t;
    msg.classList.toggle("bad", !!bad);
  };
  setBar(18);
  say("正在连接宿主桥接…");
  // 桥接慢时进度条缓慢爬行，6 秒后预告回退（meta refresh 8 秒兜底）
  const creep = setInterval(() => setBar(Math.min(38, (parseFloat(bar?.style.width) || 18) + 2.5)), 350);
  const slowNote = setTimeout(() => say("桥接响应慢，即将直接打开本机看板…"), 6000);
  let service = "";
  let bridgeErr = "";
  const hasBridge = !!window.magpie;
  try {
    await window.magpie?.ready;
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch (e) {
    bridgeErr = (e && e.message) || "桥接握手失败";
  }
  clearInterval(creep);
  clearTimeout(slowNote);
  if (bridgeErr) {
    // 桥接报错：如实展示原因，仍回退打开本机看板
    setBar(30, true);
    say("桥接未响应：" + bridgeErr + " —— 将直接打开本机看板…", true);
  } else if (!hasBridge) {
    setBar(72);
    say("未检测到宿主桥接，直接打开本机看板…");
  } else {
    setBar(72);
    say(service ? "已定位看板服务，正在跳转…" : "已就绪，正在打开本机看板…");
  }
  const target = service || FALLBACK;
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
