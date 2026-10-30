// magpie-digital-pet · usage watcher
//
// Polls magpie's usage API and feeds every completed request into the pet
// engine through the adapter. Rows carry exactly the fields we need
// (route_id for idempotency, in/out/cache_read/cache_write/reasoning/cost),
// which is why this design beats parsing response bodies: magpie has already
// accounted every request, streams included.
//
// Concurrency: several host processes may each run a watcher on the same
// database. That is safe — the engine dedupes by receipt key (route_id) and
// SQLite runs in WAL with a busy timeout — and the state file is
// last-writer-wins with a deliberate overlap handled by the same receipts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPetAdapter } from "./pet.adapter.mjs";

const DEFAULT_GATEWAY = "http://127.0.0.1:3425";

function stateFileFor(dbPath) {
  return join(dirname(dbPath), "watcher-state.json");
}

function loadState(file, backfill) {
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Number.isFinite(parsed?.since)) return { since: parsed.since };
    }
  } catch {}
  // first run: count only new usage (no backfill) unless asked otherwise
  return { since: backfill ? 0 : Date.now() - 5 * 60 * 1000 };
}

export function createPetWatcher({
  databasePath,
  dbPath,
  adapter: sharedAdapter,
  gatewayUrl = DEFAULT_GATEWAY,
  pollSeconds = 60,
  includeCacheTokens = false,
  notifications = true,
  backfill = false,
  fetchImpl,
} = {}) {
  const fetchFn = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchFn) throw new Error("no fetch available in this runtime");

  const adapter = sharedAdapter ?? createPetAdapter({
    databasePath,
    dbPath,
    notifyGate: () => notifications !== false,
  });
  const stateFile = stateFileFor(adapter.databasePath);

  let timer = null;
  let running = false;
  let polling = false;
  let since = loadState(stateFile, backfill).since;
  let lastError = null;
  let fedTotal = 0;

  const intervalMs = Math.max(15, Math.min(Number(pollSeconds) || 60, 3600)) * 1000;

  function persistState() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ since, savedAt: new Date().toISOString() }));
    } catch {}
  }

  const rowKey = (row) => {
    if (typeof row.route_id === "number" || (typeof row.route_id === "string" && row.route_id)) {
      return `route:${row.route_id}`;
    }
    return `row:${row.t}|${row.session ?? ""}|${row.agent ?? ""}|${row.model ?? ""}|${row.in ?? 0}|${row.out ?? 0}`;
  };

  const rowTime = (row) => {
    const ms = Date.parse(row.t);
    return Number.isFinite(ms) ? ms : 0;
  };

  async function pollOnce() {
    const url = `${gatewayUrl.replace(/\/+$/, "")}/v1/magpie/usage/requests`;
    const res = await fetchFn(url);
    if (!res || typeof res.json !== "function") throw new Error("usage API: no json");
    if (res.status && res.status !== 200) throw new Error(`usage API: HTTP ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (rows.length === 0) return 0;

    // chronological order keeps the gauge progression sane
    const fresh = rows
      .map((row) => ({ row, key: rowKey(row), tMs: rowTime(row) }))
      .filter((x) => x.tMs > 0 && x.tMs >= since)
      .sort((a, b) => a.tMs - b.tMs);

    let fed = 0;
    let maxT = since;
    for (const { row, key, tMs } of fresh) {
      if (tMs > maxT) maxT = tMs;
      const status = Number(row.status);
      if (Number.isFinite(status) && status >= 400) continue; // failed requests don't feed
      const input = Number(row.in) || 0;
      const output = Number(row.out) || 0;
      const reasoning = Number(row.reasoning) || 0;
      const cacheRead = includeCacheTokens ? Number(row.cache_read) || 0 : 0;
      const cacheWrite = includeCacheTokens ? Number(row.cache_write) || 0 : 0;
      if (input + output + reasoning + cacheRead + cacheWrite <= 0) continue;

      const result = await adapter.feedUsage({
        id: key,
        tokens: { input, output, reasoning, cacheRead, cacheWrite },
        cost: Number(row.cost) > 0 ? Number(row.cost) : 0,
        completedAt: tMs,
      });
      if (result?.kind === "fed") fed++;
      // duplicates (another watcher process, or the since-overlap) are fine:
      // the engine's receipt table already has the key
    }
    // keep a small overlap so late-arriving rows with older timestamps are
    // still picked up; receipts absorb the re-feeds
    since = Math.max(since, maxT - 5 * 60 * 1000);
    persistState();
    return fed;
  }

  async function tick() {
    if (polling) return;
    polling = true;
    try {
      const fed = await pollOnce();
      fedTotal += fed;
      lastError = null;
      if (fed > 0) {
        console.log(`[magpie-digital-pet] fed ${fed} request${fed === 1 ? "" : "s"} (${fedTotal} total)`);
      }
    } catch (e) {
      if (String(e?.message) !== String(lastError)) {
        lastError = e?.message ?? String(e);
        console.log("[magpie-digital-pet] poll failed:", lastError);
      }
    } finally {
      polling = false;
    }
  }

  return {
    databasePath: adapter.databasePath,
    stateFile,
    get since() {
      return since;
    },
    stats() {
      return { fedTotal, lastError, intervalMs };
    },
    start() {
      if (running) return;
      running = true;
      setTimeout(async () => {
        try {
          // a fresh install has no partner: hatch one so usage counts from
          // the first poll (usage before a partner exists is not recorded)
          if (!adapter.hasActivePartner()) {
            const spawn = await adapter.runCommand("digital-pet-spawn");
            console.log("[magpie-digital-pet] auto-spawned a partner:", spawn.text || "generation 1");
          }
        } catch {}
        await tick().catch(() => {});
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
          tick().catch(() => {});
        }, intervalMs);
        if (typeof timer?.unref === "function") timer.unref();
      }, 3000);
      if (typeof timer?.unref === "function") timer.unref();
      console.log(
        `[magpie-digital-pet] watching ${gatewayUrl} every ${Math.round(intervalMs / 1000)}s · db ${adapter.databasePath}`,
      );
    },
    async stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      persistState();
    },
    pollOnce,
  };
}
