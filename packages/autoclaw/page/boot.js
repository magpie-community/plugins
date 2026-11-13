(async () => {
  const status = document.getElementById("status");
  try {
    await window.magpie.ready;
    const bridge = window.magpie;
    let service = bridge.service;
    if (!service && (location.protocol === "wails:" || location.hostname === "wails.localhost")) {
      const port = Number((await bridge.options.get()).loginPort ?? 18741);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("loginPort 配置无效");
      service = `http://127.0.0.1:${port}/`;
    }
    if (!service) throw new Error("当前 Magpie 未提供插件服务代理，请升级 Magpie 后重试");
    const target = new URL(service);
    target.hash = new URLSearchParams({ theme: JSON.stringify(bridge.theme ?? {}) }).toString();
    location.replace(target.href);
  } catch (error) { status.textContent = `无法打开登录面板：${error.message}`; }
})();
