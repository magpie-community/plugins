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

const CREDS = {
  authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com",
  baseUrl: "https://api.ai.eu10.hana.ondemand.com",
  clientId: "synthetic-id",
  clientSecret: "synthetic-secret",
  resourceGroup: "default",
}
const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"
const TARGET = AI_ROOT + "/responses"
const DEPLOYMENTS = "/v2/lm/deployments"
const CATALOG = "/v2/lm/scenarios/foundation-models/models"
const CONFIG = "/v2/lm/configurations/"
const TOKEN = "/oauth/token"
const ASTRA = ["gpt-6-astra", "2026-09-03"]

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "magpie-fetch-discovery-"))
}

function writeCreds(dir, name, overrides = {}) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify({ ...CREDS, ...overrides }), { mode: 0o600 })
  return p
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
    if (url.pathname.startsWith(CONFIG)) return json(routes.configs[url.pathname.slice(CONFIG.length)])
    if (url.pathname.includes("/inference/") && url.pathname.endsWith("/responses")) return json({ id: "resp_a", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }, error: null, incomplete_details: null })
    throw new Error("unexpected path " + url.pathname)
  }
}

function astraRoutes(cid) {
  return {
    deployments: { resources: [row("d0000000000000a1", "gpt-6-astra", "2026-09-03", cid)] },
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: catalogFor(ASTRA),
  }
}
const BODY = JSON.stringify({ model: "gpt-6-astra", input: "hello" })

async function fetchResponse(opts, init = {}) {
  return opts.fetch(TARGET, { method: "POST", body: BODY, ...init })
}


function withFetch(mock, fn) {
  const real = globalThis.fetch
  globalThis.fetch = mock
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = real })
}

function withClock(start, fn) {
  const real = performance.now
  let t = start
  performance.now = () => t
  return Promise.resolve().then(() => fn(v => { t = v })).finally(() => { performance.now = real })
}

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

async function sign(plugin, mock, credentialFile) {
  const result = await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile }))
  assert.equal(result.type, "success")
  return { type: "api", key: result.key, metadata: result.metadata }
}

const cid = n => "c" + String(n).repeat(15).slice(0, 15)

test("routing rejects mismatched native bodies before protocol validation and recognizes undeployed Claude baselines", async () => {
  const dir = tmpDir()
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plugin = await SAPAICorePlugin()
  const good = router(astraRoutes(cid(3)))
  let inferenceCalls = 0
  const mock = (href, init) => {
    if (pathOf(href).includes("/inference/")) inferenceCalls++
    return good(href, init)
  }
  const auth = await sign(plugin, mock, writeCreds(dir, "routing.json"))
  const opts = await withFetch(mock, () => plugin.auth.loader(async () => auth))
  await withFetch(mock, async () => {
    const wrongRoute = await opts.fetch(AI_ROOT + "/messages", { method: "POST", body: BODY })
    assert.equal(wrongRoute.status, 400)
    assert.equal((await wrongRoute.json()).error.code, "destination")
    for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-ghost-9-9"]) {
      const response = await opts.fetch(AI_ROOT + "/messages", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) })
      assert.equal(response.status, 404)
      assert.equal((await response.json()).error.code, model === "claude-ghost-9-9" ? "unknown-model" : "unavailable-model")
    }
  })
  assert.equal(inferenceCalls, 0)
})


test("a failed expired discovery never dispatches from the stale deployment, then recovers", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const good = router(astraRoutes(cid(3)))
    let fail = false
    const mock = (href, init) => {
      if (pathOf(href) === TOKEN) return tokenReply()
      if (fail && pathOf(href) === DEPLOYMENTS) return json({ resources: {} })
      return good(href, init)
    }
    await withClock(0, async set => {
      const auth = await sign(plugin, mock, writeCreds(dir, "fetch-refresh.json"))
      const opts = await withFetch(mock, () => plugin.auth.loader(async () => auth))

      set(300000)
      fail = true
      const response = await withFetch(mock, () => fetchResponse(opts))
      assert.equal(response.status, 502)
      assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
      assert.equal((await response.json()).error.code, "discovery-response")

      fail = false
      assert.equal((await withFetch(mock, () => fetchResponse(opts))).status, 200)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("cancelling one expired-discovery caller leaves the other able to generate", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const good = router(astraRoutes(cid(4)))
    let gate = null
    const { wrapped, state } = counting((href, init) => {
      if (gate && pathOf(href) === DEPLOYMENTS) return gate.then(() => good(href, init))
      return good(href, init)
    })
    await withClock(0, async set => {
      const auth = await sign(plugin, wrapped, writeCreds(dir, "concurrent.json"))
      const opts = await withFetch(wrapped, () => plugin.auth.loader(async () => auth))
      const afterLoaderFirstPage = state.firstPage

      set(300000)
      let release
      gate = new Promise(r => { release = r })
      await withFetch(wrapped, async () => {
        const ctl = new AbortController()
        const cancelled = fetchResponse(opts, { signal: ctl.signal })
        const survivor = fetchResponse(opts)
        await new Promise(r => setImmediate(r))
        ctl.abort()
        release()
        const [c, s] = await Promise.all([cancelled, survivor])
        assert.equal(c.status, 499)
        assert.equal(s.status, 200)
      })
      assert.equal(state.firstPage, afterLoaderFirstPage + 1, "both fetches coalesce into one deployment listing")
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the last owner's cancel aborts the management signal and a late scan cannot warm the snapshot", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const good = router(astraRoutes(cid(5)))
    let seenSignal = null
    let gate = null
    const { wrapped, state } = counting((href, init) => {
      if (gate && pathOf(href) === DEPLOYMENTS) {
        seenSignal = init.signal
        return gate.then(() => good(href, init))
      }
      return good(href, init)
    })
    await withClock(0, async set => {
      const auth = await sign(plugin, wrapped, writeCreds(dir, "last-owner.json"))
      const opts = await withFetch(wrapped, () => plugin.auth.loader(async () => auth))

      set(300000)
      let release
      gate = new Promise(r => { release = r })
      await withFetch(wrapped, async () => {
        const ctl = new AbortController()
        const cancelled = fetchResponse(opts, { signal: ctl.signal })
        await new Promise(r => setImmediate(r))
        assert.ok(seenSignal && !seenSignal.aborted, "the scan reaches the management request")

        ctl.abort()
        const c = await cancelled
        assert.equal(c.status, 499)
        assert.equal(seenSignal.aborted, true, "the sole owner's cancel aborts the underlying management request")

        release()
        await new Promise(r => setImmediate(r))
        const before = state.firstPage
        const next = await fetchResponse(opts)
        assert.equal(next.status, 200)
        assert.ok(state.firstPage > before, "the abandoned scan warmed nothing, so the next fetch rescans")
      })
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a token refresh under a fresh snapshot preserves flight ownership across a cancel", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const good = router(astraRoutes(cid(6)))
    let tokenGate = null
    const { wrapped, state } = counting((href, init) => {
      if (pathOf(href) === TOKEN) return tokenGate ? tokenGate.then(() => tokenReply({ expires_in: 120 })) : tokenReply({ expires_in: 120 })
      return good(href, init)
    })
    await withClock(0, async set => {
      const auth = await sign(plugin, wrapped, writeCreds(dir, "token-refresh.json"))
      const opts = await withFetch(wrapped, () => plugin.auth.loader(async () => auth))
      const afterLoaderFirstPage = state.firstPage

      set(60000)
      let release
      tokenGate = new Promise(r => { release = r })
      await withFetch(wrapped, async () => {
        const ctl = new AbortController()
        const cancelled = fetchResponse(opts, { signal: ctl.signal })
        const survivor = fetchResponse(opts)
        await new Promise(r => setImmediate(r))
        ctl.abort()
        release()
        const [c, s] = await Promise.all([cancelled, survivor])
        assert.equal(c.status, 499)
        assert.equal(s.status, 200)
      })
      assert.equal(state.firstPage, afterLoaderFirstPage, "a fresh snapshot means the token refresh triggers no rescan")
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("an old loader closure refuses a fetch after the account is reauthorized and publishes nothing", async () => {
  const dir = tmpDir()
  try {
    const plugin = await SAPAICorePlugin()
    const good = router(astraRoutes(cid(7)))
    const p = writeCreds(dir, "reauth.json")
    const auth = await sign(plugin, good, p)
    const opts = await withFetch(good, () => plugin.auth.loader(async () => auth))

    const reauth = await withFetch(good, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(reauth.type, "success")

    const response = await withFetch(good, () => fetchResponse(opts))
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
    assert.equal((await response.json()).error.code, "superseded")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
