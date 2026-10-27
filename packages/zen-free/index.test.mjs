import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { protocols, declaredTools, toolReply } from "./tool-fixtures.mjs";

const subject = import("./index.mjs").then((module) => ({
  default: { server: module.ZenFreePlugin },
}));

async function fixture(t, input = {}) {
  const state = { calls: [], status: 200, modelsStatus: 200, docsStatus: 200, catalogStatus: 200 };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    state.calls.push({ url: req.url, headers: req.headers, body: text && JSON.parse(text) });
    if (state.discoveryHang) {
      state.onDiscovery?.();
      return;
    }
    if (req.url === "/v1/models" && state.listing) {
      res.writeHead(state.modelsStatus, { "content-type": "application/json" });
      res.end(state.listing);
    } else if (req.url === "/v1/models") {
      res.writeHead(state.modelsStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: (state.ids ?? ["chat-free", "responses-free", "messages-free", "paid"]).map(
            (id) => ({
              id,
            }),
          ),
        }),
      );
    } else if (req.url === "/catalog") {
      res.writeHead(state.catalogStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          opencode: {
            npm: "@ai-sdk/openai-compatible",
            models: {
              ...(state.omitChat
                ? {}
                : { "chat-free": { name: "Chat Free", limit: { context: 200000, output: 8192 } } }),
              "responses-free": { provider: { npm: "@ai-sdk/openai" } },
              "messages-free": { provider: { npm: "@ai-sdk/anthropic" } },
              paid: { cost: { input: 3, output: 10 } },
              "late-free": {},
            },
          },
        }),
      );
    } else if (req.url === "/docs") {
      res.writeHead(state.docsStatus);
      res.end(
        `| Model | chat-free | \`https://opencode.ai/zen/v1/${state.chatProtocol ?? "chat/completions"}\` | sdk |`,
      );
    } else if (state.reply) {
      res.writeHead(200, { "content-type": state.contentType ?? "text/event-stream" });
      res.end(state.reply);
    } else if (state.hang) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
    } else if (state.status !== 200) {
      res.writeHead(state.status, { "content-type": "application/json", "retry-after": "30" });
      res.end('{"error":{"message":"limited","type":"rate_limit_error"}}');
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"id":"chat-1","model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const module = await subject;
  assert.equal(typeof module.default?.server, "function", "plugin hooks must be implemented");
  const plugin = await module.default.server(input, {
    baseURL: `${origin}/v1`,
    catalogURL: `${origin}/catalog`,
    docsURL: `${origin}/docs`,
  });
  return { plugin, state, origin };
}

const publicAuth = async () => ({ type: "api", key: "public" });

for (const { protocol, path, model } of protocols) {
  for (const stream of [true, false]) {
    for (const upstreamSSE of [true, false]) {
      test(`${protocol}: guards tool names with client stream=${stream}, upstream SSE=${upstreamSSE}`, async (t) => {
        const { plugin, state, origin } = await fixture(t);
        await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
        const loader = await plugin.auth.loader(publicAuth);
        const tools = declaredTools(protocol);
        state.contentType = upstreamSSE ? "text/event-stream" : "application/json";
        const send = () =>
          loader.fetch(`${origin}/v1/${path}`, {
            method: "POST",
            body: JSON.stringify({ model, stream, tools }),
          });
        for (const [upstream, expected] of [
          ["bash", "Bash"],
          ["read", "Read"],
          ["Bash", "Bash"],
        ]) {
          state.reply = toolReply(protocol, upstream, upstreamSSE);
          const response = await send();
          assert.equal(response.status, 200);
          const text = await response.text();
          assert.match(text, new RegExp(`"name"\\s*:\\s*"${expected}"`));
          assert.doesNotMatch(text, /"name"\s*:\s*"(?:bash|read)"/);
        }
        const outbound = state.calls.at(-1).body.tools;
        assert.deepEqual(outbound.slice(0, tools.length), tools);
        for (const raw of outbound.slice(tools.length)) {
          const tool = protocol === "chat" ? raw.function : raw;
          assert.match(tool.description, /Not available\. Never call this tool\./);
          assert.equal((tool.parameters ?? tool.input_schema).additionalProperties, false);
          // Zen's free tier refuses a bash or read that takes nothing
          assert.equal(Object.keys((tool.parameters ?? tool.input_schema).properties).length, 1);
        }
        // A call of a tool the agent doesn't have reaches the agent as
        // called, as a tool call, so the agent answers it with its own
        // unknown-tool error and the model goes on; it neither fails the
        // turn (#76) nor ends it as a plain answer (#209).
        state.reply = toolReply(protocol, "edit", upstreamSSE);
        const handed = await send();
        assert.equal(handed.status, 200);
        const text = await handed.text();
        assert.match(text, /"name"\s*:\s*"edit"/);
        assert.match(text, /"tool_calls"|"tool_use"|"function_call"/);
        assert.doesNotMatch(text, /"error"|The call was left out/);
      });
    }
  }
}

test("keeps declared tools isolated between requests using the same loader", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.reply = toolReply("chat", "bash");
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream: false, tools }),
    });
  assert.equal((await send(declaredTools("chat"))).status, 200);
  const blocked = await send([]);
  assert.equal(blocked.status, 200);
  const text = await blocked.text();
  assert.doesNotMatch(text, /"name"\s*:\s*"Bash"/);
  assert.match(text, /"name"\s*:\s*"bash"/);
});

for (const [input, supplied, expected] of [
  [{}, undefined, "global"],
  [{ project: { id: "magpie" } }, undefined, "global"],
  [{ project: { id: "abc123", vcs: "git" } }, undefined, "abc123"],
  [{}, "client-project", "client-project"],
]) {
  test(`uses OpenCode project identity ${expected}`, async (t) => {
    const { plugin, state, origin } = await fixture(t, input);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: supplied ? { "x-opencode-project": supplied } : {},
      body: JSON.stringify({ model: "chat-free", stream: true }),
    });
    await response.text();
    assert.equal(state.calls.at(-1).headers["x-opencode-project"], expected);
    assert.equal(state.calls.at(-1).headers["user-agent"], "opencode/latest/2.0.25/cli");
  });
}

// The headers OpenCode 2.0.25's release binary sends to Zen, captured on
// 2026-10-25: these and no others, whatever the caller sent. Zen's free
// tier refuses (429 FreeUsageLimitError) the User-Agent OpenCode 1.19.0
// sent, which 0.1.6 to 0.1.15 sent on every request, since 2026-10-26.
for (const [path, model, key] of [
  ["chat/completions", "chat-free", ["authorization"]],
  ["responses", "responses-free", ["authorization"]],
  ["messages", "messages-free", ["anthropic-version", "x-api-key"]],
]) {
  test(`${path}: sends OpenCode's own headers and none of the caller's`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      headers: {
        "user-agent": "claude-cli/2.1.0",
        "x-stainless-lang": "js",
        "x-session-affinity": "header-parity-conversation",
        "x-magpie-work-dir": "/tmp/x",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ model, stream: true }),
    });
    await response.text();
    const sent = state.calls.at(-1).headers;
    assert.equal(sent["user-agent"], "opencode/latest/2.0.25/cli");
    assert.notEqual(sent["user-agent"], "claude-cli/2.1.0");
    assert.equal(sent.accept, "*/*");
    const own = Object.keys(sent).filter(
      (name) => !["host", "connection", "content-length", "accept-encoding"].includes(name),
    );
    assert.deepEqual(
      own.sort(),
      [
        "accept",
        "content-type",
        "user-agent",
        "x-opencode-client",
        "x-opencode-project",
        "x-opencode-session",
        "x-opencode-session-id",
        "x-session-affinity",
        "x-session-id",
        ...key,
      ].sort(),
    );
    assert.equal(sent["x-opencode-session-id"], sent["x-opencode-session"]);
    // OpenCode sends its own session id under both names; the caller's
    // never goes on.
    assert.equal(sent["x-session-affinity"], sent["x-opencode-session"]);
    assert.equal(sent["x-session-id"], sent["x-opencode-session"]);
  });
}

test("aborts discovery immediately when the inference caller cancels", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  state.discoveryHang = true;
  const started = new Promise((resolve) => {
    state.onDiscovery = resolve;
  });
  const request = loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  const rejected = assert.rejects(request, /abort/i);
  await started;
  controller.abort();
  let timer;
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("discovery ignored caller cancellation")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("partial discovery never restores a model explicitly changed to SystemOne", async (t) => {
  const { plugin, state } = await fixture(t);
  state.omitChat = true;
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.ok(before["chat-free"]);
  state.catalogStatus = 503;
  state.chatProtocol = "systemone";
  const after = await plugin.provider.models({ models: before }, { auth: await publicAuth() });
  assert.equal(after["chat-free"], undefined);
});

test("registers without overwriting user config and enables public access without a secret", async (t) => {
  const { plugin } = await fixture(t);
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider["opencode-zen-free"].name, "OpenCode Zen Free");
  cfg.provider["opencode-zen-free"].name = "My name";
  await plugin.config(cfg);
  assert.equal(cfg.provider["opencode-zen-free"].name, "My name");
  assert.deepEqual(await plugin.auth.methods[0].authorize(), { type: "success", key: "public" });
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {});
  await assert.rejects(
    plugin.auth.loader(async () => ({ type: "api", key: "paid-secret" })),
    /public/i,
  );
  assert.deepEqual((await plugin.auth.usage(publicAuth)).windows, []);
});

test("discovers protocols and free models, caches success, marks failed refresh as fallback", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const provider = { models: {} };
  const models = await plugin.provider.models(provider, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), ["chat-free", "messages-free", "responses-free"]);
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
  assert.equal(models["messages-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["chat-free"].api.url, `${origin}/v1`);
  state.modelsStatus = 503;
  const fallback = await plugin.provider.models({ models }, { auth: await publicAuth() });
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
  assert.deepEqual(Object.keys(fallback), Object.keys(models));
});

test("partial catalog failure retains previously verified models rather than dropping them", async (t) => {
  const { plugin, state } = await fixture(t);
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  state.catalogStatus = 503;
  state.docsStatus = 503;
  const fallback = await plugin.provider.models({ models }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(fallback).sort(), ["chat-free", "messages-free", "responses-free"]);
  // Zen's own list was read: not fallen back, so magpie takes this list
  // and not the last one read in full (yetone/magpie#2385)
  assert.equal(fallback[Symbol.for("magpie.fellBack")], undefined);
});

// The reporter of #2305 (yetone/magpie) saw only the three models the
// plugin knew offline: the catalog and the docs out of reach dropped every
// listed free model they didn't name. A listed free model now takes its
// endpoint from the snapshot of OpenCode's console docs; Jev (SystemOne)
// and a paid model stay out, and a model not listed isn't offered.
test("listed free models are offered when the catalog and the docs can't be read", async (t) => {
  const { plugin, state } = await fixture(t);
  state.catalogStatus = 503;
  state.docsStatus = 404;
  state.ids = ["big-pickle", "step-5-preview-free", "cat-jam-free", "jev-1.13-free", "paid"];
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), ["big-pickle", "cat-jam-free", "step-5-preview-free"]);
  assert.equal(models["step-5-preview-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["step-5-preview-free"].name, "Step 5 Preview Free");
  assert.equal(models["step-5-preview-free"].limit.context, 1000000);
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
});

// yetone/magpie#2385: Zen made deepseek-v4.1-flash-free free, and it was
// never offered. Zen's /models as the public key read it on 2026-10-15,
// byte for byte. Neither the plugin's snapshot nor an unreachable catalog
// or docs describe it, and the list it was in was said as fallen back,
// which magpie answers by keeping the last list read in full.
const zenListing = readFileSync(
  new URL("./fixtures/zen-models-2026-10-15.json", import.meta.url),
  "utf8",
);
const zenFree = [
  "big-pickle",
  "cat-jam-free",
  "deepseek-v4.1-flash-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3.5-lightning-free",
  "space-bunny-free",
  "step-5-preview-free",
];

test("a free model Zen lists that the catalog and the docs don't describe is offered, on chat (#2385)", async (t) => {
  const { plugin, state } = await fixture(t);
  state.listing = zenListing;
  state.catalogStatus = 503;
  state.docsStatus = 404;
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), zenFree);
  assert.equal(models["deepseek-v4.1-flash-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["deepseek-v4.1-flash-free"].free, true);
  assert.equal(models["muse-spark-1.3-contributor-free"].api.npm, "@ai-sdk/openai");
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
  // a request for it goes to Zen, at chat completions
  const options = await plugin.auth.loader(publicAuth);
  const response = await options.fetch(`${options.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash-free", messages: [], stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(state.calls.at(-1).url, "/v1/chat/completions");
  assert.equal(state.calls.at(-1).body.model, "deepseek-v4.1-flash-free");
});

test("a free model Zen lists before the catalog has it is offered with the catalog read (#2385)", async (t) => {
  const { plugin, state } = await fixture(t);
  state.listing = zenListing;
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(models["deepseek-v4.1-flash-free"].api.npm, "@ai-sdk/openai-compatible");
  // the fixture's catalog prices "paid" and names nothing of Zen's: no
  // paid model Zen lists is offered for being unknown
  for (const id of Object.keys(models)) assert.ok(zenFree.includes(id), id);
});

test("forces upstream streaming, preserves existing tools and returns the SSE body unbuffered", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const bash = {
    type: "function",
    function: {
      name: "bash",
      description: "real bash",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  };
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "x-session-id": "session_123",
      "content-length": "1",
    },
    body: JSON.stringify({
      model: "chat-free",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      tools: [bash],
    }),
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(await response.text(), /\[DONE\]/);
  const sent = state.calls.at(-1);
  assert.equal(sent.headers.authorization, "Bearer public");
  assert.match(sent.headers["x-opencode-session"], /^ses_[0-9a-f]{9}ff[0-9a-f][0-9A-Za-z]{14}$/);
  // OpenCode 2.0.25 sends its own session id under both; a caller's
  // (session_123) never goes on.
  assert.equal(sent.headers["x-session-affinity"], sent.headers["x-opencode-session"]);
  assert.equal(sent.headers["x-session-id"], sent.headers["x-opencode-session"]);
  assert.equal(sent.headers["x-opencode-session-id"], sent.headers["x-opencode-session"]);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.stream_options.include_usage, true);
  assert.deepEqual(sent.body.tools[0], bash);
  assert.deepEqual(
    sent.body.tools.map((tool) => tool.function.name),
    ["bash", "edit", "glob", "grep", "read"],
  );
});

test("collapses SSE for a non-streaming client and preserves upstream HTTP errors", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = () =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
    });
  const response = await send();
  assert.equal((await response.json()).choices[0].message.content, "hello");
  state.status = 429;
  const error = await send();
  assert.equal(error.status, 429);
  assert.equal(error.headers.get("retry-after"), "30");
  assert.equal((await error.json()).error.message, "limited");
});

for (const [path, model, key] of [
  ["responses", "responses-free", "parameters"],
  ["messages", "messages-free", "input_schema"],
]) {
  test(`normalizes ${path} tools and authentication using native protocol`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      body: JSON.stringify({ model, stream: true }),
    });
    await response.text();
    const sent = state.calls.at(-1);
    assert.equal(sent.body.tools[0].name, "bash");
    assert.equal(sent.body.tools[0][key].type, "object");
    if (path === "messages") {
      assert.equal(sent.headers["x-api-key"], "public");
      assert.equal(sent.headers["anthropic-version"], "2023-06-01");
      assert.equal(sent.headers.authorization, undefined);
    }
  });
}

test("rejects paid models, wrong protocol and foreign URLs before sending inference", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const before = state.calls.length;
  const paid = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "paid", stream: true }),
  });
  assert.equal(paid.status, 404);
  for (const [url, model] of [
    [`${origin}/v1/responses`, "chat-free"],
    ["https://other.example/v1/chat/completions", "chat-free"],
  ]) {
    await assert.rejects(
      loader.fetch(url, { method: "POST", body: JSON.stringify({ model, stream: true }) }),
    );
  }
  assert.equal(state.calls.length, before);
});

test("accepts Request input and aborts a streaming request", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.hang = true;
  const controller = new AbortController();
  const req = new Request(`${origin}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  const response = await loader.fetch(req);
  const body = response.text();
  controller.abort();
  await assert.rejects(body, /abort/i);
});

test("chat headers are scoped to this provider and retain the conversation session", async (t) => {
  const { plugin } = await fixture(t);
  const out = { headers: {} };
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "s1" }, out);
  assert.deepEqual(out.headers, {});
  await plugin["chat.headers"](
    { model: { providerID: "opencode-zen-free" }, sessionID: "s1" },
    out,
  );
  assert.equal(out.headers["x-session-id"], "s1");
});

test("a refresh drops a model Zen no longer lists and adds one it lists now", async (t) => {
  const { plugin, state } = await fixture(t);
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(before).sort(), ["chat-free", "messages-free", "responses-free"]);
  state.ids = ["chat-free", "messages-free", "late-free"];
  const after = await plugin.provider.models({ models: before }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(after).sort(), ["chat-free", "late-free", "messages-free"]);
  assert.equal(after[Symbol.for("magpie.fellBack")], undefined);
  // a failed list keeps the last one, said as fallen back
  state.modelsStatus = 503;
  const kept = await plugin.provider.models({ models: after }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(kept).sort(), ["chat-free", "late-free", "messages-free"]);
  assert.equal(kept[Symbol.for("magpie.fellBack")], true);
});

test("a model no longer free is answered 404 naming the free ones, so only it is set aside", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const before = state.calls.length;
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gone-free", stream: true }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error.message, /Model gone-free is not available/);
  assert.match(body.error.message, /chat-free, messages-free, responses-free/);
  // listed a moment ago: the list isn't asked again for it
  assert.equal(state.calls.length, before);
});

test("a model made free since the list was read is served after the list is asked again", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.ids = ["chat-free", "late-free"];
  state.chatProtocol = "chat/completions";
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  t.after(() => {
    Date.now = realNow;
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "late-free", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(state.calls.at(-1).body.model, "late-free");
});

test("a Chat stream Zen closes before its [DONE] ends cut short for a streaming client and fails for one that doesn't (#91)", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.reply =
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant"}}],"usage":null}\n\n' +
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"content":"Installed successfully and all"}}],"usage":null}\n\n' +
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"content":" other plugins are intact."}}],"usage":null}\n\n';
  const send = (stream) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream, messages: [{ role: "user", content: "hi" }] }),
    });
  const streamed = await send(true);
  assert.equal(streamed.status, 200);
  const text = await streamed.text();
  assert.match(text, /other plugins are intact\./);
  assert.match(text, /The reply was cut short.*"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]\n\n$/);
  assert.doesNotMatch(text, /"error"/);
  const whole = await send(false);
  assert.notEqual(whole.status, 200);
  assert.match(await whole.text(), /without a completion marker \(reply x2, 3 events/);
});

// Zen's free tier answers only at the inference API since mid-October 2026
// (403 FreeTierError at /zen/v1 to OpenCode's own request); a model listed
// before then, whose URL is /zen/v1, is asked there too.
test("asks the inference API, also for a model listed at /zen/v1", async (t) => {
  const { default: plugin } = await subject;
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "big-pickle" }] });
    if (url.endsWith("/chat/completions"))
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    return new Response("", { status: 500 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const hooks = await plugin.server({ project: { id: "x" } });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  assert.equal(loader.baseURL, "https://opencode.ai/inference/v1");
  for (const url of [
    "https://opencode.ai/zen/v1/chat/completions",
    "https://opencode.ai/inference/v1/chat/completions",
  ]) {
    const response = await loader.fetch(url, {
      method: "POST",
      body: JSON.stringify({ model: "big-pickle", stream: true, messages: [] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(asked.at(-1), "https://opencode.ai/inference/v1/chat/completions");
  }
  assert.ok(!asked.some((url) => url.startsWith("https://opencode.ai/zen/")), asked.join("\n"));
});

// Zen's free tier serves a request as OpenCode's only with OpenCode's
// environment block in a system message; without it an agent's request
// (Kimi Work's, WorkBuddy's) is 429 FreeUsageLimitError after a small
// daily allowance, while OpenCode's own goes through (杨梅 on magpie's
// Discord, 2026-10-25).
const ENV = /<env>[\s\S]*Working directory:[\s\S]*<\/env>/;
const systemText = (protocol, body) => {
  const text = (content) =>
    typeof content === "string" ? content : (content ?? []).map((part) => part.text).join("\n");
  if (protocol === "anthropic") return text(body.system);
  if (protocol === "responses")
    return [
      body.instructions ?? "",
      ...(body.input ?? []).filter((m) => ["system", "developer"].includes(m.role)).map((m) => text(m.content)),
    ].join("\n");
  return body.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n");
};
const agentPrompt = "You are WorkBuddy. Help the user.";
const withPrompt = (protocol, prompt, user) =>
  protocol === "anthropic"
    ? { ...(prompt === undefined ? {} : { system: prompt }), messages: [{ role: "user", content: user }] }
    : protocol === "responses"
      ? Array.isArray(prompt)
        ? { input: [{ role: "system", content: prompt }, { role: "user", content: user }] }
        : { ...(prompt === undefined ? {} : { instructions: prompt }), input: [{ role: "user", content: user }] }
      : {
          messages: [
            ...(prompt === undefined ? [] : [{ role: "system", content: prompt }]),
            { role: "user", content: user },
          ],
        };

for (const { protocol, path, model } of protocols) {
  test(`${protocol}: an agent's own prompt goes with OpenCode's environment block, once`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const send = async (body) => {
      const response = await loader.fetch(`${origin}/v1/${path}`, {
        method: "POST",
        body: JSON.stringify({ model, stream: true, ...body }),
      });
      await response.text();
      return state.calls.at(-1).body;
    };
    // the agent's prompt is kept, first, and the block follows it
    let sent = await send(withPrompt(protocol, agentPrompt, "hello"));
    let system = systemText(protocol, sent);
    assert.match(system, ENV);
    assert.ok(system.startsWith(agentPrompt), system);
    assert.equal(system.match(/<env>/g).length, 1);
    if (protocol === "chat") assert.equal(sent.messages.filter((m) => m.role === "system").length, 1);
    // an agent that sent no prompt gets one holding the block
    sent = await send(withPrompt(protocol, undefined, "hello"));
    assert.match(systemText(protocol, sent), ENV);
    if (protocol === "chat") assert.equal(sent.messages[0].role, "system");
    // a prompt in parts gets a part of its own
    sent = await send(withPrompt(protocol, [{ type: "text", text: agentPrompt }], "hello"));
    assert.match(systemText(protocol, sent), ENV);
    // the block in a user message doesn't count with Zen, so it is added
    sent = await send(withPrompt(protocol, agentPrompt, "<env>\n  Working directory: /x\n</env>"));
    assert.match(systemText(protocol, sent), ENV);
    // OpenCode's own prompt already has one, and gets no second
    const own = `${agentPrompt}\n<env>\n  Working directory: /Users/me/project\n</env>`;
    sent = await send(withPrompt(protocol, own, "hello"));
    assert.equal(systemText(protocol, sent), own);
  });
}
