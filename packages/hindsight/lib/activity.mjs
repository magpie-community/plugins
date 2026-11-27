import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hindsight } from "./hindsight.mjs";
import { hash } from "./turns.mjs";

const HOUR = 3600000;
const MAX_QUEUE = 1024;
const OUTCOMES = new Set(["pending", "processing", "completed", "failed", "cancelled"]);

function clean(value, limit = 128) {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, limit) : "";
}

function connection(config) {
  return hash([config.hindsight_api, config.bank]);
}

export function createActivity({ dir = process.env.MAGPIE_HINDSIGHT_STATE_DIR ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "magpie", "hindsight"),
  fetcher = fetch,
  clock = Date.now } = {}) {
  let database;
  let timer;
  let flushing;
  let lastCleanup = 0;
  let polling;
  let runtime;
  const pollPlans = new Map();
  let fallback = [];
  const queue = [];
  const ids = new Set();

  async function openDatabase() {
    if (!globalThis.Bun) return null;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const { Database } = await import("bun:sqlite");
      const db = new Database(join(dir, "activity.sqlite"));
      db.exec("PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL;");
      db.exec(
        "CREATE TABLE IF NOT EXISTS hourly (hour INTEGER, agent TEXT, bank TEXT, action TEXT, code TEXT, n INTEGER, ms INTEGER, bytes INTEGER, last INTEGER, PRIMARY KEY(hour,agent,bank,action,code));" +
        "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER, agent TEXT, bank TEXT, protocol TEXT, action TEXT, code TEXT, ms INTEGER, bytes INTEGER);" +
        "CREATE TABLE IF NOT EXISTS operations (id TEXT, connection TEXT, bank TEXT, agent TEXT, created INTEGER, due INTEGER, status TEXT, PRIMARY KEY(id,connection));" +
        "CREATE INDEX IF NOT EXISTS operations_due ON operations(connection,due);" +
        "CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT, last INTEGER);"
      );
      return db;
    } catch { return null; }
  }

  function row(event) {
    let agent = clean(event.agent) || "unknown";
    if (ids.size >= 128 && !ids.has(agent)) agent = "unknown";
    ids.add(agent);
    return {
      ts: clock(), agent, bank: clean(event.bank), protocol: clean(event.protocol, 24),
      action: clean(event.action, 24), code: clean(event.code, 32),
      ms: Math.max(0, Math.round(Number(event.ms) || 0)),
      bytes: Math.max(0, Math.round(Number(event.bytes) || 0))
    };
  }

  function observe(event, config) {
    if (queue.length >= MAX_QUEUE) return;
    const entry = row(event);
    if (event.action === "request" && /^[a-f0-9]{12}$/.test(event.revision ?? "")) {
      entry.revision = event.revision;
      runtime = { revision: entry.revision, last: entry.ts };
    }
    if (config && typeof event.operation === "string" && /^[a-f0-9-]{36}$/i.test(event.operation)) {
      entry.operation = { id: event.operation, connection: connection(config) };
      if (pollPlans.size < 16 && !pollPlans.has(entry.operation.connection)) schedulePoll(config, entry.operation.connection);
    }
    queue.push(entry);
    if (!timer) {
      timer = setTimeout(() => { timer = undefined; void flush(); }, 300);
      timer.unref?.();
    }
  }

  function insert(db, events) {
    const hourly = db.query("INSERT INTO hourly VALUES (?,?,?,?,?,1,?,?,?) ON CONFLICT(hour,agent,bank,action,code) DO UPDATE SET n=n+1,ms=ms+excluded.ms,bytes=bytes+excluded.bytes,last=MAX(last,excluded.last)");
    const recent = db.query("INSERT INTO events(ts,agent,bank,protocol,action,code,ms,bytes) VALUES (?,?,?,?,?,?,?,?)");
    const pending = db.query("INSERT OR IGNORE INTO operations VALUES (?,?,?,?,?,?,?)");
    const revision = db.query("INSERT INTO runtime VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,last=excluded.last WHERE excluded.last>=last");
    db.transaction(() => {
      for (const event of events) {
        const { ts, agent, bank, protocol, action, code, ms, bytes, operation } = event;
        hourly.run(Math.floor(ts / HOUR) * HOUR, agent, bank, action, code, ms, bytes, ts);
        if (action !== "request" && (action !== "injection" || code !== "applied"))
          recent.run(ts, agent, bank, protocol, action, code, ms, bytes);
        if (event.revision) revision.run(event.revision, ts);
        if (operation) pending.run(operation.id, operation.connection, bank, agent, ts, ts + 2000, code);
      }
      if (clock() - lastCleanup > HOUR) {
        db.query("DELETE FROM hourly WHERE hour < ?").run(clock() - 31 * 24 * HOUR);
        db.query("DELETE FROM operations WHERE created < ?").run(clock() - 31 * 24 * HOUR);
        lastCleanup = clock();
      }
      db.exec("DELETE FROM events WHERE id <= (SELECT MAX(id) - 300 FROM events)");
      db.exec("DELETE FROM operations WHERE rowid <= (SELECT MAX(rowid) - 2048 FROM operations)");
    })();
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      database ??= openDatabase();
      const db = await database;
      const batch = queue.splice(0);
      if (!batch.length) return;
      try {
        if (!db) throw new Error("no database");
        insert(db, fallback.concat(batch));
        fallback = [];
      } catch {
        fallback = fallback.concat(batch).slice(-2000);
      }
    })().finally(() => { flushing = undefined; });
    return flushing;
  }

  function schedulePoll(config, key) {
    // The hook host can confirm writes with the workbench closed. A later
    // service startup can pick up unfinished operations from the same store.
    const timer = setTimeout(async () => {
      try {
        await poll(config);
        const db = await database;
        if (db?.query("SELECT 1 FROM operations WHERE connection=? AND due<? LIMIT 1").get(key, Number.MAX_SAFE_INTEGER)) {
          schedulePoll(config, key);
          return;
        }
      } catch { /* Keep telemetry failures outside model traffic. */ }
      pollPlans.delete(key);
    }, 15000);
    timer.unref?.();
    pollPlans.set(key, timer);
  }

  async function poll(config) {
    if (!config || polling) return;
    await flush();
    const db = await database;
    if (!db || polling) return;
    const now = clock();
    const key = connection(config);
    const pending = db.query("SELECT * FROM operations WHERE connection=? AND due<=? LIMIT 8").all(key, now);
    if (!pending.length) return;
    const client = new Hindsight(config, fetcher);
    polling = Promise.allSettled(pending.map(async operation => {
      let status;
      try {
        const result = await client.operation(operation.id);
        if (OUTCOMES.has(result?.status)) status = result.status;
      } catch { /* A missing or temporarily unavailable acknowledgement stays uncertain. */ }
      if (now - operation.created > 24 * HOUR && !["completed", "failed", "cancelled"].includes(status)) status = "unknown";
      const complete = ["completed", "failed", "cancelled", "unknown"].includes(status);
      const due = complete ? Number.MAX_SAFE_INTEGER : now + Math.min(5 * 60000, Math.max(5000, (now - operation.created) / 2));
      const saved = db.query("UPDATE operations SET due=?,status=? WHERE id=? AND connection=? AND due=?")
        .run(due, status || operation.status, operation.id, key, operation.due);
      if (saved.changes && status && status !== operation.status && (complete || status === "processing")) {
        observe({ agent: operation.agent, bank: operation.bank, action: "capture", code: status });
      }
    })).finally(() => { polling = undefined; });
    return polling;
  }

  async function summary(hours = 24) {
    await flush();
    const db = await database;
    const since = Math.floor((clock() - hours * HOUR) / HOUR) * HOUR;
    if (!db) {
      const recent = fallback.filter(item => item.ts >= since).map(({ operation, revision, ...item }) => item);
      return {
        source: "session", rows: recent.map(item => ({ ...item, last: item.ts, n: 1 })),
        recent: recent.slice(-60).reverse(), runtime, updatedAt: clock(), since
      };
    }
    const rows = db.query("SELECT agent,bank,action,code,SUM(n) AS n,SUM(ms) AS ms,SUM(bytes) AS bytes,MAX(last) AS last FROM hourly WHERE hour>=? GROUP BY agent,bank,action,code").all(since);
    const recent = db.query("SELECT ts,agent,bank,protocol,action,code,ms,bytes FROM events WHERE ts>=? ORDER BY id DESC LIMIT 60").all(since);
    const observed = db.query("SELECT revision,last FROM runtime WHERE id=1").get();
    return { source: "local", rows, recent, runtime: observed ?? runtime, updatedAt: clock(), since };
  }

  return { observe, summary, poll, flush };
}

export const activity = createActivity();
