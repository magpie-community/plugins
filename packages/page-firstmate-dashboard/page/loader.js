magpie.ready.then(() => {
  const base = magpie.service || 'http://127.0.0.1:35871/';
  location.replace(base.endsWith('/') ? base : base + '/');
}).catch(() => { document.getElementById('loading').textContent = 'MagPie 页面桥接未就绪，请重新打开此插件。'; });
