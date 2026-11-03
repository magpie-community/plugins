// 带路页：把 Magpie 沙盒页导航到本机 page.service（CSP 禁止 fetch，只能 location.replace）。
(async () => {
  const DEFAULT_PORT = 3491;
  let port = DEFAULT_PORT;
  let theme = "";
  let lang = "";
  let tokens = null;
  let service = "";

  try {
    const t = await window.magpie?.ready;
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (typeof t.lang === "string" && t.lang) lang = t.lang;
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch { /* no bridge */ }
  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch { /* old magpie */ }
  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch { /* default */ }

  const q = new URLSearchParams();
  if (theme) q.set("theme", theme);
  if (lang) q.set("lang", lang);
  const slim = {};
  for (const [k, v] of Object.entries(tokens || {})) {
    const s = String(v ?? "").trim();
    if (s) slim[k] = s;
  }
  if (Object.keys(slim).length) {
    try {
      q.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));
    } catch { /* theme only */ }
  }

  // 桥接页在 Magpie 沙盒里，等不到本地服务时也要跟随 Magpie 语言。
  // 与 ui/i18n.js 一致：zh* 显示中文，其它语言显示英文；没有桥时保持中文。
  var en = !!lang && !/^zh/i.test(lang);
  function say(zh, eng) { return en ? eng : zh; }
  if (lang && document.documentElement) document.documentElement.lang = en ? "en" : "zh-CN";

  function armTimeout(p) {
    setTimeout(function () {
      var said = document.getElementById("said");
      if (!said) return;
      said.textContent = say(
        "本地服务没有在运行（127.0.0.1:" + p + "）",
        "The local service is not running (127.0.0.1:" + p + ")"
      );
      if (document.getElementById("boot-retry")) return;
      var btn = document.createElement("button");
      btn.id = "boot-retry";
      btn.type = "button";
      btn.textContent = say("重试", "Retry");
      btn.addEventListener("click", function () { location.reload(); });
      said.parentNode.appendChild(btn);
    }, 5000);
  }

  if (service) {
    armTimeout(port);
    location.replace(service.replace(/\/?$/, "/") + "?" + q.toString());
    return;
  }

  const target = "http://127.0.0.1:" + port + "/?" + q.toString();

  if (!isLoopback(location.hostname)) {
    showRemote(port, target, en);
    return;
  }
  armTimeout(port);
  location.replace(target);
})();

function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

function showRemote(port, target, en) {
  const said = document.getElementById("said");
  if (!said) return;
  const say = (zh, eng) => (en ? eng : zh);
  const host = location.hostname.replace(/^\[|\]$/g, "");
  said.textContent = "";
  const p = (text) => {
    const el = document.createElement("p");
    el.textContent = text;
    said.appendChild(el);
    return el;
  };
  p(say(
    "服务只在运行 Magpie 的机器上监听 127.0.0.1:" + port + "，从这台电脑连不到。",
    "The service only listens on 127.0.0.1:" + port + " on the machine running Magpie, so this computer cannot reach it."
  ));
  p(say("可 SSH 端口转发后点「继续」：", "Forward the port over SSH, then click Continue:"));
  const code = p("ssh -N -L " + port + ":127.0.0.1:" + port + " <用户>@" + host);
  code.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
  code.style.userSelect = "all";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = say("继续", "Continue");
  go.addEventListener("click", () => location.replace(target));
  said.appendChild(go);
}
