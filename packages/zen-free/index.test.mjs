import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { protocols, declaredTools, toolReply } from "./tool-fixtures.mjs";
import { addEnvironment, environment, latestVersion, projectID, traceHeaders, userAgent } from "./provider.mjs";

const subject = import("./index.mjs").then((module) => ({
  default: { server: module.ZenFreePlugin },
}));

async function fixture(t, input = {}) {
  const state = { calls: [], status: 200, modelsStatus: 200, docsStatus: 200, catalogStatus: 200 };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const rawOrder = req.rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
    state.calls.push({ url: req.url, headers: req.headers, rawOrder, body: text && JSON.parse(text) });
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
          // Zen's free tier refuses a core tool that takes nothing
          const schema = tool.parameters ?? tool.input_schema;
          assert.equal(Object.keys(schema.properties).length, 1);
          assert.deepEqual(schema.required, Object.keys(schema.properties));
          // OpenCode 2's names and parameters, never 1.x's bash or filePath
          assert.notEqual(tool.name, "bash");
          assert.ok(!("filePath" in schema.properties));
          if (protocol === "chat") assert.equal(tool.strict, false);
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

// OpenCode 2.2.5 names a folder that isn't a git repository
// sha1("directory:" + folder), and sends `global` only from a repository
// with no remote and no commit; 0.1.14 to 0.1.18 sent `global` always.
const homeProject = () => projectID(homedir());
for (const [input, supplied, expected] of [
  [{}, undefined, homeProject],
  [{ project: { id: "magpie" } }, undefined, homeProject],
  [{ project: { id: "abc123", vcs: "git" } }, undefined, "abc123"],
  [{}, "client-project", "client-project"],
]) {
  test(`uses OpenCode project identity ${typeof expected === "function" ? "of the folder" : expected}`, async (t) => {
    const { plugin, state, origin } = await fixture(t, input);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: supplied ? { "x-opencode-project": supplied } : {},
      body: JSON.stringify({ model: "chat-free", stream: true }),
    });
    await response.text();
    const want = typeof expected === "function" ? expected() : expected;
    assert.equal(state.calls.at(-1).headers["x-opencode-project"], want);
    assert.notEqual(state.calls.at(-1).headers["x-opencode-project"], "global");
    assert.equal(state.calls.at(-1).headers["user-agent"], "opencode/latest/2.2.5/cli");
  });
}

test("names the project as OpenCode does: the stated folder, or its repository's remote", (t) => {
  const root = mkdtempSync(join(tmpdir(), "zen-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = realpathSync(root);
  const sha1 = (text) => createHash("sha1").update(text).digest("hex");
  // a plain folder: what OpenCode 2.2.5 sent from ~/runs/zencap/home/work
  assert.equal(projectID("/Users/yetone/runs/zencap/home/work"), "1132ded9876e9dc00df57eea7de251c155550345");
  const plain = join(real, "plain");
  mkdirSync(plain);
  assert.equal(projectID(plain), sha1(`directory:${plain}`));
  // a repository with a remote, from a folder inside it
  const repo = join(real, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, ".git", "config"),
    '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/x/y.git\n[remote "origin"]\n\turl = git@GitHub.com:magpie/app.git\n',
  );
  assert.equal(projectID(join(repo, "src")), sha1("git-remote:github.com/magpie/app"));
  // one with no remote: its root folder
  const bare = join(real, "bare");
  mkdirSync(join(bare, ".git"), { recursive: true });
  writeFileSync(join(bare, ".git", "config"), "[core]\n\tbare = false\n");
  mkdirSync(join(bare, "sub"));
  assert.equal(projectID(join(bare, "sub")), sha1(`directory:${bare}`));
  const env = environment(join(bare, "sub"));
  assert.match(env, /Is directory a git repo: yes/);
  assert.match(env, new RegExp(`Workspace root folder: ${bare}\\n`));
});

// OpenCode's version is the one its own updater is told is latest; a
// version that can't be read, or is older than the one built in, leaves
// the built-in one.
test("reads OpenCode's latest version from its updater, and keeps its own otherwise", async (t) => {
  let reply = '{"version":"2.3.0","minimum":false}';
  let asked;
  const server = createServer((req, res) => {
    asked = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/update`;
  assert.equal(await latestVersion(url), "2.3.0");
  assert.equal(asked, "/update?current=2.2.5");
  for (reply of ['{"version":"2.1.0"}', '{"version":"latest"}', "nope", "{}"]) {
    assert.equal(await latestVersion(url), undefined, reply);
  }
  assert.equal(await latestVersion("http://127.0.0.1:1/none"), undefined);
  assert.equal(userAgent("2.3.0"), "opencode/latest/2.3.0/cli");
  // a plugin given the updater sends the version it names
  reply = '{"version":"2.4.1"}';
  const { state, origin } = await fixture(t);
  const module = await subject;
  const plugin = await module.default.server({}, {
    baseURL: `${origin}/v1`,
    catalogURL: `${origin}/catalog`,
    docsURL: `${origin}/docs`,
    versionURL: url,
  });
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  await response.text();
  assert.equal(state.calls.at(-1).headers["user-agent"], "opencode/latest/2.4.1/cli");
  // the model list goes as OpenCode too, never as Bun
  const list = state.calls.find((call) => call.url === "/v1/models");
  assert.equal(list.headers["user-agent"], "opencode/latest/2.4.1/cli");
});

test("trace headers keep one trace a conversation and a new span each request", () => {
  const first = traceHeaders("ses_trace_a");
  const again = traceHeaders("ses_trace_a");
  const other = traceHeaders("ses_trace_b");
  const b3 = /^([0-9a-f]{32})-([0-9a-f]{16})-1-[0-9a-f]{16}$/;
  const parent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
  for (const trace of [first, again, other]) {
    const [, id, span] = b3.exec(trace.b3);
    assert.deepEqual(parent.exec(trace.traceparent).slice(1), [id, span]);
  }
  assert.equal(b3.exec(first.b3)[1], b3.exec(again.b3)[1]);
  assert.notEqual(b3.exec(first.b3)[2], b3.exec(again.b3)[2]);
  assert.notEqual(b3.exec(first.b3)[1], b3.exec(other.b3)[1]);
});

// The headers OpenCode 2.2.5's release binary sends to Zen, captured on
// 2026-11-01, in its order: these and no others, whatever the caller sent. Zen's free
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
    assert.equal(sent["user-agent"], "opencode/latest/2.2.5/cli");
    assert.notEqual(sent["user-agent"], "claude-cli/2.1.0");
    assert.equal(sent.accept, "*/*");
    const own = Object.keys(sent).filter(
      (name) => !["host", "connection", "content-length", "accept-encoding"].includes(name),
    );
    assert.deepEqual(
      own.sort(),
      [
        "accept",
        "b3",
        "content-type",
        "traceparent",
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
    // in the order OpenCode's own request has on Bun, which the plugin
    // host runs: the headers Bun knows first, then the rest sorted, then
    // fetch's own Accept (so none is set here)
    const order = state.calls.at(-1).rawOrder.filter(
      (name) => !["host", "connection", "content-length", "accept-encoding"].includes(name),
    );
    assert.deepEqual(order, [
      ...(path === "messages" ? [] : ["authorization"]),
      "content-type",
      "user-agent",
      ...(path === "messages" ? ["anthropic-version"] : []),
      "b3",
      "traceparent",
      ...(path === "messages" ? ["x-api-key"] : []),
      "x-opencode-client",
      "x-opencode-project",
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-affinity",
      "x-session-id",
      "accept",
    ]);
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
  // OpenCode 2.2.5 sends its own session id under both; a caller's
  // (session_123) never goes on.
  assert.equal(sent.headers["x-session-affinity"], sent.headers["x-opencode-session"]);
  assert.equal(sent.headers["x-session-id"], sent.headers["x-opencode-session"]);
  assert.equal(sent.headers["x-opencode-session-id"], sent.headers["x-opencode-session"]);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.stream_options.include_usage, true);
  assert.deepEqual(sent.body.tools[0], bash);
  assert.deepEqual(
    sent.body.tools.map((tool) => tool.function.name),
    ["bash", "edit", "glob", "grep", "read", "shell"],
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
    assert.equal(sent.body.tools[0].name, "edit");
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
// before then, whose URL is /zen/v1, is asked there too. Each protocol
// goes where OpenCode 2.2.5 sends it, models.dev's v2 base_url
// (/inference/openai/v1, /inference/anthropic/v1), not /inference/v1.
test("asks the inference API where OpenCode 2 does, also for a model listed at /zen/v1", async (t) => {
  const { default: plugin } = await subject;
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "big-pickle" }, { id: "m-free" }, { id: "r-free" }] });
    if (url === "https://models.opencode.ai/api.json")
      return Response.json({
        opencode: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "big-pickle": {},
            "m-free": { provider: { npm: "@ai-sdk/anthropic" } },
            "r-free": { provider: { npm: "@ai-sdk/openai" } },
          },
        },
      });
    if (url.endsWith("/chat/completions") || url.endsWith("/messages") || url.endsWith("/responses"))
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
    assert.equal(asked.at(-1), "https://opencode.ai/inference/openai/v1/chat/completions");
  }
  for (const [path, model, sent] of [
    ["messages", "m-free", "https://opencode.ai/inference/anthropic/v1/messages"],
    ["responses", "r-free", "https://opencode.ai/inference/openai/v1/responses"],
  ]) {
    const response = await loader.fetch(`https://opencode.ai/inference/v1/${path}`, {
      method: "POST",
      body: JSON.stringify({ model, stream: true, messages: [], input: [] }),
    });
    await response.text();
    assert.equal(asked.at(-1), sent);
  }
  assert.ok(!asked.some((url) => url.startsWith("https://opencode.ai/zen/")), asked.join("\n"));
  assert.ok(!asked.some((url) => /\/inference\/v1\/(chat|messages|responses)/.test(url)), asked.join("\n"));
  // the version is asked of OpenCode's own updater, and its 500 leaves 2.2.5
  assert.ok(asked.includes("https://opencode.ai/update/api/latest/cli/npm?current=2.2.5"), asked.join("\n"));
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

// Zen answers 429 FreeUsageLimitError at once to the block 0.1.15 to
// 0.1.17 added, `Working directory: unknown`, and serves the same request
// with a path there (shanmao_10826 on magpie's Discord, 2026-10-29). The
// block names the directory the agent's prompt names, or the home folder.
test("the environment block names a real directory, never a fixed placeholder", () => {
  const home = "/home/someone";
  const added = (protocol, body) => {
    addEnvironment(body, protocol, home);
    return systemText(protocol, body);
  };
  const line = (text) => /Working directory: (.*)/.exec(text)?.[1];
  // none named: the home folder, in OpenCode's own block
  let text = added("chat", { messages: [{ role: "user", content: "hi" }] });
  assert.match(text, ENV);
  assert.equal(line(text), home);
  assert.doesNotMatch(text, /unknown/);
  assert.match(text, /^Here is some useful information about the environment you are running in:\n<env>\n/);
  assert.match(text, new RegExp(`Workspace root folder: ${home}\\n  Is directory a git repo: (yes|no)\\n  Platform: ${process.platform}\\n  Prefer ${realpathSync(tmpdir())}/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\\n</env>$`));
  // Codex's <cwd> in its first user message
  text = added("responses", {
    instructions: "You are Codex.",
    input: [{ role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/Users/me/app</cwd>\n</environment_context>" }] }],
  });
  assert.equal(line(text), "/Users/me/app");
  // Kimi's sentence, a Windows path, in the system prompt
  text = added("chat", {
    messages: [
      { role: "system", content: "You are Kimi. The current working directory is `C:\\work\\repo`." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(line(text.split("<env>")[1]), "C:\\work\\repo");
  // Anthropic: a "Working directory:" line outside an <env> block
  text = added("anthropic", { system: "Working directory: /srv/proj.\nBe brief.", messages: [] });
  assert.equal(line(text.split("<env>")[1]), "/srv/proj");
  // a relative or bare word is not a directory
  text = added("chat", { messages: [{ role: "system", content: "Working directory: unknown" }, { role: "user", content: "hi" }] });
  assert.equal(line(text.split("<env>")[1]), home);
});
