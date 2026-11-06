// Magpie settings pages cannot fetch (`connect-src 'none'`). This bridge page
// therefore only carries theme/options to the loopback diagnostics page.
(async () => {
  const fallbackPort = 3478;
  const said = document.getElementById("said");
  let port = fallbackPort;
  let theme = "";
  let lang = "";
  let tokens = null;
  let service = "";

  try {
    const ready = await window.magpie?.ready;
    if (typeof ready?.dark === "boolean") theme = ready.dark ? "dark" : "light";
    if (typeof ready?.lang === "string") lang = ready.lang;
    if (ready?.tokens && typeof ready.tokens === "object") tokens = ready.tokens;
  } catch {}
  try {
    if (typeof window.magpie?.service === "string") service = window.magpie.service;
  } catch {}
  try {
    const options = await window.magpie?.options?.get?.();
    const configured = Number(options?.diagnosticsPort);
    if (Number.isInteger(configured) && configured >= 1024 && configured <= 65535) {
      port = configured;
    }
  } catch {}

  const query = new URLSearchParams();
  if (theme) query.set("theme", theme);
  if (lang) query.set("lang", lang);
  const slim = {};
  for (const [key, value] of Object.entries(tokens || {})) {
    const text = String(value ?? "").trim();
    if (text) slim[key] = text;
  }
  if (Object.keys(slim).length) {
    try {
      query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));
    } catch {}
  }

  const suffix = query.toString();
  if (service) {
    location.replace(service + (suffix ? "?" + suffix : ""));
    return;
  }

  const target = "http://127.0.0.1:" + port + "/" + (suffix ? "?" + suffix : "");
  const loopback = /^(?:127(?:\.\d+){3}|localhost|\[::1\])$/i.test(location.hostname);
  if (!loopback && location.protocol !== "file:") {
    if (said) {
      said.textContent =
        "诊断服务只监听运行 magpie 的电脑。请在这台电脑上使用 SSH 端口转发：" +
        "ssh -N -L " + port + ":127.0.0.1:" + port + " <user>@" + location.hostname;
    }
    return;
  }
  location.replace(target);
})();
