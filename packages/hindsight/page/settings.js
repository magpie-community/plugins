const find = id => document.getElementById(id);
let root = "";
let current = {};
function launch() {
  const url = root || "http://127.0.0.1:" + (current.port ?? 3482);
  location.assign(url.replace(/\/+$/, "") + "/workbench");
}

find("open").addEventListener("click", launch);
find("save-port").addEventListener("click", async () => {
  const port = find("port").valueAsNumber;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    find("status").textContent = "请输入 1024–65535 之间的整数。";
    return;
  }
  find("save-port").disabled = true;
  try {
    current = await magpie.options.get() || {};
    await magpie.options.set({ ...current, port });
    current.port = port;
    find("status").textContent = "端口已保存。";
    launch();
  } catch {
    find("status").textContent = "保存端口失败，请从 Magpie 重新打开插件。";
  } finally {
    find("save-port").disabled = false;
  }
});

window.magpie?.ready.then(async () => {
  current = await magpie.options.get() || {};
  root = magpie.service || "";
  find("port").value = current.port ?? 3482;
  find("save-port").disabled = false;
  find("open").disabled = false;
  find("status").textContent = "配置已读取。";
  const returning = globalThis.performance?.getEntriesByType("navigation")[0]?.type === "back_forward";
  if (!returning && !new URLSearchParams(location.search).has("recovery")) launch();
}).catch(() => { find("status").textContent = "无法读取插件配置，请从 Magpie 重新打开。"; });
