import { startService } from "./server.mjs";

async function server(input, options = {}) {
  const configuration = { directory: input.directory, ...options };
  try {
    await startService(configuration);
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    let starting = false;
    const retry = setInterval(async () => {
      if (starting) return;
      starting = true;
      try { await startService(configuration); clearInterval(retry); }
      catch {}
      finally { starting = false; }
    }, 2000);
    retry.unref();
  }
  return {};
}

export default { id: "magpie-egress", server };
