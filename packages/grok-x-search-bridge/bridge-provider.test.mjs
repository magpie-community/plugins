import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DISABLED_TOOL, onProvider } from "./grok-x-search-bridge.middleware.js";
import { GrokXSearchBridge, _internal } from "./index.js";

const ctx = { protocol: "responses", provider: { id: "grok" } };

test("adds X search with missing, null or empty tools", () => {
  for (const body of [{}, { tools: null }, { tools: [] }]) {
    assert.deepEqual(onProvider(body, ctx).tools, [{ type: "x_search" }]);
  }
});

test("preserves the request, client tools and original object", () => {
  const tools = Object.freeze([
    Object.freeze({ type: "function", name: "shell", parameters: { type: "object" } }),
    Object.freeze({ type: "web_search" }),
  ]);
  const body = Object.freeze({
    model: "group/smart", input: "Search X", tools, tool_choice: "auto",
    reasoning: { effort: "high" }, parallel_tool_calls: false,
  });
  const result = onProvider(body, ctx);
  assert.deepEqual(result, { ...body, tools: [...tools, { type: "x_search" }] });
  assert.notEqual(result, body);
  assert.equal(body.tools.length, 2);
});

test("does not duplicate X search on a second pass", () => {
  const first = onProvider({}, ctx);
  assert.equal(onProvider(first, ctx), undefined);
  assert.deepEqual(first.tools, [{ type: "x_search" }]);
});

test("preserves existing X search options", () => {
  const body = {
    tools: [{
      type: "x_search", allowed_x_handles: ["OpenAI"],
      from_date: "2026-10-01", to_date: "2026-10-20",
    }],
  };
  const original = structuredClone(body);
  assert.equal(onProvider(body, ctx), undefined);
  assert.deepEqual(body, original);
});

test("respects disabled, required, named and restricted tool choices", () => {
  for (const choice of [
    "none", "required", { type: "function", name: "shell" },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "shell" }] },
  ]) {
    const body = { tool_choice: choice, tools: [] };
    assert.equal(onProvider(body, ctx), undefined);
    assert.deepEqual(body, { tool_choice: choice, tools: [] });
  }
});

test("accepts the default and automatic tool choices", () => {
  for (const choice of [undefined, null, "auto"]) {
    assert.deepEqual(onProvider({ tool_choice: choice }, ctx).tools, [{ type: "x_search" }]);
  }
});

test("ignores other providers, protocols and missing context", () => {
  for (const other of [
    { protocol: "responses", provider: { id: "codex" } },
    { protocol: "responses", provider: { id: "cursor" } },
    { protocol: "chat", provider: { id: "grok" } },
    { protocol: "anthropic", provider: { id: "grok" } },
    { protocol: "gemini", provider: { id: "grok" } },
    { protocol: "responses" }, {}, undefined,
  ]) {
    const body = { model: "grok-4.7", tools: [] };
    assert.equal(onProvider(body, other), undefined);
    assert.deepEqual(body.tools, []);
  }
});

test("targets the Grok provider rather than one model version", () => {
  for (const model of ["grok-4.7", "grok-4.6", "future-grok-model"]) {
    const result = onProvider({ model }, { ...ctx, provider: { id: "grok", model } });
    assert.equal(result.model, model);
    assert.deepEqual(result.tools, [{ type: "x_search" }]);
  }
});

test("a Grok attempt does not affect a later attempt on another provider", () => {
  const body = { tools: [{ type: "function", name: "shell" }] };
  assert.equal(onProvider(body, ctx).tools.length, 2);
  assert.equal(onProvider(body, { ...ctx, provider: { id: "codex" } }), undefined);
  assert.deepEqual(body.tools, [{ type: "function", name: "shell" }]);
});

test("handles streaming and nonstreaming requests without changing stream flags", () => {
  for (const stream of [false, true]) {
    const result = onProvider({ stream }, { ...ctx, stream });
    assert.equal(result.stream, stream);
    assert.deepEqual(result.tools, [{ type: "x_search" }]);
  }
});

test("leaves malformed bodies and tools unchanged", () => {
  for (const body of [undefined, null, [], "invalid", 1, { tools: {} }, { tools: "invalid" }]) {
    assert.equal(onProvider(body, ctx), undefined);
  }
});

test("the package declares an installable middleware entry", async () => {
  const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url)));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./index.js");
  assert.equal(pkg.exports, "./index.js");
  const entry = new URL(pkg.magpie.middleware, import.meta.url);
  assert.match(await readFile(entry, "utf8"), /export function onProvider/);
  assert.equal(typeof (await import(entry.href)).onProvider, "function");
});

test("preserves disabled tools through all three protocol conversions", () => {
  for (const [protocol, body, getTool] of [
    ["chat", { tool_choice: "none" }, b => b.tools[0].function],
    ["anthropic", { tool_choice: { type: "none" } }, b => b.tools[0]],
    ["gemini", { toolConfig: { functionCallingConfig: { mode: "NONE" } } }, b => b.tools[0].functionDeclarations[0]],
  ]) {
    const before = structuredClone(body);
    const marked = onProvider(body, { protocol, provider: { id: "grok" } });
    const tool = getTool(marked);
    assert.equal(tool.name, DISABLED_TOOL.name);
    assert.deepEqual(body, before);
    // The gateway encodes these declarations as Responses function tools.
    const converted = { tool_choice: "none", tools: [{ type: "function", ...DISABLED_TOOL }] };
    assert.deepEqual(_internal.prepare(converted), { tools: [] });
    const withClientTool = { type: "function", name: "client_echo" };
    const kept = _internal.prepare({ ...converted, tools: [...converted.tools, withClientTool] });
    assert.deepEqual(kept, { tool_choice: "none", tools: [withClientTool] });
    assert.equal(onProvider(body, { protocol, provider: { id: "cursor" } }), undefined);
  }
});

test("upstream transformation honors explicit tool choices and search filters", () => {
  for (const choice of ["required", { type: "function", name: "echo" }]) {
    assert.equal(_internal.prepare({ tools: [{ type: "function", name: "echo" }], tool_choice: choice }), undefined);
  }
  assert.equal(_internal.prepare({ tools: [{ type: "x_search", allowed_x_handles: ["OpenAI"] }] }), undefined);
  assert.deepEqual(_internal.prepare({ tool_choice: "none" }), { tools: [] });
  assert.deepEqual(_internal.prepare({ tools: [{ type: "function", name: "echo" }] }).tools,
    [{ type: "function", name: "echo" }, { type: "x_search" }]);
});

test("fetch wrapper preserves streaming response, cancellation and request options", async () => {
  const response = new Response("data: test\n\n");
  const ctl = new AbortController();
  const init = { method: "POST", body: JSON.stringify({ model: "grok-4.7", stream: true }), signal: ctl.signal, headers: { "x-test": "kept" } };
  let received;
  const options = { async fetch(input, sent) { assert.equal(this, options); received = { input, sent }; return response; } };
  assert.equal(await _internal.wrapFetch(options)("https://example.invalid/v1/responses", init), response);
  assert.equal(received.sent.signal, ctl.signal);
  assert.equal(received.sent.headers, init.headers);
  assert.equal(JSON.parse(received.sent.body).stream, true);
  assert.deepEqual(JSON.parse(received.sent.body).tools, [{ type: "x_search" }]);
  assert.equal(JSON.parse(init.body).tools, undefined);
  assert.equal(response.bodyUsed, false);
});

test("fetch wrapper leaves unrelated paths and unsupported bodies untouched", async () => {
  for (const [path, body] of [
    ["/v1/models", "{}"], ["/v1/responses", "not json"], ["/v1/responses", new Uint8Array([1, 2])],
    ["/v1/responses", "null"], ["/v1/responses", "[]"], ["/v1/responses", '{"tools":{}}'],
  ]) {
    const init = { body };
    const response = new Response();
    const options = { async fetch(input, sent) { assert.equal(sent, init); return response; } };
    assert.equal(await _internal.wrapFetch(options)(new URL("https://example.invalid" + path), init), response);
  }
});

test("keeps the existing Grok authentication, model discovery and quota hooks", async () => {
  const hooks = await GrokXSearchBridge({ client: {} });
  assert.equal(hooks.auth.provider, "grok");
  assert.equal(typeof hooks.auth.refresh, "function");
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(typeof hooks.provider.models, "function");
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {});
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth" }));
  assert.equal(typeof loaded.fetch, "function");
  const cfg = {};
  await hooks.config(cfg);
  assert.equal(cfg.provider.grok.npm, "@ai-sdk/openai");
});
