(async () => {
  const bridge = window.magpie;
  const status = document.getElementById('status');
  try {
    const theme = await bridge.ready;
    const options = await bridge.options.get();
    const configured = Number(options?.port);
    const port = Number.isInteger(configured) && configured >= 1024 && configured <= 65535 ? configured : 3498;
    const host = String(location.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const local = !host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
    const service = bridge.service || (local ? `http://127.0.0.1:${port}/` : null);
    if (!service) throw new Error('请在运行 Magpie 的电脑上打开插件。');
    const url = new URL(service, location.href);
    url.searchParams.set('theme', theme?.dark ? 'dark' : 'light');
    url.searchParams.set('_', String(Date.now()));
    location.replace(url);
  } catch (error) {
    status.textContent = error.message || '无法打开本地积分服务。';
    const retry = document.getElementById('retry');
    retry.hidden = false;
    retry.onclick = () => location.reload();
  }
})();
