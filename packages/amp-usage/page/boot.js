(async () => {
  const zh = (lang) =>
    String(lang || navigator.language || "")
      .toLowerCase()
      .startsWith("zh");
  const words = (lang) =>
    zh(lang)
      ? {
          title: "Amp 用量",
          connecting: "正在连接本地采集服务…",
          stopped: "采集服务没有启动。请查看插件日志，并确认端口没有被占用。",
          port: "插件选项中的服务端口无效。",
          remote: "请更新 Magpie，才能从远程浏览器打开这个服务。",
          retry: "重新连接",
        }
      : {
          title: "Amp usage",
          connecting: "Connecting to the local collector…",
          stopped:
            "The collector did not start. Check the plugin log and whether its port is already in use.",
          port: "Invalid service port in plugin options.",
          remote: "Update Magpie to open this service from a remote browser.",
          retry: "Reconnect",
        };
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");
  retry.addEventListener("click", () => location.reload());
  let text = words();
  const say = (key) => {
    document.title = text.title;
    document.getElementById("title").textContent = text.title;
    retry.textContent = text.retry;
    message.textContent = text[key];
  };
  say("connecting");
  try {
    const theme = await magpie.ready;
    text = words(theme.lang);
    say("connecting");
    const options = await magpie.options.get();
    const port = Number(options?.port ?? 3497);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("port");
    const target =
      magpie.service ||
      (["localhost", "127.0.0.1", ""].includes(location.hostname)
        ? `http://127.0.0.1:${port}/`
        : "");
    if (!target) throw new Error("remote");
    const url = new URL(target);
    url.searchParams.set("theme", theme.dark ? "dark" : "light");
    url.searchParams.set("lang", zh(theme.lang) ? "zh" : "en");
    // The service's page wears the window's own colours.
    const tokens = {};
    for (const [k, v] of Object.entries(theme.tokens || {}))
      if (/^[\x20-\x7e]{1,160}$/.test(String(v))) tokens[k] = String(v);
    if (Object.keys(tokens).length)
      url.searchParams.set("tokens", btoa(JSON.stringify(tokens)));
    setTimeout(() => {
      say("stopped");
      retry.hidden = false;
    }, 6000);
    location.replace(url.href);
  } catch (e) {
    say(text[e.message] ? e.message : "stopped");
    retry.hidden = false;
  }
})();
