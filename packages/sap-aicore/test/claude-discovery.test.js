import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import { resolveDeployment, projectModels, discover } from "../src/discovery.js"
import { claudeFamily, resolveCanonicalClaude } from "../src/identity.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"
const GROUP = "default"
const OPUS_ID = "d9df30a64cef44d6"
const SONNET_ID = "d41e534c5ac13dbf"
const OPUS_SAP = "anthropic--claude-4.8-opus"
const SONNET_SAP = "anthropic--claude-4.6-sonnet"

// --- canonical identity resolver ------------------------------------------

test("resolver maps the baseline display names to conventional canonical IDs", () => {
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: OPUS_SAP, displayName: "Claude 4.8 Opus" }),
    { canonicalID: "claude-opus-4-8", displayLabel: "Claude Opus 4.8" })
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: SONNET_SAP, displayName: "Claude 4.6 Sonnet" }),
    { canonicalID: "claude-sonnet-4-6", displayLabel: "Claude Sonnet 4.6" })
})

test("resolver falls back to the SAP identity format when no display name is present", () => {
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: OPUS_SAP }),
    { canonicalID: "claude-opus-4-8", displayLabel: "Claude Opus 4.8" })
})

test("resolver is stable across changed prefix, delimiter and token order", () => {
  for (const id of ["aws__claude-4.8-opus", "bedrock::claude-4.8-opus", "anthropic--claude-opus-4.8"]) {
    assert.equal(resolveCanonicalClaude({ sapIdentity: id }).canonicalID, "claude-opus-4-8", id)
  }
})

test("resolver derives newer models from metadata without a code change", () => {
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: "anthropic--claude-4.9-opus", displayName: "Claude 4.9 Opus" }),
    { canonicalID: "claude-opus-4-9", displayLabel: "Claude Opus 4.9" })
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: "x", displayName: "Claude Haiku 5" }),
    { canonicalID: "claude-haiku-5", displayLabel: "Claude Haiku 5" })
})

test("resolver preserves meaningful suffixes rather than collapsing releases", () => {
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: "z", displayName: "Claude 3.5 Sonnet 20241022" }),
    { canonicalID: "claude-sonnet-3-5-20241022", displayLabel: "Claude Sonnet 3.5 20241022" })
})

test("resolver reads hyphenated numeric versions in either token order and case", () => {
  for (const id of ["anthropic--claude-opus-4-8", "anthropic--claude-4-8-opus", "AWS__Claude-OPUS-4-8"]) {
    const r = resolveCanonicalClaude({ sapIdentity: id })
    assert.equal(r.canonicalID, "claude-opus-4-8", id)
    assert.equal(r.displayLabel, "Claude Opus 4.8", id)
  }
})

test("resolver keeps a long numeric date suffix out of the hyphenated version", () => {
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: "anthropic--claude-sonnet-3-5-20241022" }),
    { canonicalID: "claude-sonnet-3-5-20241022", displayLabel: "Claude Sonnet 3.5 20241022" })
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: "anthropic--claude-opus-4-8-preview", displayName: "Claude 4.8 Opus PREVIEW" }),
    { canonicalID: "claude-opus-4-8-preview", displayLabel: "Claude Opus 4.8 PREVIEW" })
})

test("resolver rejects non-string evidence and present-but-unparseable display names", () => {
  assert.equal(resolveCanonicalClaude({ sapIdentity: OPUS_SAP, displayName: { foo: 1 } }), null)
  assert.equal(resolveCanonicalClaude({ sapIdentity: 42, displayName: "Claude 4.8 Opus" }), null)
  assert.equal(resolveCanonicalClaude({ sapIdentity: OPUS_SAP, displayName: "Totally Bogus" }), null)
})

test("resolver reports conflicting display vs identity evidence instead of guessing", () => {
  assert.equal(resolveCanonicalClaude({ sapIdentity: OPUS_SAP, displayName: "Claude 4.6 Sonnet" }), null)
})

test("resolver returns null for genuinely opaque, unrecognized evidence", () => {
  assert.equal(resolveCanonicalClaude({ sapIdentity: "opaque-key-1234", displayName: "Mystery Model" }), null)
  assert.equal(resolveCanonicalClaude({}), null)
})

test("resolver falls back to the SAP identity format for an absent (whitespace) display name", () => {
  assert.deepEqual(resolveCanonicalClaude({ sapIdentity: OPUS_SAP, displayName: "   " }),
    { canonicalID: "claude-opus-4-8", displayLabel: "Claude Opus 4.8" })
})

test("claudeFamily recognizes Anthropic by provider or Claude identity, not executable alone", () => {
  assert.equal(claudeFamily({ provider: "Anthropic" }), true)
  assert.equal(claudeFamily({ sapIdentity: OPUS_SAP }), true)
  assert.equal(claudeFamily({ displayName: "Claude 4.8 Opus" }), true)
  assert.equal(claudeFamily({ provider: "Amazon", sapIdentity: "amazon--titan-text", displayName: "Titan Text" }), false)
  assert.equal(claudeFamily({}), false)
})

test("explicit non-Anthropic or malformed family metadata overrides Claude-like names", () => {
  for (const provider of ["Amazon", "OpenAI", "", 42, null, {}]) {
    assert.equal(claudeFamily({ provider, sapIdentity: OPUS_SAP, displayName: "Claude 4.8 Opus" }), false)
  }
  assert.equal(claudeFamily({ provider: "Anthropic", sapIdentity: 42 }), false)
  assert.equal(claudeFamily({ provider: "Anthropic", displayName: {} }), false)
  assert.equal(claudeFamily({ sapIdentity: OPUS_SAP, displayName: null }), false)
})

// --- Claude eligibility (resolveDeployment) --------------------------------

function urlFor(id) { return AI_ROOT + "/v2/inference/deployments/" + id }

function bedrockDeployment(id, sapModel, version, cid) {
  return {
    id,
    status: "RUNNING",
    deploymentUrl: urlFor(id),
    configurationId: cid,
    details: { resources: { backendDetails: { model: { name: sapModel, version } } } },
  }
}

function bedrockConfig(sapModel, version, cid) {
  return {
    id: cid,
    scenarioId: "foundation-models",
    executableId: "aws-bedrock",
    parameterBindings: [
      { key: "modelName", value: sapModel },
      ...(version === undefined ? [] : [{ key: "modelVersion", value: version }]),
    ],
  }
}

function bedrockCatalog(sapModel, version, { displayName, provider = "Anthropic", contextLength = 1000000, inputTypes = ["text", "image"] } = {}) {
  return {
    count: 1,
    resources: [{
      model: sapModel,
      executableId: "aws-bedrock",
      provider,
      displayName,
      allowedScenarios: [{ scenarioId: "foundation-models", executableId: "aws-bedrock" }],
      versions: [{ name: version, contextLength, inputTypes, deprecated: false, retirementDate: "", streamingSupported: true }],
    }],
  }
}

function opus(over = {}) {
  return {
    deployment: bedrockDeployment(OPUS_ID, OPUS_SAP, "1", "cfg-opus"),
    configuration: bedrockConfig(OPUS_SAP, "1", "cfg-opus"),
    catalog: bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" }),
    aiRoot: AI_ROOT,
    ...over,
  }
}

test("a running Bedrock Claude deployment resolves to a frozen anthropic entry with canonical identity", () => {
  const entry = resolveDeployment(opus())
  assert.equal(entry.protocol, "anthropic")
  assert.equal(entry.canonicalID, "claude-opus-4-8")
  assert.equal(entry.displayLabel, "Claude Opus 4.8")
  assert.equal(entry.apiNpm, "@ai-sdk/anthropic")
  assert.equal(entry.modelName, OPUS_SAP, "raw SAP identity retained for account-local routing")
  assert.equal(entry.deploymentID, OPUS_ID)
  assert.equal(entry.deploymentURL, urlFor(OPUS_ID))
  assert.equal(entry.activeVersion, "1")
  assert.equal(entry.executableID, "aws-bedrock")
  assert.deepEqual(entry.routePolicy, { invoke: "/invoke", stream: "/invoke-with-response-stream", query: false })
  assert.deepEqual(entry.capabilities, { text: true, functionTool: true, streaming: true, image: true })
  assert.equal(entry.metadata.contextLength, 1000000)
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.routePolicy))
  assert.deepEqual(entry.requestPolicy,
    { maxOutputTokens: 128000, rejectTemperature: true, rejectTopP: true, rejectEnabledThinking: true })
  assert.ok(Object.isFrozen(entry.requestPolicy))
})

test("a newer Claude model/version is eligible by contract with version-specific metadata, no allowlist", () => {
  const entry = resolveDeployment({
    deployment: bedrockDeployment(OPUS_ID, "anthropic--claude-4.9-opus", "2", "cfg-x"),
    configuration: bedrockConfig("anthropic--claude-4.9-opus", "latest", "cfg-x"),
    catalog: bedrockCatalog("anthropic--claude-4.9-opus", "2", { displayName: "Claude 4.9 Opus", contextLength: 2000000 }),
    aiRoot: AI_ROOT,
  })
  assert.equal(entry.canonicalID, "claude-opus-4-9")
  assert.equal(entry.activeVersion, "2")
  assert.equal(entry.metadata.contextLength, 2000000, "limits come from its own version, not a baseline")
  assert.equal(entry.requestPolicy, undefined, "a newer version never inherits the baseline request policy")
})

test("a Claude backend latest selector is unresolved even with matching catalog metadata", () => {
  for (const configuredVersion of [undefined, "latest"]) {
    assert.equal(resolveDeployment(opus({
      deployment: bedrockDeployment(OPUS_ID, OPUS_SAP, "latest", "cfg-opus"),
      configuration: bedrockConfig(OPUS_SAP, configuredVersion, "cfg-opus"),
      catalog: bedrockCatalog(OPUS_SAP, "latest", { displayName: "Claude 4.8 Opus" }),
    })), null)
  }
})

test("a newer active version of a baseline release does not inherit its output or sampling policy", () => {
  const entry = resolveDeployment({
    deployment: bedrockDeployment(OPUS_ID, OPUS_SAP, "2", "cfg-x"),
    configuration: bedrockConfig(OPUS_SAP, "latest", "cfg-x"),
    catalog: bedrockCatalog(OPUS_SAP, "2", { displayName: "Claude 4.8 Opus" }),
    aiRoot: AI_ROOT,
  })
  assert.equal(entry.activeVersion, "2")
  assert.equal(entry.requestPolicy, undefined)
  assert.equal(projectModels({ [entry.canonicalID]: entry })[entry.canonicalID].limit.output, undefined)
})

test("a non-Claude Bedrock model (Titan) is silently skipped, not an error", () => {
  const entry = resolveDeployment({
    deployment: bedrockDeployment(OPUS_ID, "amazon--titan-text", "1", "cfg-t"),
    configuration: bedrockConfig("amazon--titan-text", "1", "cfg-t"),
    catalog: bedrockCatalog("amazon--titan-text", "1", { displayName: "Titan Text", provider: "Amazon" }),
    aiRoot: AI_ROOT,
  })
  assert.equal(entry, null)
})

test("a Claude deployment whose identity cannot be resolved throws an observable discovery error", () => {
  assert.throws(() => resolveDeployment({
    deployment: bedrockDeployment(OPUS_ID, "opaque-key-9", "1", "cfg-o"),
    configuration: bedrockConfig("opaque-key-9", "1", "cfg-o"),
    catalog: bedrockCatalog("opaque-key-9", "1", { displayName: "Mystery", provider: "Anthropic" }),
    aiRoot: AI_ROOT,
  }), { code: "identity" })
})

test("a Bedrock catalog that omits the running version is not eligible", () => {
  assert.equal(resolveDeployment(opus({ catalog: bedrockCatalog(OPUS_SAP, "2", { displayName: "Claude 4.8 Opus" }) })), null)
})

test("the Sonnet baseline carries its own request policy and projected output limit", () => {
  const entry = resolveDeployment({
    deployment: bedrockDeployment(SONNET_ID, SONNET_SAP, "1", "cfg-s"),
    configuration: bedrockConfig(SONNET_SAP, "1", "cfg-s"),
    catalog: bedrockCatalog(SONNET_SAP, "1", { displayName: "Claude 4.6 Sonnet" }),
    aiRoot: AI_ROOT,
  })
  assert.equal(entry.canonicalID, "claude-sonnet-4-6")
  assert.deepEqual(entry.requestPolicy,
    { maxOutputTokens: 128000, rejectCombinedSampling: true, rejectForcedToolThinking: true })
  const model = projectModels({ [entry.canonicalID]: entry })["claude-sonnet-4-6"]
  assert.equal(model.limit.output, 128000)
})

test("a Claude version without explicit streaming support remains available for whole requests only", () => {
  for (const supported of [undefined, false]) {
    const catalog = bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" })
    if (supported === undefined) delete catalog.resources[0].versions[0].streamingSupported
    else catalog.resources[0].versions[0].streamingSupported = supported
    const entry = resolveDeployment(opus({ catalog }))
    assert.equal(entry.canonicalID, "claude-opus-4-8")
    assert.equal(entry.capabilities.streaming, false)
  }
})

test("malformed or conflicting provider metadata cannot qualify through a Claude identity", () => {
  for (const [field, value] of [["provider", "Amazon"], ["provider", 42], ["provider", null], ["displayName", { unexpected: true }], ["displayName", null]]) {
    const catalog = bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" })
    catalog.resources[0][field] = value
    assert.equal(resolveDeployment(opus({ catalog })), null)
  }
})

// --- projection ------------------------------------------------------------

test("projectModels publishes Claude under @ai-sdk/anthropic and enables image/attachment from the catalog", () => {
  const entry = resolveDeployment(opus())
  const model = projectModels({ [entry.canonicalID]: entry })["claude-opus-4-8"]
  assert.deepEqual(model.api, { id: "claude-opus-4-8", npm: "@ai-sdk/anthropic" })
  assert.equal(model.name, "Claude Opus 4.8")
  assert.equal(model.capabilities.attachment, true)
  assert.equal(model.capabilities.input.image, true)
  assert.equal(model.limit.context, 1000000)
  assert.equal(model.limit.output, 128000)
})

// --- discover(): both families, collisions, duplicates ---------------------

function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (href, init) => { calls.push({ href: String(href), init }); return handler(String(href), init) }
  cleanups.push(() => { globalThis.fetch = original })
  return calls
}

function ok(payload) {
  return { ok: true, status: 200, redirected: false, url: "", body: new Response(JSON.stringify(payload)).body }
}

function gptConfig(model, version, cid) {
  return { id: cid, scenarioId: "foundation-models", executableId: "azure-openai", parameterBindings: [{ key: "modelName", value: model }, { key: "modelVersion", value: version }] }
}

function gptCatalogResource(model, version) {
  return { model, executableId: "azure-openai", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }], versions: [{ name: version, contextLength: 1050000, inputTypes: ["text"], deprecated: false, retirementDate: "", streamingSupported: true }] }
}

function mixedRouter({ deployments, configs, catalog }) {
  return href => {
    const url = new URL(href)
    if (url.pathname === "/v2/lm/deployments") return url.searchParams.get("$skip") === "0" ? ok({ resources: deployments }) : ok({ resources: [] })
    if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return ok(catalog)
    if (url.pathname.startsWith("/v2/lm/configurations/")) return ok(configs[url.pathname.slice("/v2/lm/configurations/".length)])
    throw new Error("unexpected path " + url.pathname)
  }
}

const base = { aiRoot: AI_ROOT, resourceGroup: GROUP, bearer: async () => "tok" }

test("discovery lists GPT and Claude together, each under its own protocol identity", async () => {
  installFetch(mixedRouter({
    deployments: [
      { id: "d02212989ca345a2", status: "RUNNING", deploymentUrl: urlFor("d02212989ca345a2"), configurationId: "cfg-gpt", details: { resources: { backendDetails: { model: { name: "gpt-6-astra", version: "2026-09-03" } } } } },
      bedrockDeployment(OPUS_ID, OPUS_SAP, "1", "cfg-opus"),
      bedrockDeployment(SONNET_ID, SONNET_SAP, "1", "cfg-sonnet"),
    ],
    configs: { "cfg-gpt": gptConfig("gpt-6-astra", "2026-09-03", "cfg-gpt"), "cfg-opus": bedrockConfig(OPUS_SAP, "1", "cfg-opus"), "cfg-sonnet": bedrockConfig(SONNET_SAP, "1", "cfg-sonnet") },
    catalog: {
      count: 3,
      resources: [
        gptCatalogResource("gpt-6-astra", "2026-09-03"),
        bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" }).resources[0],
        bedrockCatalog(SONNET_SAP, "1", { displayName: "Claude 4.6 Sonnet" }).resources[0],
      ],
    },
  }))
  const registry = await discover(base)
  assert.deepEqual(Object.keys(registry), ["claude-opus-4-8", "claude-sonnet-4-6", "gpt-6-astra"])
  assert.equal(registry["claude-opus-4-8"].protocol, "anthropic")
  assert.equal(registry["claude-opus-4-8"].modelName, OPUS_SAP)
  assert.equal(registry["gpt-6-astra"].protocol, "responses")
  const models = projectModels(registry)
  assert.equal(models["claude-sonnet-4-6"].api.npm, "@ai-sdk/anthropic")
  assert.equal(models["gpt-6-astra"].api.npm, "@ai-sdk/openai")
})

test("distinct Claude identities colliding only via SAP-format fallback fail discovery with a conflict", async () => {
  installFetch(mixedRouter({
    deployments: [
      bedrockDeployment(OPUS_ID, OPUS_SAP, "1", "cfg-a"),
      bedrockDeployment(SONNET_ID, "anthropic--claude-opus-4.8", "1", "cfg-b"),
    ],
    configs: { "cfg-a": bedrockConfig(OPUS_SAP, "1", "cfg-a"), "cfg-b": bedrockConfig("anthropic--claude-opus-4.8", "1", "cfg-b") },
    catalog: {
      count: 2,
      resources: [
        bedrockCatalog(OPUS_SAP, "1").resources[0],
        bedrockCatalog("anthropic--claude-opus-4.8", "1").resources[0],
      ],
    },
  }))
  await assert.rejects(discover(base), e => e.code === "discovery-conflict" || e.code === "conflict")
})

test("distinct SAP identities with authoritative, equivalent display metadata dedup to the lowest ID", async () => {
  const lowId = "d0000000000000b2"
  installFetch(mixedRouter({
    deployments: [
      bedrockDeployment(OPUS_ID, OPUS_SAP, "1", "cfg-a"),
      bedrockDeployment(lowId, "anthropic--claude-opus-4.8", "1", "cfg-b"),
    ],
    configs: { "cfg-a": bedrockConfig(OPUS_SAP, "1", "cfg-a"), "cfg-b": bedrockConfig("anthropic--claude-opus-4.8", "1", "cfg-b") },
    catalog: {
      count: 2,
      resources: [
        bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" }).resources[0],
        bedrockCatalog("anthropic--claude-opus-4.8", "1", { displayName: "Claude Opus 4.8" }).resources[0],
      ],
    },
  }))
  const registry = await discover(base)
  assert.deepEqual(Object.keys(registry), ["claude-opus-4-8"])
  assert.equal(registry["claude-opus-4-8"].deploymentID, lowId)
  assert.equal(registry["claude-opus-4-8"].modelName, "anthropic--claude-opus-4.8")
})

test("authoritative equivalent names still conflict when version or capability metadata differs", async () => {
  for (const difference of ["version", "streaming"]) {
    const other = "opaque-opus-key"
    const version = difference === "version" ? "2" : "1"
    const otherCatalog = bedrockCatalog(other, version, { displayName: "Claude Opus 4.8" }).resources[0]
    if (difference === "streaming") otherCatalog.versions[0].streamingSupported = false
    installFetch(mixedRouter({
      deployments: [bedrockDeployment(OPUS_ID, OPUS_SAP, "1", "cfg-a"), bedrockDeployment(SONNET_ID, other, version, "cfg-b")],
      configs: { "cfg-a": bedrockConfig(OPUS_SAP, "1", "cfg-a"), "cfg-b": bedrockConfig(other, version, "cfg-b") },
      catalog: { count: 2, resources: [bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" }).resources[0], otherCatalog] },
    }))
    await assert.rejects(discover(base), { code: "conflict" })
  }
})

test("duplicate deployments of the same Claude model/version select deterministically by lowest ID", async () => {
  const lowId = "d0000000000000a1"
  installFetch(mixedRouter({
    deployments: [
      bedrockDeployment(OPUS_ID, OPUS_SAP, "1", "cfg-opus"),
      bedrockDeployment(lowId, OPUS_SAP, "1", "cfg-opus"),
    ],
    configs: { "cfg-opus": bedrockConfig(OPUS_SAP, "1", "cfg-opus") },
    catalog: bedrockCatalog(OPUS_SAP, "1", { displayName: "Claude 4.8 Opus" }),
  }))
  const registry = await discover(base)
  assert.deepEqual(Object.keys(registry), ["claude-opus-4-8"])
  assert.equal(registry["claude-opus-4-8"].deploymentID, lowId)
})
