import test from "node:test";
import assert from "node:assert/strict";
import { createPlugin } from "../lib/plugin.mjs";
import { agentPolicy, configuration } from "../lib/config.mjs";
import { OPEN } from "../lib/protocol.mjs";

const request = text => ({ messages: [{ role: "user", content: text }] });
const answer = { id: "chatcmpl-fixture", choices: [{ finish_reason: "stop", message: { content: "Final answer" } }] };
const context = extra => ({ origin: "local", agent: "claude", protocol: "chat",
  session: "session", success: true, state: {}, options: { agents: ["claude"] }, ...extra });

function stub({ result = query => query, service = null } = {}) {
  const calls = [];
  const events = [];
  const plugin = createPlugin({
    fetcher: async (url, init) => {
      const input = JSON.parse(init.body);
      calls.push(input);
      if (service) return await service(url, input);
      return url.endsWith("/recall")
        ? Response.json({ results: [{ text: await result(input.query) }] })
        : Response.json({ success: true, operation_id: input.operation_id });
    },
    observe: event => events.push(event)
  });
  return { plugin, calls, events };
}

test("automatic ownership is evidence-based for all agents; legacy options preserve exact choices", () => {
  const legacy = configuration({ agents: ["dsh"] });
  assert.equal(agentPolicy(legacy, "dsh").recall.owner, "gateway");
  assert.equal(agentPolicy(legacy, "codex").recall.owner, "off");
  const auto = configuration({ capture: true, agent_mode: "auto" });
  for (const agent of ["dsh", "hermes", "opencode"]) {
    assert.equal(agentPolicy(auto, agent).recall.owner, "pending");
    assert.equal(agentPolicy(auto, agent, { recall: "inactive" }).recall.owner, "gateway");
    assert.equal(agentPolicy(auto, agent, { recall: "active", capture: "inactive" }).recall.owner, "native");
    assert.equal(agentPolicy(auto, agent, { recall: "active", capture: "inactive" }).capture.owner, "gateway");
  }
  const explicit = configuration({ agent_mode: "manual", agent_policies: { "Claude Code": { recall: "gateway", capture: "gateway" } } });
  assert.equal(agentPolicy(explicit, "claude", { recall: "active" }).recall.reason, "native-conflict");
  assert.equal(agentPolicy(explicit, "claude", { capture: "inactive" }).capture.reason, "capture-off");
  assert.equal(agentPolicy(explicit, "dsh").recall.owner, "off");
});

test("a tool continuation without a session or a warm cache does not recall again", async () => {
  const { plugin, calls } = stub();
  const extra = { session: undefined };
  await plugin.onRequest(request("New question"), context(extra));
  const body = request("New question");
  body.messages.push({ role: "assistant", tool_calls: [{ id: "fixture" }] }, { role: "tool", content: "done" });
  assert.equal(await plugin.onRequest(body, context(extra)), undefined);
  assert.equal(calls.length, 1);
});

test("changed effective queries and subagents do not reuse other recalled content", async () => {
  const { plugin, calls } = stub();
  await plugin.onRequest(request("same"), context({ query: "First" }));
  const changed = await plugin.onRequest(request("same"), context({ query: "Second" }));
  const worker = await plugin.onRequest(request("same"), context({ query: "Second", kind: "subagent" }));
  assert.deepEqual(calls.map(call => call.query), ["First", "Second", "Second"]);
  assert.match(changed.messages[0].content, /\[1\] Second/);
  assert.match(worker.messages[0].content, /\[1\] Second/);
});

test("cancelling the first waiter leaves its shared recall alive", async () => {
  let complete;
  const { plugin, calls } = stub({ result: query => new Promise(resolve => { complete = () => resolve(query); }) });
  const cancel = new AbortController();
  const first = plugin.onRequest(request("Need memory"), context({ signal: cancel.signal }));
  const second = plugin.onRequest(request("Need memory"), context());
  cancel.abort();
  assert.equal(await first, undefined);
  complete();
  assert.match((await second).messages[0].content, /Need memory/);
  assert.equal(calls.length, 1);
});

test("long UTF-8 conversations retain the current turn within one whole-request budget", async () => {
  const { plugin } = stub({ result: query => query + " " + "记".repeat(150) });
  const history = [];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "user", content: "turn " + i });
    const original = structuredClone(history);
    const options = { agents: ["claude"], injection_max_bytes: 1100 };
    const changed = await plugin.onRequest({ messages: original }, context({ options }));
    assert.ok(changed.messages.at(-1).content.includes(OPEN));
    assert.doesNotMatch(changed.messages.at(-1).content, /\uFFFD/);
    assert.ok(Buffer.byteLength(JSON.stringify(changed.messages)) - Buffer.byteLength(JSON.stringify(history)) <= 1110);
    const continued = structuredClone(history).concat([{ role: "assistant", tool_calls: [{ id: "tool" }] }, { role: "tool", content: "done" }]);
    await plugin.onRequest({ messages: continued }, context({ options }));
    assert.deepEqual(continued.slice(0, history.length), changed.messages);
    history.push({ role: "assistant", content: "completed" });
  }
});

test("a repeated final callback enqueues one stable async operation, including stateless reply IDs", async () => {
  const { plugin, calls, events } = stub();
  const options = { agents: ["claude"], capture: true };
  const run = context({ session: undefined, options });
  await plugin.onRequest(request("Capture this"), run);
  await Promise.all([plugin.onResponse(answer, run), plugin.onResponse(answer, run)]);
  const writes = calls.filter(input => input.items);
  assert.equal(writes.length, 1);
  assert.match(writes[0].operation_id, /^[a-f0-9-]{36}$/);
  assert.equal(events.find(event => event.code === "submitted").operation, writes[0].operation_id);
  assert.ok(events.some(event => event.code === "duplicate"));
  assert.ok(!events.some(event => event.code === "completed"));
});

test("cooldown avoids serial delays during an outage and a short host budget avoids dispatch", async () => {
  const { plugin, calls, events } = stub({ service: () => Response.json({}, { status: 503 }) });
  for (let i = 0; i < 6; i++) assert.equal(await plugin.onRequest(request("new " + i), context()), undefined);
  assert.equal(calls.length, 3);
  assert.ok(events.some(event => event.code === "cooldown"));
  const budget = stub();
  await budget.plugin.onRequest(request("short budget"), context({ options: { agents: ["claude"], gatewayTimeoutMs: 200 } }));
  assert.equal(budget.calls.length, 0);
  assert.ok(budget.events.some(event => event.code === "budget"));
});

test("tags are optional and a scoped request uses the same tags for recall and retain", async () => {
  const { plugin, calls } = stub();
  const run = context({ options: { agents: ["claude"], capture: true, recall_tags: ["project:fixture"] } });
  await plugin.onRequest(request("for this workspace"), run);
  await plugin.onResponse(answer, run);
  assert.deepEqual(calls[0].tags, ["project:fixture"]);
  assert.equal(calls[0].tags_match, "any_strict");
  assert.deepEqual(calls[1].items[0].tags, calls[0].tags);
});

test("the hook injects and captures a synthetic final answer in all four wire formats", async () => {
  const text = "Find this fixture memory";
  const fixtures = {
    chat: [request(text), answer],
    responses: [{ input: [{ role: "user", content: [{ type: "input_text", text }] }] },
      { id: "resp_fixture", status: "completed", output_text: "Final answer" }],
    anthropic: [{ messages: [{ role: "user", content: [{ type: "text", text }] }] },
      { id: "msg_fixture", stop_reason: "end_turn", content: [{ type: "text", text: "Final answer" }] }],
    gemini: [{ contents: [{ role: "user", parts: [{ text }] }] },
      { responseId: "gem_fixture", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Final answer" }] } }] }]
  };
  for (const [protocol, [body, reply]] of Object.entries(fixtures)) {
    const { plugin, calls } = stub({ result: () => "fixture recall marker" });
    const run = context({ protocol, options: { agents: ["claude"], capture: true } });
    assert.match(JSON.stringify(await plugin.onRequest(body, run)), /fixture recall marker/);
    await plugin.onResponse(reply, run);
    assert.equal(calls[0].query, text);
    assert.match(calls[1].items[0].content, /Final answer/);
    assert.equal(calls[1].items[0].metadata.protocol, protocol);
  }
});
