import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, readLocal } from "../src/inventory.js";

const TMP = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ft-inv-")); TMP.push(d); return d; };
afterAll(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const withEnv = (env, fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

test("configDir: input.directory (settings.Dir) wins", () => withEnv({ MAGPIE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }, () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "plugin-providers.json"), "[]");
  assert.equal(configDir({ directory: d }), d);
}));
test("configDir: MAGPIE_CONFIG_DIR wins", () => withEnv({ MAGPIE_CONFIG_DIR: undefined }, () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "plugin-providers.json"), "[]");
  assert.equal(withEnv({ MAGPIE_CONFIG_DIR: d }, () => configDir({})), d);
}));
test("configDir: XDG fallback", () => withEnv({ MAGPIE_CONFIG_DIR: undefined }, () => {
  const x = tmp(); fs.mkdirSync(path.join(x, "magpie")); fs.writeFileSync(path.join(x, "magpie", "plugin-providers.json"), "[]");
  assert.equal(withEnv({ XDG_CONFIG_HOME: x }, () => configDir({})), path.join(x, "magpie"));
}));
test("configDir: home fallback when no input (injected empty home)", () => withEnv({ MAGPIE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }, () => {
  const h = tmp();
  const got = configDir({}, h);
  assert.equal(got, path.join(h, ".config", "magpie"));
}));
test("configDir: trusts input.directory even without files (portable fresh)", () => withEnv({ MAGPIE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }, () => {
  assert.equal(configDir({ directory: "/portable/data" }, "/home/u"), "/portable/data");
}));

test("readLocal: valid providers + checkin", () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "plugin-providers.json"), JSON.stringify([{ id: "z", signedIn: true }])); fs.writeFileSync(path.join(d, "plugin-checkin.json"), JSON.stringify({ "z|a": { outcome: "claimed" } }));
  const l = readLocal(d); assert.equal(l.providers.length, 1); assert.equal(l.checkin["z|a"].outcome, "claimed");
});
test("readLocal: missing files => empty, not null", () => { const l = readLocal(tmp()); assert.deepEqual(l.providers, []); assert.deepEqual(l.checkin, {}); });
test("readLocal: corrupt providers => null (unknown)", () => { const d = tmp(); fs.writeFileSync(path.join(d, "plugin-providers.json"), "{bad"); assert.equal(readLocal(d).providers, null); });
test("readLocal: providers non-array => []", () => { const d = tmp(); fs.writeFileSync(path.join(d, "plugin-providers.json"), "{}"); assert.deepEqual(readLocal(d).providers, []); });
test("readLocal: corrupt checkin => null (unknown)", () => { const d = tmp(); fs.writeFileSync(path.join(d, "plugin-checkin.json"), "{bad"); assert.equal(readLocal(d).checkin, null); });
test("readLocal: checkin array => {}", () => { const d = tmp(); fs.writeFileSync(path.join(d, "plugin-checkin.json"), "[]"); assert.deepEqual(readLocal(d).checkin, {}); });
