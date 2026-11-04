import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import definition from "../opencode2.mjs"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const ROOT = "https://api.ai.eu10.hana.ondemand.com"
const GPT = "gpt-6-astra"
const OPUS = "claude-opus-4-8"
const OPUS_SAP = "anthropic--claude-4.8-opus"
const TOKEN = "synthetic-opencode2-token"

function context() {
  const methods = []
  const transforms = []
  const sdkHooks = []
  const stored = new Map()
  const events = []
  let connection
  let credential
  let wake
  let refreshed
  const modelsRefreshed = new Promise(resolve => { refreshed = resolve })
  const ctx = {
    location: { directory: os.tmpdir() },
    integration: {
      transform: async transform => transform({ method: { update: method => methods.push(method) } }),
      connection: {
        active: async () => connection,
        resolve: async () => credential,
      },
    },
    provider: {
      transform: async transform => transforms.push(transform),
      reload: async () => refreshed(),
    },
    model: { reload: async () => {} },
    aisdk: { hook: async (name, callback, filter) => sdkHooks.push({ name, callback, filter }) },
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value) },
    event: {
      async *subscribe() {
        for (;;) {
          while (events.length) yield events.shift()
          await new Promise(resolve => { wake = resolve })
        }
      },
    },
  }
  const providers = () => {
    const result = []
    for (const transform of transforms) transform({ add: provider => result.push(provider) })
    return result
  }
  const emit = event => { events.push(event); wake?.() }
  return {
    ctx, methods, providers, sdkHooks, modelsRefreshed, emit,
    use(value) {
      connection = { type: "credential", id: "synthetic-account" }
      credential = value
      emit({ type: "credential.switched", data: { integrationID: "sap-aicore" } })
    },
  }
}

function backend() {
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  const calls = []
  const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
  const models = [
    { id: "gpt", name: GPT, version: "2026-09-03", executable: "azure-openai" },
    { id: "opus", name: OPUS_SAP, version: "1", executable: "aws-bedrock" },
    { id: "old-gpt", name: "gpt-5.9", version: "1", executable: "azure-openai" },
  ]
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/oauth/token") return json({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 })
    if (url.pathname === "/v2/lm/deployments") return json({ resources: url.searchParams.get("$skip") === "0" ? models.map(model => ({
      id: model.id, status: "RUNNING", deploymentUrl: `${ROOT}/v2/inference/deployments/${model.id}`, configurationId: `cfg-${model.id}`,
      details: { resources: { backendDetails: { model: { name: model.name, version: model.version } } } },
    })) : [] })
    if (url.pathname.startsWith("/v2/lm/configurations/")) {
      const model = models.find(model => url.pathname === `/v2/lm/configurations/cfg-${model.id}`)
      assert.ok(model, `unexpected configuration request ${url}`)
      return json({ id: `cfg-${model.id}`, scenarioId: "foundation-models", executableId: model.executable, parameterBindings: [{ key: "modelName", value: model.name }, { key: "modelVersion", value: model.version }] })
    }
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return json({ count: models.length, resources: models.map(model => ({
      model: model.name, executableId: model.executable, ...(model.executable === "aws-bedrock" ? { provider: "Anthropic", displayName: "Claude 4.8 Opus" } : {}),
      allowedScenarios: [{ scenarioId: "foundation-models", executableId: model.executable }],
      versions: [{ name: model.version, contextLength: 1000000, inputTypes: ["text", "image"], streamingSupported: true }],
    })) })
    calls.push({ url: url.href, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) })
    if (url.pathname === "/v2/inference/deployments/gpt/responses") return json({ id: "response-gpt", object: "response", model: GPT, status: "completed", output: [{ id: "message-gpt", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "GPT_BRIDGE_OK", annotations: [] }] }], error: null, incomplete_details: null, usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } })
    if (url.pathname === "/v2/inference/deployments/opus/invoke") return json({ id: "message-opus", type: "message", role: "assistant", model: OPUS, content: [{ type: "text", text: "CLAUDE_BRIDGE_OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 3 } })
    throw new Error(`unexpected inference request ${url}`)
  }
  return calls
}

test("OpenCode 2 setup keeps the unsigned SAP catalog empty and does not fetch credentials", async () => {
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error("unsigned setup must not request credentials") }
  const host = context()
  const stop = await definition.setup(host.ctx)
  cleanups.push(() => { stop(); host.emit({}) })
  assert.deepEqual(host.providers().map(provider => [provider.info.id, provider.models]), [["sap-aicore", []]])
  const signIn = host.methods.find(method => method.integrationID === "sap-aicore")
  assert.ok(signIn)
  assert.equal(signIn.method.form.find(field => field.key === "credentialFile").required, true)
  assert.equal(requests, 0)
})

test("OpenCode 2 credential-file sign-in discovers both families and routes their SDK requests safely", async () => {
  const calls = backend()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-opencode2-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, "credentials.json")
  fs.writeFileSync(credentialFile, JSON.stringify({ authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com", baseUrl: ROOT + "/v2", clientId: "synthetic-client", clientSecret: "synthetic-client-secret", resourceGroup: "bridge-group" }), { mode: 0o600 })
  const host = context()
  const stop = await definition.setup(host.ctx)
  cleanups.push(() => { stop(); host.emit({}) })
  const method = host.methods.find(method => method.integrationID === "sap-aicore")
  const signIn = await method.authorize({ credentialFile })
  host.use(await signIn.callback)
  await host.modelsRefreshed
  const provider = host.providers()[0]
  assert.deepEqual(provider.models.map(model => model.id).sort(), [OPUS, GPT])
  assert.deepEqual(provider.models.find(model => model.id === OPUS).capabilities.input, ["text", "image"])
  assert.equal(provider.models.find(model => model.id === OPUS).package, "aisdk:@ai-sdk/anthropic@ai-v6")
  const options = { baseURL: provider.info.settings.baseURL }
  await host.sdkHooks.find(hook => hook.name === "sdk" && hook.filter.providerID === "sap-aicore").callback({ options })
  const request = (route, body) => options.fetch(options.baseURL + route, { method: "POST", headers: { authorization: `Bearer ${options.apiKey}`, "x-api-key": "synthetic-caller-key" }, body: JSON.stringify(body) })
  const gpt = await request("/responses", { model: GPT, input: "hello", store: false })
  assert.equal(gpt.status, 200)
  assert.equal((await gpt.json()).output[0].content[0].text, "GPT_BRIDGE_OK")
  const claude = await request("/messages", { model: OPUS, messages: [{ role: "user", content: "hello" }], max_tokens: 64 })
  assert.equal(claude.status, 200)
  assert.equal((await claude.json()).content[0].text, "CLAUDE_BRIDGE_OK")
  assert.deepEqual(calls.map(call => call.url), [`${ROOT}/v2/inference/deployments/gpt/responses`, `${ROOT}/v2/inference/deployments/opus/invoke`])
  for (const call of calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(call.headers["ai-resource-group"], "bridge-group")
    assert.equal(call.headers["x-api-key"], undefined)
  }
  assert.equal(calls[1].body.anthropic_version, "bedrock-2023-05-31")
  assert.equal(calls[1].body.model, undefined)
  assert.equal(calls[1].body.stream, undefined)
}, 15000)
