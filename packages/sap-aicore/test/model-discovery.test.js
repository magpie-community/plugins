import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { SAPAICorePlugin } from "../src/index.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const CREDS = {
  authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com",
  baseUrl: "https://api.ai.eu10.hana.ondemand.com",
  clientId: "synthetic-id",
  clientSecret: "synthetic-secret",
  resourceGroup: "default",
}
const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"

const DEPLOYMENTS = "/v2/lm/deployments"
const CATALOG = "/v2/lm/scenarios/foundation-models/models"
const CONFIG = "/v2/lm/configurations/"
const TOKEN = "/oauth/token"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "magpie-model-discovery-"))
}

function writeCreds(dir, name, overrides = {}) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify({ ...CREDS, ...overrides }), { mode: 0o600 })
  return p
}

function pathKey(normalized) {
  return "sap-aicore:path:" + createHash("sha256").update("sap-aicore:path:" + normalized).digest("hex")
}

function authFor(credentialFile) {
  return { type: "api", key: pathKey(credentialFile), metadata: { credentialFile } }
}

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), init)
}

function tokenReply(overrides = {}) {
  return json({ access_token: "synthetic-token", token_type: "bearer", expires_in: 43199, ...overrides })
}

function pathOf(href) {
  return new URL(String(href instanceof Request ? href.url : href)).pathname
}

function urlFor(id) {
  return AI_ROOT + "/v2/inference/deployments/" + id
}

function row(id, model, version, configurationId) {
  return {
    id,
    status: "RUNNING",
    deploymentUrl: urlFor(id),
    configurationId,
    details: { resources: { backendDetails: { model: { name: model, version } } } },
  }
}

function config(model, version, id) {
  return {
    id,
    scenarioId: "foundation-models",
    executableId: "azure-openai",
    parameterBindings: [
      { key: "modelName", value: model },
      { key: "modelVersion", value: version },
    ],
  }
}

function catalogFor(...entries) {
  return {
    count: entries.length,
    resources: entries.map(([model, version]) => ({
      model,
      executableId: "azure-openai",
      allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }],
      versions: [{
        name: version,
        contextLength: 1050000,
        inputTypes: ["text"],
        deprecated: false,
        retirementDate: "",
        streamingSupported: true,
      }],
    })),
  }
}

function router(routes) {
  return (href) => {
    const url = new URL(String(href instanceof Request ? href.url : href))
    if (url.pathname === TOKEN) return tokenReply()
    if (url.pathname === DEPLOYMENTS) {
      return url.searchParams.get("$skip") === "0" ? json(routes.deployments) : json({ resources: [] })
    }
    if (url.pathname === CATALOG) return json(routes.catalog)
    if (url.pathname.startsWith(CONFIG)) {
      const body = routes.configs[url.pathname.slice(CONFIG.length)]
      return body && body.body !== undefined ? body : json(body)
    }
    throw new Error("unexpected path " + url.pathname)
  }
}

function withFetch(mock, fn) {
  const real = globalThis.fetch
  globalThis.fetch = mock
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = real })
}

async function authorize(plugin, mock, credentialFile) {
  const result = await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile }))
  assert.equal(result.type, "success")
  return { type: "api", key: result.key, metadata: result.metadata }
}

const ASTRA = ["gpt-6-astra", "2026-09-03"]
const SOL = ["gpt-6.1-sol", "2026-09-29"]

test("unsigned models performs no IO and returns an empty catalog", async () => {
  const plugin = await SAPAICorePlugin()
  let called = false
  await withFetch(async () => { called = true; return json({}) }, async () => {
    assert.deepEqual(await plugin.provider.models({ models: {} }), {})
    assert.deepEqual(await plugin.provider.models({ models: {} }, {}), {})
    assert.deepEqual(await plugin.provider.models({ models: {} }, { auth: null }), {})
  })
  assert.equal(called, false)
})

test("a signed account projects exactly the two verified models through the hook", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cidA = "c" + "0".repeat(15)
    const cidB = "c" + "1".repeat(15)
    const mock = router({
      deployments: { resources: [
        row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cidA),
        row("d0000000000000b1", "gpt-6.1-sol", "2026-09-29", cidB),
      ] },
      configs: {
        [cidA]: config("gpt-6-astra", "2026-09-03", cidA),
        [cidB]: config("gpt-6.1-sol", "2026-09-29", cidB),
      },
      catalog: catalogFor(ASTRA, SOL),
    })
    const p = writeCreds(dir, "two.json")
    const auth = await authorize(plugin, mock, p)
    const catalog = await withFetch(mock, () => plugin.provider.models({ models: {} }, { auth }))

    assert.deepEqual(Object.keys(catalog).sort(), ["gpt-6-astra", "gpt-6.1-sol"])
    assert.deepEqual(catalog["gpt-6-astra"], {
      id: "gpt-6-astra",
      name: "gpt-6-astra",
      providerID: "sap-aicore",
      api: { id: "gpt-6-astra", npm: "@ai-sdk/openai" },
      capabilities: {
        toolcall: true,
        attachment: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
      limit: { context: 1050000 },
    })
    assert.equal(catalog["gpt-6.1-sol"].api.npm, "@ai-sdk/openai")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a newer GPT model is listed and dispatched through Responses without an allowlist entry", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const model = "gpt-7-mini"
    const version = "2027-01-01"
    const id = "deployment-new-gpt"
    const cid = "config-new-gpt"
    const discovery = router({
      deployments: { resources: [row(id, model, version, cid)] },
      configs: { [cid]: config(model, "latest", cid) },
      catalog: catalogFor([model, version]),
    })
    const sent = []
    const mock = (href, init) => {
      if (String(href) !== urlFor(id) + "/responses") return discovery(href)
      sent.push(JSON.parse(init.body))
      return json({ id: "resp_new", object: "response", model, status: "completed", output: [] })
    }
    const auth = await authorize(plugin, mock, writeCreds(dir, "new-gpt.json"))
    await withFetch(mock, async () => {
      const catalog = await plugin.provider.models({ models: {} }, { auth })
      assert.deepEqual(Object.keys(catalog), [model])
      assert.deepEqual(catalog[model].api, { id: model, npm: "@ai-sdk/openai" })
      const loader = await plugin.auth.loader(async () => auth)
      const response = await loader.fetch(AI_ROOT + "/responses", {
        method: "POST", body: JSON.stringify({ model, input: "hello" }),
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).model, model)
      assert.deepEqual(sent, [{ model, input: "hello", store: false }])
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a mixed GPT and Claude account lists both under their protocol identities through the hook", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cidG = "c" + "0".repeat(15)
    const cidC = "c" + "3".repeat(15)
    const OPUS_SAP = "anthropic--claude-4.8-opus"
    const claudeConfig = { id: cidC, scenarioId: "foundation-models", executableId: "aws-bedrock", parameterBindings: [{ key: "modelName", value: OPUS_SAP }, { key: "modelVersion", value: "1" }] }
    const claudeResource = { model: OPUS_SAP, executableId: "aws-bedrock", provider: "Anthropic", displayName: "Claude 4.8 Opus", allowedScenarios: [{ scenarioId: "foundation-models", executableId: "aws-bedrock" }], versions: [{ name: "1", contextLength: 1000000, inputTypes: ["text", "image"], deprecated: false, retirementDate: "", streamingSupported: true }] }
    const mock = router({
      deployments: { resources: [
        row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cidG),
        row("d9df30a64cef44d6", OPUS_SAP, "1", cidC),
      ] },
      configs: { [cidG]: config("gpt-6-astra", "2026-09-03", cidG), [cidC]: claudeConfig },
      catalog: { count: 2, resources: [catalogFor(ASTRA).resources[0], claudeResource] },
    })
    const p = writeCreds(dir, "mixed.json")
    const auth = await authorize(plugin, mock, p)
    const catalog = await withFetch(mock, () => plugin.provider.models({ models: {} }, { auth }))

    assert.deepEqual(Object.keys(catalog).sort(), ["claude-opus-4-8", "gpt-6-astra"])
    assert.equal(catalog["gpt-6-astra"].api.npm, "@ai-sdk/openai")
    assert.deepEqual(catalog["claude-opus-4-8"].api, { id: "claude-opus-4-8", npm: "@ai-sdk/anthropic" })
    assert.equal(catalog["claude-opus-4-8"].name, "Claude Opus 4.8")
    assert.equal(catalog["claude-opus-4-8"].capabilities.input.image, true)
    assert.equal(catalog["claude-opus-4-8"].limit.context, 1000000)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a configured given model is excluded and the given config is not mutated", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cid = "c" + "2".repeat(15)
    const mock = router({
      deployments: { resources: [row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cid)] },
      configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
      catalog: catalogFor(ASTRA),
    })
    const p = writeCreds(dir, "given.json")
    const auth = await authorize(plugin, mock, p)

    const given = { models: { "ghost-model": { id: "ghost-model", npm: "@ai-sdk/anthropic" } } }
    const catalog = await withFetch(mock, () => plugin.provider.models(given, { auth }))

    assert.deepEqual(Object.keys(catalog), ["gpt-6-astra"])
    assert.equal("ghost-model" in catalog, false)
    assert.deepEqual(given.models, { "ghost-model": { id: "ghost-model", npm: "@ai-sdk/anthropic" } })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("successful empty discovery returns {} while a malformed response throws a prefixed discovery error", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const empty = router({ deployments: { resources: [] }, configs: {}, catalog: catalogFor() })
    const p = writeCreds(dir, "empty.json")
    const auth = await authorize(plugin, empty, p)
    assert.deepEqual(await withFetch(empty, () => plugin.provider.models({ models: {} }, { auth })), {})

    const plugin2 = await SAPAICorePlugin()
    const malformed = (href) => pathOf(href) === TOKEN ? tokenReply() : json({ resources: {} })
    const p2 = writeCreds(dir, "malformed.json")
    const auth2 = await authorize(plugin2, malformed, p2)
    await assert.rejects(
      () => withFetch(malformed, () => plugin2.provider.models({ models: {} }, { auth: auth2 })),
      err => {
        assert.equal(err.code, "discovery-response")
        assert.match(err.message, /model discovery returned an unexpected response/)
        assert.doesNotMatch(err.message, /synthetic|eu10|hana|Bearer/)
        return true
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("model-hook OAuth refusal expires sign-in while a missing credential keeps it", async () => {
  const dir = tmpDir()
  try {
    const missing = path.join(dir, "absent.json")
    const plugin = await SAPAICorePlugin()
    await assert.rejects(
      () => withFetch(() => { throw new Error("no network") }, () => plugin.provider.models({ models: {} }, { auth: authFor(missing) })),
      err => {
        assert.equal(err.code, "file")
        assert.equal(err.signIn, "kept")
        assert.doesNotMatch(err.message, /discovery/)
        return true
      },
    )

    const plugin2 = await SAPAICorePlugin()
    const p = writeCreds(dir, "refused.json")
    const refuse = (href) =>
      pathOf(href) === TOKEN
        ? json({ error: "invalid_client" }, { status: 401, headers: { "www-authenticate": "Basic realm=OAuth" } })
        : json({ resources: [] })
    await assert.rejects(
      () => withFetch(refuse, () => plugin2.provider.models({ models: {} }, { auth: authFor(p) })),
      err => {
        assert.equal(err.code, "oauth-refused")
        assert.equal(err.signIn, "expired")
        assert.doesNotMatch(err.message, /discovery/)
        return true
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("two resource groups with the same model names issue distinct requests and stay isolated", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cidA = "c" + "3".repeat(15)
    const cidB = "c" + "4".repeat(15)
    const routes = {
      groupA: router({
        deployments: { resources: [row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cidA)] },
        configs: { [cidA]: config("gpt-6-astra", "2026-09-03", cidA) },
        catalog: catalogFor(ASTRA),
      }),
      groupB: router({
        deployments: { resources: [row("d0000000000000b1", "gpt-6-astra", "2026-09-03", cidB)] },
        configs: { [cidB]: config("gpt-6-astra", "2026-09-03", cidB) },
        catalog: catalogFor(ASTRA),
      }),
    }
    const groups = []
    const mock = async (href, init) => {
      if (pathOf(href) === TOKEN) return tokenReply()
      const group = init.headers["AI-Resource-Group"]
      groups.push(group)
      return routes[group](href, init)
    }
    const pA = writeCreds(dir, "group-a.json", { resourceGroup: "groupA" })
    const pB = writeCreds(dir, "group-b.json", { resourceGroup: "groupB" })
    const authA = await authorize(plugin, mock, pA)
    const authB = await authorize(plugin, mock, pB)

    const catA = await withFetch(mock, () => plugin.provider.models({ models: {} }, { auth: authA }))
    const catB = await withFetch(mock, () => plugin.provider.models({ models: {} }, { auth: authB }))

    assert.deepEqual(Object.keys(catA), ["gpt-6-astra"])
    assert.deepEqual(Object.keys(catB), ["gpt-6-astra"])
    assert.ok(groups.includes("groupA") && groups.includes("groupB"), "each account must request its own resource group")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a generation retired mid-discovery fails superseded and publishes nothing", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cid = "c" + "5".repeat(15)
    const complete = router({
      deployments: { resources: [row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cid)] },
      configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
      catalog: catalogFor(ASTRA),
    })
    const p = writeCreds(dir, "retire.json")
    const auth = await authorize(plugin, complete, p)

    let started
    const seen = new Promise(r => { started = r })
    const hanging = (href, init) => {
      if (pathOf(href) === TOKEN) return tokenReply()
      if (pathOf(href) === DEPLOYMENTS) { started(); return new Promise(() => {}) }
      return complete(href, init)
    }

    const real = globalThis.fetch
    globalThis.fetch = hanging
    try {
      const pending = plugin.provider.models({ models: {} }, { auth })
      const guarded = pending.catch(e => e)
      await seen
      const reauth = await plugin.auth.methods[0].authorize({ credentialFile: p })
      assert.equal(reauth.type, "success")
      const error = await guarded
      assert.ok(error instanceof Error)
      assert.equal(error.code, "superseded")
      assert.doesNotMatch(error.message, /discovery/)
    } finally {
      globalThis.fetch = real
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function counting(mock) {
  const state = { management: 0, firstPage: 0 }
  const wrapped = (href, init) => {
    const p = pathOf(href)
    if (p !== TOKEN) state.management++
    if (p === DEPLOYMENTS && new URL(String(href instanceof Request ? href.url : href)).searchParams.get("$skip") === "0") state.firstPage++
    return mock(href, init)
  }
  return { wrapped, state }
}

function withClock(start, fn) {
  const real = performance.now
  let t = start
  performance.now = () => t
  return Promise.resolve().then(() => fn(v => { t = v })).finally(() => { performance.now = real })
}

function withDate(iso, fn) {
  const Real = Date
  const fixed = Real.parse(iso)
  class FakeDate extends Real {
    constructor(...args) { super(...(args.length ? args : [fixed])) }
    static now() { return fixed }
  }
  globalThis.Date = FakeDate
  return Promise.resolve().then(fn).finally(() => { globalThis.Date = Real })
}

function astraRoutes(cid) {
  return {
    deployments: { resources: [row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cid)] },
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: catalogFor(ASTRA),
  }
}

test("a fresh snapshot serves repeat scans with no further management requests", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const { wrapped, state } = counting(router(astraRoutes("c" + "6".repeat(15))))
    const auth = await authorize(plugin, wrapped, writeCreds(dir, "hit.json"))

    const first = await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
    const afterFirst = state.management
    assert.ok(afterFirst > 0, "the first scan performs discovery")
    const second = await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))

    assert.equal(state.management, afterFirst, "a fresh snapshot issues no new management requests")
    assert.deepEqual(Object.keys(first), ["gpt-6-astra"])
    assert.deepEqual(Object.keys(second), ["gpt-6-astra"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a snapshot expires on equality with the 300000 ms TTL, not just before it", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const { wrapped, state } = counting(router(astraRoutes("c" + "7".repeat(15))))
    const auth = await authorize(plugin, wrapped, writeCreds(dir, "ttl.json"))

    await withClock(0, async set => {
      await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
      const afterFirst = state.management

      set(299999)
      await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
      assert.equal(state.management, afterFirst, "299999 ms is still within the TTL")

      set(300000)
      const refreshed = await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
      assert.ok(state.management > afterFirst, "equality with the TTL forces a refresh")
      assert.deepEqual(Object.keys(refreshed), ["gpt-6-astra"])
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a successful empty discovery is cached and repeat scans stay empty without management", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const { wrapped, state } = counting(router({ deployments: { resources: [] }, configs: {}, catalog: catalogFor() }))
    const auth = await authorize(plugin, wrapped, writeCreds(dir, "empty-cache.json"))

    assert.deepEqual(await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth })), {})
    const afterFirst = state.management
    assert.ok(afterFirst > 0, "the first empty scan still performs discovery")
    assert.deepEqual(await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth })), {})
    assert.equal(state.management, afterFirst, "a cached empty result issues no new management requests")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("an expired refresh that fails throws instead of serving the stale snapshot, then recovers", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cid = "c" + "8".repeat(15)
    const good = router(astraRoutes(cid))
    let fail = false
    const mock = (href, init) => {
      if (pathOf(href) === TOKEN) return tokenReply()
      if (fail && pathOf(href) === DEPLOYMENTS) return json({ resources: {} })
      return good(href, init)
    }
    const auth = await authorize(plugin, mock, writeCreds(dir, "refresh.json"))

    await withClock(0, async set => {
      assert.deepEqual(
        Object.keys(await withFetch(mock, () => plugin.provider.models({ models: {} }, { auth }))),
        ["gpt-6-astra"],
      )
      set(300000)
      fail = true
      await assert.rejects(
        () => withFetch(mock, () => plugin.provider.models({ models: {} }, { auth })),
        err => {
          assert.equal(err.code, "discovery-response")
          assert.doesNotMatch(err.message, /synthetic|eu10|hana|Bearer/)
          return true
        },
      )
      fail = false
      const recovered = await withFetch(mock, () => plugin.provider.models({ models: {} }, { auth }))
      assert.deepEqual(Object.keys(recovered), ["gpt-6-astra"])
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("concurrent scans coalesce into a single discovery", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const good = router(astraRoutes("c" + "9".repeat(15)))
    let release
    const gate = new Promise(r => { release = r })
    const { wrapped, state } = counting(async (href, init) => {
      if (pathOf(href) === DEPLOYMENTS) await gate
      return good(href, init)
    })
    const auth = await authorize(plugin, wrapped, writeCreds(dir, "coalesce.json"))

    await withFetch(wrapped, async () => {
      const a = plugin.provider.models({ models: {} }, { auth })
      const b = plugin.provider.models({ models: {} }, { auth })
      await new Promise(r => setImmediate(r))
      release()
      const [ra, rb] = await Promise.all([a, b])
      assert.deepEqual(Object.keys(ra), ["gpt-6-astra"])
      assert.deepEqual(Object.keys(rb), ["gpt-6-astra"])
    })
    assert.equal(state.firstPage, 1, "two concurrent scans share one deployment listing")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a retirement cutoff at UTC midnight expires a TTL-young snapshot", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const cid = "c" + "a".repeat(15)
    const retiring = {
      count: 1,
      resources: [{
        model: "gpt-6-astra",
        executableId: "azure-openai",
        allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }],
        versions: [{
          name: "2026-09-03",
          contextLength: 1050000,
          inputTypes: ["text"],
          deprecated: false,
          retirementDate: "2026-11-02",
          streamingSupported: true,
        }],
      }],
    }
    const { wrapped, state } = counting(router({
      deployments: { resources: [row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cid)] },
      configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
      catalog: retiring,
    }))
    const p = writeCreds(dir, "retire-cutoff.json")
    let auth

    await withDate("2026-11-01T12:00:00Z", async () => {
      auth = await authorize(plugin, wrapped, p)
      const before = await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
      assert.deepEqual(Object.keys(before), ["gpt-6-astra"])
    })
    const afterFirst = state.management

    await withDate("2026-11-02T00:00:00Z", async () => {
      const after = await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
      assert.deepEqual(after, {}, "a model retired at UTC midnight is dropped despite a young TTL")
    })
    assert.ok(state.management > afterFirst, "crossing the retirement cutoff forces a refresh")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a cold loader with no prior scan initiates full discovery and exposes the account baseURL", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const { wrapped, state } = counting(router(astraRoutes("c" + "b".repeat(15))))
    const auth = await authorize(plugin, wrapped, writeCreds(dir, "cold-loader.json"))

    const opts = await withFetch(wrapped, () => plugin.auth.loader(async () => auth))

    assert.ok(state.management > 0, "a cold loader runs discovery during initialization")
    assert.equal(state.firstPage, 1, "the loader lists deployments exactly once")
    assert.equal(opts.baseURL, AI_ROOT)
    assert.equal(typeof opts.fetch, "function")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a prior models scan is reused by the loader with no further management requests", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const { wrapped, state } = counting(router(astraRoutes("c" + "c".repeat(15))))
    const auth = await authorize(plugin, wrapped, writeCreds(dir, "shared-cache.json"))

    const catalog = await withFetch(wrapped, () => plugin.provider.models({ models: {} }, { auth }))
    assert.deepEqual(Object.keys(catalog), ["gpt-6-astra"])
    const afterModels = state.management
    assert.ok(afterModels > 0, "the models scan performs discovery")

    const opts = await withFetch(wrapped, () => plugin.auth.loader(async () => auth))
    assert.equal(state.management, afterModels, "the loader reuses the shared snapshot")
    assert.equal(opts.baseURL, AI_ROOT)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("a fresh plugin rebuilds discovery from the stored auth reference without a prior scan", async () => {
  const dir = tmpDir()
  try {
    const plugin1 = await SAPAICorePlugin()
    const { wrapped, state } = counting(router(astraRoutes("c" + "d".repeat(15))))
    const auth = await authorize(plugin1, wrapped, writeCreds(dir, "restart.json"))

    await withFetch(wrapped, () => plugin1.auth.loader(async () => auth))
    const afterFirst = state.management
    assert.ok(afterFirst > 0, "the first plugin's loader discovers")

    const plugin2 = await SAPAICorePlugin()
    const opts = await withFetch(wrapped, () => plugin2.auth.loader(async () => auth))
    assert.ok(state.management > afterFirst, "a fresh plugin rebuilds discovery for the same auth reference")
    assert.equal(opts.baseURL, AI_ROOT)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
