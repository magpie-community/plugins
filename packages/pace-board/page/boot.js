// 本文由AI自动生成
// 带路页：把自己导航到插件自己的本地服务。
//
// 为什么必须「直接跳」而不是先探测：插件页面的 CSP 是 default-src 'none'，
// fetch/XHR/WebSocket 全被挡住，连 no-cors 都会失败。magpie 文档说得很清楚——
// 这个页面唯一能做的联网动作就是把自己导航到别处。
//
// magpie web（在另一台电脑上打开）时 127.0.0.1 指的是看页面那台机器，
// 所以优先用 bridge 给的 magpie.service；桌面窗口下就用 127.0.0.1:port。

(async () => {
  const msg = document.getElementById("msg");
  const DEFAULT_PORT = 3488;
  const say = (t, cls) => {
    if (!msg) return;
    msg.textContent = t;
    if (cls) msg.className = cls;
  };

  let port = DEFAULT_PORT;
  let theme = "";
  let lang = "";
  let service = "";

  try {
    const t = await window.magpie?.ready;
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (typeof t.lang === "string") lang = t.lang;
    }
  } catch {
    /* 没有 bridge 就按浅色来 */
  }
  if (theme) document.documentElement.dataset.theme = theme;

  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch {
    /* 旧版 magpie 没有 service */
  }

  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch {
    /* 读不到选项就用默认端口，和 package.json 里的默认值一致 */
  }

  const base = service || `http://127.0.0.1:${port}`;
  const q = new URLSearchParams();
  if (theme) q.set("theme", theme);
  if (lang) q.set("lang", lang);
  const url = `${base}/${q.toString() ? "?" + q.toString() : ""}`;

  say("正在打开额度节奏盘…");
  try {
    location.replace(url);
  } catch {
    say("跳转失败。", "err");
  }

  // 3 秒还没走，说明服务没起来——把地址给出来，别让人对着转圈猜。
  setTimeout(() => {
    if (document.visibilityState === "hidden") return;
    say(`服务好像没起来。确认 magpie 已加载本插件，或直接打开 ${base}`, "err");
  }, 3000);
})();
