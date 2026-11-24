// 本文由AI自动生成
// 带路页：插件页面在 sandbox + connect-src 'none' 里，不能 fetch，
// 唯一能做的就是把自己导航到插件自己的本地服务。

(async () => {
  const msg = document.getElementById("msg");
  const DEFAULT_PORT = 3491;
  const say = (text, cls) => {
    if (!msg) return;
    msg.textContent = text;
    if (cls) msg.className = cls;
  };

  let port = DEFAULT_PORT;
  let theme = "";
  let lang = "";
  let service = "";

  try {
    const ready = await window.magpie?.ready;
    if (ready) {
      if (typeof ready.dark === "boolean") theme = ready.dark ? "dark" : "light";
      if (typeof ready.lang === "string") lang = ready.lang;
    }
  } catch {
    /* 没有 bridge 就按浅色来 */
  }
  if (theme) document.documentElement.dataset.theme = theme;

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
  if (lang) query.set("lang", lang);
  const url = `${base}/${query.toString() ? `?${query.toString()}` : ""}`;

  say("正在打开记忆图谱…");
  try {
    location.replace(url);
  } catch {
    say("跳转失败。", "err");
  }

  setTimeout(() => {
    if (document.visibilityState === "hidden") return;
    say(`服务好像没起来。确认 magpie 已加载本插件，或直接打开 ${base}`, "err");
  }, 3000);
})();
