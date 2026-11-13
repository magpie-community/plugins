import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("./minimax-design.agent.js", import.meta.url), "utf8")

function load(platform) {
  const context = vm.createContext({ magpie: { platform } })
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

test("macOS selects observed config and the isolated runtime's Library paths", () => {
  const { agent } = load("darwin")
  assert.equal(agent.config, "~/Library/Application Support/@hilo/desktop/hub-config.json")
  assert.equal(agent.dir, "~/Library/Application Support/@hilo/desktop")
  assert.deepEqual(agent.library, {
    skills: "~/Movies/Hub/skills",
    mcp: "~/Library/Application Support/@hilo/desktop/ai-runtime/config-home/opencode/opencode.json",
    mcpFormat: "opencode",
  })
  assert.equal(agent.model, undefined)
  assert.equal(agent.library.instructions, undefined)
})

test("Windows retains its config path and gets a separate runtime Library", () => {
  const { agent } = load("windows")
  assert.equal(agent.config, "$APPDATA/@hilo/desktop/hub-config.json")
  assert.equal(agent.library.mcp, "$APPDATA/@hilo/desktop/ai-runtime/config-home/opencode/opencode.json")
  assert.equal(agent.library.skills, "~/Movies/Hub/skills")
})

test("unsupported platforms fail before exporting writable paths", () => {
  assert.throws(() => load("linux"), /macOS and Windows only/)
})

test("an older Magpie fails explicitly instead of choosing Windows on macOS", () => {
  assert.throws(() => vm.runInNewContext(source.replaceAll("export ", "")), /Update Magpie/)
})

test("models always contain valid limits and an array of supported reasoning levels", () => {
  const { result } = load("darwin")
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
    magpie: { platform: "darwin" },
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
    magpie: { platform: "darwin" },
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
