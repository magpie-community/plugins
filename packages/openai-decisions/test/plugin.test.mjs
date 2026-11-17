import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OpenAIDecisionsPlugin } from "../index.mjs";

test("registers one decision model with standard API-key sign-in only", async () => {
  const plugin = await OpenAIDecisionsPlugin({});
  const config = {};
  await plugin.config(config);
  const provider = config.provider["openai-decisions"];
  assert.equal(provider.decide, true);
  assert.equal(provider.models["gpt-6-luna"].decides, true);
  assert.equal(provider.models["gpt-6-luna"].tool_call, false);
  assert.equal(plugin.auth.provider, "openai-decisions");
  assert.equal(plugin.auth.methods.length, 1);
  assert.equal(plugin.auth.methods[0].type, "api");
  assert.notEqual(plugin.auth.methods[0].keyless, true);
  assert.equal(plugin.auth.methods[0].authorize, undefined);
});

test("the loader leaves missing or non-API sign-ins inactive", async () => {
  const plugin = await OpenAIDecisionsPlugin({});
  for (const auth of [undefined, {}, { type: "oauth", access: "fixture-oauth" }, { type: "api", key: "" }, { type: "api", key: 42 }]) {
    assert.deepEqual(await plugin.auth.loader(async () => auth), {});
  }
});

test("direct sign-in follows the selected account's key and stops after sign-out", async () => {
  const plugin = await OpenAIDecisionsPlugin({});
  let auth = { type: "api", key: "fixture-direct-one" };
  const sent = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      sent.push(init.headers.get("authorization"));
      return Response.json({ model: "gpt-6-luna", answers: [{ name: "ok", type: "predicate", probability: 1 }] });
    };
    const loaded = await plugin.auth.loader(async () => auth);
    assert.equal(loaded.apiKey, "fixture-direct-one");
    const request = { method: "POST", body: JSON.stringify({ model: "gpt-6-luna", state: "Hello", questions: { ok: { type: "noul", instructions: "Is this a greeting?" } } }) };
    assert.equal((await loaded.fetch(loaded.baseURL + "/systemone", request)).status, 200);
    auth = { type: "api", key: "fixture-direct-two" };
    assert.equal((await loaded.fetch(loaded.baseURL + "/systemone", request)).status, 200);
    auth = { type: "oauth", access: "fixture-other-account" };
    assert.equal((await loaded.fetch(loaded.baseURL + "/systemone", request)).status, 503);
    assert.deepEqual(sent, ["Bearer fixture-direct-one", "Bearer fixture-direct-two"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("community package entries use the provider package name and an HTTPS/data icon", async () => {
  const exports = await import("../index.mjs");
  assert.deepEqual(Object.keys(exports), ["OpenAIDecisionsPlugin"]);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(packageJson.name, "@magpie-community/opencode-openai-decisions-auth");
  assert.match(packageJson.magpie.icon, /^(https:\/\/|data:image\/)/);
  assert.equal(packageJson.main, "./opencode.mjs");
  const legacy = await import("../opencode.mjs");
  assert.deepEqual(Object.keys(legacy), ["OpenAIDecisionsPlugin"]);
  const modern = await import("../opencode2.mjs");
  assert.equal(modern.default.id, packageJson.name);
  assert.equal(typeof modern.default.setup, "function");
});
