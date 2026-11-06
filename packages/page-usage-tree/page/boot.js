(async () => {
  const DEFAULT_PORT = 3494;
  const words = {
    en: {
      title: "Account usage",
      connecting: "Connecting to the local usage service...",
      stopped: (port) => `The local usage service is not running (127.0.0.1:${port}).`,
      retry: "Retry",
    },
    zh: {
      title: "账号用量",
      connecting: "正在连接本地用量服务...",
      stopped: (port) => `本地用量服务没有在运行（127.0.0.1:${port}）。`,
      retry: "重试",
    },
  };

  let port = DEFAULT_PORT;
  let theme = "light";
  let lang = "en";
  let tokens = null;
  let service = "";
  const display = {
    currency: "usd",
    chineseUnits: false,
    usdCny: 0,
  };

  function followDisplay(value) {
    if (!value || typeof value !== "object") return;
    if (value.currency === "cny" || value.currency === "usd") {
      display.currency = value.currency;
    }
    if (typeof value.chineseUnits === "boolean") {
      display.chineseUnits = value.chineseUnits;
    }
    const rate = Number(value.usdCny);
    if (Number.isFinite(rate) && rate > 0) display.usdCny = rate;
  }

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
      followDisplay(current);
    }
  } catch {
    // The page still works without the bridge.
  }

  try {
    const options = await window.magpie?.options?.get?.();
    const value = Number(options?.port);
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
    followDisplay(options);
  } catch {
    // Use the declared default.
  }

  try {
    const value = window.magpie?.service;
    if (typeof value === "string" && /^https?:\/\//.test(value)) service = value;
  } catch {
    // Desktop windows navigate directly to loopback.
  }

  followLanguage(lang);
  window.magpie?.onTheme?.((next) => {
    if (!next) return;
    if (typeof next.dark === "boolean") theme = next.dark ? "dark" : "light";
    if (typeof next.lang === "string") {
      const before = lang;
      followLanguage(next.lang);
      // The frame is about to be replaced; only update the waiting text.
      if (before !== lang) {
        const retry = document.getElementById("retry");
        if (retry && !retry.hidden) retry.textContent = words[lang].retry;
      }
    }
  });

  const query = new URLSearchParams();
  query.set("theme", theme);
  query.set("lang", lang);
  query.set("currency", display.currency);
  query.set("chineseUnits", display.chineseUnits ? "1" : "0");
  if (display.usdCny > 0) query.set("usdCny", String(display.usdCny));
  if (tokens && typeof tokens === "object") {
    try {
      const slim = {};
      for (const [key, value] of Object.entries(tokens)) {
        const item = String(value ?? "").trim();
        if (item && item.length <= 160) slim[key] = item;
      }
      if (Object.keys(slim).length) {
        query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));
      }
    } catch {
      // Theme tokens are optional.
    }
  }

  const target = service || `http://127.0.0.1:${port}/`;
  const url = new URL(target, location.href);
  for (const [key, value] of query) url.searchParams.set(key, value);

  const timer = setTimeout(() => {
    const said = document.getElementById("said");
    if (!said) return;
    said.textContent = words[lang].stopped(port);
    const retry = document.getElementById("retry");
    if (retry) retry.hidden = false;
  }, 5000);

  document.getElementById("retry")?.addEventListener("click", () => {
    clearTimeout(timer);
    location.reload();
  });

  location.replace(url.href);
})();
