(async () => {
  const boot = document.getElementById("boot");
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");
  const retry = document.getElementById("retry");
  retry.addEventListener("click", () => location.reload());

  const setStatus = (text) => { status.textContent = text; };
  const fail = (message) => {
    boot.dataset.state = "error";
    boot.setAttribute("aria-busy", "false");
    setStatus(message);
    hint.hidden = true;
    retry.hidden = false;
  };

  const applyTheme = (theme) => {
    if (theme && typeof theme.dark === "boolean") {
      document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
    }
  };

  // 桥接脚本未加载（例如直接打开本文件）时给出明确提示，而不是一直转圈
  if (typeof window.magpie === "undefined") {
    fail("未检测到 Magpie，请在 Magpie 中打开此页面");
    return;
  }

  try {
    applyTheme(magpie.theme);
    const theme = await magpie.ready;
    applyTheme(theme);
    setStatus("正在启动额度服务");
    const options = await magpie.options.get();
    const port = Number(options?.port ?? 3497);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("插件端口无效");
    const service = typeof magpie.service === "string" ? magpie.service : "";
    const hostname = location.hostname.replace(/^\[|\]$/g, "");
    if (!service && hostname && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error("当前 Magpie 未提供页面服务代理，请升级 Magpie 或使用 SSH 转发");
    }
    const target = new URL(service || `http://127.0.0.1:${port}/`, location.href);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("页面服务地址无效");
    target.searchParams.set("theme", theme.dark ? "dark" : "light");
    if (theme.lang) target.searchParams.set("lang", String(theme.lang));
    // 首屏即采用 Magpie 的配色；之后的主题变化由页面直接从窗口消息中获取
    try {
      const tokens = Object.fromEntries(Object.entries(theme.tokens ?? {})
        .map(([key, value]) => [key, String(value ?? "").trim()])
        .filter(([, value]) => value));
      if (Object.keys(tokens).length) {
        target.searchParams.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(tokens)))));
      }
    } catch {
      // 配色带不过去时页面使用自己的默认配色
    }
    target.searchParams.set("_", Date.now().toString());
    setStatus("正在读取账号额度");
    setTimeout(() => {
      boot.dataset.state = "slow";
      setStatus("服务启动较慢");
      hint.textContent = "插件服务可能仍在启动，请稍候片刻；若长时间无响应，可点击重试或在插件列表中重新启用。";
      hint.hidden = false;
      retry.hidden = false;
    }, 5000);
    location.replace(target.href);
  } catch (error) {
    fail(error?.message || "加载失败");
  }
})();
