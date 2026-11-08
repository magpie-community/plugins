// The host page cannot fetch. Navigate its existing sandboxed iframe directly
// to the plugin service; magpie.service supplies a proxy URL for Magpie Web.
(async () => {
  const DEFAULT_PORT = 3491;
  let theme = '';
  let lang = 'en';
  let port = DEFAULT_PORT;
  let service = null;
  try {
    const ready = await window.magpie?.ready;
    if (typeof ready?.dark === 'boolean') theme = ready.dark ? 'dark' : 'light';
    if (typeof ready?.lang === 'string' && ready.lang) lang = ready.lang;
  } catch { /* The service can use the system theme without the bridge. */ }
  const chinese = /^zh(?:-|$)/i.test(lang);
  if (document.documentElement) document.documentElement.lang = chinese ? 'zh' : 'en';
  document.title = chinese ? 'Kimi Work 模型' : 'Kimi Work models';
  const heading = document.getElementById('heading');
  if (heading) heading.textContent = document.title;
  const message = document.getElementById('message');
  if (message) message.textContent = chinese ? '正在连接设置服务…' : 'Connecting to the settings service…';
  try {
    const options = await window.magpie?.options?.get?.();
    const value = Number(options?.settingsPort);
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
  } catch { /* The server and launcher share the same default. */ }
  try {
    const value = window.magpie?.service;
    if (typeof value === 'string') {
      const url = new URL(value, location.href);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) service = url;
    }
  } catch { /* An old host may not provide a service proxy. */ }
  if (!service) {
    const host = String(location.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const local = host === '' || host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
    if (!local) {
      if (message) message.textContent = chinese
        ? '未获得设置服务地址。请在运行 Magpie 的桌面端打开，或使用支持插件服务代理的 Magpie Web。'
        : 'No settings service address is available. Open this page on the Magpie desktop, or use Magpie Web with plugin service proxy support.';
      return;
    }
    service = new URL(`http://127.0.0.1:${port}/`);
  }
  if (!service.pathname.endsWith('/')) service.pathname += '/';
  if (theme) service.searchParams.set('theme', theme);
  service.searchParams.set('lang', lang);
  // An opaque frame cannot use connect-src 'self'; the service validates this
  // concrete origin before including it in its response's connect-src policy.
  service.searchParams.set('uiOrigin', service.origin);
  const retry = document.getElementById('retry');
  retry.textContent = chinese ? '重试' : 'Retry';
  let attempts = 0;
  const connect = () => {
    attempts += 1;
    // WebKit can leave this document alive when a navigation is refused.
    // Successful navigation destroys the document and its pending timer.
    setTimeout(() => {
      if (attempts < 3) connect();
      else {
        if (message) message.textContent = chinese
          ? '未能打开设置服务。请稍候，然后点击“重试”。'
          : 'The settings service could not be opened. Wait a moment, then select Retry.';
        retry.hidden = false;
      }
    }, 3000);
    location.replace(service.href);
  };
  retry.addEventListener('click', () => {
    attempts = 0;
    retry.hidden = true;
    if (message) message.textContent = chinese ? '正在连接设置服务…' : 'Connecting to the settings service…';
    connect();
  });
  connect();
})();
