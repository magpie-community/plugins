// The host part of the plugin: magpie's Bun host loads it and asks it for
// the page's service. The service runs inside that host, so it stops when
// magpie stops the plugin, and a new build takes the port from an older one
// (lib/server.mjs stops the older service it finds there).
import { startServer } from "./lib/server.mjs";

let started = null;

export default {
  id: "magpie-usage-tree",
  server: async (_input, options) => {
    if (!started) {
      started = startServer({ port: Number(options?.port) || 3494 }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
