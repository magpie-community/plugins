import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SAPAICorePlugin } from "../src/index.js"
import { validateRequest as validateResponsesRequest } from "../src/responses.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const ROOT = "https://api.ai.eu10.hana.ondemand.com"
const CREDS = {
  authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com",
  baseUrl: ROOT + "/v2",
  clientId: "sentinel-client",
  clientSecret: "sentinel-client-secret",
  resourceGroup: "group-a",
}
const TOKEN = "sentinel-bearer-token"
const MODEL = "gpt-6-astra"
const VERSION = "2026-09-03"
const DEPLOYMENT = ROOT + "/v2/inference/deployments/deployment-a"
const COMPLETED = {
  id: "resp_a", object: "response", model: MODEL, status: "completed",
  output: [
    { id: "rs_a", type: "reasoning", summary: [], encrypted_content: "sealed-history" },
    { id: "msg_a", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "AICORE_OK", annotations: [] }] },
  ],
  usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 3 } },
  error: null, incomplete_details: null,
}

async function fixture(inference = () => new Response(JSON.stringify(COMPLETED))) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-responses-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, "credentials.json")
  fs.writeFileSync(credentialFile, JSON.stringify(CREDS), { mode: 0o600 })
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  const sent = []
  const state = { token: TOKEN, oauth: null, discovery: null, deployment: DEPLOYMENT, activeVersion: VERSION }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const json = body => new Response(JSON.stringify(body))
    if (url.pathname === "/oauth/token") return state.oauth?.() ?? json({ access_token: state.token, token_type: "bearer", expires_in: 3600 })
    if (url.pathname === "/v2/lm/deployments") {
      if (state.discovery) return state.discovery(input, init)
      return json({ resources: url.searchParams.get("$skip") === "0" ? [{ id: "deployment-a", status: "RUNNING", deploymentUrl: state.deployment, configurationId: "configuration-a", details: { resources: { backendDetails: { model: { name: MODEL, version: state.activeVersion } } } } }] : [] })
    }
    if (url.pathname === "/v2/lm/configurations/configuration-a") return json({ id: "configuration-a", scenarioId: "foundation-models", executableId: "azure-openai", parameterBindings: [{ key: "modelName", value: MODEL }, { key: "modelVersion", value: VERSION }] })
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return json({ resources: [{ model: MODEL, executableId: "azure-openai", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }], versions: [{ name: VERSION, inputTypes: ["text"] }] }] })
    sent.push({ url: url.href, init, body: JSON.parse(init.body) })
    return inference(input, init)
  }
  const plugin = await SAPAICorePlugin()
  const signed = await plugin.auth.methods[0].authorize({ credentialFile })
  assert.equal(signed.type, "success")
  const auth = { type: "api", key: signed.key, metadata: signed.metadata }
  const loader = await plugin.auth.loader(async () => auth)
  const request = (body = { model: MODEL, input: "hello" }, init = {}) => loader.fetch(ROOT + "/responses", { method: "POST", body: JSON.stringify(body), ...init })
  return { plugin, loader, auth, request, sent, state }
}

// --- native streaming (SSE) helpers ---------------------------------------

const frame = obj => `data: ${JSON.stringify(obj)}\n\n`
const CREATED = { type: "response.created", response: { id: "resp_a", object: "response", status: "in_progress" }, sequence_number: 0 }
const delta = (d, n) => ({ type: "response.output_text.delta", delta: d, item_id: "msg_a", output_index: 1, sequence_number: n })
const DONE = { type: "response.completed", response: COMPLETED, sequence_number: 9 }

// A pull-based event-stream upstream: each chunk (string or bytes) is emitted
// only when the consumer reads, so backpressure and gating stay observable.
function streamResponse(chunks, { status = 200, headers = {}, onPull } = {}) {
  let i = 0
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    pull(controller) {
      onPull?.()
      if (i >= chunks.length) { controller.close(); return }
      const chunk = chunks[i++]
      controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk)
    },
  }, { highWaterMark: 0 })
  return new Response(stream, { status, headers: { "content-type": "text/event-stream", ...headers } })
}

function parseEvents(text) {
  return text.split("\n\n").filter(block => block.trim()).map(block =>
    JSON.parse(block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(line.indexOf(":") + 1).replace(/^ /, "")).join("\n")))
}

// --- agent-executed function-tool round-trip helpers ----------------------

// A strict function schema and the forced first-turn call the upstream emits.
// The plugin never runs the tool; each test acts as the agent that executes it.
const STRICT_TOOL = { type: "function", name: "verify_value", strict: true, parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }
const FORCE = { type: "function", name: "verify_value" }
const CALL = { id: "fc_item", type: "function_call", call_id: "call_7", name: "verify_value", arguments: '{"value":7}', status: "completed" }
const REASON_1 = { id: "rs_7", type: "reasoning", summary: [], encrypted_content: "sealed-7" }
const USER = { role: "user", content: [{ type: "input_text", text: "verify 7" }] }

const forced = tc => tc !== null && typeof tc === "object"
const jsonResponse = obj => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } })
const nativeError = (status, code, secret) => new Response(JSON.stringify({ error: { code, message: "boom " + secret } }), { status, headers: { "content-type": "application/json" } })

// The agent executes verify_value(7) -> 14 and appends the result to the full
// returned history, selecting tool_choice:"none" for the continuation turn.
function continueTurn(call) {
  const answer = JSON.parse(call.arguments).value * 2
  return {
    model: MODEL,
    input: [USER, REASON_1, call, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ answer }) }],
    tools: [STRICT_TOOL], tool_choice: "none",
  }
}

// Native-side validation of a continuation: the full history, the call's
// independent item id and call_id, exact arguments and opaque reasoning must
// survive, and the result must reference a real call. Returns the final text
// derived from the agent-produced result, or a native rejection whose message
// embeds a secret so redaction stays observable.
function derive(body) {
  const items = body.input
  const reason = items.find(i => i.type === "reasoning")
  const call = items.find(i => i.type === "function_call")
  const result = items.find(i => i.type === "function_call_output")
  if (reason?.encrypted_content === "sealed-bad") return { status: 400, code: "invalid_encrypted_content", secret: TOKEN }
  if (!items.some(i => i.role === "user") || !reason || reason.encrypted_content !== "sealed-7" ||
      !call || call.id !== "fc_item" || call.call_id !== "call_7" || call.arguments !== '{"value":7}' ||
      !result || result.call_id !== call.call_id) return { status: 400, code: "invalid_value", secret: CREDS.clientSecret }
  return { text: "AICORE_RESULT_" + JSON.parse(result.output).answer }
}

const FIRST_WHOLE = { id: "resp_1", object: "response", model: MODEL, status: "completed", output: [REASON_1, CALL], usage: COMPLETED.usage, error: null, incomplete_details: null }
const finalWhole = text => ({ id: "resp_2", object: "response", model: MODEL, status: "completed", output: [{ id: "rs_8", type: "reasoning", summary: [], encrypted_content: "sealed-8" }, { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: COMPLETED.usage, error: null, incomplete_details: null })

// Whole-reply upstream: a forced call first, then validate + derive on continuation.
function wholeToolUpstream(input, init) {
  const body = JSON.parse(init.body)
  if (forced(body.tool_choice)) return jsonResponse(FIRST_WHOLE)
  const v = derive(body)
  return v.status ? nativeError(v.status, v.code, v.secret) : jsonResponse(finalWhole(v.text))
}

const ARG_DELTAS = ['{"', "val", 'ue"', ":7", "}"]
const CREATED_1 = { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress" }, sequence_number: 0 }
const ITEM_ADDED = { type: "response.output_item.added", output_index: 0, item: { id: "fc_item", type: "function_call", call_id: "call_7", name: "verify_value", arguments: "" }, sequence_number: 1 }
const CALL_DONE = { type: "response.completed", response: FIRST_WHOLE, sequence_number: 8 }

// Streamed counterpart: argument deltas then a terminal carrying the call, and a
// continuation that streams the derived final text.
function streamToolUpstream(input, init) {
  const body = JSON.parse(init.body)
  if (forced(body.tool_choice)) {
    return streamResponse([
      frame(CREATED_1), frame(ITEM_ADDED),
      ...ARG_DELTAS.map((d, i) => frame({ type: "response.function_call_arguments.delta", delta: d, item_id: "fc_item", output_index: 0, sequence_number: i + 2 })),
      frame(CALL_DONE),
    ])
  }
  const v = derive(body)
  if (v.status) return nativeError(v.status, v.code, v.secret)
  const final = finalWhole(v.text)
  return streamResponse([
    frame(CREATED_1),
    ...[...v.text].map((ch, i) => frame(delta(ch, i + 1))),
    frame({ type: "response.completed", response: final, sequence_number: v.text.length + 1 }),
  ])
}

test("whole native Responses preserves output identity, usage, status and verified parameters", async () => {
  const { loader, request, sent } = await fixture()
  const input = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  const body = { model: MODEL, input, instructions: "Be concise", max_output_tokens: 1024, reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"] }
  const response = await request(body, { headers: { authorization: "Bearer sdk-secret", "api-key": "sdk-key", "x-magpie-work-dir": "/private", "x-magpie-sign-in": "expired", "ai-resource-group": "wrong-group" } })
  assert.ok(response instanceof Response)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), COMPLETED)
  assert.equal(loader.baseURL, ROOT)
  assert.equal(loader.headers, undefined)
  assert.equal(sent.length, 1, "a generation must never be replayed")
  assert.equal(sent[0].url, DEPLOYMENT + "/responses")
  assert.deepEqual(sent[0].body, { ...body, store: false })
  const headers = new Headers(sent[0].init.headers)
  assert.equal(headers.get("authorization"), "Bearer " + TOKEN)
  assert.equal(headers.get("ai-resource-group"), "group-a")
  assert.equal(sent[0].init.redirect, "error")
  assert.equal(headers.get("api-key"), null)
  assert.ok([...headers.keys()].every(key => !key.startsWith("x-magpie-")))
})

test("stateless continuation keeps native call identity and encrypted reasoning without replay", async () => {
  const { request, sent } = await fixture(wholeToolUpstream)
  // Turn 1: the upstream forces the function call; the plugin relays it and
  // never runs the tool. Omitted include defaults to encrypted-reasoning continuity.
  const r1 = await request({ model: MODEL, input: [USER], tools: [STRICT_TOOL], tool_choice: FORCE })
  assert.equal(r1.status, 200)
  const first = await r1.json()
  const call = first.output.find(i => i.type === "function_call")
  assert.equal(call.arguments, '{"value":7}')
  assert.notEqual(call.id, call.call_id, "output-item id stays independent from call_id")
  assert.deepEqual(sent[0].body.include, ["reasoning.encrypted_content"])
  assert.equal(sent[0].body.store, false)
  assert.equal("previous_response_id" in sent[0].body, false)
  assert.equal("conversation" in sent[0].body, false)
  // Turn 2: the agent executes verify_value(7) -> 14 and continues with the full
  // history; the upstream derives the final reply from that result, never echoes.
  const continuation = continueTurn(call)
  const r2 = await request(continuation)
  assert.equal(r2.status, 200)
  const final = await r2.json()
  assert.equal(final.output.at(-1).content[0].text, "AICORE_RESULT_14")
  assert.deepEqual(sent[1].body.input, continuation.input, "full returned history survives unchanged")
  assert.equal(sent[1].body.input.find(i => i.type === "reasoning").encrypted_content, "sealed-7")
  assert.equal(sent[1].body.tool_choice, "none")
  assert.deepEqual(sent[1].body.include, ["reasoning.encrypted_content"])
  assert.equal(sent.length, 2, "one dispatch per turn; no generation is replayed")
})

const CUSTOM_PATCH_TOOL = {
  type: "function",
  name: "apply_patch",
  parameters: {
    type: "object",
    properties: { input: { type: "string", description: "Input must match the lark grammar:\nstart: x" } },
    required: ["input"],
    additionalProperties: false,
  },
  strict: true,
}

test("Codex namespace and custom tools translate to native function tools reaching SAP", async () => {
  const tools = [
    { type: "namespace", name: "arithmetic", description: "Integer arithmetic", tools: [STRICT_TOOL] },
    { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
  ]
  const user = { role: "user", content: [{ type: "input_text", text: "verify 7" }] }
  const customCall = { id: "custom_item", type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n+7\n*** End Patch" }
  const { request, sent } = await fixture((_, init) => {
    const body = JSON.parse(init.body)
    try {
      assert.deepEqual(body.tools, [{ ...STRICT_TOOL, name: "arithmetic__verify_value" }, CUSTOM_PATCH_TOOL], "namespace and custom tools translate to native function tools")
      if (body.tool_choice === "required") {
        assert.deepEqual(body.input, [user])
        return jsonResponse({
          ...FIRST_WHOLE,
          output: [
            REASON_1,
            { ...CALL, name: "arithmetic__verify_value" },
            { id: customCall.id, type: "function_call", call_id: customCall.call_id, name: "apply_patch", arguments: JSON.stringify({ input: customCall.input }), status: "completed" },
          ],
        })
      }
      assert.equal(body.tool_choice, "none")
      assert.deepEqual(body.input.filter(item => item.type === "function_call"), [
        { ...CALL, name: "arithmetic__verify_value" },
        { id: customCall.id, type: "function_call", call_id: customCall.call_id, name: "apply_patch", arguments: JSON.stringify({ input: customCall.input }), status: "completed" },
      ])
      const results = body.input.filter(item => item.type === "function_call_output")
      assert.equal(results.length, 2)
      assert.equal(results[1].output, "patched")
      return jsonResponse(finalWhole("AICORE_RESULT_" + JSON.parse(results[0].output).answer + "_" + results[1].output))
    } catch {
      return nativeError(400, "invalid_tool_history", TOKEN)
    }
  })
  const first = await (await request({ model: MODEL, input: [user], tools, tool_choice: "required" })).json()
  const call = first.output.find(item => item.type === "function_call")
  const patchCall = first.output.find(item => item.type === "custom_tool_call")
  assert.equal(call.name, "verify_value")
  assert.equal(call.namespace, "arithmetic")
  assert.deepEqual(call.encrypted_function_args, [])
  assert.deepEqual(patchCall, { ...customCall, status: "completed" })
  const results = [
    { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ answer: JSON.parse(call.arguments).value * 2 }) },
    { type: "custom_tool_call_output", call_id: patchCall.call_id, output: "patched" },
  ]
  const second = await request({ model: MODEL, input: [user, REASON_1, call, patchCall, ...results], tools, tool_choice: "none" })
  assert.equal(second.status, 200)
  assert.equal((await second.json()).output.at(-1).content[0].text, "AICORE_RESULT_14_patched")
  assert.equal(sent.length, 2, "each turn dispatches once, with faithful custom-tool translation")
})

for (const stream of [false, true]) {
  test(`top-level and namespaced custom tools execute a complete ${stream ? "SSE" : "JSON"} loop`, async () => {
    const tools = [
      { type: "custom", name: "apply_patch", description: "Freeform patch", format: { type: "grammar", syntax: "lark", definition: "start: patch" } },
      { type: "namespace", name: "coding", tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }] },
    ]
    const inputs = ["*** Begin Patch\n+line 1\n*** End Patch\n😀", "namespaced \"patch\" \\ slash"]
    const { request, sent } = await fixture((_, init) => {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.tools.map(t => t.name), ["apply_patch", "coding__apply_patch"])
      if (body.tool_choice === "none") {
        assert.deepEqual(body.input.filter(i => i.type === "function_call").map(i => [i.name, i.arguments]), [
          ["apply_patch", JSON.stringify({ input: inputs[0] })],
          ["coding__apply_patch", JSON.stringify({ input: inputs[1] })],
        ])
        const outputs = body.input.filter(i => i.type === "function_call_output").map(i => i.output)
        const response = finalWhole("CUSTOM_OK_" + outputs.join("|"))
        return stream ? streamResponse([frame({ type: "response.completed", response })]) : jsonResponse(response)
      }
      assert.deepEqual(body.tool_choice, {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "apply_patch" }, { type: "function", name: "coding__apply_patch" }],
      })
      const wireCalls = [
        { id: "ctc_0", type: "function_call", call_id: "call_c0", name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n+line 1\\n*** End Patch\\n\\ud83d\\ude00"}', status: "completed" },
        { id: "ctc_1", type: "function_call", call_id: "call_c1", name: "coding__apply_patch", arguments: JSON.stringify({ input: inputs[1] }), status: "completed" },
      ]
      const response = { ...FIRST_WHOLE, output: [REASON_1, ...wireCalls] }
      if (!stream) return jsonResponse(response)
      const chunks0 = ['{"in', 'put":"*** Begin Patch\\n', '+line 1\\n*** End Patch\\n\\ud83d', '\\ude00"}']
      const events = [
        frame({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }),
        frame({ type: "response.output_item.added", output_index: 0, item: { ...wireCalls[0], arguments: "", status: "in_progress" } }),
        ...chunks0.map((delta, i) => frame({ type: "response.function_call_arguments.delta", item_id: "ctc_0", output_index: 0, delta, sequence_number: i + 1 })),
        frame({ type: "response.function_call_arguments.done", item_id: "ctc_0", output_index: 0, name: "apply_patch", arguments: wireCalls[0].arguments }),
        frame({ type: "response.output_item.done", output_index: 0, item: wireCalls[0] }),
        frame({ type: "response.output_item.added", output_index: 1, item: { ...wireCalls[1], arguments: "", status: "in_progress" } }),
        frame({ type: "response.function_call_arguments.delta", item_id: "ctc_1", output_index: 1, delta: wireCalls[1].arguments }),
        frame({ type: "response.function_call_arguments.done", item_id: "ctc_1", output_index: 1, name: "coding__apply_patch", arguments: wireCalls[1].arguments }),
        frame({ type: "response.output_item.done", output_index: 1, item: wireCalls[1] }),
        frame({ type: "response.completed", response }),
      ]
      return streamResponse(events)
    })
    const tool_choice = {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "custom", name: "apply_patch" }, { type: "custom", name: "apply_patch", namespace: "coding" }],
    }
    const first = await request({ model: MODEL, stream, tools, input: [USER], tool_choice })
    const events = stream ? parseEvents(await first.text()) : []
    const reply = stream ? events.at(-1).response : await first.json()
    const calls = reply.output.filter(i => i.type === "custom_tool_call")
    assert.deepEqual(calls, [
      { id: "ctc_0", type: "custom_tool_call", call_id: "call_c0", name: "apply_patch", input: inputs[0], status: "completed" },
      { id: "ctc_1", type: "custom_tool_call", call_id: "call_c1", name: "apply_patch", namespace: "coding", input: inputs[1], status: "completed" },
    ])
    if (stream) {
      assert.deepEqual(events.filter(e => e.type === "response.output_item.added").map(e => e.item), [
        { id: "ctc_0", type: "custom_tool_call", call_id: "call_c0", name: "apply_patch", input: "", status: "in_progress" },
        { id: "ctc_1", type: "custom_tool_call", call_id: "call_c1", name: "apply_patch", namespace: "coding", input: "", status: "in_progress" },
      ])
      // Custom input is not streamed incrementally: argument deltas are dropped
      // and the complete input arrives once at `custom_tool_call_input.done`.
      assert.equal(events.filter(e => e.type === "response.custom_tool_call_input.delta" || e.type === "response.function_call_arguments.delta").length, 0)
      assert.deepEqual(events.filter(e => e.type === "response.custom_tool_call_input.done").map(e => [e.name, e.namespace, e.input]), [
        ["apply_patch", undefined, inputs[0]],
        ["apply_patch", "coding", inputs[1]],
      ])
      assert.deepEqual(events.filter(e => e.type === "response.output_item.done").map(e => e.item), calls)
    }
    const results = calls.map((call, i) => ({ type: "custom_tool_call_output", call_id: call.call_id, output: "done_" + i }))
    const second = await request({ model: MODEL, stream, tools, tool_choice: "none", input: [USER, ...reply.output, ...results] })
    const finalReply = stream ? parseEvents(await second.text()).at(-1).response : await second.json()
    assert.equal(finalReply.output.at(-1).content[0].text, "CUSTOM_OK_done_0|done_1")
    assert.equal(sent.length, 2)
  })
}

test("plain function tools and history pass through untranslated", () => {
  const body = { model: MODEL, input: [USER, CALL, { type: "function_call_output", call_id: CALL.call_id, output: "{}" }], tools: [STRICT_TOOL], tool_choice: "auto" }
  const out = validateResponsesRequest(body)
  assert.deepEqual(out.tools, [STRICT_TOOL])
  assert.equal(out.input, body.input, "no namespace/custom means history reference is untouched")
})

test("tool translation preserves custom and namespaced tool_choice, paired custom history and distinct namespace names", () => {
  const customTool = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } }
  const nsToolA = { ...STRICT_TOOL, description: "from-ns-a" }
  const nsToolB = { ...STRICT_TOOL, description: "from-ns-b" }
  const otherFn = { type: "function", name: "other_fn", parameters: { type: "object" } }

  // 1. tool_choice naming a declared custom or namespaced tool translates to its wire function name,
  //    never relaxing to "auto" or omitting required choices.
  const withCustomChoice = validateResponsesRequest({
    model: MODEL,
    input: "hi",
    tools: [{ type: "namespace", name: "ns_a", tools: [nsToolA] }, customTool],
    tool_choice: { type: "custom", name: "apply_patch" },
  })
  assert.deepEqual(withCustomChoice.tools, [{ ...nsToolA, name: "ns_a__verify_value" }, CUSTOM_PATCH_TOOL])
  assert.deepEqual(withCustomChoice.tool_choice, { type: "function", name: "apply_patch" })

  const withUnmatchedFnChoice = validateResponsesRequest({
    model: MODEL,
    input: "hi",
    tools: [STRICT_TOOL],
    tool_choice: { type: "function", name: "undeclared_or_dropped" },
  })
  assert.deepEqual(withUnmatchedFnChoice.tool_choice, { type: "function", name: "undeclared_or_dropped" })

  const withNamespacedFnChoice = validateResponsesRequest({
    model: MODEL,
    input: "hi",
    tools: [{ type: "namespace", name: "ns_a", tools: [nsToolA] }],
    tool_choice: { type: "function", name: STRICT_TOOL.name, namespace: "ns_a" },
  })
  assert.deepEqual(withNamespacedFnChoice.tool_choice, { type: "function", name: "ns_a__verify_value" })

  // 2. Custom tool with tool_choice:"required" retains both the translated tool and "required" choice.
  const customRequired = validateResponsesRequest({
    model: MODEL,
    input: "hi",
    tools: [customTool],
    tool_choice: "required",
  })
  assert.deepEqual(customRequired.tools, [CUSTOM_PATCH_TOOL])
  assert.equal(customRequired.tool_choice, "required")
  assert.deepEqual(customRequired.include, ["reasoning.encrypted_content"])

  // 3. Paired custom-tool history and replayed function_call namespace tags translate faithfully
  //    even when no custom/namespace tool is declared on the turn.
  const customCall = { id: "c1", type: "custom_tool_call", call_id: "cp1", name: "apply_patch", input: "x" }
  const customOut = { type: "custom_tool_call_output", call_id: "cp1", output: "ok" }
  const translatedCustomCall = { id: "c1", type: "function_call", call_id: "cp1", name: "apply_patch", arguments: '{"input":"x"}' }
  const translatedCustomOut = { type: "function_call_output", call_id: "cp1", output: "ok" }
  const namespacedCall = { ...CALL, namespace: "ns_a" }
  const fnOut = { type: "function_call_output", call_id: CALL.call_id, output: "{}" }
  const translatedHistoryWithFnTools = validateResponsesRequest({
    model: MODEL,
    input: [USER, customCall, customOut, namespacedCall, fnOut],
    tools: [STRICT_TOOL],
  })
  assert.deepEqual(translatedHistoryWithFnTools.input, [USER, translatedCustomCall, translatedCustomOut, { ...CALL, name: "ns_a__verify_value" }, fnOut])

  const translatedHistoryOmittedTools = validateResponsesRequest({
    model: MODEL,
    input: [USER, customCall, customOut],
  })
  assert.deepEqual(translatedHistoryOmittedTools.input, [USER, translatedCustomCall, translatedCustomOut])

  // 4. Functions sharing a bare name retain every distinct tool identity.
  const dedupedNs = validateResponsesRequest({
    model: MODEL,
    input: "hi",
    tools: [
      { type: "namespace", name: "ns_a", tools: [nsToolA, otherFn] },
      { type: "namespace", name: "ns_b", tools: [nsToolB] },
    ],
  })
  assert.deepEqual(dedupedNs.tools, [{ ...nsToolA, name: "ns_a__verify_value" }, { ...otherFn, name: "ns_a__other_fn" }, { ...nsToolB, name: "ns_b__verify_value" }])

  const dedupedWithTop = validateResponsesRequest({
    model: MODEL,
    input: "hi",
    tools: [
      { type: "namespace", name: "ns_a", tools: [nsToolA] },
      STRICT_TOOL,
    ],
  })
  assert.deepEqual(dedupedWithTop.tools, [{ ...nsToolA, name: "ns_a__verify_value" }, STRICT_TOOL])
})

for (const stream of [false, true]) {
  test(`namespaced tools restore distinct identities and execute a complete ${stream ? "SSE" : "JSON"} loop`, async () => {
    const tools = [
      { type: "namespace", name: "collaboration", tools: [{ ...STRICT_TOOL, name: "spawn_agent" }] },
      { type: "namespace", name: "other", tools: [{ ...STRICT_TOOL, name: "spawn_agent" }] },
      { ...STRICT_TOOL, name: "spawn_agent" },
    ]
    const before = structuredClone(tools)
    const { request, sent } = await fixture((_, init) => {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.tools.map(t => t.name), ["collaboration__spawn_agent", "other__spawn_agent", "spawn_agent"])
      if (body.tool_choice === "none") {
        assert.deepEqual(body.input.filter(i => i.type === "function_call").map(i => i.name), body.tools.map(t => t.name))
        assert.ok(body.input.every(i => !("namespace" in i) && !("encrypted_function_args" in i)))
        const answers = body.input.filter(i => i.type === "function_call_output").map(i => JSON.parse(i.output).answer)
        const response = finalWhole("AICORE_RESULTS_" + answers.join(","))
        return stream ? streamResponse([frame({ type: "response.completed", response })]) : jsonResponse(response)
      }
      assert.deepEqual(body.tool_choice, { type: "allowed_tools", mode: "required", tools: [
        { type: "function", name: "collaboration__spawn_agent" }, { type: "function", name: "other__spawn_agent" }, { type: "function", name: "spawn_agent" },
      ] })
      const calls = body.tools.map((t, i) => ({ ...CALL, name: t.name, id: "item_" + i, call_id: "call_" + i, arguments: JSON.stringify({ value: i + 1 }) }))
      const response = { ...FIRST_WHOLE, output: [REASON_1, ...calls] }
      if (!stream) return jsonResponse(response)
      const events = [frame({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })]
      for (const [output_index, item] of calls.entries()) {
        events.push(frame({ type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } }))
        events.push(frame({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments }))
        events.push(frame({ type: "response.function_call_arguments.done", item_id: item.id, output_index, name: item.name, arguments: item.arguments }))
        events.push(frame({ type: "response.output_item.done", output_index, item }))
      }
      events.push(frame({ type: "response.completed", response }))
      const bytes = new TextEncoder().encode(events.join(""))
      return streamResponse(Array.from({ length: Math.ceil(bytes.length / 17) }, (_, i) => bytes.slice(i * 17, (i + 1) * 17)))
    })
    const fields = { model: MODEL, stream, tools }
    const tool_choice = { type: "allowed_tools", mode: "required", tools: [
      { type: "function", name: "spawn_agent", namespace: "collaboration" }, { type: "function", name: "spawn_agent", namespace: "other" }, { type: "function", name: "spawn_agent" },
    ] }
    const first = await request({ ...fields, input: [USER], tool_choice })
    const events = stream ? parseEvents(await first.text()) : []
    const reply = stream ? events.at(-1).response : await first.json()
    const calls = reply.output.filter(i => i.type === "function_call")
    assert.deepEqual(calls.map(i => [i.namespace, i.name]), [["collaboration", "spawn_agent"], ["other", "spawn_agent"], [undefined, "spawn_agent"]])
    assert.deepEqual(calls.slice(0, 2).map(i => i.encrypted_function_args), [[], []])
    assert.equal("encrypted_function_args" in calls[2], false)
    if (stream) {
      assert.deepEqual(events.filter(e => e.type === "response.output_item.done").map(e => e.item), calls)
      assert.deepEqual(events.filter(e => e.type === "response.output_item.added").map(e => e.item.namespace), ["collaboration", "other", undefined])
      assert.deepEqual(events.filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta), calls.map(i => i.arguments))
      assert.deepEqual(events.filter(e => e.type === "response.function_call_arguments.done").map(e => [e.name, e.namespace, e.arguments]), calls.map(i => [i.name, i.namespace, i.arguments]))
    }
    const results = calls.map(call => ({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ answer: JSON.parse(call.arguments).value * 2 }) }))
    const final = await request({ ...fields, tool_choice: "none", input: [USER, ...reply.output, ...results] })
    const finalReply = stream ? parseEvents(await final.text()).at(-1).response : await final.json()
    assert.equal(finalReply.output.at(-1).content[0].text, "AICORE_RESULTS_2,4,6")
    assert.deepEqual(tools, before)
    assert.equal(sent.length, 2)
  })
}

test("SSE argument completion restores only matching calls and keeps stream state isolated", async () => {
  const alias = "ns__verify_value"
  const unrelated = { type: "response.function_call_arguments.done", item_id: "unrelated", output_index: 0, name: alias, arguments: CALL.arguments, future: { name: alias } }
  const { request } = await fixture((_, init) => {
    const body = JSON.parse(init.body)
    const events = []
    if (body.input === "with-call") {
      events.push({ type: "response.output_item.added", output_index: 0, item: { ...CALL, name: alias, arguments: "" } })
      events.push({ ...unrelated, item_id: CALL.id, name: "native_unmatched" })
      events.push({ ...unrelated, item_id: CALL.id })
    } else events.push({ ...unrelated, item_id: CALL.id })
    events.push(unrelated)
    events.push({ type: "response.completed", response: COMPLETED })
    return streamResponse(events.map(frame))
  })
  const fields = { model: MODEL, stream: true, tools: [{ type: "namespace", name: "ns", tools: [STRICT_TOOL] }] }
  const withCall = await request({ ...fields, input: "with-call" })
  const withoutCall = await request({ ...fields, input: "without-call" })
  // Consume the stream that learns the call first. Its IDs must not affect the other reply.
  const events = parseEvents(await withCall.text())
  const completions = events.filter(e => e.type === "response.function_call_arguments.done")
  assert.deepEqual(completions, [{ ...unrelated, item_id: CALL.id, name: "native_unmatched" }, { ...unrelated, item_id: CALL.id, name: CALL.name, namespace: "ns" }, unrelated])
  assert.deepEqual(parseEvents(await withoutCall.text()).filter(e => e.type === "response.function_call_arguments.done"), [{ ...unrelated, item_id: CALL.id }, unrelated])
})

test("identical repeated namespaced declarations emit one tool without deduplicating native tools", async () => {
  const reordered = { parameters: structuredClone(STRICT_TOOL.parameters), name: STRICT_TOOL.name, strict: true, type: "function" }
  const namespace = { type: "namespace", name: "ns", tools: [STRICT_TOOL, reordered] }
  const tools = [namespace, structuredClone(namespace), { type: "namespace", name: "other", tools: [STRICT_TOOL] }, STRICT_TOOL, STRICT_TOOL]
  const snapshot = structuredClone(tools)
  const { request, sent } = await fixture((_, init) => {
    const body = JSON.parse(init.body)
    assert.deepEqual(body.tools, [{ ...STRICT_TOOL, name: "ns__verify_value" }, { ...STRICT_TOOL, name: "other__verify_value" }, STRICT_TOOL, STRICT_TOOL])
    return jsonResponse({ ...FIRST_WHOLE, output: [{ ...CALL, name: "ns__verify_value" }] })
  })
  const reply = await (await request({ model: MODEL, tools, input: [USER] })).json()
  assert.equal(reply.output[0].namespace, "ns")
  assert.deepEqual(tools, snapshot)
  assert.equal(sent.length, 1)
})

test("conflicting namespaced definitions and malformed namespaces reject before SAP dispatch", async () => {
  const { request, sent } = await fixture()
  const namespace = { type: "namespace", name: "ns", tools: [STRICT_TOOL] }
  const malformed = [
    ...[undefined, null, false, 42, {}, [], ""].map(name => [{ ...namespace, name }, STRICT_TOOL]),
    [{ ...namespace, tools: null }], [{ ...namespace, tools: {} }],
    [{ ...namespace, tools: [{ ...STRICT_TOOL, name: undefined }] }],
    [{ ...namespace, tools: [{ ...STRICT_TOOL, name: 42 }] }],
    [{ ...namespace, tools: [STRICT_TOOL, { ...STRICT_TOOL, strict: false }] }],
    [namespace, { ...namespace, tools: [{ ...STRICT_TOOL, description: "conflicting" }] }],
  ]
  for (const tools of malformed) {
    const response = await request({ model: MODEL, input: [USER], tools })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, "invalid-request")
  }
  assert.equal(sent.length, 0)
})

test("qualified-name collisions and long names get bounded reversible aliases", async () => {
  const declarations = [
    { type: "namespace", name: "collaboration", tools: [{ ...STRICT_TOOL, name: "spawn_agent" }] },
    { ...STRICT_TOOL, name: "collaboration__spawn_agent" },
    { type: "namespace", name: "a__b", tools: [{ ...STRICT_TOOL, name: "c" }] },
    { type: "namespace", name: "a", tools: [{ ...STRICT_TOOL, name: "b__c" }] },
    { type: "namespace", name: "long".repeat(20), tools: [STRICT_TOOL] },
  ]
  const snapshot = structuredClone(declarations)
  const { request, sent } = await fixture((_, init) => {
    const body = JSON.parse(init.body)
    const names = body.tools.map(t => t.name)
    assert.equal(new Set(names).size, names.length)
    assert.ok(names.every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)))
    assert.equal(names[1], "collaboration__spawn_agent")
    assert.ok(names.filter((_, i) => i !== 1).every(name => name.startsWith("mp_ns_")))
    return jsonResponse({ ...FIRST_WHOLE, output: names.map((name, i) => ({ ...CALL, name, id: "id_" + i, call_id: "call_" + i })) })
  })
  const reply = await (await request({ model: MODEL, input: [USER], tools: declarations })).json()
  assert.deepEqual(reply.output.map(i => [i.namespace, i.name]), [["collaboration", "spawn_agent"], [undefined, "collaboration__spawn_agent"], ["a__b", "c"], ["a", "b__c"], ["long".repeat(20), "verify_value"]])
  const reordered = validateResponsesRequest({ model: MODEL, tools: [...declarations].reverse() })
  assert.deepEqual(reordered.tools.map(t => t.name).reverse(), sent[0].body.tools.map(t => t.name))
  assert.deepEqual(declarations, snapshot)
  const hashedName = sent[0].body.tools[0].name
  assert.throws(() => validateResponsesRequest({ model: MODEL, tools: [declarations[0], declarations[1], { ...STRICT_TOOL, name: hashedName }] }), { code: "invalid-request" })
})

for (const stream of [false, true]) for (const status of ["incomplete", "failed"]) {
  test(`namespace restoration preserves ${status} ${stream ? "SSE" : "JSON"} output and redaction`, async () => {
    const call = { ...CALL, name: "ns__verify_value", encrypted_function_args: ["opaque-marker"] }
    const response = { ...FIRST_WHOLE, status, output: [REASON_1, call], error: status === "failed" ? { code: "server_error", message: "failure " + TOKEN } : null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null }
    const { request } = await fixture(() => stream ? streamResponse([frame({ type: "response." + status, response })]) : jsonResponse(response))
    const result = await request({ model: MODEL, stream, input: [USER], tools: [{ type: "namespace", name: "ns", tools: [STRICT_TOOL] }] })
    const text = await result.text()
    const reply = stream ? parseEvents(text).at(-1).response : JSON.parse(text)
    assert.deepEqual(reply.output, [REASON_1, { ...call, name: CALL.name, namespace: "ns" }])
    assert.deepEqual(reply.usage, response.usage)
    assert.equal(reply.status, status)
    assert.deepEqual(reply.incomplete_details, response.incomplete_details)
    assert.ok(!text.includes(TOKEN))
  })
}

test("history-only namespaces restore calls and only empty plaintext markers are removed on replay", async () => {
  const input = [USER, { ...CALL, namespace: "ns", encrypted_function_args: [] }, { ...CALL, namespace: "other", encrypted_function_args: ["opaque"] }]
  const snapshot = structuredClone(input)
  const { request, sent } = await fixture((_, init) => {
    const body = JSON.parse(init.body)
    assert.deepEqual(body.input, [USER, { ...CALL, name: "ns__verify_value" }, { ...CALL, name: "other__verify_value", encrypted_function_args: ["opaque"] }])
    return jsonResponse({ ...FIRST_WHOLE, output: [{ ...CALL, name: "ns__verify_value" }] })
  })
  const reply = await (await request({ model: MODEL, input })).json()
  assert.deepEqual(reply.output, [{ ...CALL, namespace: "ns", encrypted_function_args: [] }])
  assert.deepEqual(input, snapshot)
  assert.equal("tools" in sent[0].body, false)
})

test("native tool-choice restrictions and malformed shapes reach SAP validation unchanged", async () => {
  const tools = [{ ...STRICT_TOOL, name: "read" }, { ...STRICT_TOOL, name: "write" }]
  const choices = [
    ...["auto", "required"].map(mode => ({ type: "allowed_tools", mode, tools: [{ type: "function", name: "read" }], future: { keep: true } })),
    { type: "function", name: "missing" }, { type: "future", options: ["read"] }, { type: "allowed_tools", mode: "invalid", tools: "invalid" },
  ]
  let index = 0
  const { request, sent } = await fixture((_, init) => {
    const body = JSON.parse(init.body)
    assert.deepEqual(body.tool_choice, choices[index++])
    return index <= 2 ? jsonResponse({ ...FIRST_WHOLE, output: [{ ...CALL, name: "read" }] }) : nativeError(400, "invalid_tool_choice", TOKEN)
  })
  for (const [i, tool_choice] of choices.entries()) {
    const response = await request({ model: MODEL, input: [USER], tools, tool_choice })
    assert.equal(response.status, i < 2 ? 200 : 400)
    const reply = await response.json()
    if (i < 2) assert.equal(reply.output[0].name, "read")
    else assert.equal(reply.error.code, "invalid_tool_choice")
    assert.equal(validateResponsesRequest({ model: MODEL, tools, tool_choice }).tool_choice, tool_choice)
  }
  assert.equal(sent.length, choices.length)
})

test("choices targeting translated tools are adapted and explicit required/forced choices are never relaxed", async () => {
  const custom = { type: "custom", name: "apply_patch" }
  const native = { ...STRICT_TOOL, name: "read" }
  const tools = [native, { type: "namespace", name: "ns", tools: [STRICT_TOOL, custom] }, custom]
  const unchanged = { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read" }] }
  assert.equal(validateResponsesRequest({ model: MODEL, tools, tool_choice: unchanged }).tool_choice, unchanged)
  for (const mode of ["required", "auto"]) {
    const choice = { type: "allowed_tools", mode, future: true, tools: [{ type: "custom", name: "apply_patch" }, { type: "function", namespace: "ns", name: CALL.name, future: true }, { type: "function", name: "read" }, { type: "custom", namespace: "ns", name: "apply_patch" }] }
    const before = structuredClone(choice)
    assert.deepEqual(validateResponsesRequest({ model: MODEL, tools, tool_choice: choice }).tool_choice, {
      ...choice,
      tools: [
        { type: "function", name: "apply_patch" },
        { type: "function", name: "ns__verify_value", future: true },
        { type: "function", name: "read" },
        { type: "function", name: "ns__apply_patch" },
      ],
    })
    assert.deepEqual(choice, before)
  }
  const forcedCustomAllowed = { type: "allowed_tools", mode: "required", tools: [{ type: "custom", name: "apply_patch" }] }
  assert.deepEqual(validateResponsesRequest({ model: MODEL, tools, tool_choice: forcedCustomAllowed }).tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "apply_patch" }],
  })
  assert.deepEqual(validateResponsesRequest({ model: MODEL, tools: [custom], tool_choice: forcedCustomAllowed }).tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "apply_patch" }],
  })
  assert.deepEqual(validateResponsesRequest({ model: MODEL, tools: [custom], tool_choice: { type: "custom", name: "apply_patch" } }).tool_choice, {
    type: "function",
    name: "apply_patch",
  })
  assert.equal(validateResponsesRequest({ model: MODEL, tools: [custom], tool_choice: "required" }).tool_choice, "required")
  for (const tool_choice of ["none", "auto", { type: "future" }, { type: "function", name: "missing" }, { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "missing" }] }]) {
    assert.equal(validateResponsesRequest({ model: MODEL, tools: [custom], tool_choice }).tool_choice, tool_choice)
  }
  assert.deepEqual(validateResponsesRequest({ model: MODEL, tools, tool_choice: { type: "function", name: CALL.name, namespace: "ns", future: true } }).tool_choice, { type: "function", name: "ns__verify_value", future: true })

  // Unsupported hosted tools, invalid custom declarations, unpaired/malformed custom history,
  // and undeclared or toolless forced/required choices reject with local 400 before dispatch.
  const { request, sent } = await fixture()
  const validCall = { id: "c1", type: "custom_tool_call", call_id: "cp1", name: "apply_patch", input: "patch" }
  const validOut = { type: "custom_tool_call_output", call_id: "cp1", output: "ok" }
  const rejected = [
    { tools: [{ type: "web_search" }] },
    { tools: [STRICT_TOOL, { type: "web_search_preview" }] },
    { tools: [{ type: "file_search" }] },
    { tools: [{ type: "code_interpreter" }] },
    { tools: [{ type: "computer_use_preview" }] },
    { tools: [{ type: "mcp", server_label: "srv" }] },
    { tools: [{ type: "namespace", name: "ns", tools: [{ type: "web_search" }] }] },
    { tools: [{ type: "namespace", name: "empty", tools: [] }] },
    { tools: [{ type: "custom", name: "" }] },
    { tools: [{ type: "custom", name: STRICT_TOOL.name }, STRICT_TOOL] },
    { tools: [custom, { type: "custom", name: "apply_patch", format: { type: "text" } }] },
    { tools: [], tool_choice: "required" },
    { tool_choice: "required" },
    { tools: [], tool_choice: { type: "function", name: "read" } },
    { tools, tool_choice: { type: "web_search" } },
    { tools, tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }] } },
    { tools, tool_choice: { type: "allowed_tools", mode: "required", tools: [] } },
    { tools, tool_choice: { type: "custom", name: "apply_patch", namespace: "unknown" } },
    { tools: [native], tool_choice: { type: "custom", name: "apply_patch" } },
    { tools, tool_choice: { type: "function", name: "apply_patch" } },
    { tools, tool_choice: { type: "function", name: "verify_value", namespace: "unknown" } },
    { input: [USER, validCall] },
    { input: [USER, validOut] },
    { input: [USER, validOut, validCall] },
    { input: [USER, { ...validCall, input: 123 }, validOut] },
    { input: [USER, validCall, { type: "function_call_output", call_id: "cp1", output: "ok" }] },
    { input: [USER, { type: "web_search_call", id: "ws_1", status: "completed" }] },
  ]
  for (const extra of rejected) {
    const response = await request({ model: MODEL, input: [USER], ...extra })
    assert.equal(response.status, 400, JSON.stringify(extra))
    assert.equal((await response.json()).error.code, "invalid-request")
  }
  assert.equal(sent.length, 0)

  // Custom validation checks only the fields the translation reads: unknown
  // definition/format fields and unknown history fields are tolerated, so new
  // Codex fields do not become local 400s. Unknown history fields pass through.
  const tolerated = [
    { tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "unknown", definition: "x" } }] },
    { tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "" } }] },
    { tools: [{ type: "custom", name: "apply_patch", format: { type: "text", syntax: "lark" } }] },
    { tools: [{ type: "custom", name: "apply_patch", unknown: true }] },
    { input: [USER, { ...validCall, unknown: true }, validOut] },
    { input: [USER, validCall, { ...validOut, output: 123 }] },
  ]
  for (const extra of tolerated) {
    assert.doesNotThrow(() => validateResponsesRequest({ model: MODEL, input: [USER], ...extra }), JSON.stringify(extra))
  }
  const passthrough = validateResponsesRequest({ model: MODEL, input: [USER, { ...validCall, extra_meta: { t: 1 } }, validOut] })
  assert.deepEqual(passthrough.input[1].extra_meta, { t: 1 })
  assert.equal(passthrough.input[1].type, "function_call")
})

test("a streamed forced function call and result round trip to an agent-derived final reply", async () => {
  const { request, sent } = await fixture(streamToolUpstream)
  const r1 = await request({ model: MODEL, input: [USER], tools: [STRICT_TOOL], tool_choice: FORCE, stream: true })
  assert.equal(r1.headers.get("content-type"), "text/event-stream")
  const events1 = parseEvents(await r1.text())
  assert.deepEqual(events1.filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta), ARG_DELTAS, "argument deltas arrive before the terminal")
  assert.equal(events1.at(-1).type, "response.completed")
  const call = events1.at(-1).response.output.find(i => i.type === "function_call")
  assert.notEqual(call.id, call.call_id)
  assert.equal(call.arguments, '{"value":7}')
  assert.deepEqual(sent[0].body.include, ["reasoning.encrypted_content"])
  const continuation = { ...continueTurn(call), stream: true }
  const events2 = parseEvents(await (await request(continuation)).text())
  assert.equal(events2.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join(""), "AICORE_RESULT_14")
  assert.equal(events2.at(-1).response.output.at(-1).content[0].text, "AICORE_RESULT_14")
  assert.deepEqual(sent[1].body.input, continuation.input)
  assert.equal(sent[1].body.tool_choice, "none")
  assert.equal(sent.length, 2)
})

test("Pi-style high reasoning and cache affinity support streamed stateless tool turns", async () => {
  const { request } = await fixture(streamToolUpstream)
  const fields = { reasoning: { effort: "high", summary: "auto" }, prompt_cache_key: "pi-session-1", stream: true }
  const firstResponse = await request({ model: MODEL, input: [USER], tools: [STRICT_TOOL], tool_choice: FORCE, ...fields })
  assert.equal(firstResponse.status, 200)
  const first = parseEvents(await firstResponse.text()).at(-1).response
  const call = first.output.find(item => item.type === "function_call")
  assert.equal(call.arguments, '{"value":7}')
  const finalResponse = await request({ ...continueTurn(call), ...fields })
  assert.equal(finalResponse.status, 200)
  const final = parseEvents(await finalResponse.text()).at(-1).response
  assert.equal(final.status, "completed")
  assert.equal(final.output.at(-1).content[0].text, "AICORE_RESULT_14")
})

test("continuation rejections surface once without stripping history or leaking secrets", async () => {
  const { request, sent } = await fixture(wholeToolUpstream)
  // Wrong call_id: the native upstream rejects; the plugin surfaces it once and
  // never strips the history nor replays the request.
  const wrong = continueTurn(CALL)
  wrong.input = wrong.input.map(i => i.type === "function_call_output" ? { ...i, call_id: "call_WRONG" } : i)
  const r1 = await request(wrong)
  assert.equal(r1.status, 400)
  assert.equal((await r1.json()).error.code, "invalid_value")
  assert.deepEqual(sent.at(-1).body.input, wrong.input, "history is not stripped")
  assert.equal(sent.length, 1)
  // Invalid encrypted reasoning: rejected once, never stripped or retried.
  const sealed = continueTurn(CALL)
  sealed.input = sealed.input.map(i => i.type === "reasoning" ? { ...i, encrypted_content: "sealed-bad" } : i)
  const r2 = await request(sealed)
  assert.equal(r2.status, 400)
  const body2 = await r2.json()
  assert.equal(body2.error.code, "invalid_encrypted_content")
  assert.equal(sent.at(-1).body.input.find(i => i.type === "reasoning").encrypted_content, "sealed-bad")
  assert.equal(sent.length, 2, "each rejection is exactly one dispatch")
  for (const secret of [TOKEN, CREDS.clientSecret]) assert.ok(!JSON.stringify(body2).includes(secret), secret)
})

test("omitted include defaults to encrypted reasoning while an explicit empty include keeps it absent", async () => {
  const includeAware = (input, init) => {
    const body = JSON.parse(init.body)
    const wants = Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content")
    const reasoning = wants ? { id: "rs_x", type: "reasoning", summary: [], encrypted_content: "sealed-x" } : { id: "rs_x", type: "reasoning", summary: [] }
    return jsonResponse({ ...COMPLETED, output: [reasoning, COMPLETED.output[1]] })
  }
  const { request, sent } = await fixture(includeAware)
  // Omitted include + function tools -> default requests encrypted reasoning.
  const out1 = (await (await request({ model: MODEL, input: "hi", tools: [STRICT_TOOL] })).json()).output.find(i => i.type === "reasoning")
  assert.equal(out1.encrypted_content, "sealed-x")
  assert.deepEqual(sent[0].body.include, ["reasoning.encrypted_content"])
  // Explicit [] is preserved verbatim; the consumer observes no encrypted reasoning.
  const out2 = (await (await request({ model: MODEL, input: "hi", tools: [STRICT_TOOL], include: [] })).json()).output.find(i => i.type === "reasoning")
  assert.equal("encrypted_content" in out2, false)
  assert.deepEqual(sent[1].body.include, [])
  assert.equal(sent.length, 2)
})

test("stateless and stream framing guards reject unsafe requests before dispatch", async () => {
  const { request, sent } = await fixture()
  const cases = [
    { store: true }, { store: null }, { store: 0 }, { store: "false" },
    { background: true }, { background: null }, { background: 0 }, { background: "false" },
    { previous_response_id: null }, { previous_response_id: "resp_old" },
    { conversation: null }, { conversation: "conv_1" }, { conversation: {} },
    { stream: "true" }, { stream: null }, { stream: 0 }, { stream: {} },
    { model: null }, { model: "" }, { model: 7 }, { model: [] },
  ]
  for (const extra of cases) {
    const response = await request({ model: MODEL, input: "hello", ...extra })
    assert.equal(response.status, 400, JSON.stringify(extra))
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
    assert.equal((await response.json()).error.code, "invalid-request")
  }
  const missingModel = await request({ input: "hello" })
  assert.equal(missingModel.status, 400)
  assert.equal((await missingModel.json()).error.code, "invalid-request")
  assert.equal(sent.length, 0)

  const allowed = await request({ model: MODEL, input: "hello", store: false, background: false, stream: false })
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), COMPLETED)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.store, false)
  assert.equal(sent[0].body.background, false)
  assert.equal(sent[0].body.stream, false)
})

test("SAP owns generation validation and receives client metadata, text and future fields unchanged", async () => {
  const body = {
    model: MODEL,
    input: [USER, { type: "item_reference", id: "item_ref_1" }],
    prompt: { id: "pmpt_123", version: "1" },
    client_metadata: { session_id: "session-42", flags: [false, null, { channel: "agent" }] },
    text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }, verbosity: "low" },
    future_generation_field: { nested: [{ enabled: false, limit: 0 }, null, "opaque"] },
    reasoning: { effort: "none", summary: "detailed" },
    max_output_tokens: "backend-owned",
    include: ["message.output_text.logprobs"],
  }
  const { request, sent } = await fixture((_, init) => {
    let intact = true
    try { assert.deepEqual(JSON.parse(init.body), { ...body, store: false }) } catch { intact = false }
    return new Response(JSON.stringify({ error: intact
      ? { code: "unsupported_reasoning_summary", type: "invalid_request_error", param: "reasoning.summary", message: "Unsupported summary " + TOKEN + " " + CREDS.clientId + " " + CREDS.clientSecret + " sdk-secret" }
      : { code: "forwarded_payload_changed", type: "transport_error", param: "request", message: "A generation value was dropped or changed" },
    }), { status: intact ? 422 : 409, headers: { "content-type": "application/json" } })
  })
  const response = await request(body, { headers: { authorization: "Bearer sdk-secret" } })
  assert.equal(response.status, 422)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  const raw = await response.text()
  const error = JSON.parse(raw).error
  assert.equal(error.code, "unsupported_reasoning_summary")
  assert.equal(error.type, "invalid_request_error")
  assert.equal(error.param, "reasoning.summary")
  for (const secret of [TOKEN, CREDS.clientId, CREDS.clientSecret, "sdk-secret"]) assert.ok(!raw.includes(secret), secret)
  assert.equal(sent.length, 1, "a backend validation error must not trigger a stripped or modified replay")
})


test("upstream 429 and temporary failures preserve native code, seconds and redacted details without replay", async () => {
  let status = 429
  let reason = "quota_exceeded"
  const { request, sent } = await fixture(() => new Response(JSON.stringify({ error: { code: reason, type: "upstream_error", param: "input", message: "Failure " + TOKEN + " " + CREDS.clientId + " " + CREDS.clientSecret + " sdk-secret" } }), { status, headers: { "retry-after": "17", "x-magpie-sign-in": "expired", "x-api-key": TOKEN, location: "https://example.invalid/" } }))
  for (const [code, category] of [[429, "quota_exceeded"], [429, "backend_capacity"], [503, "temporarily_unavailable"]]) {
    status = code
    reason = category
    const response = await request(undefined, { headers: { authorization: "Bearer sdk-secret" } })
    assert.equal(response.status, code)
    assert.equal(response.headers.get("retry-after"), "17")
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
    assert.equal(response.headers.get("x-api-key"), null)
    assert.equal(response.headers.get("location"), null)
    const text = await response.text()
    const body = JSON.parse(text)
    assert.equal(body.error.code, category)
    assert.equal(body.error.param, "input")
    for (const secret of [TOKEN, CREDS.clientId, CREDS.clientSecret, "sdk-secret"]) assert.ok(!text.includes(secret), secret)
  }
  assert.equal(sent.length, 3)
})

test("verified Bearer rejection keeps sign-in and preserves failure; a later operation reacquires without replay", async () => {
  let refused = true
  const { request, sent, state } = await fixture(() => refused
    ? new Response(JSON.stringify({ error: { code: "invalid_token", message: "Rejected " + TOKEN } }), { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"', "x-magpie-sign-in": "expired" } })
    : new Response(JSON.stringify(COMPLETED)))
  const first = await request()
  assert.equal(first.status, 401)
  assert.equal(first.headers.get("x-magpie-sign-in"), "kept")
  assert.equal((await first.json()).error.code, "invalid_token")
  assert.equal(sent.length, 1)
  let acquired = 0
  state.oauth = () => { acquired++; return new Response(JSON.stringify({ access_token: "replacement-token", expires_in: 3600 })) }
  refused = false
  const next = await request()
  assert.equal(next.status, 200)
  assert.equal(acquired, 1)
  assert.equal(new Headers(sent[1].init.headers).get("authorization"), "Bearer replacement-token")
  assert.equal(sent.length, 2, "a second independent operation is not a replay")
})

test("malformed successful replies cannot masquerade as completed native Responses", async () => {
  let payload = null
  const { request } = await fixture(() => new Response(JSON.stringify(payload)))
  for (const invalid of [null, [], { object: "chat.completion", choices: [] }, { id: "resp_a", object: "response", status: "in_progress", output: [] }, { id: "resp_a", object: "response", status: "completed", output: {} }]) {
    payload = invalid
    const response = await request()
    assert.equal(response.status, 502, JSON.stringify(invalid))
    assert.equal((await response.json()).error.code, "inference-response")
  }
})

test("cancellation aborts a pending inference and cancels a partially read whole reply", async () => {
  let started
  let resolveFetch
  let upstreamSignal
  const gate = new Promise(resolve => { started = resolve })
  const { request, sent } = await fixture((_, init) => {
    upstreamSignal = init.signal
    started()
    return new Promise(resolve => { resolveFetch = resolve })
  })
  const controller = new AbortController()
  const pending = request(undefined, { signal: controller.signal })
  await gate
  controller.abort(new Error("sentinel-abort-secret"))
  const cancelled = await pending
  assert.equal(cancelled.status, 499)
  assert.equal(upstreamSignal.aborted, true)
  assert.ok(!(await cancelled.text()).includes("sentinel-abort-secret"))
  let bodyCancelled = false
  resolveFetch(new Response(new ReadableStream({ cancel() { bodyCancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bodyCancelled, true)
  assert.equal(sent.length, 1)
})

test("the request deadline bounds an inference fetch that ignores its AbortSignal", async () => {
  let upstreamSignal
  const { request } = await fixture((_, init) => { upstreamSignal = init.signal; return new Promise(() => {}) })
  const original = globalThis.setTimeout
  cleanups.push(() => { globalThis.setTimeout = original })
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 120000 ? 20 : ms, ...args)
  const response = await request()
  assert.equal(response.status, 504)
  assert.equal((await response.json()).error.code, "inference-timeout")
  assert.equal(upstreamSignal.aborted, true)
})

test("first request after system sleep renews a wall-expired token before discovery", async () => {
  const monotonic = performance.now
  const wall = Date.now
  cleanups.push(() => { performance.now = monotonic; Date.now = wall })
  let elapsed = 0
  let epoch = 1793600000000
  performance.now = () => elapsed
  Date.now = () => epoch
  const { request, state, sent } = await fixture()
  state.oauth = () => {
    state.token = "wake-token"
    return new Response(JSON.stringify({ access_token: state.token, expires_in: 3600 }))
  }
  state.discovery = (input, init) => {
    if (new Headers(init.headers).get("authorization") !== "Bearer wake-token") {
      return new Response("expired token", { status: 401 })
    }
    const firstPage = new URL(String(input)).searchParams.get("$skip") === "0"
    return jsonResponse({ resources: firstPage ? [{ id: "deployment-a", status: "RUNNING", deploymentUrl: DEPLOYMENT, configurationId: "configuration-a", details: { resources: { backendDetails: { model: { name: MODEL, version: VERSION } } } } }] : [] })
  }
  elapsed = 300001
  epoch += 16 * 60 * 60 * 1000
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).output[1].content[0].text, "AICORE_OK")
  assert.equal(new Headers(sent[0].init.headers).get("authorization"), "Bearer wake-token")
})

test("first request after system sleep rejects a deployment that is no longer running", async () => {
  const monotonic = performance.now
  const wall = Date.now
  cleanups.push(() => { performance.now = monotonic; Date.now = wall })
  performance.now = () => 0
  let epoch = 1793600000000
  Date.now = () => epoch
  const { request, state, sent } = await fixture()
  state.discovery = () => jsonResponse({ resources: [] })
  epoch += 16 * 60 * 60 * 1000
  const response = await request()
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "unavailable-model")
  assert.equal(sent.length, 0)
})

test("dispatch discovery 401 keeps sign-in; only verified OAuth credential refusal expires it", async () => {
  const clock = performance.now
  cleanups.push(() => { performance.now = clock })
  let now = 0
  performance.now = () => now
  const { request, state, sent } = await fixture()
  now = 300001
  state.discovery = () => new Response(JSON.stringify({ error: { message: "unauthorized " + TOKEN } }), { status: 401 })
  const discovery = await request()
  assert.equal(discovery.status, 401)
  assert.equal(discovery.headers.get("x-magpie-sign-in"), "kept")
  assert.equal((await discovery.json()).error.code, "discovery-response")
  now = 3600001
  state.oauth = () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "www-authenticate": "Basic realm=OAuth" } })
  const refused = await request()
  assert.equal(refused.status, 401)
  assert.equal(refused.headers.get("x-magpie-sign-in"), "expired")
  assert.equal((await refused.json()).error.code, "oauth-refused")
  assert.equal(sent.length, 0)
})

test("OAuth quota and temporary failures preserve their status and Retry-After without lapsing sign-in", async () => {
  const clock = performance.now
  cleanups.push(() => { performance.now = clock })
  let now = 0
  performance.now = () => now
  const { request, state, sent } = await fixture()
  now = 3600001
  for (const status of [429, 503, 401]) {
    state.oauth = () => new Response("non-JSON intermediary failure " + CREDS.clientSecret, { status, headers: { "retry-after": "19" } })
    const response = await request()
    assert.equal(response.status, status)
    assert.equal(response.headers.get("retry-after"), "19")
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
    assert.ok(!(await response.text()).includes(CREDS.clientSecret))
  }
  assert.equal(sent.length, 0)
})

test("Request bodies work without init overrides and unsafe routes disclose no credentials", async () => {
  const { loader, sent } = await fixture()
  const body = { model: MODEL, input: "hello" }
  const response = await loader.fetch(new Request(ROOT + "/responses", { method: "POST", body: JSON.stringify(body) }), { body: undefined })
  assert.equal(response.status, 200)
  assert.deepEqual(sent[0].body, { ...body, store: false })
  const original = globalThis.fetch
  let disclosed = false
  globalThis.fetch = async () => { disclosed = true; throw new Error("unreachable") }
  for (const [url, method] of [[ROOT + "/responses", "GET"], [ROOT + "/responses/resp_a", "GET"], [ROOT + "/responses/resp_a", "DELETE"], [ROOT + "/responses/resp_a/cancel", "POST"], [ROOT + "/responses/compact", "POST"], [ROOT + "/chat/completions", "POST"], [ROOT + "/responses?api-version=x", "POST"], ["https://example.invalid/responses", "POST"]]) {
    const failure = await loader.fetch(url, { method, body: JSON.stringify(body) })
    assert.equal(failure.status, 400)
  }
  globalThis.fetch = original
  assert.equal(disclosed, false)
})

test("unknown and unavailable models stay distinct and an unsafe discovered deployment never receives credentials", async () => {
  const clock = performance.now
  cleanups.push(() => { performance.now = clock })
  let now = 0
  performance.now = () => now
  const { request, sent, state } = await fixture()
  for (const model of ["gpt-unknown", "gpt-5.9-mini"]) {
    const unknown = await request({ model, input: "hello" })
    assert.equal((await unknown.json()).error.code, "unknown-model")
  }
  for (const model of ["gpt-6-mini", "gpt-7", "gpt-10.1-mini"]) {
    const missing = await request({ model, input: "hello" })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, "unavailable-model")
  }
  state.deployment = "https://api.ai.other.hana.ondemand.com/v2/inference/deployments/deployment-a"
  now = 300001
  const unavailable = await request()
  assert.equal((await unavailable.json()).error.code, "unavailable-model")
  assert.equal(sent.length, 0)
})

test("unsafe redirects are not followed and malformed failed bodies preserve useful HTTP status", async () => {
  let mode = "redirect"
  const { request, sent } = await fixture(() => {
    if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://example.invalid/" } })
    if (mode === "wrong-url") {
      const response = new Response(JSON.stringify(COMPLETED))
      Object.defineProperty(response, "url", { value: "https://example.invalid/responses" })
      return response
    }
    return new Response("malformed " + TOKEN, { status: 503, headers: { "retry-after": "23" } })
  })
  for (mode of ["redirect", "wrong-url"]) {
    const response = await request()
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, "inference-redirect")
  }
  mode = "malformed"
  const failed = await request()
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get("retry-after"), "23")
  assert.ok(!(await failed.text()).includes(TOKEN))
  assert.equal(sent.length, 3)
})

test("whole-body cancellation closes the upstream reader before it can finish delivering", async () => {
  let entered
  let cancelled = false
  const reading = new Promise(resolve => { entered = resolve })
  const { request } = await fixture(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"resp_a"')); entered() },
    cancel() { cancelled = true },
  })))
  const controller = new AbortController()
  const pending = request(undefined, { signal: controller.signal })
  await reading
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal((await pending).status, 499)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
})

test("native incomplete and failed statuses retain details and JSON-safe credential redaction", async () => {
  let status = "incomplete"
  const escapedSecret = 'credential-"quoted"-\\backslash'
  const { request } = await fixture(() => new Response(JSON.stringify({ ...COMPLETED, status, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null, error: status === "failed" ? { code: "backend_failure", message: TOKEN + " " + escapedSecret } : null })))
  const incomplete = await request()
  const first = await incomplete.json()
  assert.equal(first.status, "incomplete")
  assert.deepEqual(first.incomplete_details, { reason: "max_output_tokens" })
  assert.deepEqual(first.output, COMPLETED.output)
  status = "failed"
  const failed = await request(undefined, { headers: { "api-key": escapedSecret } })
  const last = await failed.json()
  assert.equal(failed.status, 200)
  assert.equal(last.status, "failed")
  assert.equal(last.error.code, "backend_failure")
  assert.ok(!last.error.message.includes(TOKEN))
  assert.ok(!last.error.message.includes(escapedSecret))
  assert.deepEqual(last.usage, COMPLETED.usage)
})

test("malformed and oversized request bodies fail before generation and cancel unread input", async () => {
  const { loader, sent } = await fixture()
  for (const body of ["{", "null", "[]", new Uint8Array([0xff])]) {
    const response = await loader.fetch(ROOT + "/responses", { method: "POST", body })
    assert.equal(response.status, 400)
  }
  for (const body of [new Uint8Array(16 * 1024 * 1024 + 1), "x".repeat(16 * 1024 * 1024 + 1), "é".repeat(8 * 1024 * 1024 + 1)]) {
    const oversized = await loader.fetch(ROOT + "/responses", { method: "POST", body })
    assert.equal(oversized.status, 413)
  }
  let cancelled = false
  const input = new ReadableStream({ cancel() { cancelled = true } })
  const controller = new AbortController()
  const pending = loader.fetch(ROOT + "/responses", { method: "POST", body: input, signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal((await pending).status, 499)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  assert.equal(sent.length, 0)
})

test("an unverified 401 does not discard valid Bearer credentials or expire sign-in", async () => {
  const { request, sent, state } = await fixture(() => new Response(JSON.stringify({ error: { code: "upstream_unauthorized", message: "not an OAuth refusal" } }), { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token_unverified"' } }))
  const first = await request()
  assert.equal(first.headers.get("x-magpie-sign-in"), "kept")
  let renewals = 0
  state.oauth = () => { renewals++; return new Response(JSON.stringify({ access_token: "replacement", expires_in: 3600 })) }
  await request()
  assert.equal(renewals, 0)
  assert.equal(new Headers(sent[1].init.headers).get("authorization"), "Bearer " + TOKEN)
})

test("rejected encrypted reasoning remains actionable and is never stripped or replayed by the plugin", async () => {
  const { request, sent } = await fixture(() => new Response(JSON.stringify({ error: { code: "invalid_encrypted_content", message: "Encrypted reasoning could not be decrypted", param: "input" } }), { status: 400 }))
  const input = [...COMPLETED.output, { role: "user", content: "continue" }]
  const response = await request({ model: MODEL, input })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_encrypted_content")
  assert.deepEqual(sent[0].body.input, input)
  assert.equal(sent.length, 1)
})

test("a rejected Bearer is discarded before a stalled error body is cancelled", async () => {
  let started
  const reading = new Promise(resolve => { started = resolve })
  const { request, state } = await fixture(() => new Response(new ReadableStream({ start() { started() } }), { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } }))
  const controller = new AbortController()
  const pending = request(undefined, { signal: controller.signal })
  await reading
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal((await pending).status, 499)
  let acquired = 0
  state.oauth = () => { acquired++; return new Response(JSON.stringify({ access_token: "replacement-token", expires_in: 3600 })) }
  const nextController = new AbortController()
  const next = request(undefined, { signal: nextController.signal })
  await new Promise(resolve => setImmediate(resolve))
  nextController.abort()
  await next
  assert.equal(acquired, 1)
})

test("sign-in state headers cannot change expired_token errors during credential redaction", async () => {
  const { request } = await fixture(() => new Response(JSON.stringify({
    error: { code: "expired_token", type: "authentication_error", param: "authorization", message: "expired " + TOKEN + " sdk-secret", details: { description: CREDS.clientSecret, output: TOKEN, id: "sdk-secret", reason: { status: "token " + TOKEN + " rejected", param: "sdk-secret" } } },
  }), { status: 401, headers: { "www-authenticate": 'Bearer error="expired_token"' } }))
  const response = await request(undefined, { headers: { "x-magpie-sign-in": "expired", authorization: "Bearer sdk-secret" } })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await response.json(), {
    error: { code: "expired_token", type: "authentication_error", param: "authorization", message: "expired [redacted] [redacted]", details: { description: "[redacted]", output: "[redacted]", id: "[redacted]", reason: { status: "token [redacted] rejected", param: "[redacted]" } } },
  })
})

test("credential redaction preserves failed response status, error categories and continuation items", async () => {
  const upstream = {
    ...COMPLETED, id: "resp_failed", status: "failed",
    error: { code: "failed_token", type: "failed_authentication", param: "input_failed", message: "failed credentials " + TOKEN, details: { code: "backend_detail", message: "Rejected " + CREDS.clientSecret } },
    output: [{ id: "rs_failed", type: "reasoning", summary: [], encrypted_content: "failed-encrypted-history" }, { id: "fc_failed", type: "function_call", call_id: "call_failed", name: "failed_function", arguments: '{"state":"failed"}', status: "completed" }],
  }
  const { request } = await fixture(() => new Response(JSON.stringify(upstream)))
  const response = await request(undefined, { headers: { "api-key": "failed", "x-magpie-sign-in": "expired" } })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.status, "failed")
  assert.equal(body.id, "resp_failed")
  assert.deepEqual(body.output, upstream.output)
  assert.deepEqual(body.usage, COMPLETED.usage)
  assert.deepEqual(body.error, { code: "failed_token", type: "failed_authentication", param: "input_failed", message: "[redacted] credentials [redacted]", details: { code: "backend_detail", message: "Rejected [redacted]" } })
})

test("a non-streaming request still relays a whole native Response and preserves the native stream flag", async () => {
  const { request, sent } = await fixture()
  for (const incoming of [undefined, false]) {
    const body = { model: MODEL, input: "hello", ...(incoming === undefined ? {} : { stream: incoming }) }
    const response = await request(body)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "application/json")
    assert.deepEqual(await response.json(), COMPLETED)
    assert.deepEqual(sent.at(-1).body, incoming === undefined
      ? { model: MODEL, input: "hello", store: false }
      : { model: MODEL, input: "hello", store: false, stream: false })
  }
  assert.equal(sent.length, 2, "one dispatch per independent operation")
})

test("a streaming request relays native events in order and gates the first byte on the consumer", async () => {
  let pulls = 0
  const frames = [frame(CREATED), frame(delta("Hel", 1)), frame(delta("lo", 2)), frame(DONE)]
  const { request, sent } = await fixture(() => streamResponse(frames, { onPull: () => { pulls++ } }))
  const response = await request({ model: MODEL, input: "hi", stream: true })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(sent[0].body, { model: MODEL, input: "hi", store: false, stream: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pulls, 0, "no upstream bytes are pulled before the consumer reads")
  const events = parseEvents(await response.text())
  assert.deepEqual(events.map(e => e.type), ["response.created", "response.output_text.delta", "response.output_text.delta", "response.completed"])
  assert.deepEqual(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta), ["Hel", "lo"])
  assert.deepEqual(events.at(-1).response, COMPLETED)
  assert.ok(pulls > 0)
})

test("split multibyte UTF-8 and frame boundaries reassemble without corruption", async () => {
  const text = frame(CREATED) + frame(delta("café→", 1)) + frame(delta("—😀", 2)) + frame(DONE)
  const bytes = new TextEncoder().encode(text)
  const chunks = []
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7))
  const { request } = await fixture(() => streamResponse(chunks))
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.deepEqual(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta), ["café→", "—😀"])
  assert.equal(events.at(-1).type, "response.completed")
})

test("arbitrary CR, LF and CRLF line endings frame native events correctly", async () => {
  const text =
    "data: " + JSON.stringify(CREATED) + "\r\n\r\n" +
    "data: " + JSON.stringify(delta("x", 1)) + "\n\n" +
    "data: " + JSON.stringify(DONE) + "\r\r"
  const { request } = await fixture(() => streamResponse([text]))
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.deepEqual(events.map(e => e.type), ["response.created", "response.output_text.delta", "response.completed"])
})

test("function-call argument deltas and numeric fidelity pass through verbatim without accumulation", async () => {
  const argDeltas = ['{"ci', 'ty":', '"NYC"}']
  const frames = [
    frame(CREATED),
    ...argDeltas.map((d, i) => frame({ type: "response.function_call_arguments.delta", delta: d, item_id: "fc_a", output_index: 0, sequence_number: i + 1 })),
    'data: {"type":"response.in_progress","response":{"id":"resp_a","temperature":1.0,"top_p":0.0},"sequence_number":5}\n\n',
    frame(DONE),
  ]
  const { request } = await fixture(() => streamResponse([frames.join("")]))
  const raw = await (await request({ model: MODEL, input: "hi", stream: true, tools: [{ type: "function", name: "lookup" }], tool_choice: "auto" })).text()
  const events = parseEvents(raw)
  assert.deepEqual(events.filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta), argDeltas)
  assert.ok(raw.includes('"temperature":1.0,"top_p":0.0'), "untouched frames are relayed byte-for-byte")
  assert.equal(events.at(-1).type, "response.completed")
})

test("failed streaming terminals relay natively with descriptive-error credential redaction", async () => {
  const failed = { ...COMPLETED, id: "resp_fail", status: "failed", error: { code: "backend_failure", type: "server_error", param: "input", message: "boom " + TOKEN + " " + CREDS.clientSecret } }
  const frames = frame({ type: "response.created", response: { id: "resp_fail", object: "response", status: "in_progress" }, sequence_number: 0 }) +
    frame({ type: "response.failed", response: failed, sequence_number: 1 })
  const { request } = await fixture(() => streamResponse([frames]))
  const raw = await (await request({ model: MODEL, input: "hi", stream: true }, { headers: { "api-key": "sdk-secret" } })).text()
  const events = parseEvents(raw)
  assert.equal(events.at(-1).type, "response.failed")
  const error = events.at(-1).response.error
  assert.equal(error.code, "backend_failure")
  assert.equal(error.type, "server_error")
  assert.equal(error.param, "input")
  assert.equal(events.at(-1).response.status, "failed")
  assert.deepEqual(events.at(-1).response.output, COMPLETED.output)
  for (const secret of [TOKEN, CREDS.clientSecret]) assert.ok(!raw.includes(secret), secret)
})

test("incomplete streaming terminals retain their native details", async () => {
  const incomplete = { ...COMPLETED, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
  const frames = frame(CREATED) + frame({ type: "response.incomplete", response: incomplete, sequence_number: 1 })
  const { request } = await fixture(() => streamResponse([frames]))
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.equal(events.at(-1).type, "response.incomplete")
  assert.deepEqual(events.at(-1).response.incomplete_details, { reason: "max_output_tokens" })
})

test("a streaming upstream that ends without a terminal yields a safe error, never a fabricated completion", async () => {
  const frames = frame(CREATED) + frame(delta("partial", 1))
  const { request } = await fixture(() => streamResponse([frames]))
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.equal(events.at(-1).type, "error")
  assert.equal(events.at(-1).error.code, "inference-response")
  assert.ok(!events.some(e => e.type === "response.completed"))
})

test("an oversized never-terminated streaming frame is bounded into a safe error", async () => {
  const giant = "x".repeat(16 * 1024 * 1024 + 8)
  const frames = frame(CREATED) + `data: {"type":"response.output_text.delta","delta":"${giant}"`
  const { request } = await fixture(() => streamResponse([frames]))
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.equal(events.at(-1).type, "error")
  assert.equal(events.at(-1).error.code, "inference-response")
})

test("a successful streaming request that is not an event stream fails safely", async () => {
  const { request, sent } = await fixture(() => new Response(JSON.stringify(COMPLETED), { headers: { "content-type": "application/json" } }))
  const response = await request({ model: MODEL, input: "hi", stream: true })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, "inference-response")
  assert.equal(sent.length, 1)
})

test("a streaming request rejected upstream preserves HTTP status and never replays", async () => {
  const { request, sent } = await fixture(() => new Response(JSON.stringify({ error: { code: "quota_exceeded", message: "slow down " + TOKEN } }), { status: 429, headers: { "retry-after": "12" } }))
  const response = await request({ model: MODEL, input: "hi", stream: true })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "12")
  const body = await response.json()
  assert.equal(body.error.code, "quota_exceeded")
  assert.ok(!JSON.stringify(body).includes(TOKEN))
  assert.equal(sent.length, 1)
})

test("the relay applies backpressure, pulling upstream only as the consumer reads", async () => {
  let pulls = 0
  const frames = [frame(CREATED), frame(delta("a", 1)), frame(delta("b", 2)), frame(DONE)]
  const { request } = await fixture(() => streamResponse(frames, { onPull: () => { pulls++ } }))
  const response = await request({ model: MODEL, input: "hi", stream: true })
  const reader = response.body.getReader()
  assert.equal(pulls, 0)
  await reader.read()
  const afterFirst = pulls
  assert.ok(afterFirst >= 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pulls, afterFirst, "no upstream chunk is pulled ahead of the next consumer read")
  for (;;) { const { done } = await reader.read(); if (done) break }
  assert.ok(pulls > afterFirst)
})

test("cancelling a streaming consumer cancels the underlying upstream reader", async () => {
  let cancelled = false
  const upstream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(CREATED))) },
    cancel() { cancelled = true },
  })
  const { request } = await fixture(() => new Response(upstream, { headers: { "content-type": "text/event-stream" } }))
  const controller = new AbortController()
  const response = await request({ model: MODEL, input: "hi", stream: true }, { signal: controller.signal })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
})

test("the request deadline terminates a streaming body that stalls mid-flight, cancels upstream and yields no output", async () => {
  let cancelled = false
  const upstream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(CREATED))) },
    cancel() { cancelled = true },
  })
  const { request } = await fixture(() => new Response(upstream, { headers: { "content-type": "text/event-stream" } }))
  const original = globalThis.setTimeout
  cleanups.push(() => { globalThis.setTimeout = original })
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 120000 ? 20 : ms, ...args)
  const response = await request({ model: MODEL, input: "hi", stream: true })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const first = await reader.read()
  const seen = parseEvents(new TextDecoder().decode(first.value))
  assert.deepEqual(seen.map(e => e.type), ["response.created"], "only the pre-deadline event is relayed")
  let caught
  await assert.rejects(async () => { for (;;) { const { done } = await reader.read(); if (done) break } }, error => { caught = error; return true })
  assert.equal(caught.code, "inference-idle-timeout", "the stall rejection carries the idle-timeout code, never a fabricated completion")
  assert.ok(!seen.some(e => e.type === "response.completed"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true, "the stalled upstream reader is cancelled")
})

test("a streaming operation recovers after cancellation without replaying the generation", async () => {
  let calls = 0
  const { request, sent } = await fixture(() => {
    calls++
    if (calls === 1) return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
    return streamResponse([frame(CREATED) + frame(DONE)])
  })
  const controller = new AbortController()
  const first = await request({ model: MODEL, input: "hi", stream: true }, { signal: controller.signal })
  const reader = first.body.getReader()
  const reading = reader.read()
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(reading)
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.equal(events.at(-1).type, "response.completed")
  assert.equal(sent.length, 2, "each streaming operation dispatches exactly once")
})

test("a successful streaming terminal relays output text, item id and call_id verbatim even when they overlap credentials", async () => {
  const overlap = {
    id: TOKEN, object: "response", model: MODEL, status: "completed",
    output: [
      { id: CREDS.clientSecret, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "the token is " + TOKEN, annotations: [] }] },
      { id: "fc_a", type: "function_call", call_id: CREDS.clientId, name: "lookup", arguments: '{"secret":"' + CREDS.clientSecret + '"}', status: "completed" },
    ],
    usage: COMPLETED.usage, error: null, incomplete_details: null,
  }
  const frames = frame(CREATED) +
    frame(delta(TOKEN, 1)) +
    frame({ type: "response.completed", response: overlap, sequence_number: 9 })
  const { request } = await fixture(() => streamResponse([frames]))
  const raw = await (await request({ model: MODEL, input: "hi", stream: true }, { headers: { "api-key": CREDS.clientSecret } })).text()
  const events = parseEvents(raw)
  assert.equal(events.at(-1).type, "response.completed")
  assert.deepEqual(events.at(-1).response, overlap, "native success output is immutable, never redacted")
  assert.equal(events.find(e => e.type === "response.output_text.delta").delta, TOKEN, "a delta overlapping a secret is relayed verbatim")
  for (const secret of [TOKEN, CREDS.clientSecret, CREDS.clientId]) assert.ok(raw.includes(secret), "successful output keeps " + secret)
})

test("a failed streaming terminal keeps top-level error protocol fields but redacts nested descriptive details including a secret-bearing code", async () => {
  const failed = {
    ...COMPLETED, id: "resp_fail", status: "failed",
    error: {
      code: "backend_failure", type: "server_error", param: "input",
      message: "boom " + TOKEN,
      details: {
        code: "detail_" + CREDS.clientSecret,
        reason: "token " + TOKEN + " rejected",
        items: [{ note: "see " + CREDS.clientId }],
      },
    },
  }
  const frames = frame({ type: "response.created", response: { id: "resp_fail", object: "response", status: "in_progress" }, sequence_number: 0 }) +
    frame({ type: "response.failed", response: failed, sequence_number: 1 })
  const { request } = await fixture(() => streamResponse([frames]))
  const raw = await (await request({ model: MODEL, input: "hi", stream: true }, { headers: { "api-key": "sdk-secret" } })).text()
  const events = parseEvents(raw)
  const terminal = events.at(-1)
  assert.equal(terminal.type, "response.failed")
  assert.equal(terminal.response.status, "failed")
  assert.deepEqual(terminal.response.output, COMPLETED.output, "native output history is immutable")
  const error = terminal.response.error
  assert.equal(error.code, "backend_failure", "top-level category is a protocol field, preserved verbatim")
  assert.equal(error.type, "server_error")
  assert.equal(error.param, "input")
  assert.equal(error.message, "boom [redacted]")
  assert.equal(error.details.code, "detail_[redacted]", "a nested descriptive code carrying a secret is redacted")
  assert.equal(error.details.reason, "token [redacted] rejected")
  assert.equal(error.details.items[0].note, "see [redacted]")
  for (const secret of [TOKEN, CREDS.clientSecret, CREDS.clientId]) assert.ok(!raw.includes(secret), secret)
})

test("nested streaming error events retain protocol fields and redact descriptive details", async () => {
  for (const type of ["error", "response.error"]) {
    const event = {
      type, code: "stream_failure", message: "outer " + TOKEN,
      error: { code: "backend_failure", type: "server_error", param: "input", message: "inner " + TOKEN, details: { code: "detail_" + CREDS.clientSecret } },
    }
    const { request } = await fixture(() => streamResponse([frame(event)]))
    const raw = await (await request({ model: MODEL, input: "hi", stream: true })).text()
    const [redacted] = parseEvents(raw)
    assert.equal(redacted.type, type)
    assert.equal(redacted.code, event.code)
    assert.equal(redacted.message, "outer [redacted]")
    assert.deepEqual(redacted.error, { code: "backend_failure", type: "server_error", param: "input", message: "inner [redacted]", details: { code: "detail_[redacted]" } })
    for (const secret of [TOKEN, CREDS.clientSecret]) assert.ok(!raw.includes(secret))
  }
})

test("data-only, event+data, multiline data and comment frames reassemble across mixed CR/LF/CRLF endings and arbitrary byte splits", async () => {
  const parts = [
    ": keep-alive\n\n",
    "event: response.created\r\ndata: " + JSON.stringify(CREATED) + "\r\n\r\n",
    "data: {\"type\":\"response.output_text.delta\",\n" +
      "data: \"delta\":\"multi\",\"item_id\":\"msg_a\",\"output_index\":1,\"sequence_number\":2}\n\n",
    ": another comment\r\r",
    "data: " + JSON.stringify(delta("tail", 3)) + "\r\r",
    "event: response.completed\ndata: " + JSON.stringify(DONE) + "\n\n",
  ]
  const bytes = new TextEncoder().encode(parts.join(""))
  const chunks = []
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes.slice(i, i + 1))
  const { request } = await fixture(() => streamResponse(chunks))
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.deepEqual(events.map(e => e.type), ["response.created", "response.output_text.delta", "response.output_text.delta", "response.completed"])
  assert.deepEqual(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta), ["multi", "tail"])
  assert.deepEqual(events.at(-1).response, COMPLETED)
})

test("a terminal event with a malformed, mislabelled or status-mismatched native response is a safe error, never a completion", async () => {
  const terminals = [
    frame({ type: "response.completed", response: { ...COMPLETED, status: "in_progress" }, sequence_number: 9 }),
    frame({ type: "response.completed", response: { id: "resp_a", object: "response", status: "completed", output: {} }, sequence_number: 9 }),
    frame({ type: "response.failed", response: { ...COMPLETED, status: "completed" }, sequence_number: 9 }),
    "event: response.failed\ndata: " + JSON.stringify(DONE) + "\n\n",
  ]
  for (const terminal of terminals) {
    const { request } = await fixture(() => streamResponse([frame(CREATED) + terminal]))
    const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
    assert.equal(events.at(-1).type, "error", terminal)
    assert.equal(events.at(-1).error.code, "inference-response")
    assert.ok(!events.some(e => e.type === "response.completed" || e.type === "response.failed"), terminal)
  }
})

test("malformed JSON, invalid UTF-8 and an unframed trailing terminal each yield a safe error without a completion", async () => {
  const enc = new TextEncoder()
  const cases = [
    [frame(CREATED) + "data: {not json}\n\n"],
    [enc.encode(frame(CREATED) + "data: "), new Uint8Array([0xff, 0xfe]), enc.encode("\n\n")],
    [frame(CREATED) + "data: " + JSON.stringify(DONE)],
  ]
  for (const chunks of cases) {
    const { request } = await fixture(() => streamResponse(chunks))
    const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
    assert.equal(events.at(-1).type, "error")
    assert.equal(events.at(-1).error.code, "inference-response")
    assert.ok(!events.some(e => e.type === "response.completed"))
  }
})

test("a fully framed oversized frame is bounded by bytes, including a multibyte frame crossing the 16 MiB limit", async () => {
  const cases = [
    frame(CREATED) + 'data: {"type":"response.output_text.delta","delta":"' + "x".repeat(16 * 1024 * 1024 + 8) + '"}\n\n',
    frame(CREATED) + 'data: {"type":"response.output_text.delta","delta":"' + "\u20ac".repeat(6 * 1024 * 1024) + '"}\n\n',
  ]
  for (const frames of cases) {
    const { request } = await fixture(() => streamResponse([frames]))
    const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
    assert.equal(events.at(-1).type, "error")
    assert.equal(events.at(-1).error.code, "inference-response")
  }
})

test("coalesced events are reconstructed one frame per read without reading upstream ahead or pre-parsing past the terminal", async () => {
  let pulls = 0
  const coalesced = frame(CREATED) + frame(delta("a", 1)) + frame(delta("b", 2)) + frame(DONE) +
    "data: {garbage after the terminal that must never be parsed}\n\n"
  const { request } = await fixture(() => streamResponse([coalesced], { onPull: () => { pulls++ } }))
  const reader = (await request({ model: MODEL, input: "hi", stream: true })).body.getReader()
  const decoder = new TextDecoder()
  const got = []
  for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(...parseEvents(decoder.decode(value, { stream: true }))) }
  assert.deepEqual(got.map(e => e.type), ["response.created", "response.output_text.delta", "response.output_text.delta", "response.completed"])
  assert.deepEqual(got.filter(e => e.type === "response.output_text.delta").map(e => e.delta), ["a", "b"])
  assert.ok(!got.some(e => e.type === "error"), "bytes after the terminal are never parsed")
  assert.equal(pulls, 1, "a single coalesced chunk is pulled once and replayed frame by frame")
})

test("an unread streaming body cancels its upstream eagerly on cancellation and a later operation recovers", async () => {
  let cancelled = false
  let calls = 0
  const { request, sent } = await fixture(() => {
    calls++
    if (calls === 1) {
      const upstream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(frame(CREATED))) },
        cancel() { cancelled = true },
      })
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } })
    }
    return streamResponse([frame(CREATED) + frame(DONE)])
  })
  const controller = new AbortController()
  const first = await request({ model: MODEL, input: "hi", stream: true }, { signal: controller.signal })
  const reader = first.body.getReader()
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true, "the upstream reader is cancelled even though the returned body was never read")
  await reader.read().catch(() => {})
  const events = parseEvents(await (await request({ model: MODEL, input: "hi", stream: true })).text())
  assert.equal(events.at(-1).type, "response.completed")
  assert.equal(sent.length, 2, "recovery dispatches a fresh generation, never a replay")
})
