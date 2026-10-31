(async () => {
  const DEFAULT_PORT = 3488;
  let port = DEFAULT_PORT;
  let theme = "light";
  let lang = "zh";
  let tokens = null;
  let service = "";

  try {
    const current = await window.magpie?.ready;
    if (current) {
      theme = current.dark ? "dark" : "light";
      lang = typeof current.lang === "string" ? current.lang : lang;
      tokens = current.tokens || null;
    }
  } catch {
    // The page still works without the bridge.
  }

  try {
    const options = await window.magpie?.options?.get?.();
    const value = Number(options?.port);
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
  } catch {
    // Use the declared default.
  }

  try {
    const value = window.magpie?.service;
    if (typeof value === "string" && /^https?:\/\//.test(value)) service = value;
  } catch {
    // Desktop windows navigate directly to loopback.
  }

  const query = new URLSearchParams();
  query.set("theme", theme);
  query.set("lang", lang);
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
    said.textContent = `本地用量服务没有在运行（127.0.0.1:${port}）`;
    const retry = document.getElementById("retry");
    if (retry) retry.hidden = false;
  }, 5000);

  document.getElementById("retry")?.addEventListener("click", () => {
    clearTimeout(timer);
    location.reload();
  });

  location.replace(url.href);
})();
