(() => {
  const status = document.getElementById("status");
  const retry = document.getElementById("retry");
  let port = 3498;
  let opened = false;
  function open() {
    if (opened) return;
    const proxy = window.magpie?.service;
    const url = new URL(proxy || `http://127.0.0.1:${port}/`, location.href);
    if (!["http:", "https:"].includes(url.protocol))
      throw Error("Invalid service URL");
    opened = true;
    location.replace(url.href);
  }
  function attempt() {
    try {
      open();
    } catch {
      opened = false;
      status.textContent = "设置服务地址不可用，请重试。";
    }
  }
  retry.onclick = () => {
    opened = false;
    attempt();
  };
  const timer = setTimeout(attempt, 3000);
  (async () => {
    try {
      await window.magpie?.ready;
      const options = await window.magpie?.options?.get?.();
      const n = Number(options?.port);
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
    } finally {
      clearTimeout(timer);
      attempt();
    }
  })().catch(() => {});
})();
