async function openReceipts() {
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    const port = Number(options.receiptPort || 3478);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
    const base=magpie.service || `http://127.0.0.1:${port}/`;
    location.replace(new URL("session-authorization.html",base.endsWith("/")?base:base+"/").href);
  } catch { document.getElementById("loading").textContent = "无法打开保护页面，请重新打开插件页面。"; }
}
openReceipts();
