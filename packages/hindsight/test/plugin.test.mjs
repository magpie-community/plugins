import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPlugin } from "../lib/plugin.mjs";
import { OPEN } from "../lib/protocol.mjs";

const request = () => ({ model: "cheap", messages: [{ role: "user", content: "What is the codeword?" }] });
const reply = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "synthetic answer" } }] };

function context(options = {}, extra = {}) {
  return {
    origin: "local", protocol: "chat", agent: "Claude Code", session: "test-session", success: true,
    options, state: {}, reports: [],
    report(code, bytes) { this.reports.push({ code, bytes }); },
    ...extra
  };
}

function mockHindsight(calls, memories = ["SYNTHETIC_RECALL_7F3C9A"]) {
  return async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, payload });
    if (url.endsWith("/memories/recall")) return Response.json({ results: memories.map(text => ({ text })) });
    if (url.endsWith("/memories")) return Response.json({ success: true, async: true, operation_ids: ["operation-test"] });
    throw new Error(`unexpected URL: ${url}`);
  };
}

test("package declares asynchronous hooks and safe defaults", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.main, "./page/service.mjs");
  assert.equal(pkg.magpie.hooks, "./hooks.mjs");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.magpie.options.capture, false);
  assert.equal(pkg.magpie.options.hindsight_api, "http://127.0.0.1:8888");
  assert.equal(pkg.magpie.options.bank, "hermes");
  assert.equal(pkg.magpie.options.recall_max_tokens, 1024);
  assert.equal(pkg.magpie.options.gatewayTimeoutMs, 5000);
  assert.ok(pkg.keywords.includes("magpie-plugin"));
  const entry = await import("../hooks.mjs");
  assert.equal(typeof entry.onRequest, "function");
  assert.equal(typeof entry.onResponse, "function");
});

test("recall is attached to the user turn, and capture is off by default", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls) });
  const ctx = context();
  const changed = await plugin.onRequest(request(), ctx);

  assert.ok(changed);
  assert.equal(changed.messages.length, 1, "no system message is added");
  assert.equal(changed.messages[0].role, "user");
  assert.ok(changed.messages[0].content.startsWith("What is the codeword?"));
  assert.ok(changed.messages[0].content.includes(OPEN));
  assert.match(changed.messages[0].content, /SYNTHETIC_RECALL_7F3C9A/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8888/v1/default/banks/hermes/memories/recall");
  assert.equal(calls[0].payload.query, "What is the codeword?");
  assert.equal(calls[0].payload.max_tokens, 1024);
  assert.ok(ctx.reports.some(r => r.code === "ready"));

  await plugin.onResponse(reply, ctx);
  assert.equal(calls.length, 1, "default capture must not call retain");
  assert.ok(ctx.reports.some(r => r.code === "skipped"));
});

test("a turn recalls once; tool-loop replays are sticky and history is re-attached", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls) });
  const ctx = context();

  // Turn 1: single user message.
  const first = await plugin.onRequest(request(), ctx);
  const injectedText = first.messages[0].content;
  assert.equal(calls.length, 1);

  // Tool loop: the agent resends the ORIGINAL (uninjected) conversation.
  const second = await plugin.onRequest(request(), ctx);
  assert.equal(calls.length, 1, "no second recall for the same turn");
  assert.equal(second.messages[0].content, injectedText, "same block, byte for byte");

  // Turn 2 arrives: history is replayed for turn 1, only turn 2 is recalled.
  const ctx2 = context();
  const body2 = {
    model: "cheap",
    messages: [
      { role: "user", content: "What is the codeword?" },
      { role: "assistant", content: "intermediate" },
      { role: "user", content: "Next question" }
    ]
  };
  // Same conversation (same session) so the turn-1 cache applies.
  ctx2.session = ctx.session;
  const changed2 = await plugin.onRequest(body2, ctx2);
  assert.equal(calls.length, 2, "only the new turn is recalled");
  assert.equal(calls[1].payload.query, "Next question");
  assert.ok(changed2.messages[0].content.includes(OPEN), "history turn keeps its block");
  assert.equal(changed2.messages[0].content, injectedText);
  assert.ok(changed2.messages[2].content.includes(OPEN));
  assert.ok(changed2.messages[2].content.startsWith("Next question"));
});

test("ctx.query wins over raw user text", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls) });
  const ctx = context({}, { query: "stripped clean query" });
  await plugin.onRequest(request(), ctx);
  assert.equal(calls[0].payload.query, "stripped clean query");
});

test("capture opt-in retains the current turn asynchronously to the same hermes bank", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls, []) });
  const ctx = context({ capture: true, recall_max_tokens: 64 });
  await plugin.onRequest(request(), ctx);
  // An in-flight options edit must not redirect this turn to another bank.
  ctx.options = { capture: true, bank: "hermes-dsh" };
  await plugin.onResponse(reply, ctx);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:8888/v1/default/banks/hermes/memories/recall");
  assert.equal(calls[1].url, "http://127.0.0.1:8888/v1/default/banks/hermes/memories");
  assert.equal(calls[1].payload.async, true);
  assert.equal(calls[1].payload.items.length, 1);
  const item = calls[1].payload.items[0];
  assert.match(item.content, /What is the codeword\?/);
  assert.match(item.content, /synthetic answer/);
  assert.match(item.document_id, /^magpie-[a-f0-9]{64}$/);
  assert.deepEqual(item.metadata, { source: "magpie-hindsight", agent: "Claude Code", protocol: "chat" });
  assert.ok(ctx.reports.some(r => r.code === "ready"));
});

test("agent filter skips both recall and capture", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls) });
  const ctx = context({ capture: true, agents: ["Another Agent"] });
  assert.equal(await plugin.onRequest(request(), ctx), undefined);
  await plugin.onResponse(reply, ctx);
  assert.equal(calls.length, 0);
  assert.ok(ctx.reports.some(r => r.code === "skipped"));
});

test("Hindsight failure leaves the model request unchanged", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) });
    return Response.json({ error: "unavailable" }, { status: 503 });
  } });
  const ctx = context();
  assert.equal(await plugin.onRequest(request(), ctx), undefined);
  assert.ok(ctx.reports.some(r => r.code === "unavailable"));
  await plugin.onResponse(reply, ctx);
  assert.equal(calls.length, 1, "capture remains off after recall failure");
});

test("incomplete model answers are not captured", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls, []) });
  const ctx = context({ capture: true });
  await plugin.onRequest(request(), ctx);
  await plugin.onResponse({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }, ctx);
  assert.equal(calls.length, 1);
  assert.ok(ctx.reports.some(r => r.code === "skipped"));
});

test("remote API without opt-in fails closed with no fetch", async () => {
  const calls = [];
  const plugin = createPlugin({ fetcher: mockHindsight(calls) });
  const ctx = context({ hindsight_api: "https://hindsight.example.com" });
  assert.equal(await plugin.onRequest(request(), ctx), undefined);
  assert.equal(calls.length, 0, "no opt-in, no data leaves the machine");
  assert.ok(ctx.reports.some(r => r.code === "invalid"));
});
