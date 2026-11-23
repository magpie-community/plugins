(async () => {
  const status = document.getElementById("status");
  document.getElementById("retry").addEventListener("click", () => location.reload());
  try {
    const theme = await magpie.ready;
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
    setTimeout(() => {
      status.textContent = "服务未就绪";
    }, 5000);
    location.replace(target.href);
  } catch (error) {
    status.textContent = error.message;
  }
})();
