// The Magpie window runs this page inside a sandboxed frame, so it cannot
// fetch anything: the page only reads the theme and the service port, then
// hands the whole window over to the service that runs on this computer.
// The port the service of this package listens on. The plugin options may
// name another one.
const DEFAULT_PORT = 3498;

(async () => {
  const message = document.getElementById('message');
  const retry = document.getElementById('retry');
  retry.addEventListener('click', () => location.reload());

  try {
    const theme = await magpie.ready;
    const options = await magpie.options.get();
    const port = Number(options?.port ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口没有设置好。');

    // This computer's window: wails://localhost on macOS and Linux,
    // http://wails.localhost on Windows.
    const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const local =
      host === '' ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      /^127\./.test(host);

    // magpie.service is only filled in when the page was opened in a browser
    // through "magpie web"; in the app window the service sits on this
    // computer.
    const target = magpie.service
      ? new URL(magpie.service, location.href)
      : local
        ? new URL(`http://127.0.0.1:${port}/`)
        : null;
    if (!target) throw new Error('这个页面要在运行 Magpie 的电脑上打开。');

    target.searchParams.set('theme', theme?.dark ? 'dark' : 'light');
    location.replace(target.href);
  } catch (error) {
    message.textContent = `打不开本机的额度服务：${error?.message || '不知道原因'}`;
    retry.hidden = false;
  }
})();
