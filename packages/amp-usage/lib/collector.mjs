import { sendUsage } from "./transport.mjs";
import { createReadStream, unlinkSync } from "node:fs";
import { access, mkdir, open, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { parseThread, fingerprint, tokenSignature } from "./parser.mjs";
import { readCloud, readLocal, localDirs } from "./sources.mjs";
import { readJSON, writeJSON } from "./storage.mjs";

export function gatewayURL(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["/", "/v1", "/v1/"].includes(u.pathname)
  )
    throw new Error(
      "Use a loopback HTTP Magpie address, such as http://127.0.0.1:3425.",
    );
  return u.origin;
}

export async function acquireLock(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "collector.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const f = await open(path, "wx", 0o600);
      await f.writeFile(JSON.stringify({ pid: process.pid }));
      await f.close();
      const drop = () => {
        try {
          unlinkSync(path);
        } catch {}
      };
      process.once("exit", drop);
      return () => {
        process.off("exit", drop);
        drop();
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A lock is live only if its PID is a process this user can signal; a
      // torn write, a dead PID or a stranger's process is a leftover.
      try {
        process.kill((await readJSON(path, null)).pid, 0);
      } catch {
        await unlink(path).catch(() => {});
        continue;
      }
      throw new Error(
        "Another Amp collector is running for this Magpie configuration.",
      );
    }
  }
  throw new Error("Could not acquire collector lock.");
}

async function gatewayCalls(path) {
  try {
    await access(path);
  } catch (e) {
    if (e.code === "ENOENT") return new Map();
    throw e;
  }
  const rows = new Map();
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      r.source === "reported" ||
      r.rid?.startsWith("amp-usage:") ||
      !r.t ||
      ![r.in, r.out, r.cache_read, r.cache_write].some((n) => n > 0)
    )
      continue;
    const key = `${bareModel(r.served || r.model)}:${tokenSignature(r)}`;
    const group = rows.get(key) || [];
    group.push({ t: r.t, session: r.session });
    rows.set(key, group);
  }
  return rows;
}
const bareModel = (s) =>
  String(s || "")
    .split("/")
    .at(-1);
export function gatewayMatch(record, rows) {
  const candidates =
    rows.get(`${bareModel(record.model)}:${tokenSignature(record)}`) || [];
  return candidates.some(
    (r) =>
      r.session === record.session ||
      Math.abs(Date.parse(r.t) - Date.parse(record.t)) <= 5_000,
  );
}

export async function createCollector({
  dataDir,
  configDir,
  options = {},
  source,
  fetchImpl = sendUsage,
  clock = Date.now,
}) {
  const base = gatewayURL(options.gatewayURL || "http://127.0.0.1:3425");
  const interval =
    Math.max(60, Math.min(3600, Number(options.intervalSeconds) || 300)) * 1000;
  const settleMs =
    Math.max(30, Math.min(3600, Number(options.settleSeconds) || 120)) * 1000;
  const statePath = join(dataDir, "state.json");
  const state = await readJSON(statePath, {
    version: 1,
    imported: {},
    pending: {},
  });
  if (state.version !== 1 || !state.imported || !state.pending)
    throw new Error(
      "Unsupported collector state. Existing state was preserved.",
    );
  // Gateway rows leave usage.jsonl when Magpie rotates it; the verdict must not.
  state.gateway ||= {};
  // Installing the plugin is the consent to report; `sync: false` only reads.
  const syncing = options.sync !== false;
  // The last scan's records, for the page's own totals.
  let latest = [];
  let job = null,
    timer,
    closed = false;
  const emptyStatus = () => ({
    phase: "idle",
    lastScan: null,
    lastImport: null,
    scannedThreads: 0,
    eligible: 0,
    pending: 0,
    imported: 0,
    skipped: 0,
    remaining: 0,
    issues: {},
    errors: [],
  });
  let status = emptyStatus();
  const pad = (n) => String(n).padStart(2, "0");
  function usage() {
    const rows = new Map();
    for (const r of latest) {
      const d = new Date(r.t);
      // Local hours, so the page can show a day or the last 24 hours.
      const hour = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
      const key = `${hour} ${r.model}`;
      const row = rows.get(key) || {
        hour,
        model: r.model,
        calls: 0,
        in: 0,
        out: 0,
        cache_read: 0,
        cache_write: 0,
      };
      row.calls++;
      for (const k of ["in", "out", "cache_read", "cache_write"])
        row[k] += r[k];
      rows.set(key, row);
    }
    return [...rows.values()];
  }
  const view = () => ({
    ...status,
    usage: usage(),
    totalImported: Object.keys(state.imported).length,
  });
  // Legacy files have real times and the ledger, so they are read first and
  // win a record both sources hold; the account adds what they lack.
  async function readThreads() {
    const dirs = options.threadDirs?.length ? options.threadDirs : null;
    const local = await readLocal(dirs || localDirs(), { required: !!dirs });
    let cloud = { threads: [], errors: [], remaining: 0 };
    try {
      cloud = await readCloud({
        dataDir,
        ampPath: options.ampPath,
        now: clock,
      });
    } catch (e) {
      cloud.errors.push(e.message);
    }
    return {
      threads: [...local.threads, ...cloud.threads],
      errors: [...local.errors, ...cloud.errors],
      remaining: cloud.remaining,
    };
  }
  const persist = () => writeJSON(statePath, state);
  async function scan() {
    status = {
      ...status,
      phase: "reading",
      errors: [],
      issues: {},
      imported: 0,
      skipped: 0,
    };
    try {
      const result = await (source || readThreads)();
      const records = new Map();
      const issues = {};
      const addIssue = (k, n = 1) => {
        issues[k] = (issues[k] || 0) + n;
      };
      for (const thread of result.threads) {
        if (options.excludedThreadIds?.includes(thread.id)) {
          addIssue("excludedThread");
          continue;
        }
        const parsed = parseThread(thread, { now: clock(), settleMs });
        for (const [k, n] of Object.entries(parsed.issues)) addIssue(k, n);
        for (const r of parsed.records) {
          if (
            options.excludedModels?.includes(r.model) ||
            /^(magpie|custom:magpie)[/:]/i.test(r.model)
          ) {
            addIssue("excludedModel");
            continue;
          }
          if (!records.has(r.rid)) records.set(r.rid, r);
        }
      }
      let through;
      const ready = [];
      const importedFingerprints = new Set(Object.values(state.imported));
      for (const id of Object.keys(state.pending))
        if (!records.has(id)) delete state.pending[id];
      let pending = 0;
      const shown = [];
      for (const r of records.values()) {
        const fp = fingerprint(r);
        if (state.imported[r.rid]) {
          if (state.imported[r.rid] !== fp) addIssue("changedAfterImport");
          shown.push(r);
          continue;
        }
        if (importedFingerprints.has(fp)) {
          addIssue("identityChanged");
          continue;
        }
        shown.push(r);
        // Read the gateway log only for records still undecided. If it cannot
        // be read, fail closed instead of double-counting.
        if (state.gateway[r.rid] !== fp)
          through ??= await gatewayCalls(join(configDir, "usage.jsonl"));
        if (state.gateway[r.rid] === fp || gatewayMatch(r, through)) {
          state.gateway[r.rid] = fp;
          delete state.pending[r.rid];
          addIssue("gatewayDuplicate");
          continue;
        }
        const previous = state.pending[r.rid];
        if (!previous || previous.fingerprint !== fp)
          state.pending[r.rid] = { fingerprint: fp, since: clock() };
        if (clock() - state.pending[r.rid].since < settleMs) {
          pending++;
          continue;
        }
        ready.push(r);
      }
      latest = shown;
      status = {
        ...status,
        scannedThreads: new Set(result.threads.map((t) => t.id)).size,
        eligible: ready.length,
        pending,
        remaining: result.remaining || 0,
        issues,
        errors: [...new Set(result.errors || [])].slice(0, 10),
        lastScan: new Date(clock()).toISOString(),
      };
      await persist();
      if (syncing) {
        for (let i = 0; i < ready.length; i += 200) {
          if (closed) break;
          const batch = ready.slice(i, i + 200);
          const response = await fetchImpl(`${base}/v1/magpie/usage/requests`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok)
            throw new Error(
              `Magpie refused usage (HTTP ${response.status}). Check the gateway address and Magpie version.`,
            );
          const ack = await response.json();
          if (
            !Array.isArray(ack.records) ||
            ack.records.length !== batch.length ||
            ack.records.some((a, j) => a.rid !== batch[j].rid)
          )
            throw new Error(
              "Unexpected Magpie acknowledgement; retry is safe with the same record IDs.",
            );
          for (const [j, r] of batch.entries()) {
            const result = ack.records[j].status;
            // A record Magpie refuses is retried later; it must not block the rest.
            if (!["accepted", "skipped"].includes(result)) {
              status.issues.rejected = (status.issues.rejected || 0) + 1;
              continue;
            }
            state.imported[r.rid] = fingerprint(r);
            delete state.pending[r.rid];
            status[result === "accepted" ? "imported" : "skipped"]++;
          }
          await persist();
          status.eligible -= batch.length;
          status.lastImport = new Date(clock()).toISOString();
        }
      }
    } catch (e) {
      status.errors = [...status.errors, e.message].slice(0, 10);
    } finally {
      status.phase = "idle";
    }
    return view();
  }
  function run() {
    if (closed) return Promise.reject(new Error("Collector is closed."));
    if (job) return job;
    job = scan().finally(() => {
      job = null;
    });
    return job;
  }
  timer = setInterval(() => {
    if (syncing && !closed) void run();
  }, interval);
  timer.unref?.();
  return {
    view,
    run,
    async close() {
      closed = true;
      clearInterval(timer);
      if (job) await job;
    },
  };
}
