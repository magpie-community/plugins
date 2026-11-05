import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { keyFromAuth, readOpenAIKey } from "../credentials.mjs";
import { OpenAIDecisionsPlugin } from "../index.mjs";

test("ordinary API-key sign-in works without a saved Magpie OpenAI provider", () => {
  assert.equal(keyFromAuth({ type: "api", key: "fixture-direct-key" }), "fixture-direct-key");
  assert.throws(() => keyFromAuth({ type: "oauth", access: "fixture-oauth" }));
  assert.throws(() => keyFromAuth({ type: "api", key: "" }));
});

test("reads only the configured official OpenAI provider and follows key changes", () => {
  mkdirSync(resolve(".data"), { recursive: true });
  const directory = mkdtempSync(resolve(".data/test-credentials-"));
  const path = join(directory, "providers.json");
  const row = { id: "openai", preset: "openai", chat: "https://api.openai.com/v1", key: "fixture-key-one" };
  try {
    writeFileSync(path, JSON.stringify({ providers: [{ id: "other", key: "unrelated" }, row] }), { mode: 0o600 });
    assert.equal(readOpenAIKey(path), "fixture-key-one");
    row.key = "fixture-key-two";
    writeFileSync(path, JSON.stringify({ providers: [row] }));
    assert.equal(readOpenAIKey(path), "fixture-key-two");
    for (const invalid of [{ ...row, off: true }, { ...row, key: "" }, { ...row, preset: "another-vendor" }, { ...row, chat: "https://another.example/v1" }]) {
      writeFileSync(path, JSON.stringify({ providers: [invalid] }));
      assert.throws(() => readOpenAIKey(path));
    }
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test("registers one real decision model and an explicit local-key sign-in method", async () => {
  const plugin = await OpenAIDecisionsPlugin({});
  const config = {};
  await plugin.config(config);
  const provider = config.provider["openai-decisions"];
  assert.equal(provider.decide, true);
  assert.equal(provider.models["gpt-6-luna"].decides, true);
  assert.equal(provider.models["gpt-6-luna"].tool_call, false);
  assert.equal(plugin.auth.provider, "openai-decisions");
  assert.equal(plugin.auth.methods[0].type, "api");
  assert.notEqual(plugin.auth.methods[0].keyless, true);
  assert.equal(plugin.auth.methods[1].keyless, true);
  assert.equal(typeof plugin.auth.methods[1].authorize, "function");
});

test("the entry module exports only the plugin, as Magpie's loader expects", async () => {
  const exports = await import("../index.mjs");
  assert.deepEqual(Object.keys(exports), ["OpenAIDecisionsPlugin"]);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(packageJson.main, "./opencode.mjs");
  const legacy = await import("../opencode.mjs");
  assert.deepEqual(Object.keys(legacy), ["OpenAIDecisionsPlugin"]);
  const modern = await import("../opencode2.mjs");
  assert.equal(modern.default.id, packageJson.name);
  assert.equal(typeof modern.default.setup, "function");
});
