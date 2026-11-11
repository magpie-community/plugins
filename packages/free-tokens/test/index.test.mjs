import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refresh } from "../src/refresh.js";
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
