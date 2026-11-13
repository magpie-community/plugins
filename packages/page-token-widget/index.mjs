import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

let running;
let current;

// The host calls this again when the options change, and calls it once when
// the plugin is loaded. The service is restarted whenever the hand-over
// changes, so a new port or a new gateway takes effect.
export default {
  id: 'magpie-page-token-widget',
  async server(input, options) {
    if (!input?.directory) throw new Error('The Magpie plugin host is required.');
    options ||= {};
    const wanted = JSON.stringify([input.directory, options]);
    if (wanted !== current) {
      const previous = running;
      current = wanted;
      running = (async () => {
        await (await previous?.catch(() => null))?.close();
        return startServer({
          root,
          dataDir: path.join(input.directory, 'page-token-widget'),
          magpieDir: input.directory,
          options,
        });
      })();
      running.catch(() => {
        if (current === wanted) current = undefined;
      });
    }
    await running;
    return {};
  },
};
