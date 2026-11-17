import { startServer } from "./lib/server.mjs";

let service;

export default {
  id: "magpie-provider-quota",
  server: async (input, options) => {
    if (!service) {
      const port = Number(options?.port ?? 3497);
      service = startServer({
        port,
        configDir: input?.directory,
      }).catch((error) => {
        service = undefined;
        throw error;
      });
    }
    await service;
    return {};
  },
};
