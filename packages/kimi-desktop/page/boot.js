// The host page cannot fetch. Navigate its existing sandboxed iframe directly
// to the plugin service; magpie.service supplies a proxy URL for Magpie Web.
(async () => {
  const DEFAULT_PORT = 3491;
  let theme = '';
  let port = DEFAULT_PORT;
  let service = null;
  try {
    const ready = await window.magpie?.ready;
    if (typeof ready?.dark === 'boolean') theme = ready.dark ? 'dark' : 'light';
  } catch { /* The service can use the system theme without the bridge. */ }
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
      const message = document.getElementById('message');
      if (message) message.textContent = '未获得设置服务地址。请在运行 Magpie 的桌面端打开，或使用支持插件服务代理的 Magpie Web。';
      return;
    }
    service = new URL(`http://127.0.0.1:${port}/`);
  }
  if (!service.pathname.endsWith('/')) service.pathname += '/';
  if (theme) service.searchParams.set('theme', theme);
  // An opaque frame cannot use connect-src 'self'; the service validates this
  // concrete origin before including it in its response's connect-src policy.
  service.searchParams.set('uiOrigin', service.origin);
  location.replace(service.href);
})();
