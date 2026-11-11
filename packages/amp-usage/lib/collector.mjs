import { sendUsage } from "./transport.mjs";
import { createReadStream } from "node:fs";
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
      return () => unlink(path).catch(() => {});
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const old = await readJSON(path, null);
      if (!Number.isInteger(old?.pid) || old.pid < 1)
        throw new Error(
          "Invalid collector lock; inspect it before restarting.",
        );
      try {
        process.kill(old.pid, 0);
      } catch (err) {
        if (err.code === "ESRCH") {
          await unlink(path);
          continue;
        }
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
  const settingsPath = join(dataDir, "settings.json");
  const state = await readJSON(statePath, {
    version: 1,
    imported: {},
    pending: {},
  });
  if (state.version !== 1 || !state.imported || !state.pending)
    throw new Error(
      "Unsupported collector state. Existing state was preserved.",
    );
  let settings = await readJSON(settingsPath, {
    enabled: false,
    mode: "cloud",
  });
  if (
    typeof settings.enabled !== "boolean" ||
    !["cloud", "local"].includes(settings.mode)
  )
    throw new Error("Invalid collector settings.");
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
  const view = () => ({
    ...status,
    settings: { ...settings },
    totalImported: Object.keys(state.imported).length,
    gatewayURL: base,
    intervalSeconds: interval / 1000,
    settleSeconds: settleMs / 1000,
    threadDirs: options.threadDirs?.length ? options.threadDirs : localDirs(),
  });
  const persist = () => writeJSON(statePath, state);
  async function scan(write) {
    status = {
      ...status,
      phase: write ? "syncing" : "scanning",
      errors: [],
      issues: {},
      imported: 0,
      skipped: 0,
    };
    try {
      const result = source
        ? await source(settings.mode)
        : settings.mode === "cloud"
          ? await readCloud({ dataDir, ampPath: options.ampPath, now: clock })
          : await readLocal(
              options.threadDirs?.length ? options.threadDirs : localDirs(),
            );
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
          if (
            records.has(r.rid) &&
            fingerprint(records.get(r.rid)) !== fingerprint(r)
          )
            throw new Error(
              "Conflicting source records; no usage was imported.",
            );
          records.set(r.rid, r);
        }
      }
      // If the gateway log cannot be read, fail closed instead of double-counting.
      const through = await gatewayCalls(join(configDir, "usage.jsonl"));
      const ready = [];
      const importedFingerprints = new Set(Object.values(state.imported));
      for (const id of Object.keys(state.pending))
        if (!records.has(id)) delete state.pending[id];
      let pending = 0;
      for (const r of records.values()) {
        const fp = fingerprint(r);
        if (state.imported[r.rid]) {
          if (state.imported[r.rid] !== fp) addIssue("changedAfterImport");
          continue;
        }
        if (importedFingerprints.has(fp)) {
          addIssue("identityChanged");
          continue;
        }
        if (gatewayMatch(r, through)) {
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
      status = {
        ...status,
        scannedThreads: result.threads.length,
        eligible: ready.length,
        pending,
        remaining: result.remaining || 0,
        issues,
        errors: [...new Set(result.errors || [])].slice(0, 10),
        lastScan: new Date(clock()).toISOString(),
      };
      await persist();
      if (write) {
        for (let i = 0; i < ready.length; i += 200) {
          if (closed || !settings.enabled) break;
          const batch = ready.slice(i, i + 200);
          const response = await fetchImpl(`${base}/v1/magpie/usage/requests`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch),
            redirect: "error",
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
            ack.records.some(
              (a, j) =>
                a.rid !== batch[j].rid ||
                !["accepted", "skipped"].includes(a.status),
            )
          )
            throw new Error(
              "Unexpected Magpie acknowledgement; retry is safe with the same record IDs.",
            );
          for (const [j, r] of batch.entries()) {
            state.imported[r.rid] = fingerprint(r);
            delete state.pending[r.rid];
            status[
              ack.records[j].status === "accepted" ? "imported" : "skipped"
            ]++;
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
  function run(write = false) {
    if (closed) return Promise.reject(new Error("Collector is closed."));
    if (job) return job;
    job = scan(write && settings.enabled).finally(() => {
      job = null;
    });
    return job;
  }
  async function configure(patch) {
    if (job) throw new Error("Wait for the current scan to finish.");
    if (
      typeof patch.enabled !== "boolean" ||
      !["cloud", "local"].includes(patch.mode)
    )
      throw new Error("Invalid settings.");
    const next = { enabled: patch.enabled, mode: patch.mode };
    await writeJSON(settingsPath, next);
    if (settings.mode !== next.mode) status = emptyStatus();
    settings = next;
    return view();
  }
  timer = setInterval(() => {
    if (settings.enabled && !closed) void run(true);
  }, interval);
  timer.unref?.();
  return {
    view,
    run,
    configure,
    async close() {
      closed = true;
      clearInterval(timer);
      if (job) await job;
    },
  };
}
