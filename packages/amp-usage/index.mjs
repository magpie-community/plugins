import { join } from "node:path";
import { startServer } from "./lib/server.mjs";

// When any plugin updates, Magpie starts a new host at once but lets the old
// one finish its calls for up to 10 minutes. Until then the old service holds
// the lock and the port, so this one waits for them instead of failing.
const retryEvery = 5_000;
const retryFor = 11 * 60_000;
const held = (e) => e?.code === "ELOCKED" || e?.code === "EADDRINUSE";

let running, current, ready;
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
      let waiting;
      const waited = new Promise((resolve) => (waiting = resolve));
      running = (async () => {
        await (await previous?.catch(() => null))?.close();
        const until = Date.now() + retryFor;
        for (;;) {
          try {
            return await startServer({
              port: Number(options.port ?? 3497),
              configDir: input.directory,
              dataDir: join(input.directory, "amp-usage"),
              options,
            });
          } catch (e) {
            if (!held(e) || current !== wanted) throw e;
            if (Date.now() >= until) {
              console.error(`amp-usage: gave up waiting: ${e.message}`);
              throw e;
            }
            if (waiting) {
              console.warn(`amp-usage: ${e.message} Retrying.`);
              waiting();
              waiting = null;
            }
            await new Promise((resolve) => setTimeout(resolve, retryEvery));
          }
        }
      })();
      running.catch(() => {
        if (current === wanted) current = undefined;
      });
      // A service that must wait does not hold up the host's plugin load.
      ready = Promise.race([running, waited]);
    }
    await ready;
    return {};
  },
};
