import { test, afterEach } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveDeployment, projectModels } from "../src/discovery.js"
import { SAPAICorePlugin } from "../src/index.js"
import { validateRequest, dispatch } from "../src/gemini.js"

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ROOT = "https://api.ai.eu10.hana.ondemand.com"
const MODEL = "gemini-3.8-flash"
const URL = ROOT + "/v2/inference/deployments/gemini-deployment"
const CREDS = { authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com", baseUrl: ROOT, aiRoot: ROOT, clientId: "fake-gemini-client", clientSecret: "fake-gemini-secret", resourceGroup: "gemini-group" }
const TOKEN = { value: "fake-gemini-bearer" }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const signed = [
  { text: "Tool needed.", thought: true },
  { text: "Calling tool.", thoughtSignature: "opaque-text-signature==" },
  { functionCall: { id: "multiply-1", name: "multiply", args: { x: 19, y: 23 } }, thoughtSignature: "opaque-call-signature==" },
]
const reply = (parts = [{ text: "437" }]) => ({ candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 17 }, modelVersion: MODEL + "-001" })
const base = (over = {}) => ({ model: MODEL, contents: [{ role: "user", parts: [{ text: "Multiply 19 and 23." }] }], ...over })
function evidence(model = MODEL) {
  return {
    aiRoot: ROOT,
    deployment: { id: "gemini-deployment", status: "RUNNING", deploymentUrl: URL, configurationId: "config-gemini", details: { resources: { backendDetails: { model: { name: model, version: "001" } } } } },
    configuration: { id: "config-gemini", scenarioId: "foundation-models", executableId: "gcp-vertexai", parameterBindings: [{ key: "modelName", value: model }, { key: "modelVersion", value: "001" }] },
    catalog: { resources: [{ model, provider: "Google", executableId: "gcp-vertexai", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "gcp-vertexai" }], versions: [{ name: "001", streamingSupported: true, inputTypes: ["text", "image"], contextLength: 1000000 }] }] },
  }
}
const entry = () => resolveDeployment(evidence())
function mockFetch(fn) {
  const original = globalThis.fetch
  globalThis.fetch = fn
  cleanups.push(() => { globalThis.fetch = original })
}
const args = body => ({ entry: entry(), body, credentials: CREDS, token: TOKEN })
const frames = events => events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("")
const streamReply = text => new Response(text, { headers: { "content-type": "text/event-stream" } })

async function pluginFixture(inference = () => json(reply())) {
  const e = evidence()
  const calls = []
  mockFetch(async (input, init) => {
    const url = new globalThis.URL(String(input))
    calls.push({ url: url.href, init })
    if (url.pathname === "/oauth/token") return json({ access_token: TOKEN.value, token_type: "bearer", expires_in: 43199 })
    if (url.pathname === "/v2/lm/deployments") return json({ resources: url.searchParams.get("$skip") === "0" ? [e.deployment] : [] })
    if (url.pathname === "/v2/lm/configurations/config-gemini") return json(e.configuration)
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return json(e.catalog)
    if (url.pathname.startsWith("/v2/inference/")) return inference(url, init)
    throw new Error("Unexpected synthetic URL")
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-test-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "credentials.json")
  fs.writeFileSync(file, JSON.stringify(CREDS), { mode: 0o600 })
  const plugin = await SAPAICorePlugin({})
  const login = await plugin.auth.methods[0].authorize({ credentialFile: file })
  assert.equal(login.type, "success")
  const auth = { type: "api", key: login.key, metadata: login.metadata }
  const loaded = await plugin.auth.loader(async () => auth)
  const post = (route, body = base()) => loaded.fetch(ROOT + route, { method: "POST", headers: { authorization: "Bearer incoming-sdk-secret", "x-goog-api-key": "incoming-google-key" }, body: JSON.stringify(body) })
  return { plugin, loaded, calls, post }
}

test("Gemini discovery uses reconciled catalog/version evidence and supports future releases", () => {
  for (const model of [MODEL, "gemini-4.2-pro-preview", "gemini-2.5-flash-lite"]) {
    const resolved = resolveDeployment(evidence(model))
    assert.equal(resolved.protocol, "gemini")
    assert.equal(resolved.canonicalID, model)
    assert.equal(projectModels({ [model]: resolved })[model].api.npm, "@ai-sdk/google")
  }
  for (const model of ["gemini-embedding", "gemini-embedding-2", "text-bison", "gemini-../../bad"]) assert.equal(resolveDeployment(evidence(model)), null)
  for (const change of [
    e => { e.deployment.status = "STOPPED" },
    e => { e.deployment.details.resources.backendDetails.model.version = "002" },
    e => { e.configuration.executableId = "azure-openai" },
    e => { e.catalog.resources[0].provider = "OpenAI" },
    e => { e.catalog.resources[0].versions[0].deprecated = true },
    e => { e.catalog.resources[0].versions[0].streamingSupported = false },
    e => { e.catalog.resources[0].versions[0].streamingSupported = undefined },
    e => { e.catalog.resources[0].allowedScenarios = [] },
    e => { e.deployment.deploymentUrl = "https://attacker.invalid/v2/inference/deployments/gemini-deployment" },
  ]) { const e = evidence(); change(e); assert.equal(resolveDeployment(e), null) }
})

test("native model-in-path requests and whole replies retain signed numeric JSON verbatim", async () => {
  const native = '{"contents":[{"role":"user","parts":[{"text":"continue"}]},{"role":"model","parts":[{"functionCall":{"id":"large-1","name":"multiply","args":{"large":9007199254740993}},"thoughtSignature":"opaque=="}]},{"role":"user","parts":[{"functionResponse":{"id":"large-1","name":"multiply","response":{"large":9007199254740993}}}]}]}'
  const success = '{"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"large-2","name":"multiply","args":{"large":9007199254740993}},"thoughtSignature":"new-opaque=="}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":1}}'
  const f = await pluginFixture((url, init) => {
    assert.equal(init.body, native, "routing must not round signed function arguments/results")
    return new Response(success, { headers: { "content-type": "application/json" } })
  })
  const response = await f.loaded.fetch(ROOT + "/models/" + MODEL + ":generateContent", { method: "POST", body: native })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), success)
})

test("native schemas, thinking, signatures, IDs and function responses validate unchanged", () => {
  const body = base({
    systemInstruction: { parts: [{ text: "Use tools." }] },
    contents: [...base().contents, { role: "model", parts: signed }, { role: "user", parts: [{ functionResponse: { id: "multiply-1", name: "multiply", response: { product: 437, snake_case: true } } }] }],
    tools: [{ functionDeclarations: [{ name: "multiply", parametersJsonSchema: { type: "object", properties: { snake_case: { type: "integer" } } } }] }],
    toolConfig: { functionCallingConfig: { mode: "NONE" } },
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: { snake_case: { type: "integer" } } }, thinkingConfig: { thinkingLevel: "LOW", includeThoughts: true } },
  })
  const copy = structuredClone(body)
  assert.equal(validateRequest(body, entry()), body)
  assert.deepEqual(body, copy)
})

test("Google SDK lowercase thinking levels validate without changing native values", () => {
  for (const level of ["minimal", "low", "medium", "high", "MINIMAL", "LOW", "MEDIUM", "HIGH"]) {
    const body = base({ generationConfig: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } } })
    assert.equal(validateRequest(body, entry()), body)
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, level)
  }
  for (const level of ["unknown", "low ", 1, null]) assert.throws(() => validateRequest(base({ generationConfig: { thinkingConfig: { thinkingLevel: level } } }), entry()), { code: "invalid-request" })
})

test("image eligibility and malformed/out-of-scope requests fail explicitly", () => {
  const body = base({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] }] })
  assert.equal(validateRequest(body, entry()), body)
  assert.throws(() => validateRequest(body, { capabilities: { image: false } }), /Image input/)
  const toolImage = base({ contents: [{ role: "user", parts: [{ functionResponse: { id: "tool-1", name: "multiply", response: { output: "image" }, parts: body.contents[0].parts } }] }] })
  assert.equal(validateRequest(toolImage, entry()), toolImage)
  assert.throws(() => validateRequest(toolImage, { capabilities: { image: false } }), /Image input/)
  for (const over of [
    { contents: [] }, { messages: [] }, { contents: [{ role: "assistant", parts: [{ text: "x" }] }] },
    { contents: [{ role: "user", parts: [{ text: "x", thoughtSignature: "sig" }] }] },
    { contents: [{ role: "user", parts: [{ functionCall: { name: "x", args: {} } }] }] },
    { contents: [{ role: "user", parts: [{ functionResponse: { name: "x", response: { output: "hi" }, parts: [{ text: "hi" }] } }] }] },
    { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "aGVsbG8=" } }] }] },
    { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "bad!" } }] }] },
    { contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://example.com/a.png" } }] }] },
    { tools: [{ googleSearch: {} }] }, { tools: [{ codeExecution: {} }] }, { tools: [{ urlContext: {} }] },
    { generationConfig: { thinkingConfig: { thinkingBudget: 10, thinkingLevel: "LOW" } } },
    { generationConfig: { maxOutputTokens: -1 } }, { generationConfig: { responseSchema: [], responseMimeType: "application/json" } },
  ]) assert.throws(() => validateRequest(base(over), entry()), { code: "invalid-request" })
})

test("dispatch sends native body once with account-owned headers and preserves whole reply", async () => {
  const body = base({ contents: [...base().contents, { role: "model", parts: signed }] })
  let captured
  mockFetch(async (url, init) => { captured = { url, init }; return json(reply(signed)) })
  const result = await dispatch(args(body))
  assert.deepEqual(await result.json(), reply(signed))
  assert.equal(captured.url, URL + "/models/" + MODEL + ":generateContent")
  const { model, ...native } = body
  assert.deepEqual(JSON.parse(captured.init.body), native)
  assert.equal(captured.init.headers.authorization, "Bearer " + TOKEN.value)
  assert.equal(captured.init.headers["AI-Resource-Group"], CREDS.resourceGroup)
  assert.equal(captured.init.redirect, "error")
})

test("SSE preserves native finish, signatures and trailing usage through EOF", async () => {
  const events = [
    { candidates: [{ index: 0, content: { role: "model", parts: signed } }] },
    { candidates: [{ index: 0, finishReason: "STOP" }] },
    { usageMetadata: reply().usageMetadata, modelVersion: "native-version" },
  ]
  mockFetch(async url => { assert.ok(url.endsWith(":streamGenerateContent?alt=sse")); return streamReply(frames(events)) })
  const result = await dispatch(args(base({ stream: true })))
  assert.equal(await result.text(), frames(events))
})

test("stream truncation, malformed data and unfinished candidates emit native errors", async () => {
  for (const text of [
    frames([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]),
    "data: {bad}\n\n", frames([reply()]) + "data: {",
    frames([{ candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }] }]),
    frames([{ candidates: [{ index: 0, finishReason: "STOP" }, { index: 1, content: { parts: [{ text: "partial" }] } }] }]),
    frames([reply(), { candidates: [{ content: { parts: [{ text: "after finish" }] } }] }]),
  ]) {
    mockFetch(async () => streamReply(text))
    const result = await dispatch(args(base({ stream: true })))
    assert.match(await result.text(), /"error"/)
  }
})

test("native SAP errors are surfaced without credential echoes or silent retries", async () => {
  let count = 0
  mockFetch(async () => { count++; return json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "The following tool is not allowed: googleSearch. " + TOKEN.value, details: [{ message: CREDS.clientSecret }] } }, 400) })
  const result = await dispatch(args(base()))
  assert.equal(result.status, 400)
  const value = await result.json()
  assert.equal(value.error.status, "INVALID_ARGUMENT")
  assert.equal(value.error.message, "The following tool is not allowed: googleSearch. [redacted]")
  assert.equal(value.error.details[0].message, "[redacted]")
  assert.equal(count, 1)
})

test("stream error frames redact every credential detail", async () => {
  mockFetch(async () => streamReply(frames([{ error: { code: 400, message: TOKEN.value, details: [{ message: CREDS.clientSecret }] }, echoed: CREDS.clientId }])))
  const text = await (await dispatch(args(base({ stream: true })))).text()
  for (const secret of [TOKEN.value, CREDS.clientSecret, CREDS.clientId]) assert.ok(!text.includes(secret))
  assert.match(text, /redacted/)
})

test("redirects, unsafe deployment URLs, malformed success and wrong streaming types fail", async () => {
  for (const response of [json({}, 302), json({}), json(reply())]) {
    mockFetch(async () => response)
    await assert.rejects(dispatch(args(base({ stream: true }))))
  }
  mockFetch(async () => json({ candidates: [{ content: { parts: [] } }] }))
  await assert.rejects(dispatch(args(base())), { code: "inference-response" })
  for (const deploymentURL of ["https://attacker.invalid/v2/inference/deployments/x", URL + "/../x", URL + "?x=y"]) await assert.rejects(dispatch({ ...args(base()), entry: { ...entry(), deploymentURL } }), { code: "inference-destination" })
})

test("plugin model-in-path routing preserves signed two-turn loop and strips SDK credentials", async () => {
  const f = await pluginFixture((url, init) => {
    const body = JSON.parse(init.body)
    assert.equal("model" in body, false)
    assert.equal("stream" in body, false)
    if (body.contents.length === 1) return json(reply(signed))
    assert.deepEqual(body.contents[1], { role: "model", parts: signed })
    assert.equal(body.contents[2].parts[0].functionResponse.id, "multiply-1")
    assert.equal(body.contents[2].parts[0].functionResponse.response.product, 437)
    return json(reply())
  })
  const route = "/models/" + MODEL + ":generateContent"
  const { model, ...firstBody } = base()
  const first = await f.post(route, firstBody)
  assert.equal(first.status, 200)
  const content = (await first.json()).candidates[0].content
  const call = content.parts.find(part => part.functionCall).functionCall
  const second = await f.post(route, { contents: [...firstBody.contents, content, { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { product: call.args.x * call.args.y } } }] }] })
  assert.equal(second.status, 200)
  assert.equal((await second.json()).candidates[0].content.parts[0].text, "437")
  const calls = f.calls.filter(call => call.url.includes("/inference/"))
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.init.headers.authorization, "Bearer " + TOKEN.value)
    assert.equal(call.init.headers["x-goog-api-key"], undefined)
    assert.equal(call.init.headers["AI-Resource-Group"], CREDS.resourceGroup)
  }
  assert.ok(f.calls.some(call => new globalThis.URL(call.url).searchParams.get("executableIds")?.includes("gcp-vertexai")))
})

test("plugin accepts native streaming path and rejects wrong model/protocol/query before inference", async () => {
  const f = await pluginFixture(() => streamReply(frames([reply()])))
  const streamed = await f.post("/models/" + MODEL + ":streamGenerateContent?alt=sse", { contents: base().contents })
  assert.equal(streamed.status, 200)
  assert.equal(await streamed.text(), frames([reply()]))
  const mark = f.calls.length
  for (const [route, body] of [
    ["/responses", base()], ["/messages", base()],
    ["/models/" + MODEL + ":countTokens", base()],
    ["/models/" + MODEL + ":generateContent?alt=sse", base()],
    ["/models/" + MODEL + ":streamGenerateContent", base()],
    ["/models/" + MODEL + ":streamGenerateContent?alt=sse&key=x", base()],
    ["/models/" + MODEL + ":generateContent", base({ model: "gemini-4.2-pro" })],
    ["/models/" + MODEL + ":generateContent", base({ stream: true })],
  ]) assert.ok((await f.post(route, body)).status >= 400, route)
  assert.equal(f.calls.slice(mark).filter(call => call.url.includes("/inference/")).length, 0)
})

test("Gemini streaming preserves fragmented UTF-8 and applies cancellable backpressure", async () => {
  const wire = frames([reply([{ text: "café🙂" }])])
  const bytes = new TextEncoder().encode(wire)
  let offset = 0
  mockFetch(async () => new Response(new ReadableStream({
    pull(output) {
      if (offset === bytes.length) { output.close(); return }
      output.enqueue(bytes.slice(offset, ++offset))
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }))
  assert.equal(await (await dispatch(args(base({ stream: true })))).text(), wire)
  let pulls = 0
  let cancelled = false
  const events = [{ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] }, reply()]
  mockFetch(async () => new Response(new ReadableStream({
    pull(output) { output.enqueue(new TextEncoder().encode(frames([events[pulls++]]))) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }))
  const reader = (await dispatch(args(base({ stream: true })))).body.getReader()
  assert.equal(pulls, 0)
  await reader.read()
  assert.equal(pulls, 1)
  await reader.cancel()
  assert.equal(cancelled, true)
})

test("Gemini cancellation ends a stalled native stream without completion", async () => {
  let cancelled = false
  mockFetch(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }))
  const controller = new AbortController()
  const reader = (await dispatch({ ...args(base({ stream: true })), signal: controller.signal })).body.getReader()
  const pending = reader.read()
  controller.abort()
  await assert.rejects(pending)
  assert.equal(cancelled, true)
  let calls = 0
  mockFetch(async () => { calls++; return json(reply()) })
  await assert.rejects(dispatch({ ...args(base()), signal: controller.signal }))
  assert.equal(calls, 0)
})

test("verified Bearer refusal invalidates token once without replaying inference", async () => {
  let invalidated = 0
  let fetched = 0
  mockFetch(async () => {
    fetched++
    return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED", message: "expired" } }), { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } })
  })
  const response = await dispatch({ ...args(base()), rejectedToken: () => invalidated++ })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(invalidated, 1)
  assert.equal(fetched, 1)
})

test("native safety blocks remain distinct from malformed or truncated answers", async () => {
  const blocked = { promptFeedback: { blockReason: "SAFETY", safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", blocked: true }] }, usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 } }
  mockFetch(async () => json(blocked))
  assert.deepEqual(await (await dispatch(args(base()))).json(), blocked)
  mockFetch(async () => streamReply(frames([blocked])))
  assert.equal(await (await dispatch(args(base({ stream: true })))).text(), frames([blocked]))
  mockFetch(async () => streamReply(frames([{ usageMetadata: { totalTokenCount: -1 } }])))
  assert.match(await (await dispatch(args(base({ stream: true })))).text(), /"error"/)
})
