// 带路页：把它自己（也就是 magpie 页面那个框架）导航到插件的服务。
//
// 这里必须"直接跳"，不能先探测：
//   页面的 CSP 是 connect-src 'none'，一切脚本级联网动作都被禁止 ——
//   「先探一下服务在不在」这条路走不通，只能整页跳转。
//
// 端口用插件选项里的 port（默认 3492），服务端（src/server.ts 经 src/plugin.ts）读同一个值。
//
// 跳到哪：magpie 把页面给浏览器时（`magpie web`，可能在另一台电脑上打开），
// 127.0.0.1 是看页面那台电脑自己，不是跑服务的机器。这时 bridge 会给出
// magpie.service：magpie web 在它自己的地址上替本服务转发的路径（package.json
// 的 magpie.page.service 声明了它）。有就跳那里；没有（桌面窗口，或旧版
// magpie）就照旧跳 127.0.0.1。
//
// 顺手把窗口的主题、界面语言和设计令牌一起带上（magpie 的 bridge 已经把它们算好了），
// 这样窗口预热页的配色跟窗口完全一致，连用户的自定义主题也算在内；语言跟随 magpie 本身，
// 页面不再有自己的语言设置。
(async () => {
  const DEFAULT_PORT = 3492;
  let port = DEFAULT_PORT;
  let theme = "";
  let tokens = null;
  let service = "";
  let lang = "";

  try {
    const t = await window.magpie?.ready;           // { dark, lang, tokens }
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
      if (typeof t.lang === "string" && t.lang) lang = t.lang;
    }
  } catch { /* 没有 bridge 就退回默认主题 */ }
  try {
    // 带路页自己的提示语也跟着 magpie 的语言走（认不出就保持中文默认）
    const said = document.getElementById("said");
    if (said) {
      const l = lang.toLowerCase();
      if (l.startsWith("en")) said.textContent = "Connecting to the local Window Warmup service…";
      else if (l === "zh-tw" || l === "zh-hk" || l === "zh-hant") said.textContent = "正在連線到本機視窗預熱服務…";
      else if (l.startsWith("ja")) said.textContent = "ローカルのウィンドウ予熱サービスに接続しています…";
    }
  } catch { /* 保持中文默认 */ }
  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch { /* 旧版 magpie 没有 service */ }
  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch { /* 没有 options 就用默认端口 */ }

  const q = new URLSearchParams();
  if (theme) q.set("theme", theme);
  if (lang) q.set("lang", lang);
  {
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

  // magpie 给了 service 就走它：这是 magpie web 在自己地址上的转发，远程也能用。
  if (service) {
    location.replace(service + "?" + q.toString());
    return;
  }

  const target = "http://127.0.0.1:" + port + "/?" + q.toString();

  // 服务只听本机的 127.0.0.1，跳过去的是「打开这个页面的浏览器」所在的机器。
  // magpie web 部署在服务器上、从别的电脑打开时，那台电脑的 127.0.0.1 上没有服务，
  // 直接跳只会得到「127.0.0.1 拒绝连接」。旧版 magpie 不给 service 时，先说明原因，
  // 给出 SSH 端口转发的做法，转好了再点「继续」。
  if (!isLoopback(location.hostname)) {
    showRemote(port, target);
    return;
  }
  location.replace(target);
})();

function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

function showRemote(port, target) {
  const said = document.getElementById("said");
  if (!said) return;
  const host = location.hostname.replace(/^\[|\]$/g, "");
  said.textContent = "";
  const p = (text) => {
    const el = document.createElement("p");
    el.textContent = text;
    said.appendChild(el);
    return el;
  };
  p("窗口预热页的服务只在运行 magpie 的那台机器上监听 127.0.0.1:" + port + "，从这台电脑的浏览器连不到它。");
  p("在这台电脑上开一个 SSH 端口转发，然后点「继续」：");
  const code = p("ssh -N -L " + port + ":127.0.0.1:" + port + " <用户名>@" + host);
  code.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
  code.style.userSelect = "all";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "继续";
  go.addEventListener("click", () => location.replace(target));
  said.appendChild(go);
}
