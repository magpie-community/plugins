import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";

const SERVE = fileURLToPath(new URL("./serve.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("./", import.meta.url));
const DEFAULT_PORT = 3488;

let started = null;

async function alive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(900),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.name === "magpie-usage-tree";
  } catch {
    return false;
  }
}

// Magpie starts a plugin host on demand and stops it again on a Restart (a
// plugin installed or set, an update). A service tied to that host would
// vanish under an open page, so the service is started once as its own
// process. Every host then finds the same one on the port.
function startDetached(port) {
  const child = spawn(process.execPath, [SERVE, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: ROOT,
  });
  child.unref();
  return child;
}

async function waitFor(port, deadline) {
  while (Date.now() < deadline) {
    if (await alive(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return alive(port);
}

function ensureStarted(options) {
  if (!started) {
    started = (async () => {
      const port = Number(options?.port) || DEFAULT_PORT;

      if (await alive(port)) return { port, reused: true };

      try {
        startDetached(port);
        if (await waitFor(port, Date.now() + 6000)) return { port, detached: true };
      } catch (error) {
        console.error("[usage-tree] detached start failed:", error?.message || error);
      }

      // Last resort: serve from this host, as page-chat does. It stops with
      // the host, but the page still works while the host is up.
      const info = await startServer({
        port,
        usdCny: Number(options?.usdCny) || 7.2,
      });
      return { port: info.port, reused: info.reused };
    })().catch((error) => {
      console.error("[usage-tree] could not start:", error?.message || error);
      started = null;
      return null;
    });
  }
  return started;
}

export default {
  id: "magpie-usage-tree",
  server: async (_input, options) => {
    await ensureStarted(options);
    return {};
  },
};
