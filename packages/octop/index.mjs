import { OctopAdapter } from './adapter.mjs';

const instance = Symbol.for('magpie.octop.adapter.v1');

export default async function Octop(input) {
  if (!globalThis[instance]) {
    const log = code => {
      try {
        void input?.client?.app?.log?.({ body: { service: 'octop', level: 'warn', message: code } })?.catch?.(() => {});
      } catch { /* Never log configuration, credentials or raw RPC errors. */ }
    };
    const adapter = await new OctopAdapter({ log }).start();
    globalThis[instance] = adapter;
    // The shared host owns shutdown. Its normal exit path is synchronous;
    // never install signal handlers or terminate a host shared with plugins.
    process.once('exit', () => adapter.restoreOnExit());
  }
  return {};
}
