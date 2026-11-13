// Magpie serves this shell; navigate to the plugin's local service, which
// serves the real page. Same pattern as the other page plugins.
(async () => {
  const DEFAULT_PORT = 3499;
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");
  const say = (text) => {
    if (message) message.textContent = text;
  };
  const zh = /^zh(?:-|$)/i.test(String(navigator.language || ""));
  const words = zh
    ? { connecting: "正在连接本地服务…", failed: "无法连接本地服务；请查看插件日志后重试。", remote: "请从 Magpie 桌面端打开这个页面，或使用支持插件服务代理的 Magpie Web。", retry: "重试" }
    : { connecting: "Connecting to the local service…", failed: "Could not reach the local service. Check the plugin log, then retry.", remote: "Open this page from the Magpie desktop app, or use Magpie Web with plugin service proxy support.", retry: "Retry" };
  say(words.connecting);
  if (retry) {
    retry.textContent = words.retry;
    retry.addEventListener("click", () => location.reload());
  }
  let port = DEFAULT_PORT;
  try {
    const options = await window.magpie?.options?.get?.();
    const value = Number(options?.port);
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
  } catch {
    // use the default
  }
  let service = null;
  try {
    const value = window.magpie?.service;
    if (typeof value === "string") service = new URL(value, location.href);
  } catch {
    // old host
  }
  if (!service) {
    const host = String(location.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    const local =
      host === "" ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1";
    if (!local) {
      say(words.remote);
      if (retry) retry.hidden = false;
      return;
    }
    service = new URL(`http://127.0.0.1:${port}/`);
  }
  if (!service.pathname.endsWith("/")) service.pathname += "/";
  if (zh) service.searchParams.set("lang", "zh");
  setTimeout(() => {
    say(words.failed);
    if (retry) retry.hidden = false;
  }, 6000);
  location.replace(service.href);
})();
