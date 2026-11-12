(async () => {
  var DEFAULT_PORT = 4397;
  var HOST = "127.0.0.1";
  var words = {
    zh: {
      title: "路由洞察",
      stopped: "本地服务没有响应（127.0.0.1:{port}）。",
      open: "打开界面",
      copy: "复制地址",
      copied: "已复制",
      retry: "重试",
      detail: "排查信息",
      hint: "插件宿主重启时端口会空一两秒，稍等再点重试。",
      target: "目标地址",
      undefined: "未定义",
      origin: "页面来源",
      browser: "浏览器"
    },
    en: {
      title: "Route insight",
      stopped: "The local service does not answer on 127.0.0.1:{port}.",
      open: "Open interface",
      copy: "Copy address",
      copied: "Copied",
      retry: "Retry",
      detail: "Diagnostics",
      hint: "The plugin host port is empty for a second or two after a restart.",
      target: "Target address",
      undefined: "undefined",
      origin: "Page origin",
      browser: "Browser"
    }
  };

  var lang = "zh";
  var theme = "dark";
  var port = DEFAULT_PORT;
  var service = "";
  var given = null;
  var options = null;

  function say(key, values) {
    var text = words[lang][key] || words.en[key] || "";
    return String(text).replace(/\{(\w+)\}/g, function (all, name) {
      return values && values[name] !== undefined ? String(values[name]) : all;
    });
  }

  function follow(value) {
    lang = String(value || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = say("title");
    var title = document.getElementById("title");
    if (title) title.textContent = lang === "zh" ? "路由洞察 Route insight" : "Route insight";
  }

  try {
    var current = await (window.magpie && window.magpie.ready);
    if (current) {
      theme = current.dark === false ? "light" : "dark";
      lang = String(current.lang || lang).toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    }
  } catch (error) {
    // 没有 bridge 也能用。
  }

  try {
    options = await (window.magpie && window.magpie.options && window.magpie.options.get && window.magpie.options.get());
    var value = Number(options && options.port);
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
  } catch (error) {
    // 用声明的默认端口。
  }

  try {
    given = window.magpie ? window.magpie.service : null;
    if (typeof given === "string" && /^https?:\/\//.test(given)) service = given;
  } catch (error) {
    // 桌面窗口直接导航到 loopback。
  }

  follow(lang);
  if (window.magpie && window.magpie.onTheme) {
    window.magpie.onTheme(function (next) {
      if (!next) return;
      if (typeof next.dark === "boolean") theme = next.dark ? "dark" : "light";
      if (typeof next.lang === "string") follow(next.lang);
    });
  }

  var target = service || "http://" + HOST + ":" + port + "/";
  var url = new URL(target, location.href);
  url.searchParams.set("theme", theme);
  url.searchParams.set("lang", lang);
  url.searchParams.set("uiOrigin", location.origin);

  // 官方 page 插件的做法：不探活，直接导航到插件自己的 loopback 服务。
  // 宿主重启导致端口暂时没开时浏览器只会停在错误页，所以 ?diag=1 或 8 秒后仍在本页才显示排查面板。
  var navigated = false;

  function go() {
    navigated = true;
    location.replace(url.href);
  }

  function line(label, value) {
    var row = document.createElement("div");
    row.className = "row";
    var key = document.createElement("span");
    key.className = "key";
    key.textContent = label;
    var val = document.createElement("code");
    val.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
    row.appendChild(key);
    row.appendChild(val);
    return row;
  }

  var panel = null;

  function showPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "panel";

    var heading = document.createElement("div");
    heading.className = "head";
    heading.textContent = say("stopped", { port: port });
    panel.appendChild(heading);

    var box = document.createElement("div");
    box.className = "rows";
    box.appendChild(line(say("target"), url.href));
    box.appendChild(line("magpie.service", given === undefined ? say("undefined") : JSON.stringify(given)));
    box.appendChild(line("options", JSON.stringify(options)));
    box.appendChild(line(say("origin"), location.href));
    box.appendChild(line(say("browser"), navigator.userAgent));
    panel.appendChild(box);

    var actions = document.createElement("div");
    actions.className = "actions";

    var open = document.createElement("button");
    open.type = "button";
    open.textContent = say("open");
    open.onclick = go;
    actions.appendChild(open);

    var copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = say("copy");
    copy.onclick = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url.href).then(
          function () {
            copy.textContent = say("copied");
          },
          function () {
            copy.textContent = say("copied");
          }
        );
      }
    };
    actions.appendChild(copy);

    var retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = say("retry");
    retry.onclick = go;
    actions.appendChild(retry);

    panel.appendChild(actions);

    var hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = say("hint");
    panel.appendChild(hint);

    document.body.appendChild(panel);
  }

  if (/[?&]diag=1/.test(location.search)) {
    showPanel();
    return;
  }

  go();

  setTimeout(function () {
    if (!navigated) return;
    // 导航被拦下时页面还在，给出排查面板。
    if (document.visibilityState !== "hidden") showPanel();
  }, 8000);
})();
