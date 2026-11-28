import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refresh, lastPath } from "../src/refresh.js";
import { fetchFreeTokens } from "../src/aihot.js";
import "../page/view.js";
import pkg from "../index.js";

const TMP = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ft-idx-")); TMP.push(d); return d; };
afterAll(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const deal = { id: "x", kind: "daily", title: "t", provider: "DeepSeek", detail: "", url: "https://e/x", tags: [], endsAt: null, validity: "", verifiedAt: "2026-11-09T00:00:00Z", yuan: 3, label: "", face: "", counted: true };

test("refresh success writes payload (opts injected)", async () => {
  const out = path.join(tmp(), "data.js");
  const p = await refresh({}, { configDir: () => "/x", readLocal: () => ({ providers: [], checkin: {} }), fetchFreeTokens: async () => ({ deals: [deal], basis: {} }), dataPath: out });
  assert.equal(p.meta.totalDeals, 1);
  assert.match(fs.readFileSync(out, "utf8"), /__FREE_TOKENS__/);
});
test("refresh failure writes error marker, returns null", async () => {
  const out = path.join(tmp(), "data.js");
  const p = await refresh({}, { configDir: () => "/x", readLocal: () => ({ providers: [], checkin: {} }), fetchFreeTokens: async () => { throw new Error("boom"); }, dataPath: out });
  assert.strictEqual(p, null);
  assert.match(fs.readFileSync(out, "utf8"), /error: true/);
});
test("refresh default dataPath via env", async () => {
  const out = path.join(tmp(), "data.js");
  const old = process.env.FREE_TOKENS_DATA_PATH; process.env.FREE_TOKENS_DATA_PATH = out;
  try { await refresh({}, { configDir: () => "/x", readLocal: () => ({ providers: [], checkin: {} }), fetchFreeTokens: async () => ({ deals: [], basis: {} }) }); assert.ok(fs.existsSync(out)); }
  finally { if (old === undefined) delete process.env.FREE_TOKENS_DATA_PATH; else process.env.FREE_TOKENS_DATA_PATH = old; }
});
test("default server covers defaults (no network)", async () => {
  const home = tmp(); const out = path.join(home, "data.js");
  const of = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no net"); };
  const oldEnv = { HOME: process.env.HOME, FREE_TOKENS_DATA_PATH: process.env.FREE_TOKENS_DATA_PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.FREE_TOKENS_DATA_PATH = out; delete process.env.XDG_CONFIG_HOME;
  try {
    const r = await pkg.server({ directory: path.join(home, "work") });
    assert.deepEqual(r, {});
    assert.match(fs.readFileSync(out, "utf8"), /error: true/);
  } finally {
    globalThis.fetch = of;
    for (const k of Object.keys(oldEnv)) { if (oldEnv[k] === undefined) delete process.env[k]; else process.env[k] = oldEnv[k]; }
  }
});

const REAL = fs.readFileSync(fileURLToPath(new URL("./fixtures/free-tokens.md", import.meta.url)), "utf8");
const readData = (f) => { const t = fs.readFileSync(f, "utf8"); return JSON.parse(t.slice(t.indexOf("=") + 1).trim().replace(/;$/, "")); };

test("real md through refresh: deals in all three tiers", async () => {
  const out = path.join(tmp(), "data.js");
  const local = { providers: [{ id: "trae-cn", name: "Trae", signedIn: true }, { id: "zcode", name: "ZCode", signedIn: false }], checkin: {} };
  const md = async () => ({ ok: true, status: 200, text: async () => REAL });
  const p = await refresh({}, { configDir: () => "/x", readLocal: () => local, fetchFreeTokens: () => fetchFreeTokens(md), dataPath: out });
  const V = globalThis.FTView;
  const c = V.counts(p.deals, p.mapping, p.demoState);
  assert.ok(c.ready > 0 && c.setup > 0 && c.none > 0, JSON.stringify(c));
  assert.deepEqual(p.deals.filter((d) => V.bucketOf(d, p.mapping, p.demoState).key === "ready").map((d) => d.provider), ["字节 TRAE"]);
  assert.ok(!p.deals.some((d) => d.provider === "长亭 MonkeyCode"), "third parties stay out");
  assert.equal(p.meta.updatedAt, "2026-11-28T09:11:00+08:00");
  assert.equal(readData(out).deals.length, p.deals.length);
  assert.ok(fs.existsSync(lastPath(out)));
});
test("a later failed fetch keeps the last good data, tiers re-read from now", async () => {
  const out = path.join(tmp(), "data.js");
  await refresh({}, { configDir: () => "/x", readLocal: () => ({ providers: [], checkin: {} }), fetchFreeTokens: async () => ({ deals: [deal], basis: {} }), dataPath: out });
  const first = readData(out).meta.fetchedAt;
  const p = await refresh({}, { configDir: () => "/x", readLocal: () => ({ providers: [{ id: "zed", signedIn: true }], checkin: {} }), fetchFreeTokens: async () => { throw new Error("AIHOT 403 Forbidden use_open_interfaces"); }, dataPath: out });
  assert.equal(p.meta.stale, true);
  assert.equal(p.meta.fetchedAt, first);
  assert.equal(p.deals.length, 1);
  assert.ok(p.demoState.installed.zed);
  const d = readData(out); assert.equal(d.error, undefined); assert.equal(d.meta.stale, true);
});
test("a corrupt or empty last copy is not used", async () => {
  for (const bad of ["{bad", JSON.stringify({ fetchedAt: "x", ft: { deals: [] } }), JSON.stringify({ ft: { deals: [deal] } })]) {
    const out = path.join(tmp(), "data.js");
    fs.writeFileSync(lastPath(out), bad);
    const p = await refresh({}, { configDir: () => "/x", readLocal: () => ({ providers: [], checkin: {} }), fetchFreeTokens: async () => { throw new Error("down"); }, dataPath: out });
    assert.strictEqual(p, null);
    assert.match(fs.readFileSync(out, "utf8"), /error: true/);
  }
});
