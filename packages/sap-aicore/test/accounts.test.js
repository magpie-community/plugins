import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SAPAICorePlugin } from "../src/index.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const ROOT = "https://api.ai.eu10.hana.ondemand.com"
const urlFor = id => ROOT + "/v2/inference/deployments/" + id

// Two accounts/resource groups with overlapping canonical GPT and Claude names
// but distinct raw SAP identities and deployments for the same canonical Claude
// model (version-first vs variant-first SAP format, both -> claude-opus-4-8).
const GROUPS = {
  "group-a": {
    client: "client-a",
    gpt: { did: "deploy-a-gpt", cid: "cfg-a-gpt" },
    opus: { sap: "anthropic--claude-4.8-opus", display: "Claude 4.8 Opus", did: "deploy-a-opus", cid: "cfg-a-opus" },
  },
  "group-b": {
    client: "client-b",
    gpt: { did: "deploy-b-gpt", cid: "cfg-b-gpt" },
    opus: { sap: "anthropic--claude-opus-4.8", display: "Claude Opus 4.8", did: "deploy-b-opus", cid: "cfg-b-opus" },
  },
}

const message = model => ({ id: "msg_" + model, type: "message", role: "assistant", model, content: [{ type: "text", text: "OK:" + model }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } })

function backend(creds, group) {
  const json = body => new Response(JSON.stringify(body))
  const g = GROUPS[group]
  const deployments = [
    { id: g.gpt.did, status: "RUNNING", deploymentUrl: urlFor(g.gpt.did), configurationId: g.gpt.cid, details: { resources: { backendDetails: { model: { name: "gpt-6-astra", version: "2026-09-03" } } } } },
    { id: g.opus.did, status: "RUNNING", deploymentUrl: urlFor(g.opus.did), configurationId: g.opus.cid, details: { resources: { backendDetails: { model: { name: g.opus.sap, version: "1" } } } } },
  ]
  const configs = {
    [g.gpt.cid]: { id: g.gpt.cid, scenarioId: "foundation-models", executableId: "azure-openai", parameterBindings: [{ key: "modelName", value: "gpt-6-astra" }, { key: "modelVersion", value: "2026-09-03" }] },
    [g.opus.cid]: { id: g.opus.cid, scenarioId: "foundation-models", executableId: "aws-bedrock", parameterBindings: [{ key: "modelName", value: g.opus.sap }, { key: "modelVersion", value: "1" }] },
  }
  const catalog = { count: 2, resources: [
    { model: "gpt-6-astra", executableId: "azure-openai", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }], versions: [{ name: "2026-09-03", contextLength: 1050000, inputTypes: ["text"], streamingSupported: true }] },
    { model: g.opus.sap, executableId: "aws-bedrock", provider: "Anthropic", displayName: g.opus.display, allowedScenarios: [{ scenarioId: "foundation-models", executableId: "aws-bedrock" }], versions: [{ name: "1", contextLength: 1000000, inputTypes: ["text"], streamingSupported: true }] },
  ] }
  return { json, deployments, configs, catalog }
}

function install(counters) {
  const original = globalThis.fetch
  cleanups.push(() => { globalThis.fetch = original })
  const inference = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const json = body => new Response(JSON.stringify(body))
    if (url.pathname === "/oauth/token") {
      const basic = Buffer.from((init.headers.Authorization || "").replace(/^Basic\s+/, ""), "base64").toString("utf8")
      const client = basic.split(":")[0]
      counters.oauth[client] = (counters.oauth[client] ?? 0) + 1
      return json({ access_token: "token-" + client, token_type: "bearer", expires_in: 3600 })
    }
    const group = init.headers?.["AI-Resource-Group"]
    const b = backend(null, group)
    if (url.pathname === "/v2/lm/deployments") return b.json({ resources: url.searchParams.get("$skip") === "0" ? b.deployments : [] })
    if (url.pathname.startsWith("/v2/lm/configurations/")) return b.json(b.configs[url.pathname.slice("/v2/lm/configurations/".length)])
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return b.json(b.catalog)
    // inference
    inference.push({ url: url.href, group, auth: init.headers.authorization })
    const model = url.pathname.includes("-opus") ? "claude-opus-4-8" : "gpt-6-astra"
    if (url.pathname.endsWith("/responses")) return new Response(JSON.stringify({ id: "resp", object: "response", model, status: "completed", output: [{ id: "m", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK:" + model, annotations: [] }] }], usage: {}, error: null, incomplete_details: null }))
    return new Response(JSON.stringify(message(model)))
  }
  return inference
}

function writeCreds(dir, name, group) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify({
    authUrl: "https://t.authentication.eu10.hana.ondemand.com",
    baseUrl: ROOT + "/v2",
    clientId: GROUPS[group].client,
    clientSecret: "secret-" + group,
    resourceGroup: group,
  }), { mode: 0o600 })
  return file
}

async function account(plugin, credentialFile) {
  const signed = await plugin.auth.methods[0].authorize({ credentialFile })
  assert.equal(signed.type, "success")
  const auth = { type: "api", key: signed.key, metadata: signed.metadata }
  const loader = await plugin.auth.loader(async () => auth)
  return { auth, loader }
}

test("two accounts expose the same canonical Claude ID yet dispatch never crosses identity, group or protocol", async () => {
  const counters = { oauth: {} }
  const inference = install(counters)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-accounts-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fileA = writeCreds(dir, "a.json", "group-a")
  const fileB = writeCreds(dir, "b.json", "group-b")

  const plugin = await SAPAICorePlugin()
  const a = await account(plugin, fileA)
  const b = await account(plugin, fileB)

  // Both accounts list the same canonical IDs with canonical (never raw SAP) api.id.
  for (const acc of [a, b]) {
    const models = await plugin.provider.models({ models: {} }, { auth: acc.auth })
    assert.deepEqual(Object.keys(models).sort(), ["claude-opus-4-8", "gpt-6-astra"])
    assert.deepEqual(models["claude-opus-4-8"].api, { id: "claude-opus-4-8", npm: "@ai-sdk/anthropic" })
  }

  // Claude dispatch on each account reaches that account's own deployment/group.
  const ra = await a.loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) })
  const rb = await b.loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) })
  assert.equal(ra.status, 200)
  assert.equal(rb.status, 200)

  const opusCalls = inference.filter(c => c.url.includes("-opus/invoke"))
  assert.deepEqual(opusCalls.map(c => c.url).sort(), [urlFor("deploy-a-opus") + "/invoke", urlFor("deploy-b-opus") + "/invoke"])
  const a1 = opusCalls.find(c => c.group === "group-a")
  const b1 = opusCalls.find(c => c.group === "group-b")
  assert.equal(a1.url, urlFor("deploy-a-opus") + "/invoke")
  assert.equal(a1.auth, "Bearer token-client-a")
  assert.equal(b1.url, urlFor("deploy-b-opus") + "/invoke")
  assert.equal(b1.auth, "Bearer token-client-b")
})

test("GPT and Claude share one account-scoped token without extra OAuth exchanges or crossing accounts", async () => {
  const counters = { oauth: {} }
  const inference = install(counters)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-accounts-tok-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plugin = await SAPAICorePlugin()
  const a = await account(plugin, writeCreds(dir, "a.json", "group-a"))

  await a.loader.fetch(ROOT + "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", input: "hi" }) })
  await a.loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) })

  assert.equal(counters.oauth["client-a"], 1, "a single OAuth exchange serves both protocols")
  assert.equal(counters.oauth["client-b"], undefined, "no cross-account token work")
  assert.deepEqual(inference.map(c => c.group), ["group-a", "group-a"])
})

test("after a restart a fresh plugin rebuilds discovery and dispatch from the credential file alone", async () => {
  const counters = { oauth: {} }
  const inference = install(counters)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-accounts-restart-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = writeCreds(dir, "b.json", "group-b")

  // First process: sign in and dispatch.
  const first = await SAPAICorePlugin()
  const a1 = await account(first, file)
  assert.equal((await a1.loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) })).status, 200)

  // Restart: a brand-new plugin instance with no prior in-memory state, only the
  // stored credential-file reference, rebuilds the same canonical mapping.
  const second = await SAPAICorePlugin()
  const stored = { type: "api", key: a1.auth.key, metadata: a1.auth.metadata }
  const loader = await second.auth.loader(async () => stored)
  const models = await second.provider.models({ models: {} }, { auth: stored })
  assert.equal(models["claude-opus-4-8"].api.id, "claude-opus-4-8")
  const response = await loader.fetch(ROOT + "/messages", { method: "POST", body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) })
  assert.equal(response.status, 200)
  assert.equal(inference.at(-1).url, urlFor("deploy-b-opus") + "/invoke", "restart rebuilds the group-b raw identity/deployment mapping")
})
