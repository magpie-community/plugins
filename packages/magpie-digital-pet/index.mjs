// magpie-digital-pet · plugin entry
//
// Loaded by magpie's Bun host as an OpenCode v1 plugin (the page-chat
// pattern): the entry registers no providers and no tools — it borrows the
// host process to run
//   1. the pet watcher: polls magpie's usage API and feeds the engine
//   2. the pet page server: a local HTTP server the sidebar page navigates to
//
// Nothing is injected into any agent's context; requests are never modified.

import { createPetAdapter } from "./lib/pet.adapter.mjs";
import { createPetWatcher } from "./lib/pet.watcher.mjs";
import { createPetServer } from "./lib/pet.server.mjs";

const DEFAULTS = {
  enabled: true,
  notifications: true,
  includeCacheTokens: false,
  backfill: false,
  pollSeconds: 60,
  gatewayUrl: "http://127.0.0.1:3425",
  dbPath: "",
  port: 3571,
};

let watcher = null;
let server = null;
let starting = null;

async function startAll(options) {
  const opts = { ...DEFAULTS, ...(options && typeof options === "object" ? options : {}) };
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
  if (server) {
    await server.close();
    server = null;
  }
  if (opts.enabled === false) {
    console.log("[magpie-digital-pet] disabled by options");
    return;
  }
  const dbPath = typeof opts.dbPath === "string" && opts.dbPath.trim() ? opts.dbPath.trim() : undefined;
  const port = Number.isFinite(Number(opts.port)) && Number(opts.port) >= 0 ? Number(opts.port) : 3571;

  const adapter = createPetAdapter({ dbPath, notifyGate: () => opts.notifications !== false });
  server = createPetServer({ adapter, port });
  watcher = createPetWatcher({
    adapter,
    gatewayUrl: opts.gatewayUrl,
    pollSeconds: opts.pollSeconds,
    includeCacheTokens: opts.includeCacheTokens === true,
    notifications: opts.notifications !== false,
    backfill: opts.backfill === true,
  });
  await server.start();
  watcher.start();
}

export default {
  id: "magpie-digital-pet",
  server: async (_input, options) => {
    // the host calls this on load (and again after a hot reload with new
    // options) — (re)start everything there; errors never fail the load
    starting = startAll(options).catch((e) => {
      console.log("[magpie-digital-pet] start failed:", e?.message ?? e);
    });
    await starting.catch(() => null);
    return {};
  },
};
