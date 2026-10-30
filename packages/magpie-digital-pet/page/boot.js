// 带路页：把 magpie 页面框架导航到插件的本地服务。
// 页面 CSP 是 connect-src 'none'，唯一能做的联网动作就是跳转自己。
// bridge 偶发不应答时也不能停在加载页：最多等 350ms，然后直接盲跳。
const withTimeout = (promise, ms) =>
  Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

(async () => {
  const DEFAULT_PORT = 3571;
  let port = DEFAULT_PORT;

  const options = await withTimeout(window.magpie?.options?.get?.(), 350);
  if (options && Number.isFinite(Number(options.port)) && Number(options.port) > 0) {
    port = Number(options.port);
  }

  const q = new URLSearchParams();
  const theme = await withTimeout(window.magpie?.ready, 350);
  if (theme && typeof theme.dark === "boolean") q.set("theme", theme.dark ? "dark" : "light");
  if (theme && typeof theme.lang === "string") q.set("lang", theme.lang);

  location.replace("http://127.0.0.1:" + port + "/?" + q.toString());
})();
