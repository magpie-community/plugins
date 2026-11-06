// The host part of the plugin: magpie's Bun host loads it and asks it for
// the page's service. The service runs inside that host, so it stops when
// magpie stops the plugin.
import { startServer } from "./lib/server.mjs";

let started = null;

export default {
  id: "magpie-usage-tree",
  server: async (_input, options) => {
    if (!started) {
      started = startServer({
        port: Number(options?.port) || 3494,
        currency: options?.currency,
        chineseUnits: options?.chineseUnits,
        usdCny: options?.usdCny,
      }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
