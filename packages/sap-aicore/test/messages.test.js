import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SAPAICorePlugin } from "../src/index.js"
import { validateRequest, dispatch } from "../src/messages.js"
import { readJSONRequest } from "../src/transport.js"

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
const OPUS_SAP = "anthropic--claude-4.8-opus"
const OPUS = "claude-opus-4-8"
const OPUS_URL = ROOT + "/v2/inference/deployments/deployment-opus"
const SONNET = "claude-sonnet-4-6"
const SONNET_URL = ROOT + "/v2/inference/deployments/deployment-sonnet"
const GPT = "gpt-6-astra"
const GPT_VERSION = "2026-09-03"
const GPT_URL = ROOT + "/v2/inference/deployments/deployment-gpt"

const MESSAGE = {
  id: "msg_01ABC", type: "message", role: "assistant", model: OPUS,
  content: [{ type: "text", text: "AICORE_CLAUDE_OK" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 6 },
}

// --- native request validation (direct) ------------------------------------

const base = (over = {}) => ({ model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 1024, ...over })
const parse = async body => validateRequest(await readJSONRequest(ROOT + "/messages", { body: JSON.stringify(body) }))

test("a valid native Messages body passes and is returned verbatim", async () => {
  const body = base({ system: "be terse", stop_sequences: ["STOP"], temperature: 0.4 })
  const out = await parse(body)
  assert.deepEqual(out, body)
})

test("max_tokens is required; zero is accepted; negative and non-integer are rejected", async () => {
  await assert.rejects(parse({ model: OPUS, messages: [{ role: "user", content: "hi" }] }), { code: "invalid-request" })
  assert.equal((await parse(base({ max_tokens: 0 }))).max_tokens, 0)
  await assert.rejects(parse(base({ max_tokens: -1 })), { code: "invalid-request" })
  await assert.rejects(parse(base({ max_tokens: 1.5 })), { code: "invalid-request" })
})

test("out-of-scope parameters, multimodal content, and unrecognized fields are rejected", async () => {
  await assert.rejects(parse(base({ metadata: { user_id: "u" } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ mcp_servers: [] })), { code: "invalid-request" })
  await assert.rejects(parse(base({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] })), { code: "invalid-request" })
  // Unrecognized top-level fields fail explicitly rather than reaching upstream.
  for (const field of ["anthropic_beta", "top_logprobs", "functions", "tool_Calls", "stream_options"]) {
    await assert.rejects(parse(base({ [field]: field === "top_logprobs" ? 1 : [] })), { code: "invalid-request" }, field)
  }
})

const IMAGE_CAPABLE = { capabilities: { image: true } }
const parseWith = async (body, entry) => validateRequest(await readJSONRequest(ROOT + "/messages", { body: JSON.stringify(body) }), entry)
const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }
const withImage = block => base({ messages: [{ role: "user", content: [block, { type: "text", text: "describe" }] }] })

test("a base64 image block is accepted only for an image-capable model", async () => {
  // No capability (default) and an explicitly image-off model both reject.
  await assert.rejects(parseWith(withImage(imageBlock)), { code: "invalid-request" })
  await assert.rejects(parseWith(withImage(imageBlock), { capabilities: { image: false } }), { code: "invalid-request" })
  // An image-capable model accepts it and forwards the block verbatim.
  const out = await parseWith(withImage(imageBlock), IMAGE_CAPABLE)
  assert.deepEqual(out.messages[0].content[0], imageBlock)
})

test("an image-capable model still rejects non-base64 sources and malformed image blocks", async () => {
  const bad = [
    { type: "image", source: { type: "url", url: "https://example.invalid/i.png" } },
    { type: "image", source: { type: "base64", media_type: "image/png" } },
    { type: "image", source: { type: "base64", data: "iVBORw0KGgo=" } },
    { type: "image" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" }, detail: "high" },
  ]
  for (const block of bad) await assert.rejects(parseWith(withImage(block), IMAGE_CAPABLE), { code: "invalid-request" }, JSON.stringify(block))
})

test("tools, tool_choice and a forced tool name are validated against declared tools", async () => {
  const tools = [{ name: "lookup", input_schema: { type: "object" } }]
  assert.ok(await parse(base({ tools, tool_choice: { type: "tool", name: "lookup" } })))
  await assert.rejects(parse(base({ tools, tool_choice: { type: "tool", name: "missing" } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ tool_choice: { type: "any" } })), { code: "invalid-request" })
})

test("pi's boolean tool hints pass validation; other unknown and malformed tool fields are rejected", async () => {
  // pi attaches eager_input_streaming (and defer_loading on its deferred placeholder
  // tool); these boolean hints pass validation unchanged and are stripped at dispatch.
  const tools = [{ name: "lookup", description: "d", eager_input_streaming: true, strict: true, input_schema: { type: "object" } }]
  assert.deepEqual((await parse(base({ tools }))).tools, tools)
  assert.ok(await parse(base({ tools: [{ name: "__pi_deferred_placeholder__", input_schema: { type: "object" }, defer_loading: true }] })))
  // A malformed (non-boolean) pi hint is rejected.
  await assert.rejects(parse(base({ tools: [{ name: "x", input_schema: { type: "object" }, eager_input_streaming: "yes" }] })), { code: "invalid-request" })
  // Any other unknown tool field is rejected, not forwarded.
  await assert.rejects(parse(base({ tools: [{ name: "x", input_schema: { type: "object" }, unknown_tool_field: 1 }] })), { code: "invalid-request" })
  // Structural validation of enumerated fields still applies.
  await assert.rejects(parse(base({ tools: [{ name: "x", input_schema: { type: "object" }, strict: "yes" }] })), { code: "invalid-request" })
  await assert.rejects(parse(base({ tools: [{ name: "x" }] })), { code: "invalid-request" })
})

test("signed thinking blocks (including empty text) and a conflicting anthropic_version", async () => {
  const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-abc" }] }
  assert.ok(await parse(base({ messages: [thinking, { role: "user", content: "go" }] })))
  await assert.rejects(parse(base({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }] })), { code: "invalid-request" })
  await assert.rejects(parse(base({ anthropic_version: "2023-06-01" })), { code: "invalid-request" })
})

test("native thinking controls validate structurally: enabled budget, adaptive/disabled, display/block_binding, output_config effort", async () => {
  // Enabled thinking requires a positive integer budget; adaptive/disabled take none.
  assert.ok(await parse(base({ thinking: { type: "enabled", budget_tokens: 1024 } })))
  assert.ok(await parse(base({ thinking: { type: "adaptive" } })))
  assert.ok(await parse(base({ thinking: { type: "disabled" } })))
  // display/block_binding and output_config.effort are recognized structural controls.
  assert.ok(await parse(base({ thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }, output_config: { effort: "high" } })))
  // Malformed: unknown type, missing/non-positive enabled budget, budget on adaptive/disabled.
  await assert.rejects(parse(base({ thinking: { type: "auto" } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ thinking: { type: "enabled" } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ thinking: { type: "enabled", budget_tokens: 0 } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ thinking: { type: "enabled", budget_tokens: -1 } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ thinking: { type: "adaptive", budget_tokens: 1024 } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ thinking: { type: "enabled", budget_tokens: 1024, unknown: 1 } })), { code: "invalid-request" })
  await assert.rejects(parse(base({ output_config: { effort: 5 } })), { code: "invalid-request" })
})

// --- whole-reply dispatch through the plugin loader ------------------------

async function fixture(inference = () => new Response(JSON.stringify(MESSAGE)), options = {}) {
  const opusStreaming = Object.hasOwn(options, "opusStreaming") ? options.opusStreaming : true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-messages-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, "credentials.json")
  fs.writeFileSync(credentialFile, JSON.stringify(CREDS), { mode: 0o600 })
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  const sent = []
  const json = body => new Response(JSON.stringify(body))
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/oauth/token") return json({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 })
    if (url.pathname === "/v2/lm/deployments") {
      return json({ resources: url.searchParams.get("$skip") === "0" ? [
        { id: "deployment-gpt", status: "RUNNING", deploymentUrl: GPT_URL, configurationId: "cfg-gpt", details: { resources: { backendDetails: { model: { name: GPT, version: GPT_VERSION } } } } },
        { id: "deployment-opus", status: "RUNNING", deploymentUrl: OPUS_URL, configurationId: "cfg-opus", details: { resources: { backendDetails: { model: { name: OPUS_SAP, version: "1" } } } } },
      ] : [] })
    }
    if (url.pathname === "/v2/lm/configurations/cfg-gpt") return json({ id: "cfg-gpt", scenarioId: "foundation-models", executableId: "azure-openai", parameterBindings: [{ key: "modelName", value: GPT }, { key: "modelVersion", value: GPT_VERSION }] })
    if (url.pathname === "/v2/lm/configurations/cfg-opus") return json({ id: "cfg-opus", scenarioId: "foundation-models", executableId: "aws-bedrock", parameterBindings: [{ key: "modelName", value: OPUS_SAP }, { key: "modelVersion", value: "1" }] })
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return json({ count: 2, resources: [
      { model: GPT, executableId: "azure-openai", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }], versions: [{ name: GPT_VERSION, contextLength: 1050000, inputTypes: ["text"], streamingSupported: true }] },
      { model: OPUS_SAP, executableId: "aws-bedrock", provider: "Anthropic", displayName: "Claude 4.8 Opus", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "aws-bedrock" }], versions: [{ name: "1", contextLength: 1000000, inputTypes: ["text", "image"], ...(opusStreaming === undefined ? {} : { streamingSupported: opusStreaming }) }] },
    ] })
    sent.push({ url: url.href, init, body: JSON.parse(init.body) })
    return inference(input, init)
  }
  const plugin = await SAPAICorePlugin()
  const signed = await plugin.auth.methods[0].authorize({ credentialFile })
  assert.equal(signed.type, "success")
  const auth = { type: "api", key: signed.key, metadata: signed.metadata }
  const loader = await plugin.auth.loader(async () => auth)
  const post = (route, body, init = {}) => loader.fetch(ROOT + route, { method: "POST", body: JSON.stringify(body), ...init })
  const models = () => plugin.provider.models({}, { auth })
  return { loader, post, sent, plugin, auth, models }
}

test("a whole Claude reply reaches /invoke and returns native Anthropic JSON", async () => {
  const { post, sent } = await fixture()
  const response = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stop_sequences: ["STOP"] })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), MESSAGE)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")

  const call = sent.at(-1)
  assert.equal(call.url, OPUS_URL + "/invoke")
  assert.equal(call.init.method, "POST")
  assert.equal(call.init.headers.authorization, "Bearer " + TOKEN)
  assert.equal(call.init.headers["AI-Resource-Group"], "group-a")
  assert.equal(call.body.anthropic_version, "bedrock-2023-05-31")
  assert.equal("model" in call.body, false, "routing model is removed from the Bedrock body")
  assert.equal("stream" in call.body, false, "stream selector is omitted from the body")
  assert.deepEqual(call.body.stop_sequences, ["STOP"], "explicit native fields are forwarded, not dropped")
  assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }])
})

test("pi's non-native tool hints are stripped from the Bedrock invoke body", async () => {
  const { post, sent } = await fixture()
  const tools = [
    { name: "read_file", description: "d", eager_input_streaming: true, strict: true, input_schema: { type: "object", properties: {} } },
    { name: "__pi_deferred_placeholder__", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true },
  ]
  const response = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 64, tools })
  assert.equal(response.status, 200)
  assert.deepEqual(sent.at(-1).body.tools, [
    { name: "read_file", description: "d", strict: true, input_schema: { type: "object", properties: {} } },
    { name: "__pi_deferred_placeholder__", input_schema: { type: "object", properties: {}, required: [] } },
  ])
})

test("pi's adaptive thinking and output_config reach the Bedrock invoke body verbatim", async () => {
  const { post, sent } = await fixture()
  const thinking = { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }
  const output_config = { effort: "high" }
  const response = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 64, thinking, output_config })
  assert.equal(response.status, 200)
  assert.deepEqual(sent.at(-1).body.thinking, thinking)
  assert.deepEqual(sent.at(-1).body.output_config, output_config)
})

test("no sampling default is injected for Claude when the client omits it", async () => {
  const { post, sent } = await fixture()
  await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 64 })
  const call = sent.at(-1)
  assert.equal("temperature" in call.body, false)
  assert.equal("top_p" in call.body, false)
})

test("a model addressed through the wrong protocol route fails before inference", async () => {
  const { post, sent } = await fixture()
  const mark = sent.length
  // Claude model on the Responses route.
  const a = await post("/responses", { model: OPUS, input: "hi" })
  assert.equal(a.status, 400)
  // GPT model on the Messages route.
  const b = await post("/messages", { model: GPT, messages: [{ role: "user", content: "hi" }], max_tokens: 16 })
  assert.equal(b.status, 400)
  assert.equal(sent.length, mark, "no upstream inference call was made")
})

test("a native Anthropic error reply preserves status and redacts credential echoes", async () => {
  const { post } = await fixture(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad " + CREDS.clientSecret } }), { status: 400 }))
  const response = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 16 })
  assert.equal(response.status, 400)
  const text = await response.text()
  assert.equal(text.includes(CREDS.clientSecret), false)
  assert.ok(text.includes("[redacted]"))
})

test("an unknown model on the Messages route is a 404", async () => {
  const { post } = await fixture()
  const response = await post("/messages", { model: "claude-ghost-9-9", messages: [{ role: "user", content: "hi" }], max_tokens: 16 })
  assert.equal(response.status, 404)
})

// --- dispatch request-policy and capability gates (direct) -----------------

const CREDENTIALS = { aiRoot: ROOT, resourceGroup: "group-a", clientId: CREDS.clientId, clientSecret: CREDS.clientSecret }
const OPUS_POLICY = { maxOutputTokens: 128000, rejectTemperature: true, rejectTopP: true, rejectEnabledThinking: true }
const SONNET_POLICY = { maxOutputTokens: 128000, rejectCombinedSampling: true, rejectForcedToolThinking: true }
const entryFor = (url, policy, streaming = true) => ({
  deploymentURL: url, protocol: "anthropic",
  capabilities: { text: true, functionTool: true, streaming },
  ...(policy ? { requestPolicy: policy } : {}),
})
const bodyFor = over => ({ model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 64, ...over })
const invoke = (entry, body) => dispatch({ entry, body, credentials: CREDENTIALS, token: { value: TOKEN } })

function stubFetch(impl) {
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async (input, init) => { calls++; return impl(input, init) }
  return { calls: () => calls }
}

test("the Opus baseline policy rejects temperature, top_p, enabled thinking and the output ceiling before inference", async () => {
  const spy = stubFetch(() => new Response(JSON.stringify(MESSAGE)))
  const entry = entryFor(OPUS_URL, OPUS_POLICY)
  await assert.rejects(invoke(entry, bodyFor({ temperature: 0.2 })), { code: "invalid-request" })
  await assert.rejects(invoke(entry, bodyFor({ top_p: 0.5 })), { code: "invalid-request" })
  await assert.rejects(invoke(entry, bodyFor({ thinking: { type: "enabled", budget_tokens: 1024 } })), { code: "invalid-request" })
  await assert.rejects(invoke(entry, bodyFor({ max_tokens: 128001 })), { code: "invalid-request" })
  assert.equal(spy.calls(), 0, "no rejected request escaped the gate to inference")
})

test("the Opus baseline accepts adaptive and disabled thinking and max_tokens at the ceiling", async () => {
  stubFetch(() => new Response(JSON.stringify(MESSAGE)))
  const entry = entryFor(OPUS_URL, OPUS_POLICY)
  assert.equal((await invoke(entry, bodyFor({ thinking: { type: "adaptive" } }))).status, 200)
  assert.equal((await invoke(entry, bodyFor({ thinking: { type: "disabled" } }))).status, 200)
  assert.equal((await invoke(entry, bodyFor({ max_tokens: 128000 }))).status, 200)
})

test("the Sonnet baseline allows individual sampling and a fixed budget but rejects combined sampling and forced-tool thinking", async () => {
  const sonnetReply = { ...MESSAGE, model: SONNET }
  const spy = stubFetch(() => new Response(JSON.stringify(sonnetReply)))
  const entry = entryFor(SONNET_URL, SONNET_POLICY)
  assert.equal((await invoke(entry, bodyFor({ model: SONNET, temperature: 0.2 }))).status, 200)
  assert.equal((await invoke(entry, bodyFor({ model: SONNET, top_p: 0.5 }))).status, 200)
  assert.equal((await invoke(entry, bodyFor({ model: SONNET, thinking: { type: "enabled", budget_tokens: 1024 } }))).status, 200)
  const reached = spy.calls()
  await assert.rejects(invoke(entry, bodyFor({ model: SONNET, temperature: 0.2, top_p: 0.5 })), { code: "invalid-request" })
  const tools = [{ name: "lookup", input_schema: { type: "object" } }]
  await assert.rejects(invoke(entry, bodyFor({ model: SONNET, tools, tool_choice: { type: "any" }, thinking: { type: "enabled", budget_tokens: 1024 } })), { code: "invalid-request" })
  assert.equal(spy.calls(), reached, "rejected combinations never reached inference")
})

test("a newer Claude deployment carries no policy, so structurally valid controls pass through and upstream validation is preserved", async () => {
  // No requestPolicy (not a verified baseline): the gate invents no restriction and
  // forwards combined sampling, enabled thinking and a large budget to upstream,
  // whose own validation verdict is preserved verbatim.
  const upstream = { type: "error", error: { type: "invalid_request_error", message: "unsupported by this version" } }
  const spy = stubFetch(() => new Response(JSON.stringify(upstream), { status: 400 }))
  const entry = entryFor(ROOT + "/v2/inference/deployments/deployment-next", null)
  const response = await invoke(entry, bodyFor({ model: "claude-opus-5-0", temperature: 0.2, top_p: 0.5, max_tokens: 400000, thinking: { type: "enabled", budget_tokens: 4096 } }))
  assert.equal(response.status, 400)
  assert.equal(spy.calls(), 1, "the request reached upstream unblocked")
})

test("a streamed request to a model without streaming capability is rejected before inference", async () => {
  const spy = stubFetch(() => new Response(JSON.stringify(MESSAGE)))
  const entry = entryFor(OPUS_URL, OPUS_POLICY, false)
  await assert.rejects(invoke(entry, bodyFor({ stream: true })), { code: "invalid-request" })
  assert.equal(spy.calls(), 0, "the capability gate fires before any inference call")
})

test("malformed whole message identity, role, stop reason, or usage is rejected as an upstream response failure", async () => {
  let reply = MESSAGE
  const { post } = await fixture(() => new Response(JSON.stringify(reply)))
  for (const invalid of [{ id: "" }, { role: "user" }, { stop_reason: "" }, { usage: undefined }, { usage: { input_tokens: -1, output_tokens: 2 } }]) {
    reply = { ...MESSAGE, ...invalid }
    const response = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 16 })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, "inference-response")
  }
})

test("a whole error redacts top-level sibling credential echoes and preserves the native error category", async () => {
  const { post } = await fixture(() => new Response(JSON.stringify({
    type: "error", message: "oops " + CREDS.clientSecret, details: { echo: CREDS.clientSecret },
    error: { type: "overloaded_error", message: "native failure", details: { echo: CREDS.clientSecret } },
  }), { status: 529 }))
  const response = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 16 })
  assert.equal(response.status, 529)
  const text = await response.text()
  assert.equal(text.includes(CREDS.clientSecret), false)
  assert.equal(JSON.parse(text).error.type, "overloaded_error", "native error category is preserved")
})

test("Claude versions with absent or false catalog streaming support remain listed and whole-only", async () => {
  for (const opusStreaming of [undefined, false]) {
    const { post, sent, models } = await fixture(undefined, { opusStreaming })
    const listed = await models()
    assert.equal(listed[OPUS].limit.output, 128000)
    const whole = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 16 })
    assert.equal(whole.status, 200)
    assert.deepEqual(await whole.json(), MESSAGE)
    assert.equal(sent.at(-1).url, OPUS_URL + "/invoke")
    const invokes = sent.length
    const streamed = await post("/messages", { model: OPUS, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true })
    assert.equal(streamed.status, 400)
    assert.equal((await streamed.json()).error.code, "invalid-request")
    assert.equal(sent.length, invokes)
  }
})
