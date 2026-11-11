// 带路页：把 magpie 的框架导航到本插件的页面服务。
// 页面 CSP 是 connect-src 'none'，只能直接跳转，不能先探测。
(async () => {
  const DEFAULT_PORT = 3496;
  const words = {
    en: {
      title: "Model Quota",
      connecting: "Connecting to the local quota service...",
      stopped: (port) => `The local quota service is not running (127.0.0.1:${port}).`,
      remote: (port) => `The service listens on 127.0.0.1:${port} on the machine running magpie. Open the page there, or forward that port.`,
      retry: "Retry",
    },
    zh: {
      title: "模型剩余额度",
      connecting: "正在连接本地额度服务…",
      stopped: (port) => `本地额度服务没有在运行（127.0.0.1:${port}）。`,
      remote: (port) => `服务只在运行 magpie 的那台机器上监听 127.0.0.1:${port}，请在本机打开或做端口转发。`,
      retry: "重试",
    },
  };

  let port = DEFAULT_PORT;
  let theme = "light";
  let lang = "en";
  let tokens = null;
  let service = "";

  function followLanguage(value) {
    lang = String(value || "").toLowerCase().startsWith("zh") ? "zh" : "en";
    const text = words[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = text.title;
    document.getElementById("title").textContent = text.title;
    document.getElementById("said").textContent = text.connecting;
    document.getElementById("retry").textContent = text.retry;
  }

  try {
    const current = await window.magpie?.ready;
    if (current) {
      theme = current.dark ? "dark" : "light";
      lang = String(current.lang || lang).toLowerCase().startsWith("zh") ? "zh" : "en";
      tokens = current.tokens || null;
    }
  } catch {
    // 没有桥接时页面照样能用。
  }

  try {
    const options = await window.magpie?.options?.get?.();
    const value = Number(options?.port);
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
  } catch {
    // 用声明的默认值。
  }

  try {
    const value = window.magpie?.service;
    if (typeof value === "string" && /^https?:\/\//.test(value)) service = value;
  } catch {
    // 桌面窗口直接导航到回环地址。
  }

  followLanguage(lang);
  window.magpie?.onTheme?.((next) => {
    if (!next) return;
    if (typeof next.dark === "boolean") theme = next.dark ? "dark" : "light";
    if (typeof next.lang === "string") {
      const before = lang;
      followLanguage(next.lang);
      // 框架马上要被替换，只更新等待文字。
      if (before !== lang) {
        const retry = document.getElementById("retry");
        if (retry && !retry.hidden) retry.textContent = words[lang].retry;
      }
    }
  });

  const query = new URLSearchParams();
  query.set("theme", theme);
  query.set("lang", lang);
  // 每次打开都换一个地址，浏览器不会拿缓存里的旧文档（旧口令）来用。
  query.set("_", String(Date.now()));
  if (tokens && typeof tokens === "object") {
    try {
      const slim = {};
      for (const [key, value] of Object.entries(tokens)) {
        const text = String(value ?? "").trim();
        if (text) slim[key] = text;
      }
      if (Object.keys(slim).length) {
        query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));
      }
    } catch {
      // 主题色带不过去就用页面自己的。
    }
  }

  const retry = document.getElementById("retry");
  retry.hidden = false;
  retry.addEventListener("click", () => location.reload());

  if (service) {
    location.replace(service + "?" + query.toString());
    return;
  }

  const host = String(location.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const local = !host || host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  if (!local) {
    document.getElementById("said").textContent = words[lang].remote(port);
    return;
  }

  // 服务没起来时，跳转过去只会看到空白：五秒后把原因写回这一页。
  const timer = setTimeout(() => {
    if (document.getElementById("said")) document.getElementById("said").textContent = words[lang].stopped(port);
  }, 5000);
  location.replace("http://127.0.0.1:" + port + "/?" + query.toString());
  void timer;
})();
