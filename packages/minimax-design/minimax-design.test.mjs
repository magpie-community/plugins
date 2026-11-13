import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("./minimax-design.agent.js", import.meta.url), "utf8")

function load() {
  const context = vm.createContext({})
  return JSON.parse(vm.runInContext(
    source.replaceAll("export ", "") + "\nJSON.stringify({ agent, result: connect(input) })",
    Object.assign(context, {
      input: {
        gateway: { v1: "http://127.0.0.1:3425/v1", key: "test-key" },
        models: [{ id: "vendor/model", context: 128000, output: 16000, efforts: ["none", "high"] }],
      },
    }),
  ))
}

test("agent loads without host globals and uses the shared native-data entry", () => {
  const { agent } = load()
  assert.equal(agent.config, "~/.minimax-design/hub-config.json")
  assert.equal(agent.dir, "~/.minimax-design")
  assert.deepEqual(agent.library, {
    skills: "~/Movies/Hub/skills",
    mcp: "~/.minimax-design/ai-runtime/config-home/opencode/opencode.json",
    mcpFormat: "opencode",
  })
  assert.equal(agent.model, undefined)
  assert.equal(agent.library.instructions, undefined)
})

test("invalid IDs are omitted and duplicate IDs do not consume provider slots", () => {
  const valid = Array.from({ length: 51 }, (_, index) => ({
    id: `vendor/model-${index}`, context: 128000, output: 16000, efforts: ["high", "high", "none"],
  }))
  const invalid = ["", "vendor/bad id", "vendor/\u0000bad", "__hub_reasoning__reserved", 123]
    .map((id) => ({ id, context: 128000, output: 16000 }))
  const context = vm.createContext({
    input: {
      gateway: { v1: "http://localhost/v1", key: "test-key" },
      models: [...invalid, ...valid, ...valid],
    },
  })
  const result = JSON.parse(vm.runInContext(
    source.replaceAll("export ", "") + "\nJSON.stringify(connect(input))", context,
  ))
  const entries = Object.values(result)
  assert.deepEqual(entries.map((entry) => entry.models.length), [50, 1])
  assert.deepEqual(entries.flatMap((entry) => entry.models.map((model) => model.id)),
    valid.map((model) => model.id))
  assert.deepEqual(entries[0].models[0].reasoningLevels, ["high"])
  context.input.models = invalid
  assert.throws(() => vm.runInContext("connect(input)", context), /valid ID/)
})

test("models always contain valid limits and an array of supported reasoning levels", () => {
  const { result } = load()
  assert.deepEqual(result, {
    "config.customModels.user-custom-magpie": {
      protocol: "openai-compatible", providerName: "Magpie",
      baseUrl: "http://127.0.0.1:3425/v1", apiKey: "test-key",
      models: [{ id: "vendor/model", contextWindow: 128000, maxOutputTokens: 16000, reasoningLevels: ["high"] }],
    },
  })
})

test("Design's 50-model limit splits a large catalog without truncation", () => {
  const models = Array.from({ length: 101 }, (_, index) => ({
    id: `vendor/model-${index}`, context: 128000, output: 16000, efforts: [],
  }))
  const context = vm.createContext({
    input: { gateway: { v1: "http://localhost/v1", key: "test-key" }, models },
  })
  const result = JSON.parse(vm.runInContext(
    source.replaceAll("export ", "") + "\nJSON.stringify(connect(input))", context,
  ))
  assert.deepEqual(Object.values(result).map((entry) => entry.models.length), [50, 50, 1])
  assert.deepEqual(Object.values(result).flatMap((entry) => entry.models.map((model) => model.id)),
    models.map((model) => model.id))
})

test("missing limits are omitted and an empty eligible catalog is refused", () => {
  const context = vm.createContext({
    input: {
      gateway: { v1: "http://localhost/v1", key: "test-key" },
      models: [
        { id: "missing" }, { id: "zero", context: 0, output: 10 },
        { id: "too-large", context: 10, output: 11 },
        { id: "fraction", context: 100, output: 1.5 },
      ],
    },
  })
  assert.throws(() => vm.runInContext(
    source.replaceAll("export ", "") + "\nconnect(input)", context,
  ), /valid context and output limits/)
})
