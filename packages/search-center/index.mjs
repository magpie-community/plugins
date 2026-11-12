import { hooks } from "./adapter.mjs";
import { Center } from "./center.mjs";
import { createService, PORT } from "./service.mjs";
import { VERSION } from "./version.mjs";

const center = new Center();
let service;
async function start() {
  if (service) return;
  const candidate = createService(center);
  await new Promise((resolve, reject) => {
    candidate.once("error", async error => {
      if (error.code !== "EADDRINUSE") return reject(error);
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
        const status = await response.json();
        if (status.plugin !== "magpie-search-center" || status.version !== VERSION || status.service !== "dsh-ui-port")
          throw new Error("搜索中心端口被其他服务占用");
        // Magpie starts transient CLI hosts alongside the persistent GUI host.
        // Both use the same revision-locked store; keep the persistent UI service.
        resolve();
      } catch { reject(error); }
    });
    candidate.listen(PORT, "127.0.0.1", resolve);
  });
  if (candidate.listening) { candidate.unref(); service = candidate; }
}
export default {
  id: "magpie-search-center",
  server: async () => {
    await start();
    const result = hooks();
    for (const [id, entry] of Object.entries(result.search)) entry.execute = async (args, ctx) => {
      const found = await center.search({ ...args, channels: [id], profile: "quick" }, { ...ctx, native: true });
      if (!found.results.length) throw new Error("此渠道没有返回可用来源，请查看搜索中心记录");
      return found.results.slice(0, 6);
    };
    result.tool.search.execute = (args, ctx) => center.search(args, ctx);
    result.tool.capabilities.execute = () => center.publicCapabilities();
    return result;
  },
};
