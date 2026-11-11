import { join } from "node:path";
import { startServer } from "./lib/server.mjs";
let running, current;
export default {
  id: "amp-usage",
  async server(input, options) {
    if (!input?.directory)
      throw new Error("Amp usage needs Magpie's plugin host.");
    options ||= {};
    // The host calls again when options change; restart to apply them.
    const wanted = JSON.stringify([input.directory, options]);
    if (wanted !== current) {
      const previous = running;
      current = wanted;
      running = (async () => {
        await (await previous?.catch(() => null))?.close();
        return startServer({
          port: Number(options.port ?? 3497),
          configDir: input.directory,
          dataDir: join(input.directory, "amp-usage"),
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
