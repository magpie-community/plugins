// offline self-test: watcher -> adapter -> upstream engine -> sqlite
// run: bun tests/selftest.mjs
import { rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// node:http speaks directly to 127.0.0.1 and never consults HTTP_PROXY.
// Bun's fetch would go through the shell's proxy (HTTP_PROXY is set with an
// empty NO_PROXY here) and a proxy 502 is neither "up" nor "down".
const httpGet = (port, path) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = join(ROOT, "tests", "tmp-selftest.db");
const STATE = join(ROOT, "tests", "watcher-state.json");
for (const p of [TMP, TMP + "-wal", TMP + "-shm", STATE]) {
  try { rmSync(p, { force: true }); } catch {}
}

const checks = [];
const ok = (name, cond, extra = "") => {
  checks.push([name, !!cond]);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const { createPetWatcher } = await import(join(ROOT, "lib", "pet.watcher.mjs"));

// ------------------------------------------------------------ fake gateway ---
// timestamps are RELATIVE to now: a fixed date rots the moment the wall
// clock passes it (the "since" window is now-5min)
const T0 = Date.now() - 3 * 60 * 1000;
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const rows = [
  { route_id: 101, t: iso(1000), session: "s1", agent: "pi", model: "m1", in: 500, out: 100, cache_read: 900, cache_write: 0, reasoning: 0, cost: 0.001, status: 200 },
  { route_id: 102, t: iso(2000), session: "s2", agent: "claude", model: "m2", in: 300, out: 50, cache_read: 0, cache_write: 0, reasoning: 25, cost: 0.002, status: 200 },
  { route_id: 103, t: iso(3000), session: "s3", agent: "codex", model: "m3", in: 999, out: 999, status: 500 }, // failed: skip
  { t: iso(4000), session: "s4", agent: "workbuddy", model: "hy4", in: 40, out: 60, cost: 0, status: 0, source: "log" }, // no route_id
];

let fetchCalls = 0;
const fakeFetch = async () => {
  fetchCalls++;
  return {
    status: 200,
    json: async () => ({ period: "30d", rows }),
  };
};

// ------------------------------------------------------------------- run 1 ---
const w1 = createPetWatcher({
  databasePath: TMP,
  gatewayUrl: "http://fake.local",
  pollSeconds: 3600,
  includeCacheTokens: false,
  notifications: false,
  fetchImpl: fakeFetch,
});
const fed1 = await w1.pollOnce();
ok("first poll feeds nothing (no partner yet, honest)", fed1 === 0, `got ${fed1}`);
// expected tokens once fed: 600 + 375 + 100 = 1075 (cache 900 excluded)

// spawn first so receipts land in usage_receipts
const { createPetAdapter } = await import(join(ROOT, "lib", "pet.adapter.mjs"));
const adapter = createPetAdapter({ databasePath: TMP, notifyGate: () => false });
const spawn = await adapter.runCommand("digital-pet-spawn");
ok("spawn works", spawn.text.length > 0, JSON.stringify(spawn.text));

// wait: run 1 fed before spawn -> no partner -> "no_active_partner" (not stored)
// feed again now that a partner exists
const fed1b = await w1.pollOnce();
ok("re-feed after spawn lands", fed1b === 3, `got ${fed1b}`);

const { Database } = await import("bun:sqlite");
const db = new Database(TMP, { readonly: true });
const receipts = db.query("SELECT COUNT(*) c, SUM(token_delta) s FROM usage_receipts").get();
db.close();
ok("3 receipts stored", receipts.c === 3, `got ${receipts.c}`);
ok("token sum 1075 (cache excluded, failed skipped)", receipts.s === 1075, `got ${receipts.s}`);

// ------------------------------------------------------------------- run 2 ---
// duplicate poll: same rows, but since moved past them -> nothing new
const fed2 = await w1.pollOnce();
ok("duplicate poll feeds nothing", fed2 === 0, `got ${fed2}`);

// ------------------------------------------------------------------- run 3 ---
// new row arrives; overlap window re-offers old rows -> receipts dedupe them
rows.push({ route_id: 104, t: iso(30 * 1000), session: "s5", agent: "pi", model: "m1", in: 7, out: 8, status: 200, cost: 0.5 });
const fed3 = await w1.pollOnce();
ok("new row feeds once", fed3 === 1, `got ${fed3}`);
const db2 = new Database(TMP, { readonly: true });
const r2 = db2.query("SELECT COUNT(*) c, SUM(token_delta) s FROM usage_receipts").get();
db2.close();
ok("receipt total 4, sum 1090", r2.c === 4 && r2.s === 1090, `got ${r2.c}/${r2.s}`);

// ------------------------------------------------------------------- run 4 ---
// includeCacheTokens = true (new watcher on the same db, state file shared)
rows.push({ route_id: 105, t: iso(60 * 1000), session: "s6", agent: "pi", model: "m1", in: 1, out: 1, cache_read: 1000, status: 200 });
const w4 = createPetWatcher({
  databasePath: TMP,
  gatewayUrl: "http://fake.local",
  pollSeconds: 3600,
  includeCacheTokens: true,
  notifications: false,
  fetchImpl: fakeFetch,
});
const fed4 = await w4.pollOnce();
const db3 = new Database(TMP, { readonly: true });
const r3 = db3.query("SELECT COUNT(*) c, SUM(token_delta) s FROM usage_receipts").get();
db3.close();
ok("cache tokens counted when enabled", r3.s === 1090 + 1002, `got ${r3.s}`);

// ------------------------------------------------------------------- run 5 ---
// engine commands still work through the same db
const fr = await adapter.runCommand("digital-pet-freeze");
ok("freeze works", fr.text.length > 0 || fr.toasts.length > 0);
const unf = await adapter.runCommand("digital-pet-unfreeze");
ok("unfreeze works", unf.text.length > 0 || unf.toasts.length > 0);

// ------------------------------------------------------------------- run 6 ---
// unreachable gateway degrades to an error, not a crash
const w6 = createPetWatcher({
  databasePath: TMP,
  gatewayUrl: "http://127.0.0.1:1",
  pollSeconds: 3600,
  fetchImpl: async () => { throw new Error("ECONNREFUSED fake"); },
});
let threw = false;
try { await w6.pollOnce(); } catch (e) { threw = true; }
ok("poll errors propagate for the tick wrapper", threw);

// ------------------------------------------------------------------- run 8 ---
// sidebar page server: /api/state, /api/command, static app.html
const { createPetServer } = await import(join(ROOT, "lib", "pet.server.mjs"));
const srv = createPetServer({ databasePath: TMP, port: 0, notifyGate: () => false });
const served = await srv.start();
ok("server binds", served === true);
const SRV_PORT = srv.port;
const SRV_TOKEN = srv.apiToken;

const state1 = await (await fetch(`http://127.0.0.1:${SRV_PORT}/api/state`, { headers: { "x-magpie-pet-token": SRV_TOKEN } })).json();
ok("api/state returns partner", state1.ok === true && state1.partner && state1.partner.node.id === "0-001", JSON.stringify(state1.partner?.node));
ok("api/state counts receipts", state1.fedRequests === 5, `got ${state1.fedRequests}`);

const pageHtml = await (await fetch(`http://127.0.0.1:${SRV_PORT}/`)).text();
ok("dashboard served", pageHtml.includes("\u5ba0\u7269") && pageHtml.includes("api/state"));
const bootJs = await (await fetch(`http://127.0.0.1:${SRV_PORT}/boot.js`)).text();
ok("boot.js served (guide page asset)", bootJs.includes("3571") && bootJs.includes("Promise.race"));

const badCmd = await fetch(`http://127.0.0.1:${SRV_PORT}/api/command`, {
  method: "POST", headers: { "content-type": "application/json", "x-magpie-pet-token": SRV_TOKEN },
  body: JSON.stringify({ name: "rm -rf" }),
});
ok("unknown command rejected", badCmd.status === 400);
const badSet = await fetch(`http://127.0.0.1:${SRV_PORT}/api/command`, {
  method: "POST", headers: { "content-type": "application/json", "x-magpie-pet-token": SRV_TOKEN },
  body: JSON.stringify({ name: "digital-pet-set", args: "DROP TABLE" }),
});
ok("set id validated", badSet.status === 400);
const goodFreeze = await (await fetch(`http://127.0.0.1:${SRV_PORT}/api/command`, {
  method: "POST", headers: { "content-type": "application/json", "x-magpie-pet-token": SRV_TOKEN },
  body: JSON.stringify({ name: "digital-pet-freeze" }),
})).json();
ok("freeze via page server", goodFreeze.text.length > 0 || (goodFreeze.toasts || []).length > 0);
ok("command response carries state", goodFreeze.state && goodFreeze.state.frozen === true);
await srv.close();
// direct connection, no proxy: after close the port must refuse to connect
const afterClose = await httpGet(SRV_PORT, "/api/ping").then(() => false, () => true);
ok("server closed", afterClose);

// ------------------------------------------------------------------- run 8b --
// EADDRINUSE retry: second server on a taken port backs off, then takes
// over after the holder closes
const holder = createPetServer({ databasePath: TMP, port: 0, notifyGate: () => false });
ok("holder binds", (await holder.start()) === true);
const heldPort = holder.port;
const taker = createPetServer({ databasePath: TMP, port: heldPort, notifyGate: () => false, retryMs: 250 });
ok("taker backs off while port held", (await taker.start()) === false);
await holder.close();
await new Promise((r) => setTimeout(r, 700));
const taken = await httpGet(heldPort, "/api/ping")
  .then((r) => JSON.parse(r.body))
  .catch(() => null);
ok("taker takes over after holder exits", taken && taken.ok === true);
await taker.close();

// ------------------------------------------------------------------- run 9 ---
// entry server() smoke: starts a real watcher against a dead gateway, must
// not throw and must return {}
const entry = await import(join(ROOT, "index.mjs"));
let entryOk = true;
try {
  const hooks = await entry.default.server({}, { dbPath: TMP, gatewayUrl: "http://127.0.0.1:1", pollSeconds: 3600, port: 0 });
  entryOk = hooks && typeof hooks === "object";
} catch (e) {
  entryOk = false;
  console.log("entry error:", e?.message);
}
ok("entry server() returns hooks object", entryOk);
await new Promise((r) => setTimeout(r, 3500)); // let its first tick fire and fail quietly

// ------------------------------------------------------------------ cleanup ---
await w1.stop().catch(() => {});
await w4.stop().catch(() => {});
await w6.stop().catch(() => {});
try { await srv.close(); } catch {}
for (const p of [TMP, TMP + "-wal", TMP + "-shm", STATE]) {
  try { rmSync(p, { force: true }); } catch {}
}

const failed = checks.filter(([, c]) => !c);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
