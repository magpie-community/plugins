// 带路页：把它自己（也就是 magpie 页面那个框架）导航到插件的服务。
//
// 这里必须"直接跳"，不能先探测：
//   页面的 CSP 是 connect-src 'none'，fetch/XHR/WebSocket 全被禁止 ——
//   连 no-cors 的请求都会被直接拒绝。所以「先探一下服务在不在」这条路走不通，
//   alive() 永远返回 false，页面会永远停在等待页。
//   magpie 文档也明说了：这个页面唯一能做的联网动作就是把自己跳转到别处。
//
// 端口用插件选项里的 port（默认 3477），服务端（index.mjs）读的是同一个值。
//
// 顺手把窗口的主题和设计令牌一起带上（magpie 的 bridge 已经把它们算好了），
// 这样对话页的配色和字体跟窗口完全一致，连用户的自定义主题也算在内。
(async () => {
  const DEFAULT_PORT = 3477;
  let port = DEFAULT_PORT;
  let theme = "";
  let tokens = null;

  try {
    const t = await window.magpie?.ready;           // { dark, lang, tokens }
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch { /* 没有 bridge 就退回默认主题 */ }

  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch { /* 没有 options 就用默认端口 */ }

  // 字体不在这里传。
  //
  // 试过从 magpie 页面的 CSS 变量里读 --ui-font 再带过去，但时机靠不住：
  // magpie 是设置加载完之后才把 --ui-font 写到 :root 上的，这里 await 完
  // magpie.ready 立刻读，经常读到空。而且页面 CSP 是 connect-src 'none'，
  // 读不到也没法重试。现在改成服务端直接读 magpie 的 settings.json，
  // 由 /api/fonts.css 提供给对话页 —— 那边什么时候读都准。

  const q = new URLSearchParams();
  if (theme) q.set("theme", theme);
  if (true) {
    // 只留非空的令牌，压成一个短串；令牌本身就是 magpie 自己的 CSS 变量值。
    const slim = {};
    for (const [k, v] of Object.entries(tokens || {})) {
      const s = String(v ?? "").trim();
      if (s) slim[k] = s;
    }
    if (Object.keys(slim).length) {
      try { q.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim))))); } catch { /* 编码不了就只带主题 */ }
    }
  }

  location.replace("http://127.0.0.1:" + port + "/?" + q.toString());
})();
