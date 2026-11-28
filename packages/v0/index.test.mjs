import assert from "node:assert/strict";
import test from "node:test";
import { V0Plugin } from "./opencode.mjs";
import { chatFetch } from "./chat.mjs";

const input = (body) => ({
  method: "POST",
  body: JSON.stringify({ model: "v0-max", messages: [{ role: "user", content: "Hi" }], ...body }),
});
const url = "https://api.v0.dev/v1/chat/completions";
const answer = { id: "chat_1", messages: [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "OK", finishReason: "stop" },
] };

test("registers the four v0 models and API key sign-in", async () => {
  const plugin = await V0Plugin();
  const config = {};
  await plugin.config(config);
  assert.deepEqual(Object.keys(config.provider.v0.models), ["v0-mini", "v0-pro", "v0-max", "v0-max-fast"]);
  assert.equal(plugin.auth.methods[0].type, "api");
});

test("creates a private chat and returns only the assistant answer", async () => {
  const signal = new AbortController().signal;
  const response = await chatFetch("test-key", async (target, options) => {
    assert.equal(target, "https://api.v0.dev/v1/chats");
    assert.equal(options.headers.authorization, "Bearer test-key");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal, signal);
    assert.deepEqual(JSON.parse(options.body), {
      privacy: "private", modelConfiguration: { modelId: "v0-max" },
      message: '[{"role":"system","content":"Be concise"},{"role":"user","content":"Hi"}]',
    });
    return Response.json(answer);
  })(url, { ...input({ messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hi" }] }), signal });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).choices, [
    { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
  ]);
});

test("returns completed text in Chat Completions SSE when requested", async () => {
  const response = await chatFetch("key", async () => Response.json(answer))(url, input({ stream: true }));
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = (await response.text()).trim().split("\n\n").map((e) => e.slice(6));
  assert.equal(JSON.parse(events[0]).choices[0].delta.content, "OK");
  assert.equal(JSON.parse(events[1]).choices[0].finish_reason, "stop");
  assert.equal(events[2], "[DONE]");
});

test("rejects unsupported inputs and preserves the vendor status", async () => {
  let calls = 0;
  const proxy = chatFetch("key", async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "retry-after": "10" } });
  });
  assert.equal((await proxy(url, input({ model: "unknown" }))).status, 400);
  assert.equal((await proxy(url, input({ tool_choice: "required" }))).status, 400);
  assert.equal((await proxy(url, input({ messages: [{ role: "user", content: [{ type: "image_url" }] }] }))).status, 400);
  assert.equal((await proxy("https://example.com/v1/chat/completions", input())).status, 404);
  assert.equal(calls, 0);
  const response = await proxy(url, input());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "10");
  assert.equal(calls, 1);
});
