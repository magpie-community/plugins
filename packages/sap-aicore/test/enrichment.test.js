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

const DEPLOYMENTS = "/v2/lm/deployments"
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

function catalogStreaming(model, version, streaming) {
  const catalog = catalogFor([model, version])
  if (streaming === undefined) delete catalog.resources[0].versions[0].streamingSupported
  else catalog.resources[0].versions[0].streamingSupported = streaming
  return catalog
}

function router(routes) {
  return (href) => {
    const url = new URL(href)
    if (url.pathname === DEPLOYMENTS) {
      if (url.searchParams.get("$skip") !== "0") return ok({ resources: [] })
      return wrap(routes.deployments)
    }
    if (url.pathname === CATALOG) return wrap(routes.catalog)
    if (url.pathname.startsWith(CONFIG)) return wrap(routes.configs[url.pathname.slice(CONFIG.length)])
    throw new Error("unexpected path " + url.pathname)
  }
}

function wrap(value) {
  if (value === undefined) throw new Error("no route")
  return value && value.body !== undefined ? value : ok(value)
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

test("a complete row resolves to a concrete frozen registry entry with authorized config and catalog lookups", async () => {
  const cid = "c" + "0".repeat(15)
  const calls = installFetch(router({
    deployments: { resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] },
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  const registry = await discover(base())

  assert.deepEqual(Object.keys(registry), ["gpt-6-astra"])
  assert.equal(Object.getPrototypeOf(registry), null)
  assert.ok(Object.isFrozen(registry))
  const entry = registry["gpt-6-astra"]
  assert.equal(entry.deploymentID, "d02212989ca345a2")
  assert.equal(entry.deploymentURL, urlFor("d02212989ca345a2"))
  assert.equal(entry.activeVersion, "2026-09-03")
  assert.equal(entry.configurationID, cid)
  assert.equal(entry.metadata.contextLength, 1050000)
  assert.ok(Object.isFrozen(entry))

  const config_call = calls.find(c => new URL(c.href).pathname === CONFIG + cid)
  const catalog_call = calls.find(c => new URL(c.href).pathname === CATALOG)
  for (const call of [config_call, catalog_call]) {
    assert.equal(call.init.method, "GET")
    assert.equal(call.init.redirect, "error")
    assert.equal(call.init.headers.Authorization, "Bearer tok")
    assert.equal(call.init.headers["AI-Resource-Group"], GROUP)
  }
})

test("after eligibility the lexicographically smallest id wins and an invalid lower id never does", async () => {
  const lower = "d0000000000000aa"
  const higher = "d0000000000000bb"
  const lowConfig = "c" + "1".repeat(15)
  const highConfig = "c" + "2".repeat(15)
  installFetch(router({
    deployments: { resources: [
      row(higher, "gpt-6-astra", "2026-09-03", highConfig),
      row(lower, "gpt-6-astra", "2026-09-03", lowConfig),
    ] },
    configs: {
      [lowConfig]: config("gpt-6-astra", "2026-08-01", lowConfig),
      [highConfig]: config("gpt-6-astra", "2026-09-03", highConfig),
    },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  const registry = await discover(base())

  assert.deepEqual(Object.keys(registry), ["gpt-6-astra"])
  assert.equal(registry["gpt-6-astra"].deploymentID, higher)
})

test("eligible GPT versions share the lowest-id selection without mixing version metadata", async () => {
  const model = "gpt-6.2-mini"
  const catalog = catalogFor([model, "2027-01-01"])
  catalog.resources[0].versions.push({ name: "2027-02-01", contextLength: 200000 })
  const deployments = { resources: [
    row("deployment-b", model, "2027-01-01", "config-b"),
    row("deployment-a", model, "2027-02-01", "config-a"),
  ] }
  installFetch(router({
    deployments,
    configs: {
      "config-a": config(model, "2027-02-01", "config-a"),
      "config-b": config(model, "2027-01-01", "config-b"),
    },
    catalog,
  }))
  const registry = await discover(base())
  assert.deepEqual(Object.keys(registry), [model])
  assert.equal(registry[model].deploymentID, "deployment-a")
  assert.equal(registry[model].activeVersion, "2027-02-01")
  assert.deepEqual(registry[model].metadata, { contextLength: 200000 })
  deployments.resources.reverse()
  assert.deepEqual(await discover(base()), registry)
})

test("a later configuration failure rejects the whole result with no partial registry", async () => {
  const first = "c" + "3".repeat(15)
  const second = "c" + "4".repeat(15)
  installFetch(router({
    deployments: { resources: [
      row("d0000000000000aa", "gpt-6-astra", "2026-09-03", first),
      row("d0bdd146b3138906", "gpt-6.1-sol", "2026-09-29", second),
    ] },
    configs: {
      [first]: config("gpt-6-astra", "2026-09-03", first),
      [second]: { ok: false, status: 500, redirected: false, url: "", body: body("{}") },
    },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"], ["gpt-6.1-sol", "2026-09-29"]),
  }))

  await assert.rejects(discover(base()), err => {
    assert.equal(err.code, "response")
    return true
  })
})

test("a structurally malformed catalog or configuration envelope rejects rather than returning empty", async () => {
  const cid = "c" + "5".repeat(15)
  const deployments = { resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] }

  installFetch(router({
    deployments,
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: { count: 1, resources: {} },
  }))
  await assert.rejects(discover(base()), { code: "response" })

  installFetch(router({
    deployments,
    configs: { [cid]: "not-an-object-envelope" },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))
  await assert.rejects(discover(base()), { code: "response" })
})

test("two resource groups with the same model stay isolated in tokens and selected ids", async () => {
  const cidA = "c" + "6".repeat(15)
  const cidB = "c" + "7".repeat(15)
  const idA = "d0000000000000a1"
  const idB = "d0000000000000b1"
  const routes = {
    A: router({
      deployments: { resources: [row(idA, "gpt-6-astra", "2026-09-03", cidA)] },
      configs: { [cidA]: config("gpt-6-astra", "2026-09-03", cidA) },
      catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
    }),
    B: router({
      deployments: { resources: [row(idB, "gpt-6-astra", "2026-09-03", cidB)] },
      configs: { [cidB]: config("gpt-6-astra", "2026-09-03", cidB) },
      catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
    }),
  }
  const calls = installFetch((href, init) => {
    const group = init.headers["AI-Resource-Group"]
    return routes[group](href, init)
  })

  const registryA = await discover(base({ resourceGroup: "A", bearer: async () => "tokA" }))
  const registryB = await discover(base({ resourceGroup: "B", bearer: async () => "tokB" }))

  assert.equal(registryA["gpt-6-astra"].deploymentID, idA)
  assert.equal(registryB["gpt-6-astra"].deploymentID, idB)
  const tokensFor = group => new Set(calls.filter(c => c.init.headers["AI-Resource-Group"] === group).map(c => c.init.headers.Authorization))
  assert.deepEqual([...tokensFor("A")], ["Bearer tokA"])
  assert.deepEqual([...tokensFor("B")], ["Bearer tokB"])
})

test("two eligible duplicates in shuffled order resolve to the smaller deployment id", async () => {
  const lower = "d0000000000000aa"
  const higher = "d0000000000000bb"
  const lowConfig = "c" + "a".repeat(15)
  const highConfig = "c" + "b".repeat(15)
  installFetch(router({
    deployments: { resources: [
      row(higher, "gpt-6-astra", "2026-09-03", highConfig),
      row(lower, "gpt-6-astra", "2026-09-03", lowConfig),
    ] },
    configs: {
      [lowConfig]: config("gpt-6-astra", "2026-09-03", lowConfig),
      [highConfig]: config("gpt-6-astra", "2026-09-03", highConfig),
    },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))

  const registry = await discover(base())

  assert.deepEqual(Object.keys(registry), ["gpt-6-astra"])
  assert.equal(registry["gpt-6-astra"].deploymentID, lower)
})

test("a bare {} configuration, malformed bindings, and a bad catalog count each reject instead of yielding an empty registry", async () => {
  const cid = "c" + "d".repeat(15)
  const deployments = { resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] }
  const goodCatalog = catalogFor(["gpt-6-astra", "2026-09-03"])

  installFetch(router({ deployments, configs: { [cid]: {} }, catalog: goodCatalog }))
  await assert.rejects(discover(base()), { code: "response" })

  installFetch(router({
    deployments,
    configs: { [cid]: {
      scenarioId: "foundation-models",
      executableId: "azure-openai",
      parameterBindings: [{ key: "modelName", value: 7 }],
    } },
    catalog: goodCatalog,
  }))
  await assert.rejects(discover(base()), { code: "response" })

  installFetch(router({
    deployments,
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: { count: -1, resources: [] },
  }))
  await assert.rejects(discover(base()), { code: "response" })
})

test("empty and stopped deployments yield an empty registry without any configuration or catalog lookup", async () => {
  const stopped = { id: "d0000000000000cc", status: "STOPPED", deploymentUrl: urlFor("d0000000000000cc"), configurationId: "c" + "e".repeat(15) }

  const emptyCalls = installFetch(router({ deployments: { resources: [] }, configs: {}, catalog: catalogFor() }))
  assert.deepEqual(Object.keys(await discover(base())), [])
  assert.ok(emptyCalls.every(c => new URL(c.href).pathname === DEPLOYMENTS))

  const stoppedCalls = installFetch(router({ deployments: { resources: [stopped] }, configs: {}, catalog: catalogFor() }))
  assert.deepEqual(Object.keys(await discover(base())), [])
  assert.ok(stoppedCalls.every(c => new URL(c.href).pathname === DEPLOYMENTS))
})

test("caller cancellation during a configuration lookup rejects and a fresh call recovers", async () => {
  const cid = "c" + "9".repeat(15)
  let reading
  const started = new Promise(r => { reading = r })
  installFetch((href) => {
    const url = new URL(href)
    if (url.pathname === DEPLOYMENTS) {
      return url.searchParams.get("$skip") === "0"
        ? ok({ resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] })
        : ok({ resources: [] })
    }
    return { ok: true, status: 200, redirected: false, url: "", body: streamBody({ onStart: () => reading() }) }
  })

  const controller = new AbortController()
  const pending = discover(base({ signal: controller.signal }))
  await started
  controller.abort()
  await assert.rejects(pending, { code: "cancelled" })

  installFetch(router({
    deployments: { resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] },
    configs: { [cid]: config("gpt-6-astra", "2026-09-03", cid) },
    catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
  }))
  assert.deepEqual(Object.keys(await discover(base())), ["gpt-6-astra"])
})

test("a malformed deployment status rejects the whole discovery and never yields a partial registry", async () => {
  const MISSING = Symbol("missing")
  const good = "c" + "f".repeat(15)
  for (const value of [MISSING, null, 7, ""]) {
    const bad = row("d0000000000000bb", "gpt-6.1-sol", "2026-09-29", "c" + "0".repeat(15))
    if (value === MISSING) delete bad.status
    else bad.status = value
    installFetch(router({
      deployments: { resources: [
        row("d0000000000000aa", "gpt-6-astra", "2026-09-03", good),
        bad,
      ] },
      configs: { [good]: config("gpt-6-astra", "2026-09-03", good) },
      catalog: catalogFor(["gpt-6-astra", "2026-09-03"]),
    }))
    await assert.rejects(discover(base()), { code: "response" })
  }
})

test("a valid non-RUNNING status string is excluded without a lookup and never throws", async () => {
  for (const status of ["STOPPED", "PENDING", "UNKNOWN"]) {
    const only = row("d0000000000000cc", "gpt-6-astra", "2026-09-03", "c" + "e".repeat(15))
    only.status = status
    const calls = installFetch(router({ deployments: { resources: [only] }, configs: {}, catalog: catalogFor() }))
    assert.deepEqual(Object.keys(await discover(base())), [])
    assert.ok(calls.every(c => new URL(c.href).pathname === DEPLOYMENTS))
  }
})

test("missing catalog streaming keeps the verified capability true while an explicit false hides the deployment", async () => {
  const cid = "c" + "3".repeat(15)
  const deployments = { resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] }
  const configs = { [cid]: config("gpt-6-astra", "2026-09-03", cid) }

  installFetch(router({ deployments, configs, catalog: catalogStreaming("gpt-6-astra", "2026-09-03", undefined) }))
  const entry = (await discover(base()))["gpt-6-astra"]
  assert.equal(entry.capabilities.streaming, true)
  assert.ok(!("streamingSupported" in (entry.metadata ?? {})))

  installFetch(router({ deployments, configs, catalog: catalogStreaming("gpt-6-astra", "2026-09-03", false) }))
  assert.deepEqual(Object.keys(await discover(base())), [])
})

test("the deadline wins while a configuration lookup hangs and cancels its reader", async () => {
  jest.useFakeTimers()
  const cid = "c" + "8".repeat(15)
  let cancelled = false
  let reading
  const started = new Promise(r => { reading = r })
  installFetch((href) => {
    const url = new URL(href)
    if (url.pathname === DEPLOYMENTS) {
      return url.searchParams.get("$skip") === "0"
        ? ok({ resources: [row("d02212989ca345a2", "gpt-6-astra", "2026-09-03", cid)] })
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
