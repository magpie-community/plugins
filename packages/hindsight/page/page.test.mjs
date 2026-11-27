import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import { createService } from "./service.mjs";
import { testConnection } from "./probe.mjs";

const load = file => readFile(new URL(file, import.meta.url), "utf8");
const fixturePort = 3482;
const base = "http://127.0.0.1:" + fixturePort;

function server(call) {
  const used = [];
  const factory = createService({
    fetcher: async (url, init) => {
      used.push({ url, init });
      return await call?.(url, init) ?? backend(url);
    },
    readInventory: async () => ({
      agents: [{ id: "dsh", name: "DeepSeek Harness", installed: true, native: { recall: "active", capture: "inactive" } }],
      native: {}, checkedAt: 1
    }),
    stats: { summary: async () => ({ rows: [], recent: [] }), poll: async () => {} }
  });
  const handle = (path, args = {}) => factory.handle(new Request(base + path, {
    ...args, headers: { host: "127.0.0.1:" + fixturePort, ...args.headers }
  }), { port: fixturePort });
  return { ...factory, handle, used };
}

function backend(url) {
  if (url.endsWith("/health")) return Response.json({ status: "healthy", database: "connected" });
  if (url.includes("/banks?q=")) return Response.json({ banks: [{ bank_id: "hermes" }], total: 1 });
  if (url.endsWith("/banks/hermes/stats")) return Response.json({ bank_id: "hermes", total_documents: 4, total_nodes: 5, content: "private" });
  if (url.includes("/banks?limit=")) return Response.json({ banks: [{ bank_id: "hermes" }, { bank_id: "fixture-existing" }], total: 2 });
  return new Response("no", { status: 404 });
}

async function tokenFor(handle) {
  const response = await handle("/workbench");
  const html = await response.text();
  return html.match(/name="hindsight-token" content="([a-f0-9]+)"/)?.[1];
}

test("settings launcher keeps a sandbox-safe options bridge and port recovery", async () => {
  const html = await load("settings.html");
  assert.match(html, /_magpie\/bridge\.js/);
  const script = await load("settings.js");
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, { dataset: {}, events: {}, addEventListener(name, callback) { this.events[name] = callback; } });
    return fields.get(id);
  };
  const opened = [];
  let options = { bank: "hermes", agents: ["claude"], unrelated: true };
  const magpie = { ready: Promise.resolve(), service: "", options: { get: async () => options, set: async next => { options = next; } } };
  new Script(script).runInNewContext({
    document: { getElementById: field }, window: { magpie }, magpie,
    URLSearchParams, location: { search: "?recovery=1", assign: url => opened.push(url) }
  });
  await new Promise(resolve => setImmediate(resolve));
  field("port").valueAsNumber = 4382;
  await field("save-port").events.click();
  assert.deepEqual(opened, ["http://127.0.0.1:4382/workbench"]);
  assert.equal(options.port, 4382);
  assert.equal(options.unrelated, true);
});

test("workbench response has scoped CSP, a nonce and no unresolved assets", async () => {
  const { handle } = server();
  const response = await handle("/workbench");
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await response.text();
  assert.doesNotMatch(html, /%%/);
  for (const id of ["bank-state", "agent-rows", "activity-totals", "check-draft", "mode-help", "save"]) assert.ok(html.includes('id="' + id + '"'));
  assert.doesNotThrow(() => new Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]));
});

test("draft probe distinguishes API, database and the exact existing bank without a recall", async () => {
  const calls = [];
  const result = await testConnection({ bank: "hermes" }, async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, redirect: init.redirect });
    return backend(url);
  });
  assert.equal(result.api, "connected");
  assert.equal(result.database, "connected");
  assert.equal(result.bankStatus, "accessible");
  assert.equal(result.stats.documents, 4);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === "GET" && call.body === undefined && call.redirect === "error"));
  const missing = await testConnection({ bank: "other" }, backend);
  assert.equal(missing.api, "connected");
  assert.equal(missing.bankStatus, "not-listed");
  assert.equal((await testConnection({}, () => Response.json({}, { status: 403 }))).api, "unauthorized");
});

test("status and preview share effective policy, while draft checks do not replace saved status", async () => {
  const { options, handle, used } = server();
  options({ bank: "hermes", agents: ["claude"] });
  const token = await tokenFor(handle);
  const post = (path, input = {}) => handle(path, {
    method: "POST", headers: { "x-hindsight-token": token, origin: "null" }, body: JSON.stringify(input)
  }).then(response => response.json());
  const saved = await post("/api/status", { hints: ["Codex"] });
  assert.equal(saved.mode, "legacy");
  assert.equal(saved.agents.find(agent => agent.id === "dsh").policy.recall.owner, "off");
  assert.ok(saved.agents.some(agent => agent.id === "codex"));
  const draft = await post("/api/preview", { options: { capture: true, agent_mode: "auto" } });
  const dsh = draft.agents.find(agent => agent.id === "dsh");
  assert.equal(dsh.policy.recall.owner, "native");
  assert.equal(dsh.policy.capture.owner, "gateway");
  assert.equal((await post("/api/check", { options: { bank: "other" } })).bankStatus, "not-listed");
  assert.equal((await post("/api/status")).connection, null);
  assert.equal(used.filter(call => call.url.endsWith("/health")).length, 1);
});

test("the bank selector lists existing IDs and rejects a nonexistent bank on save validation", async () => {
  const { options, handle } = server();
  options({ bank: "hermes", agents: ["claude"] });
  const token = await tokenFor(handle);
  const post = (path, input = {}) => handle(path, {
    method: "POST", headers: { "x-hindsight-token": token }, body: JSON.stringify(input)
  }).then(response => response.json());
  const policy = bank => ({ agent_mode: "manual", agent_policies: { dsh: { recall: "gateway", bank } } });
  const listing = await post("/api/banks");
  assert.deepEqual(listing.banks.map(bank => bank.id), ["hermes", "fixture-existing"]);
  const valid = await post("/api/preview", { options: policy("fixture-existing"), verifyBanks: true });
  assert.equal(valid.defaultBank, "hermes");
  assert.equal(valid.agents.find(agent => agent.id === "dsh").gatewayBank, "fixture-existing");
  const invalid = await post("/api/preview", { options: policy("absent-bank"), verifyBanks: true });
  assert.equal(invalid.error, "bank-unverified");
  assert.deepEqual(invalid.missing, ["absent-bank"]);
});

test("sandboxed pages can wait for the saved revision without reusing a service token", async () => {
  const initial = server();
  initial.options({ bank: "hermes", agents: ["claude"] });
  const token = await tokenFor(initial.handle);
  const next = { bank: "hermes", agents: ["claude"], agent_mode: "auto" };
  const preview = await initial.handle("/api/preview", {
    method: "POST", headers: { "x-hindsight-token": token, origin: "null" },
    body: JSON.stringify({ options: next })
  }).then(response => response.json());
  const path = "/ready?revision=" + preview.revision;
  const sandbox = { headers: { origin: "null" } };
  assert.equal((await initial.handle(path, sandbox)).status, 425);
  const replacement = server();
  replacement.options(next);
  const ready = await replacement.handle(path, sandbox);
  assert.equal(ready.status, 204);
  assert.equal(ready.headers.get("access-control-allow-origin"), "null");
  assert.equal(await ready.text(), "");
  assert.equal((await replacement.handle(path, { headers: { origin: "https://foreign.example" } })).status, 403);
  const stale = await replacement.handle("/api/status", { method: "POST", headers: { "x-hindsight-token": token } });
  assert.equal(stale.status, 403);
});

test("loopback bridge denies foreign sites, stale tokens and arbitrary URLs", async () => {
  const { handle, used } = server();
  const token = await tokenFor(handle);
  const post = (headers, input) => handle("/api/check", { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  assert.equal((await post({ origin: "https://foreign.example", "x-hindsight-token": token })).status, 403);
  assert.equal((await post({ origin: "null", "x-hindsight-token": "invalid" })).status, 403);
  assert.equal((await post({ host: "elsewhere.example", "x-hindsight-token": token })).status, 403);
  const invalid = await post({ origin: "null", "x-hindsight-token": token }, { options: { hindsight_api: "https://unexpected.example" } });
  assert.equal((await invalid.json()).api, "invalid-options");
  assert.equal(used.length, 0);
  const options = await handle("/api/check", { method: "OPTIONS", headers: { origin: "null" } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "null");
});

test("service startup binds loopback and can recover from an unavailable port", async t => {
  const service = (await import("./service.mjs")).default;
  let failure = true;
  let stopCalls = 0;
  t.mock.method(console, "warn", () => {});
  const prior = globalThis.Bun;
  globalThis.Bun = { serve(options) {
    assert.equal(options.hostname, "127.0.0.1");
    if (failure) throw new Error("test port busy");
    return { port: options.port, stop: () => stopCalls++ };
  }};
  try {
    assert.deepEqual(await service.server({}, { port: 3482 }), {});
    failure = false;
    const run = await service.server({}, { port: 4382 });
    assert.equal(typeof run.close, "function");
    run.close();
    assert.equal(stopCalls, 1);
  } finally {
    if (prior === undefined) delete globalThis.Bun;
    else globalThis.Bun = prior;
  }
});
