import { KimiAdapter } from './adapter.mjs';
import { startSettingsServer, SETTINGS_PORT } from './settings.mjs';
import { setPrimaryModel } from './primary-model.mjs';

const instance = Symbol.for('magpie.kimi-desktop.adapter.v1');
const SETTINGS_START_ERRORS = new Set(['settings_invalid_port', 'settings_port_in_use', 'settings_bind_failed']);

function syncSettings(adapter, log) {
  if (adapter.stopping) return;
  if (adapter.settingsPending) return adapter.settingsPending;
  if (adapter.settingsServer?.port === adapter.settingsPort) return;
  adapter.settingsPending = (async () => {
    for (;;) {
      const previous = adapter.settingsServer;
      adapter.settingsServer = null;
      await previous?.stop();
      const port = adapter.settingsPort;
      try {
        adapter.settingsServer = await startSettingsServer({
          port,
          readSettings: () => adapter.readSettings(),
          saveSettings: patch => adapter.saveSettings(patch),
        });
        adapter.settingsFailure = null;
      } catch (error) {
        const code = SETTINGS_START_ERRORS.has(error?.message) ? error.message : 'settings_server_unavailable';
        if (adapter.settingsFailure !== code) log(code);
        adapter.settingsFailure = code;
        return;
      }
      // A newer initialization may change the requested port while bind awaits.
      if (port === adapter.settingsPort) return;
    }
  })().finally(() => { adapter.settingsPending = null; });
  return adapter.settingsPending;
}

export default async function KimiDesktop(input, options = {}) {
  if (process.env.MAGPIE_KIMI_SKIP_ADAPTER === '1') return {};
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
  adapter.setPrimaryModel = model => setPrimaryModel(model, { magpiePath: options?.magpiePath, directory: input?.directory });
  adapter.settingsPort = options?.settingsPort ?? SETTINGS_PORT;
  adapter.syncSettings = () => syncSettings(adapter, log);
  await adapter.syncSettings();
  return {};
}
