import { startServer } from "./lib/server.mjs";

let started = null;
export default {
  id: "magpie-usage-tree",
  server: async (_input, options) => {
    // The listener belongs to the host and stops when Magpie replaces it.
    if (!started) {
      started = startServer({ port: Number(options?.port) || 3491 }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
