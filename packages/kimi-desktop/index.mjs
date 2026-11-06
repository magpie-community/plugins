import { KimiAdapter } from './adapter.mjs';
import { startSettingsServer, SETTINGS_PORT } from './settings.mjs';

const instance = Symbol.for('magpie.kimi-desktop.adapter.v1');

export default async function KimiDesktop(input, options = {}) {
  const log = code => {
    try {
      void input?.client?.app?.log?.({ body: { service: 'kimi-desktop', level: 'warn', message: code } })?.catch?.(() => {});
    } catch { /* No configuration, credentials or raw RPC errors in logs. */ }
  };
  if (!globalThis[instance]) {
    const adapter = await new KimiAdapter({ log }).start();
    globalThis[instance] = adapter;
    // The shared host owns shutdown. Its normal exit path is synchronous;
    // never install signal handlers or terminate a host shared with plugins.
    process.once('exit', () => adapter.restoreFileOnExit());
  }
  const adapter = globalThis[instance];
  if (!adapter.settingsServer) {
    try {
      adapter.settingsServer = await startSettingsServer({
        port: options?.settingsPort ?? SETTINGS_PORT,
        readSettings: () => adapter.readSettings(),
        saveSettings: patch => adapter.saveSettings(patch),
      });
    } catch { log('settings_server_unavailable'); }
  }
  return {};
}
