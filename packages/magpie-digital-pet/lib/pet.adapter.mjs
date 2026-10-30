// magpie-digital-pet · engine adapter
//
// The upstream @jcendal/opencode-digital-pet 0.18.0 bundle (lib/upstream/index.js,
// Apache-2.0) exports an OpenCode plugin factory `plugin(input, options)` that
// returns server hooks. We drive that engine from magpie's gateway middleware:
//
//   - a fake `input.client` whose tui.showToast logs to the plugin log channel
//     and whose session.messages never returns anything (we never emit
//     "session.idle" events);
//   - usage is fed by synthesizing the OpenCode "message.updated" event shape
//     the engine already knows how to parse;
//   - commands (spawn/freeze/unfreeze/set) go through the engine's
//     "command.execute.before" hook, the same path OpenCode's TUI uses.
//
// Everything below this comment is adapter code; all game logic, catalog data
// (650 Digimon, 2606 evolution routes), SQLite schema and migrations are the
// upstream engine, untouched.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { plugin as createOpenCodePetPlugin, DIGIMON_DATA } from "@jcendal/opencode-digital-pet";

export { DIGIMON_DATA };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), Number.MAX_SAFE_INTEGER) : 0;
};

export function userDataDir() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "magpie-digital-pet");
  }
  return join(homedir(), ".config", "magpie-digital-pet");
}

export function legacyDatabasePath() {
  const here = dirname(fileURLToPath(import.meta.url)); // .../lib
  return join(dirname(here), "data", "pet.db");
}

export function defaultDatabasePath() {
  // Personal progress lives outside the plugin package, so updating the game
  // code never touches the save. dbPath remains an explicit override.
  return join(userDataDir(), "pet.db");
}

export function migrateLegacyDatabase(target = defaultDatabasePath()) {
  if (existsSync(target)) return false;
  const legacy = legacyDatabasePath();
  if (!existsSync(legacy)) return false;
  mkdirSync(dirname(target), { recursive: true });
  const src = new Database(legacy, { readonly: true });
  try {
    src.exec(`VACUUM INTO ${JSON.stringify(target)}`);
  } finally {
    src.close();
  }
  const legacyWatcher = join(dirname(legacy), "watcher-state.json");
  const targetWatcher = join(dirname(target), "watcher-state.json");
  if (existsSync(legacyWatcher) && !existsSync(targetWatcher)) copyFileSync(legacyWatcher, targetWatcher);
  return true;
}

// name lookup for status output (raw catalog data, engine-shaped)
export function nodeById(id) {
  if (typeof id !== "string") return undefined;
  return DIGIMON_DATA.find((entry) => entry.id === id);
}

export function createPetAdapter({ databasePath, dbPath, notifyGate } = {}) {
  const explicit = (typeof databasePath === "string" && databasePath.trim())
    || (typeof dbPath === "string" && dbPath.trim());
  const raw = explicit
    ? (typeof databasePath === "string" && databasePath.trim() ? databasePath.trim() : dbPath.trim())
    : defaultDatabasePath();
  const db = raw;
  mkdirSync(dirname(db), { recursive: true });
  if (!explicit) migrateLegacyDatabase(db);

  const toasts = [];
  const gate = typeof notifyGate === "function" ? notifyGate : () => true;

  const fakeClient = {
    tui: {
      // OpenCode's toast channel; magpie has none for gateway middleware, so
      // the toast text is mirrored to the plugin log instead.
      showToast: async (payload) => {
        if (gate()) {
          const source = payload && typeof payload.body === "object" && payload.body !== null ? payload.body : payload;
          toasts.push(source);
          try {
            const title = typeof source?.title === "string" ? source.title : "";
            const message = typeof source?.message === "string" ? source.message : typeof source?.body === "string" ? source.body : "";
            const line = `[magpie-digital-pet] ${[title, message].filter(Boolean).join(" — ")}`.trim();
            if (line.length > "[magpie-digital-pet] ".length) console.log(line);
          } catch {}
        }
        return { data: true };
      },
    },
    session: {
      // never reached: we never emit session.idle events
      messages: async () => ({ data: [] }),
    },
  };

  const ready = createOpenCodePetPlugin({ client: fakeClient }, { databasePath: db }).then((hooks) => {
    if (typeof hooks?.event !== "function" || typeof hooks?.["command.execute.before"] !== "function") {
      throw new Error("upstream engine returned unexpected hooks");
    }
    return hooks;
  });

  // read-only mirror connection for receipt lookups (the engine keeps its
  // own read-write handle; WAL makes concurrent readers safe)
  let roDb = null;
  function receiptSeen(receiptKey) {
    try {
      if (!roDb) {
        if (!existsSync(db)) return false;
        roDb = new Database(db, { readonly: true });
        roDb.run("PRAGMA busy_timeout = 5000");
      }
      const a = roDb.query("SELECT 1 FROM usage_receipts WHERE receipt_key = ? LIMIT 1").get(receiptKey);
      if (a) return true;
      const b = roDb.query("SELECT 1 FROM vpet_control_receipts WHERE receipt_key = ? LIMIT 1").get(receiptKey);
      return !!b;
    } catch {
      return false; // fail-open: let the engine's own dedupe decide
    }
  }

  // Starter pool: the first egg is Digiegg. Later hatches pick the first
  // baby form the player has not owned yet, so hatching does not repeat until
  // the available baby pool is exhausted. Later stages still come from
  // evolution, not from the hatch pool.
  function applyStarterPool() {
    try {
      const rw = new Database(db);
      rw.run("PRAGMA busy_timeout = 5000");
      try {
        const active = rw
          .query("SELECT partner_id, current_node_id FROM partners WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1) AND retired_at IS NULL LIMIT 1")
          .get();
        if (!active || active.current_node_id !== "0-001") return null;
        const owned = new Set(
          rw.query("SELECT DISTINCT current_node_id FROM partners").all().map((row) => row.current_node_id),
        );
        const stageOf = (id) => DIGIMON_DATA.find((entry) => entry.id === id)?.stage ?? 0;
        const hasOwnedBabyForm = [...owned].some((id) => stageOf(id) >= 1);
        if (!hasOwnedBabyForm) return null;
        const picked =
          DIGIMON_DATA.find((entry) => entry.stage === 1 && !owned.has(entry.id)) ||
          DIGIMON_DATA.find((entry) => entry.stage === 2 && !owned.has(entry.id));
        if (!picked) return null;
        rw.query("UPDATE partners SET current_node_id = ?, gauge = 0 WHERE partner_id = ?").run(picked.id, active.partner_id);
        const spawnEvent = rw
          .query("SELECT event_id FROM partner_events WHERE partner_id = ? AND kind = 'spawned' ORDER BY created_at DESC LIMIT 1")
          .get(active.partner_id);
        if (spawnEvent) {
          rw.query("UPDATE partner_events SET current_node_id = ? WHERE event_id = ?").run(picked.id, spawnEvent.event_id);
        }
        return picked.id;
      } finally {
        rw.close();
      }
    } catch {
      return null;
    }
  }

  const adapter = {
    databasePath: db,
    lastToasts(n = 5) {
      return toasts.slice(-n);
    },

    // Feed one completed request's token usage into the engine.
    // tokens: { input, output, reasoning, cacheRead, cacheWrite } (already
    // filtered by the includeCacheTokens option upstream of this call).
    async feedUsage({ id, tokens = {}, cost, completedAt } = {}) {
      const input = num(tokens.input);
      const output = num(tokens.output);
      const reasoning = num(tokens.reasoning);
      const cacheRead = num(tokens.cacheRead);
      const cacheWrite = num(tokens.cacheWrite);
      const total = input + output + reasoning + cacheRead + cacheWrite;
      if (total <= 0) return { kind: "skipped" };

      const messageId = typeof id === "string" && id.length > 0 ? id.slice(0, 200) : `magpet-${randomUUID()}`;
      const receiptKey = `message:${messageId}`;
      if (receiptSeen(receiptKey)) return { kind: "duplicate", tokenDelta: total };
      const info = {
        role: "assistant",
        id: messageId,
        time: { completed: Number.isFinite(completedAt) ? completedAt : Date.now() },
        tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
        cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      };

      const hooks = await ready;
      const before = toasts.length;
      await hooks.event({ event: { type: "message.updated", properties: { info } } });
      // the engine tells us nothing back — verify the receipt landed to tell
      // "fed" apart from "no active partner" (usage before the first spawn
      // is not recorded by the engine, by design)
      const stored = receiptSeen(receiptKey);
      return {
        kind: stored ? "fed" : "no_partner",
        tokenDelta: total,
        toasts: toasts.slice(before),
      };
    },

    // true when the engine has an active partner (a fresh install has none,
    // and usage without one is not recorded)
    hasActivePartner() {
      try {
        if (!existsSync(db)) return false;
        if (!roDb) {
          roDb = new Database(db, { readonly: true });
          roDb.run("PRAGMA busy_timeout = 5000");
        }
        const row = roDb
          .query(
            "SELECT 1 FROM partners WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1) AND retired_at IS NULL LIMIT 1",
          )
          .get();
        return !!row;
      } catch {
        return false;
      }
    },

    // Run one of the engine's slash commands: digital-pet-spawn,
    // digital-pet-freeze, digital-pet-unfreeze, digital-pet-set <id>.
    async runCommand(name, args) {
      const hooks = await ready;
      const messageID = `digital-pet-${name}-magpie-${randomUUID()}`;
      const output = { parts: [] };
      const before = toasts.length;
      await hooks["command.execute.before"](
        { command: name, sessionID: "magpie-cli", arguments: args },
        output,
      );
      let text = output.parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim();
      if (name === "digital-pet-spawn") {
        const starterId = applyStarterPool();
        if (starterId) {
          const starter = nodeById(starterId);
          const label = starter ? `${starter.name_en} · ${starter.name_jp}` : starterId;
          text = `${text}\n孵化池起效了：这次孵出的是 ${label}。`;
          toasts.push({ title: "孵化池", message: `孵出了 ${label}` });
        }
      }
      return {
        text,
        toasts: toasts.slice(before),
      };
    },
  };

  // surface init errors to the first caller instead of dead-ending
  const wrap = (fn) => async (...a) => {
    await ready;
    return fn(...a);
  };
  adapter.feedUsage = wrap(adapter.feedUsage);
  adapter.runCommand = wrap(adapter.runCommand);
  return adapter;
}
