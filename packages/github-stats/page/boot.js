(async () => {
  try {
    await window.magpie.ready;
    const options = await window.magpie.options.get();
    const port = Number(options?.port) || 3498;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid port");
    const target = window.magpie.service || `http://127.0.0.1:${port}/`;
    const url = new URL(target, location.href);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Invalid service");
    location.replace(url.href);
  } catch {
    document.getElementById("status").textContent =
      "本地服务未启动，请重新启用插件，或运行 magpie-github-stats serve。";
  }
  document
    .getElementById("retry")
    .addEventListener("click", () => location.reload());
})();
