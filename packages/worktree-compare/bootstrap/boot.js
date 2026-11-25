(async () => {
  const status = document.querySelector('#status');
  const retry = document.querySelector('#retry');
  retry.addEventListener('click', () => location.reload());
  const failed = () => {
    status.textContent = 'Reopen this page in Magpie and check the plugin service port. / 请在 Magpie 中重新打开，或检查插件服务端口。';
    retry.hidden = false;
  };
  const timer = setTimeout(failed, 10000);
  try {
    await window.magpie.ready;
    const options = await window.magpie.options.get();
    if (!/^[0-9a-f]{64}$/.test(options.arenaAccess || '')) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const arenaAccess = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      await window.magpie.options.set({ ...options, arenaAccess });
      // Setting options restarts the host. Loading this entry again warms the new host.
      clearTimeout(timer);
      location.reload();
      return;
    }
    const port = Number(options.port ?? 3497);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
    const url = window.magpie.service ? new URL(window.magpie.service, location.href) : new URL('http://127.0.0.1:' + port + '/');
    if (window.magpie.service) {
      const entry = new URL(location.href);
      const root = entry.pathname.match(/^(.*\/_magpie\/plugin\/[a-f0-9]{32}\/)/)?.[1];
      if (!root || url.origin !== entry.origin || !/^https?:$/.test(url.protocol) ||
          url.pathname !== root + '_magpie/service/' || url.search || url.username || url.password) {
        throw Error('Unexpected plugin service');
      }
    }
    url.hash = new URLSearchParams({ access: options.arenaAccess }).toString();
    location.replace(url.href);
  } catch {
    clearTimeout(timer);
    failed();
  }
})();
