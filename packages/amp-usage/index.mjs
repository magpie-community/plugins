import { join } from "node:path";
import { startServer } from "./lib/server.mjs";
let running;
export default {
  id: "amp-usage",
  async server(input, options) {
    if (!input?.directory)
      throw new Error("Amp usage needs Magpie's plugin host.");
    if (!running)
      running = startServer({
        port: Number(options?.port ?? 3497),
        configDir: input.directory,
        dataDir: join(input.directory, "amp-usage"),
        options: options || {},
      }).catch((e) => {
        running = undefined;
        throw e;
      });
    await running;
    return {};
  },
};
