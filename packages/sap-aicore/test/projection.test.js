import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import { projectModels } from "../src/discovery.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

function entry(modelName, extra = {}) {
  return Object.freeze({
    protocol: "responses",
    canonicalID: modelName,
    displayLabel: modelName,
    apiNpm: "@ai-sdk/openai",
    modelName,
    deploymentID: "d-" + modelName,
    deploymentURL: "https://api.ai.eu10.hana.ondemand.com/v2/inference/deployments/d-" + modelName,
    configuredVersion: "latest",
    activeVersion: "2026-09-03",
    activeEvidence: "deployment-backend",
    scenarioID: "foundation-models",
    executableID: "azure-openai",
    configurationID: "c-" + modelName,
    routePolicy: Object.freeze({ path: "/responses", query: false }),
    capabilities: Object.freeze({ text: true, functionTool: true, streaming: true }),
    ...extra,
  })
}

test("projects a verified entry with context into the public catalog shape", () => {
  const registry = { "gpt-6-astra": entry("gpt-6-astra", { metadata: Object.freeze({ contextLength: 1050000, retirementDate: "2027-01-01", inputTypes: Object.freeze(["text"]) }) }) }
  assert.deepEqual(projectModels(registry), {
    "gpt-6-astra": {
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
    },
  })
})

test("omits limit when context length is absent", () => {
  const noMeta = projectModels({ "gpt-6.1-sol": entry("gpt-6.1-sol") })["gpt-6.1-sol"]
  const retireOnly = projectModels({ "gpt-6.1-sol": entry("gpt-6.1-sol", { metadata: Object.freeze({ retirementDate: "2027-01-01" }) }) })["gpt-6.1-sol"]
  assert.equal("limit" in noMeta, false)
  assert.equal("limit" in retireOnly, false)
})

test("leaks no deployment, configuration, or provenance state", () => {
  const model = projectModels({ "gpt-6-astra": entry("gpt-6-astra", { metadata: Object.freeze({ contextLength: 1050000, retirementDate: "2027-01-01" }) }) })["gpt-6-astra"]
  for (const key of ["deploymentID", "deploymentURL", "configurationID", "configuredVersion", "activeVersion", "activeEvidence", "scenarioID", "executableID", "routePolicy", "metadata", "retirementDate"]) {
    assert.equal(key in model, false, key)
  }
  assert.deepEqual(Object.keys(model.capabilities), ["toolcall", "attachment", "input", "output"])
})

test("each projection owns fresh objects isolated from the registry and prior calls", () => {
  const source = entry("gpt-6-astra", { metadata: Object.freeze({ contextLength: 1050000 }) })
  const registry = { "gpt-6-astra": source }
  const first = projectModels(registry)
  first["gpt-6-astra"].capabilities.toolcall = false
  first["gpt-6-astra"].limit.context = 1
  first["gpt-6-astra"].capabilities.input.text = false
  const second = projectModels(registry)
  assert.equal(second["gpt-6-astra"].capabilities.toolcall, true)
  assert.equal(second["gpt-6-astra"].limit.context, 1050000)
  assert.equal(second["gpt-6-astra"].capabilities.input.text, true)
  assert.equal(source.capabilities.functionTool, true)
})
