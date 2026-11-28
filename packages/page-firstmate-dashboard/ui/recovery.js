(() => {
  const prefix = 'firstmate-edit-recovery:';
  function take() {
    if (!window.name.startsWith(prefix)) return null;
    const raw = window.name.slice(prefix.length); window.name = '';
    try {
      const record = JSON.parse(raw);
      if (typeof record.previousName === 'string') window.name = record.previousName;
      if (record.version !== 1 || !Number.isFinite(record.at) || Date.now() - record.at > 300000 || Date.now() < record.at || typeof record.home !== 'string') return null;
      return record;
    } catch { return null; }
  }
  function keep(record) {
    const text = JSON.stringify({ ...record, version: 1, at: Date.now(), previousName: window.name.startsWith(prefix) ? '' : window.name });
    if (text.length > 2 * 1024 * 1024) throw new Error('编辑内容太大，未重载页面；当前编辑仍在本页。');
    // window.name survives a same-URL reload even in MagPie's opaque iframe.
    // This holds form data in the same browsing context, never a write token,
    // never a disk cache, and never a request to replay automatically.
    window.name = prefix + text;
  }
  window.FMRecovery = { take, keep };
})();
