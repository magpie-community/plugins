// 本文由AI自动生成
// 带路页：插件页面在 sandbox + connect-src 'none' 里，不能 fetch，
// 唯一能做的就是把自己导航到插件自己的本地服务。
//
// 服务现在是「先 listen 再初始化」，所以正常情况下毫秒级就能进；
// 万一宿主还没把 listener 拉起来，这里自动重试两次，再给出重试按钮和端口号，
// 不再像以前那样 3 秒就写死一句「服务好像没起来」。

(async () => {
  const msg = document.getElementById("msg");
  const retry = document.getElementById("retry");
  const DEFAULT_PORT = 3491;
  const say = (text, cls) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = cls || "";
  };

  let port = DEFAULT_PORT;
  let theme = "";
  let lang = new URLSearchParams(location.search).get("lang") || "";
  let service = "";

  try {
    const ready = await window.magpie?.ready;
    if (ready) {
      if (typeof ready.dark === "boolean") theme = ready.dark ? "dark" : "light";
      if (!lang && typeof ready.lang === "string") lang = ready.lang;
    }
  } catch {
    /* 没有 bridge 就按浅色来 */
  }
  if (theme) document.documentElement.dataset.theme = theme;

  const isZh = String(lang || navigator.language || "en")
    .toLowerCase()
    .startsWith("zh");
  const effectiveLang = lang || (isZh ? "zh" : "en");
  const t = (zh, en) => (isZh ? zh : en);
  if (retry) retry.textContent = t("重试", "Retry");

  try {
    const given = window.magpie?.service;
    if (typeof given === "string" && /^https?:\/\//.test(given)) service = given;
  } catch {
    /* 旧版 magpie 没有 service */
  }

  try {
    const options = await window.magpie?.options?.get?.();
    const value = Number(options?.port);
    if (Number.isFinite(value) && value > 0) port = value;
  } catch {
    /* 读不到选项就用默认端口 */
  }

  const base = service || `http://127.0.0.1:${port}`;
  const query = new URLSearchParams();
  if (theme) query.set("theme", theme);
  if (effectiveLang) query.set("lang", effectiveLang);
  const url = `${base}/${query.toString() ? `?${query.toString()}` : ""}`;

  let tries = 0;
  function go() {
    tries++;
    try {
      location.replace(url);
      return true;
    } catch {
      return false;
    }
  }

  if (!go()) {
    say(t("跳转失败。", "Navigation failed."), "err");
  }
  say(t("正在打开记忆图谱…", "Opening Memory Graph…"));

  // 导航成功时这份文档已经被替换，下面的定时器不会有机会跑；
  // 所以这里的重试只会在「导航没生效」时发生。
  setTimeout(() => {
    if (document.visibilityState === "hidden") return;
    say(t(`正在等待本地服务…（端口 ${port}）`, `Waiting for local service… (port ${port})`));
    if (tries < 2) go();
  }, 3000);

  setTimeout(() => {
    if (document.visibilityState === "hidden") return;
    if (tries < 3) go();
  }, 9000);

  setTimeout(() => {
    if (document.visibilityState === "hidden") return;
    say(
      t(
        `还没连上本地服务（端口 ${port}）。确认 magpie 已启用「记忆图谱」插件；若端口被别的程序占用，可在插件选项里改 port。`,
        `Could not connect to local service (port ${port}). Ensure the "Memory Graph" plugin is enabled in magpie; if the port is in use, change "port" in plugin options.`,
      ),
      "err",
    );
    if (retry) {
      retry.classList.add("on");
      retry.addEventListener("click", () => {
        retry.classList.remove("on");
        say(t("正在重试…", "Retrying…"));
        tries = 0;
        go();
        setTimeout(() => {
          if (document.visibilityState === "hidden") return;
          say(t(`还是没连上（端口 ${port}）。`, `Still unable to connect (port ${port}).`), "err");
          retry.classList.add("on");
        }, 4000);
      });
    }
  }, 14000);
})();
