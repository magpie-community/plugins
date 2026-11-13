// Loaded inside the verified Trae main process. No credentials or chat data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const CHANNEL = 'vscode:main::sandbox-icubeModelManagementChange';
const INSTANCE = Symbol.for('magpie.trae.model-refresh.v1');

function startNotifier(options = {}) {
  if (globalThis[INSTANCE]) return globalThis[INSTANCE];
  const electron = options.electron || createRequire(process.execPath)('electron');
  const directory = options.directory || path.join(os.homedir(), '.config/magpie-trae');
  const file = path.join(directory, 'sync-status.json');
  const delivered = new Map();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    let status;
    try { status = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!['synced', 'disconnected'].includes(status.state) || !/^[a-f0-9]{64}$/.test(status.revision || '')) return;
    const windows = electron.webContents.getAllWebContents().filter(w => !w.isDestroyed() &&
      w.getURL().startsWith('vscode-file://vscode-app/'));
    const active = new Set(windows.map(w => w.id));
    for (const id of delivered.keys()) if (!active.has(id)) delivered.delete(id);
    let sent = 0;
    for (const window of windows) {
      if (window.isLoadingMainFrame() || delivered.get(window.id) === status.revision) continue;
      try {
        // Same broadcast as Trae's own model editor. Every window refreshes its
        // native catalog and persistence, without selecting a model or focusing.
        window.send(CHANNEL, { detail: { source: 'magpie', revision: status.revision } });
        delivered.set(window.id, status.revision); sent++;
      } catch { /* A closing window is retried only if it still exists. */ }
    }
    if (sent) {
      try { fs.writeFileSync(path.join(directory, 'client-refresh-status.json'), JSON.stringify({
        revision: status.revision, windows: sent, notifiedAt: new Date().toISOString(),
      })); } catch { /* Diagnostic status never prevents a refresh. */ }
    }
    return sent;
  };
  const timer = setInterval(tick, options.interval ?? 1000); timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); delete globalThis[INSTANCE]; };
  const instance = { tick, stop };
  globalThis[INSTANCE] = instance;
  electron.app.once('will-quit', stop);
  tick();
  return instance;
}

module.exports = { startNotifier, CHANNEL };
