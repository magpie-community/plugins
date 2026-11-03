import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import { discover } from "../src/discovery.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"
const GROUP = "default"
const TIMEOUT_MS = 15000

const LIST = "/v2/lm/deployments"
const DETAIL = "/v2/lm/deployments/"
const CATALOG = "/v2/lm/scenarios/foundation-models/models"
const CONFIG = "/v2/lm/configurations/"

function body(text) {
  return new Response(text).body
}

function streamBody(hooks) {
  return new ReadableStream({ start() { hooks.onStart?.() }, cancel() { hooks.onCancel?.() } })
}

function ok(payload) {
  return { ok: true, status: 200, redirected: false, url: "", body: body(JSON.stringify(payload)) }
}

function urlFor(id) {
  return AI_ROOT + "/v2/inference/deployments/" + id
}

function backend(model, version) {
  return { details: { resources: { backendDetails: { model: { name: model, version } } } } }
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
      versions: [{ name: version, contextLength: 1050000, inputTypes: ["text"], deprecated: false, retirementDate: "", streamingSupported: true }],
    })),
  }
}

function wrap(value) {
  if (value === undefined) throw new Error("no route")
  return value && value.body !== undefined ? value : ok(value)
}

function router(routes) {
  return (href) => {
    const url = new URL(href)
    if (url.pathname === LIST) {
      if (url.searchParams.get("$skip") !== "0") return ok({ resources: [] })
      return wrap(routes.deployments)
    }
    if (url.pathname.startsWith(DETAIL)) return wrap((routes.details || {})[url.pathname.slice(DETAIL.length)])
    if (url.pathname === CATALOG) return wrap(routes.catalog)
    if (url.pathname.startsWith(CONFIG)) return wrap(routes.configs[url.pathname.slice(CONFIG.length)])
    throw new Error("unexpected path " + url.pathname)
  }
}

function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (href, init) => {
    calls.push({ href, init })
    return handler(href, init, calls.length - 1)
  }
  cleanups.push(() => { globalThis.fetch = original })
  return calls
}

function base(overrides = {}) {
  return { aiRoot: AI_ROOT, resourceGroup: GROUP, bearer: async () => "tok", ...overrides }
}

const detailPaths = calls => calls.filter(c => new URL(c.href).pathname.startsWith(DETAIL)).map(c => new URL(c.href).pathname)

test("a running row missing url and backend is repaired from matching detail into an eligible entry", async () => {
  const id = "d02212989ca345a2"
  const cid = "c" + "0".repeat(15)
  const calls = installFetch(router({
    deployments: { resources: [{ id, status: "RUNNING", configurationId: cid }] },
    details: { [id]: { id, status: "RUNNING", deploymentUrl: urlFor(id), ...backend("gpt-6-astra", "2026-09-03") } },
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  const registry = await discover(base())

  assert.deepEqual(Object.keys(registry), ["gpt-6-astra"])
  const entry = registry["gpt-6-astra"]
  assert.equal(entry.deploymentID, id)
  assert.equal(entry.deploymentURL, urlFor(id))
  assert.equal(entry.activeVersion, "2026-09-03")
  assert.equal(entry.configurationID, cid)
  assert.deepEqual(detailPaths(calls), [DETAIL + id])
})

test("a running row missing only configurationId is repaired from detail", async () => {
  const id = "d0bdd146b3138906"
  const cid = "c" + "1".repeat(15)
  installFetch(router({
    deployments: { resources: [{ id, status: "RUNNING", deploymentUrl: urlFor(id), ...backend("gpt-6.1-sol", "2026-09-29") }] },
    details: { [id]: { id, status: "RUNNING", configurationId: cid } },
    configs: { [cid]: config("gpt-6.1-sol", "2026-09-29", cid) },
    catalog: catalogFor(["gpt-6.1-sol", "2026-09-29"]),
  }))

  const registry = await discover(base())

  assert.deepEqual(Object.keys(registry), ["gpt-6.1-sol"])
  assert.equal(registry["gpt-6.1-sol"].deploymentID, id)
  assert.equal(registry["gpt-6.1-sol"].configurationID, cid)
})

test("a lower id whose detail configurationId conflicts is hidden and never displaces the valid higher id", async () => {
  const lower = "d0000000000000aa"
  const higher = "d0000000000000bb"
  const lowCid = "c" + "2".repeat(15)
  const detailCid = "c" + "3".repeat(15)
  const highCid = "c" + "4".repeat(15)
  const calls = installFetch(router({
    deployments: { resources: [
      { id: lower, status: "RUNNING", configurationId: lowCid, ...backend("gpt-6-astra", "2026-09-03") },
      { id: higher, status: "RUNNING", deploymentUrl: urlFor(higher), configurationId: highCid, ...backend("gpt-6-astra", "2026-09-03") },
    ] },
    details: { [lower]: { id: lower, status: "RUNNING", deploymentUrl: urlFor(lower), configurationId: detailCid } },
    configs: {
      [lowCid]: config("gpt-6-astra", "2026-09-03", lowCid),
      [highCid]: config("gpt-6-astra", "2026-09-03", highCid),
    },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  const registry = await discover(base())

  assert.deepEqual(Object.keys(registry), ["gpt-6-astra"])
  assert.equal(registry["gpt-6-astra"].deploymentID, higher)
  assert.ok(calls.every(c => new URL(c.href).pathname !== CONFIG + lowCid))
})

test("a mismatched id, a malformed envelope, or an http failure on detail rejects the whole discovery", async () => {
  const id = "d02212989ca345a2"
  const cid = "c" + "5".repeat(15)
  const incomplete = { resources: [{ id, status: "RUNNING", configurationId: cid, ...backend("gpt-6-astra", "2026-09-03") }] }

  installFetch(router({ deployments: incomplete, details: { [id]: { id: "d0000000000000zz", status: "RUNNING", deploymentUrl: urlFor(id) } } }))
  await assert.rejects(discover(base()), { code: "response" })

  installFetch(router({ deployments: incomplete, details: { [id]: { id, status: 7, deploymentUrl: urlFor(id) } } }))
  await assert.rejects(discover(base()), { code: "response" })

  installFetch(router({ deployments: incomplete, details: { [id]: { ok: false, status: 500, redirected: false, url: "", body: body("{}") } } }))
  await assert.rejects(discover(base()), { code: "response" })
})

test("a present but unsafe deployment url hides the row and issues zero detail request", async () => {
  const id = "d02212989ca345a2"
  const cid = "c" + "6".repeat(15)
  const calls = installFetch(router({
    deployments: { resources: [{ id, status: "RUNNING", deploymentUrl: "https://evil.example.com/v2/inference/deployments/" + id, configurationId: cid, ...backend("gpt-6-astra", "2026-09-03") }] },
    details: { [id]: { id, status: "RUNNING", deploymentUrl: urlFor(id) } },
    configs: {},
    catalog: catalogFor(),
  }))

  assert.deepEqual(Object.keys(await discover(base())), [])
  assert.deepEqual(detailPaths(calls), [])
})

test("a row whose backend stays absent after detail remains hidden without throwing", async () => {
  const id = "d02212989ca345a2"
  const cid = "c" + "7".repeat(15)
  const calls = installFetch(router({
    deployments: { resources: [{ id, status: "RUNNING", deploymentUrl: urlFor(id), configurationId: cid }] },
    details: { [id]: { id, status: "RUNNING" } },
    configs: {},
    catalog: catalogFor(),
  }))

  assert.deepEqual(Object.keys(await discover(base())), [])
  assert.deepEqual(detailPaths(calls), [DETAIL + id])
})

test("a running row with a malformed list backend container is hidden and never repaired from detail", async () => {
  const id = "d02212989ca345a2"
  const cid = "c" + "9".repeat(15)
  const calls = installFetch(router({
    deployments: { resources: [{
      id, status: "RUNNING", deploymentUrl: urlFor(id), configurationId: cid,
      details: { resources: { backendDetails: { model: { name: 7, version: "2026-09-03" } } } },
    }] },
    details: { [id]: { id, status: "RUNNING", ...backend("gpt-6-astra", "2026-09-03") } },
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  assert.deepEqual(Object.keys(await discover(base())), [])
  assert.deepEqual(detailPaths(calls), [])
})

test("a partial list model missing version is filled from detail, while a conflicting version hides the row", async () => {
  const id = "d0bdd146b3138906"
  const cid = "c" + "a".repeat(15)
  const partialList = {
    id, status: "RUNNING", deploymentUrl: urlFor(id), configurationId: cid,
    details: { resources: { backendDetails: { model: { name: "gpt-6.1-sol" } } } },
  }

  installFetch(router({
    deployments: { resources: [{ ...partialList }] },
    details: { [id]: { id, status: "RUNNING", configurationId: cid, ...backend("gpt-6.1-sol", "2026-09-29") } },
    configs: { [cid]: config("gpt-6.1-sol", "2026-09-29", cid) },
    catalog: catalogFor(["gpt-6.1-sol", "2026-09-29"]),
  }))
  const registry = await discover(base())
  assert.deepEqual(Object.keys(registry), ["gpt-6.1-sol"])
  assert.equal(registry["gpt-6.1-sol"].activeVersion, "2026-09-29")

  installFetch(router({
    deployments: { resources: [{ ...partialList, configurationId: undefined, details: { resources: { backendDetails: { model: { name: "gpt-6.1-sol", version: "2026-01-01" } } } } }] },
    details: { [id]: { id, status: "RUNNING", configurationId: cid, ...backend("gpt-6.1-sol", "2026-09-29") } },
    configs: { [cid]: config("gpt-6.1-sol", "2026-09-29", cid) },
    catalog: catalogFor(["gpt-6.1-sol", "2026-09-29"]),
  }))
  assert.deepEqual(Object.keys(await discover(base())), [])
})

test("a malformed detail backend rejects the whole refresh while a well-typed empty detail only hides the row", async () => {
  const id = "d02212989ca345a2"
  const cid = "c" + "b".repeat(15)
  const incomplete = { resources: [{ id, status: "RUNNING", deploymentUrl: urlFor(id), configurationId: cid }] }

  installFetch(router({
    deployments: incomplete,
    details: { [id]: { id, status: "RUNNING", details: { resources: { backendDetails: { model: { name: "gpt-6-astra", version: 9 } } } } } },
  }))
  await assert.rejects(discover(base()), { code: "response" })

  const calls = installFetch(router({
    deployments: incomplete,
    details: { [id]: { id, status: "RUNNING", details: { resources: {} } } },
    configs: {},
    catalog: catalogFor(),
  }))
  assert.deepEqual(Object.keys(await discover(base())), [])
  assert.deepEqual(detailPaths(calls), [DETAIL + id])
})

test("an earlier eligible row does not survive a malformed detail on a later row", async () => {
  const good = "d0000000000000aa"
  const later = "d0000000000000bb"
  const goodCid = "c" + "c".repeat(15)
  const laterCid = "c" + "d".repeat(15)
  installFetch(router({
    deployments: { resources: [
      { id: good, status: "RUNNING", deploymentUrl: urlFor(good), configurationId: goodCid, ...backend("gpt-6-astra", "2026-09-03") },
      { id: later, status: "RUNNING", deploymentUrl: urlFor(later), configurationId: laterCid },
    ] },
    details: { [later]: { id: later, status: "RUNNING", details: { resources: { backendDetails: { model: { name: 5 } } } } } },
    configs: { [goodCid]: config("gpt-6-astra", "2026-09-03", goodCid) },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  await assert.rejects(discover(base()), { code: "response" })
})

test("the deadline still bounds a hanging detail lookup and cancels its reader", async () => {
  jest.useFakeTimers()
  const id = "d02212989ca345a2"
  const cid = "c" + "8".repeat(15)
  let cancelled = false
  let reading
  const started = new Promise(r => { reading = r })
  installFetch((href) => {
    const url = new URL(href)
    if (url.pathname === LIST) {
      return url.searchParams.get("$skip") === "0"
        ? ok({ resources: [{ id, status: "RUNNING", deploymentUrl: urlFor(id), configurationId: cid }] })
        : ok({ resources: [] })
    }
    return { ok: true, status: 200, redirected: false, url: "",
      body: streamBody({ onStart: () => reading(), onCancel: () => { cancelled = true } }) }
  })

  const pending = discover(base())
  await started
  jest.advanceTimersByTime(TIMEOUT_MS)
  await assert.rejects(pending, { code: "timeout" })
  assert.equal(cancelled, true)
})
