import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import { resolveDeployment } from "../src/discovery.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"
const ASTRA_ID = "d02212989ca345a2"
const SOL_ID = "d0bdd146b3138906"
const FUTURE = "2099-01-01"

function urlFor(id) {
  return AI_ROOT + "/v2/inference/deployments/" + id
}

function backend(name, version) {
  return { details: { resources: { backendDetails: { model: { name, version } } } } }
}

function deployment(over = {}) {
  const id = over.id ?? ASTRA_ID
  return {
    id,
    status: "RUNNING",
    deploymentUrl: urlFor(id),
    ...backend("gpt-6-astra", "2026-09-03"),
    ...over,
  }
}

function configuration(over = {}) {
  return {
    id: "c" + "0".repeat(15),
    scenarioId: "foundation-models",
    executableId: "azure-openai",
    parameterBindings: [
      { key: "modelName", value: "gpt-6-astra" },
      { key: "modelVersion", value: "2026-09-03" },
    ],
    ...over,
  }
}

function catalogFor(model, version, versionOver = {}) {
  return {
    count: 1,
    resources: [{
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
        ...versionOver,
      }],
    }],
  }
}

function astra(over = {}) {
  return {
    deployment: deployment(over.deployment),
    configuration: configuration(over.configuration),
    catalog: over.catalog ?? catalogFor("gpt-6-astra", "2026-09-03"),
    aiRoot: over.aiRoot ?? AI_ROOT,
  }
}

function sol(over = {}) {
  return {
    deployment: deployment({
      id: SOL_ID,
      ...backend("gpt-6.1-sol", "2026-09-29"),
      ...over.deployment,
    }),
    configuration: configuration({
      parameterBindings: [
        { key: "modelName", value: "gpt-6.1-sol" },
        { key: "modelVersion", value: "2026-09-29" },
      ],
      ...over.configuration,
    }),
    catalog: over.catalog ?? catalogFor("gpt-6.1-sol", "2026-09-29"),
    aiRoot: AI_ROOT,
  }
}

test("eligible gpt-6-astra yields a frozen entry with identity, URL, route, and capabilities", () => {
  const entry = resolveDeployment(astra())
  assert.equal(entry.modelName, "gpt-6-astra")
  assert.equal(entry.protocol, "responses")
  assert.equal(entry.canonicalID, "gpt-6-astra")
  assert.equal(entry.displayLabel, "gpt-6-astra")
  assert.equal(entry.apiNpm, "@ai-sdk/openai")
  assert.equal(entry.deploymentID, ASTRA_ID)
  assert.equal(entry.deploymentURL, urlFor(ASTRA_ID))
  assert.equal(entry.configuredVersion, "2026-09-03")
  assert.equal(entry.activeVersion, "2026-09-03")
  assert.equal(entry.scenarioID, "foundation-models")
  assert.equal(entry.executableID, "azure-openai")
  assert.deepEqual(entry.routePolicy, { path: "/responses", query: false })
  assert.deepEqual(entry.capabilities, { text: true, functionTool: true, streaming: true, image: false })
  assert.equal(entry.configurationID, "c" + "0".repeat(15))
  assert.equal(entry.metadata.contextLength, 1050000)
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.routePolicy) && Object.isFrozen(entry.metadata))
})

test("eligible gpt-6.1-sol resolves its own identity and active version", () => {
  const entry = resolveDeployment(sol())
  assert.equal(entry.modelName, "gpt-6.1-sol")
  assert.equal(entry.deploymentID, SOL_ID)
  assert.equal(entry.activeVersion, "2026-09-29")
  assert.equal(entry.deploymentURL, urlFor(SOL_ID))
})

test("configuration supplies fallback identity and executable when the deployment omits them", () => {
  const entry = resolveDeployment(astra({ deployment: {} }))
  assert.equal(entry.modelName, "gpt-6-astra")
  assert.equal(entry.executableID, "azure-openai")
})

test("the latest selector resolves the active version from the concrete backend", () => {
  const entry = resolveDeployment(astra({
    configuration: { parameterBindings: [{ key: "modelName", value: "gpt-6-astra" }] },
  }))
  assert.equal(entry.configuredVersion, "latest")
  assert.equal(entry.activeVersion, "2026-09-03")
})

test("a pinned version that disagrees with the backend is rejected", () => {
  const out = resolveDeployment(astra({
    configuration: {
      parameterBindings: [
        { key: "modelName", value: "gpt-6-astra" },
        { key: "modelVersion", value: "2026-08-01" },
      ],
    },
  }))
  assert.equal(out, null)
})

test("missing backend evidence hides the deployment", () => {
  assert.equal(resolveDeployment(astra({ deployment: { details: undefined } })), null)
})

test("a pin alone without backend never proves active", () => {
  const dep = deployment()
  delete dep.details
  assert.equal(resolveDeployment({ ...astra(), deployment: dep }), null)
})

test("GPT major versions 6 and above accept any catalog-matched active version", () => {
  for (const name of ["gpt-6", "gpt-6-mini", "gpt-6.2", "gpt-6.2-mini", "gpt-7-astra", "gpt-10", "gpt-10.1-mini"]) {
    const version = "2027-01-01"
    const entry = resolveDeployment(astra({
      deployment: backend(name, version),
      configuration: { parameterBindings: [{ key: "modelName", value: name }, { key: "modelVersion", value: version }] },
      catalog: catalogFor(name, version),
    }))
    assert.ok(entry, name)
    assert.equal(entry.canonicalID, name)
    assert.equal(entry.activeVersion, version)
    assert.equal(entry.protocol, "responses")
  }
})

test("older GPT majors, non-GPT identities, malformed names, and stopped deployments stay hidden", () => {
  assert.equal(resolveDeployment(astra({ deployment: { status: "STOPPED" } })), null)
  for (const name of ["gpt-4o", "gpt-5", "gpt-5-turbo", "gpt-5.9-mini", "o6", "claude-6", "not-gpt-6", "gpt-six", "gpt-6x", "gpt-6.", "gpt-6-", "gpt-6\n"]) {
    assert.equal(resolveDeployment(astra({
      deployment: backend(name, "2027-01-01"),
      configuration: { parameterBindings: [{ key: "modelName", value: name }] },
      catalog: catalogFor(name, "2027-01-01"),
    })), null, name)
  }
})

test("a wrong scenario or executable hides, in configuration, deployment, and catalog", () => {
  assert.equal(resolveDeployment(astra({ configuration: { scenarioId: "orchestration" } })), null)
  assert.equal(resolveDeployment(astra({ configuration: { executableId: "openai" } })), null)
  assert.equal(resolveDeployment(astra({ deployment: { scenarioId: "orchestration" } })), null)
  assert.equal(resolveDeployment(astra({ deployment: { executableId: "openai" } })), null)
  const wrongScenario = catalogFor("gpt-6-astra", "2026-09-03")
  wrongScenario.resources[0].allowedScenarios = [{ scenarioId: "orchestration", executableId: "orchestration" }]
  assert.equal(resolveDeployment(astra({ catalog: wrongScenario })), null)
})

test("conflicting configuration id and duplicate identity bindings fail closed", () => {
  assert.equal(resolveDeployment(astra({
    deployment: { configurationId: "c" + "1".repeat(15) },
  })), null)
  assert.equal(resolveDeployment(astra({
    configuration: {
      parameterBindings: [
        { key: "modelName", value: "gpt-6-astra" },
        { key: "modelName", value: "gpt-6.1-sol" },
        { key: "modelVersion", value: "2026-09-03" },
      ],
    },
  })), null)
  assert.equal(resolveDeployment(astra({
    configuration: { parameterBindings: [] },
  })), null)
})

test("a catalog duplicate model or version fails closed", () => {
  const dupModel = catalogFor("gpt-6-astra", "2026-09-03")
  dupModel.resources.push(dupModel.resources[0])
  assert.equal(resolveDeployment(astra({ catalog: dupModel })), null)
  const dupVersion = catalogFor("gpt-6-astra", "2026-09-03")
  dupVersion.resources[0].versions.push({ ...dupVersion.resources[0].versions[0] })
  assert.equal(resolveDeployment(astra({ catalog: dupVersion })), null)
})

test("context metadata is included when valid and omitted when absent", () => {
  const withCtx = resolveDeployment(astra())
  assert.equal(withCtx.metadata.contextLength, 1050000)
  const noCtx = resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { contextLength: undefined }) }))
  assert.ok(!("contextLength" in (noCtx.metadata ?? {})))
  const badCtx = resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { contextLength: "big" }) }))
  assert.equal(badCtx, null)
})

test("a deprecated, retired, or invalid-metadata version hides, future retirement is retained", () => {
  assert.equal(resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { deprecated: true }) })), null)
  assert.equal(resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { retirementDate: "2000-01-01" }) })), null)
  assert.equal(resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { retirementDate: "2026-13-40" }) })), null)
  assert.equal(resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { streamingSupported: false }) })), null)
  assert.equal(resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { inputTypes: ["image"] }) })), null)
  const retained = resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { retirementDate: FUTURE }) }))
  assert.equal(retained.metadata.retirementDate, FUTURE)
  // Boundary: a version retiring at exactly today's UTC date is already expired
  // (the cutoff is <=, not <), so it hides rather than being served its last day.
  const today = new Date().toISOString().slice(0, 10)
  assert.equal(resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { retirementDate: today }) })), null)
})

test("an image-advertising catalog adds image capability", () => {
  const entry = resolveDeployment(astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { inputTypes: ["text", "image"] }) }))
  assert.deepEqual(entry.capabilities, { text: true, functionTool: true, streaming: true, image: true })
})

test("an unsafe deployment URL is rejected", () => {
  const unsafe = [
    undefined,
    "http://api.ai.eu10.hana.ondemand.com/v2/inference/deployments/" + ASTRA_ID,
    "https://user:pass@api.ai.eu10.hana.ondemand.com/v2/inference/deployments/" + ASTRA_ID,
    "https://api.ai.eu10.hana.ondemand.com:443/v2/inference/deployments/" + ASTRA_ID,
    urlFor(ASTRA_ID) + "?x=1",
    urlFor(ASTRA_ID) + "#f",
    urlFor(ASTRA_ID) + "/responses",
    urlFor(ASTRA_ID) + " ",
    "https://api.ai.eu10.hana.ondemand.com/v2/inference/deployments/" + ASTRA_ID + "/..",
    "https://api.ai.eu10.hana.ondemand.com/v2/inference/deployments/%2e%2e",
    "https://api.ai.eu10.hana.ondemand.com\\@evil.example.com/v2/inference/deployments/" + ASTRA_ID,
    "https://evil.example.com/v2/inference/deployments/" + ASTRA_ID,
    "https://api.ai.eu10.hana.ondemand.com/v2/lm/deployments/" + ASTRA_ID,
  ]
  for (const deploymentUrl of unsafe) {
    assert.equal(resolveDeployment(astra({ deployment: { deploymentUrl } })), null, String(deploymentUrl))
  }
})

test("the URL origin must match aiRoot, never a base reconstructed from the id", () => {
  const other = "https://api.ai.us10.hana.ondemand.com"
  assert.equal(resolveDeployment({ ...astra(), aiRoot: other }), null)
})

test("catalog availability alone never generates a deployment", () => {
  assert.equal(resolveDeployment({ deployment: undefined, configuration: configuration(), catalog: catalogFor("gpt-6-astra", "2026-09-03"), aiRoot: AI_ROOT }), null)
  assert.equal(resolveDeployment({ ...astra(), catalog: undefined }), null)
})

test("a malformed parameterBindings member fails closed, never silently ignored", () => {
  for (const bad of ["garbage", 42, null, { foo: 1 }, { key: "extra", value: 5 }, { key: 7, value: "x" }]) {
    assert.equal(resolveDeployment(astra({
      configuration: { parameterBindings: [
        { key: "modelName", value: "gpt-6-astra" },
        { key: "modelVersion", value: "2026-09-03" },
        bad,
      ] },
    })), null, String(bad && bad.key))
  }
})

test("a malformed modelVersion value never collapses to the latest selector", () => {
  assert.equal(resolveDeployment(astra({
    configuration: { parameterBindings: [
      { key: "modelName", value: "gpt-6-astra" },
      { key: "modelVersion", value: 20260903 },
    ] },
  })), null)
})

test("a duplicate modelVersion binding fails closed", () => {
  assert.equal(resolveDeployment(astra({
    configuration: { parameterBindings: [
      { key: "modelName", value: "gpt-6-astra" },
      { key: "modelVersion", value: "2026-09-03" },
      { key: "modelVersion", value: "2026-09-03" },
    ] },
  })), null)
})

test("a backend identity that disagrees with the configured model fails closed", () => {
  assert.equal(resolveDeployment(astra({
    deployment: backend("gpt-6.1-sol", "2026-09-03"),
  })), null)
})

test("an explicit latest selector resolves and labels the backend active version", () => {
  const entry = resolveDeployment(astra({
    configuration: { parameterBindings: [
      { key: "modelName", value: "gpt-6-astra" },
      { key: "modelVersion", value: "latest" },
    ] },
  }))
  assert.equal(entry.configuredVersion, "latest")
  assert.equal(entry.activeVersion, "2026-09-03")
  assert.equal(entry.activeEvidence, "deployment-backend")
})

test("latest accepts a new backend version only with matching catalog evidence", () => {
  const input = astra({
    deployment: backend("gpt-6-astra", "2027-01-01"),
    configuration: { parameterBindings: [{ key: "modelName", value: "gpt-6-astra" }] },
    catalog: catalogFor("gpt-6-astra", "2027-01-01", { contextLength: 200000 }),
  })
  const entry = resolveDeployment(input)
  assert.equal(entry.configuredVersion, "latest")
  assert.equal(entry.activeVersion, "2027-01-01")
  assert.equal(entry.metadata.contextLength, 200000)
  input.catalog = catalogFor("gpt-6-astra", "2026-09-03")
  assert.equal(resolveDeployment(input), null)
})

test("a backend latest selector is unresolved even with matching catalog metadata", () => {
  for (const versionBindings of [[], [{ key: "modelVersion", value: "latest" }]]) {
    assert.equal(resolveDeployment(astra({
      deployment: backend("gpt-6-astra", "latest"),
      configuration: { parameterBindings: [{ key: "modelName", value: "gpt-6-astra" }, ...versionBindings] },
      catalog: catalogFor("gpt-6-astra", "latest"),
    })), null)
  }
})

test("a non-nonnegative-integer catalog count fails closed", () => {
  for (const count of [-1, 1.5, "1", Number.NaN]) {
    const cat = catalogFor("gpt-6-astra", "2026-09-03")
    cat.count = count
    assert.equal(resolveDeployment(astra({ catalog: cat })), null, String(count))
  }
})

test("a malformed model-level allowedScenarios member fails closed despite a valid row", () => {
  const cat = catalogFor("gpt-6-astra", "2026-09-03")
  cat.resources[0].allowedScenarios = [
    { scenarioId: "foundation-models", executableId: "azure-openai" },
    { scenarioId: 5 },
  ]
  assert.equal(resolveDeployment(astra({ catalog: cat })), null)
})

test("a version-level allowedScenarios is validated and must carry the required tuple", () => {
  const ok = resolveDeployment(astra({
    catalog: catalogFor("gpt-6-astra", "2026-09-03", {
      allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }],
    }),
  }))
  assert.equal(ok.activeVersion, "2026-09-03")
  assert.equal(resolveDeployment(astra({
    catalog: catalogFor("gpt-6-astra", "2026-09-03", {
      allowedScenarios: [{ scenarioId: "orchestration", executableId: "orchestration" }],
    }),
  })), null)
  assert.equal(resolveDeployment(astra({
    catalog: catalogFor("gpt-6-astra", "2026-09-03", {
      allowedScenarios: [{ scenarioId: 5, executableId: "azure-openai" }],
    }),
  })), null)
})

test("a non-boolean version isLatest fails closed, a boolean never infers active", () => {
  assert.equal(resolveDeployment(astra({
    catalog: catalogFor("gpt-6-astra", "2026-09-03", { isLatest: "yes" }),
  })), null)
  const entry = resolveDeployment(astra({
    catalog: catalogFor("gpt-6-astra", "2026-09-03", { isLatest: true }),
  }))
  assert.equal(entry.activeVersion, "2026-09-03")
  assert.ok(!("isLatest" in entry.metadata))
})

test("matched catalog capability and lifecycle metadata is retained as copied primitives and array", () => {
  const entry = resolveDeployment(astra())
  assert.equal(entry.metadata.streamingSupported, true)
  assert.equal(entry.metadata.deprecated, false)
  assert.deepEqual(entry.metadata.inputTypes, ["text"])
  assert.ok(Object.isFrozen(entry.metadata.inputTypes))
})

test("retained inputTypes is a copy, not an alias of the catalog input array", () => {
  const input = astra({ catalog: catalogFor("gpt-6-astra", "2026-09-03", { inputTypes: ["text", "audio"] }) })
  const entry = resolveDeployment(input)
  assert.notEqual(entry.metadata.inputTypes, input.catalog.resources[0].versions[0].inputTypes)
  input.catalog.resources[0].versions[0].inputTypes.push("image")
  assert.deepEqual(entry.metadata.inputTypes, ["text", "audio"])
})

test("the returned entry is isolated from later mutation of the inputs", () => {
  const input = astra()
  const entry = resolveDeployment(input)
  const before = { ...entry.metadata }
  input.catalog.resources[0].versions[0].contextLength = 7
  input.deployment.deploymentUrl = "https://evil.example.com"
  assert.deepEqual({ ...entry.metadata }, before)
  assert.equal(entry.deploymentURL, urlFor(ASTRA_ID))
  assert.throws(() => { entry.modelName = "x" })
})
