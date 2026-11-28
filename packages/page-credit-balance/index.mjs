import { startServer } from './lib/server.mjs';

let started;
export default {
  id: 'magpie-credit-balance',
  async server(input, options) {
    const value = Number(options?.port);
    const port = Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 3498;
    started ??= startServer({ configDir: input?.directory, port }).catch(error => {
      started = undefined;
      throw error;
    });
    await started;
    return {};
  },
};
