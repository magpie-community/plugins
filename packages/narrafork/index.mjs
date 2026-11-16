// The host half of the NarraFork agent, run in magpie's plugin host (Bun) the
// way a provider plugin's main is. It keeps one entry in NarraFork's settings
// file — the "magpie" provider — and nothing else; settings.mjs holds what that
// takes, and this file exports only the function the host calls, since magpie
// takes every function a main exports as a plugin of its own.
//
// NarraFork reloads settings.json on whatever writes it (settings-file-watcher.ts),
// and magpie writes agent.defaultModel into it when a model is picked: watching
// the folder, as NarraFork does, puts the entry back after either. A file that
// already has it is never rewritten.
import { watch } from "node:fs";
import { dirname } from "node:path";
import { GATEWAY, PROVIDER, settingsPath, syncSettings } from "./settings.mjs";

// What the host says once per status, so a settings file it cannot write is
// told once and not on every save NarraFork makes.
const SAID = {
  absent: "settings.json is not there yet: start NarraFork once",
  missing: "settings.json has no customApiProviders array yet: open NarraFork's provider settings once",
  added: "the magpie provider is in settings.json",
  updated: "the magpie provider is as it should be again",
};

export default async function NarraFork(input, options = {}) {
  const path = settingsPath();
  const gateway = options?.gateway || GATEWAY;
  const key = options?.key || PROVIDER;
  const log = (level, message) => {
    try {
      void input?.client?.app?.log?.({ body: { service: "narrafork", level: level, message: message } })?.catch?.(() => {});
    } catch {
      /* nothing to log into */
    }
  };
  const told = new Set();
  let stopped = false;
  let folding = null;

  const sync = async () => {
    if (stopped) return;
    try {
      const said = await syncSettings({ path: path, gateway: gateway, key: key });
      const message = SAID[said.status];
      if (!message || told.has(said.status)) return;
      told.add(said.status);
      log(said.status === "absent" || said.status === "missing" ? "warn" : "info", message);
    } catch (error) {
      const message = "settings.json: " + (error?.message || String(error));
      if (told.has(message)) return;
      told.add(message);
      log("warn", message);
    }
  };

  await sync();

  // NarraFork watches this folder itself (settings-file-watcher.ts listens to
  // the folder, since an atomic rename replaces the file); so does this, so the
  // entry comes back after NarraFork rewrites the file and after magpie writes
  // agent.defaultModel into it. The write this makes is itself a change, and the
  // pass after it finds nothing to do.
  let watcher = null;
  try {
    watcher = watch(dirname(path), () => {
      if (stopped) return;
      clearTimeout(folding);
      folding = setTimeout(() => void sync(), 200);
    });
    watcher.on("error", () => {});
  } catch {
    /* NarraFork makes the folder on its first start: without it there is nothing to watch */
  }
  const stop = () => {
    stopped = true;
    clearTimeout(folding);
    watcher?.close();
  };
  process.once("exit", stop);
  return {};
}
