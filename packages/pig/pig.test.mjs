import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { agent, connect } from "./pig.agent.js"

const gateway = { url: "http://127.0.0.1:3499", v1: "http://127.0.0.1:3499/v1", key: "magpie-pig" }
const model = { id: "relay/vendor/model:variant", name: "Example", context: 262144, output: 32768, images: true, efforts: ["none", "low", "high", "max"] }
const output = (models = [model]) => connect({ gateway, models, agent: { id: "pig", config: "/synthetic/.pig/agent/models.json" } })
const provider = (models = [model]) => output(models)["providers.magpie"]

test("registers PiG as a connect-only agent with no model or Library writes", () => {
  expect(agent).toMatchObject({ id: "pig", name: "PiG", bin: "pig", config: "~/.pig/agent/models.json", format: "json" })
  expect(agent.icon).toBe("https://pi-in-go.dev/pig-favicon.svg")
  expect(agent.model).toBeUndefined()
  expect(agent.library).toBeUndefined()
  expect(agent.notice).toContain("/model")
})

test("declares the standard community Agent entry and no host plugin", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  expect(pkg.name).toBe("@magpie-community/agent-pig")
  expect(pkg.magpie.agent).toBe("./pig.agent.js")
  expect(pkg.magpie.icon).toBe(agent.icon)
  expect(pkg.main).toBeUndefined()
  expect(pkg.dependencies).toBeUndefined()
  expect(pkg.scripts.preinstall).toBeUndefined()
  expect(pkg.scripts.postinstall).toBeUndefined()
})

test("gives the host one complete provider restore unit without touching other providers or settings", () => {
  const out = output()
  expect(Object.keys(out)).toEqual(["providers.magpie"])
  expect(out["providers.magpie"].baseUrl).toBe(gateway.v1)
  expect(out["providers.magpie"].apiKey).toBe("magpie-pig")
  expect(out["providers.magpie"].api).toBe("openai-completions")
})

test("preserves gateway model IDs including slashes and maps capability metadata", () => {
  expect(provider().models).toEqual([{
    id: model.id, name: "Example", input: ["text", "image"], reasoning: true,
    contextWindow: 262144, maxTokens: 32768,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  }])
})

test("does not advertise thinking off for a model that always thinks", () => {
  const [entry] = provider([{ ...model, efforts: ["high"] }]).models
  expect(entry.thinkingLevelMap.off).toBeNull()
  expect(entry.thinkingLevelMap.high).toBe("high")
  expect(entry.thinkingLevelMap.medium).toBeNull()
})

test("leaves missing or nonpositive limits to PiG and handles text-only models", () => {
  for (const limits of [{}, { context: 0, output: 0 }, { context: -1, output: -1 }]) {
    expect(provider([{ id: "relay/plain", ...limits }]).models).toEqual([
      { id: "relay/plain", name: "relay/plain", input: ["text"], reasoning: false },
    ])
  }
})

test("keeps a published output limit within its known context window", () => {
  const [bounded] = provider([{ id: "relay/oversized-output", context: 8192, output: 32768 }]).models
  expect(bounded.maxTokens).toBe(8192)
  const [unknownWindow] = provider([{ id: "relay/unknown-window", output: 32768 }]).models
  expect(unknownWindow.maxTokens).toBe(32768)
  expect(unknownWindow.contextWindow).toBeUndefined()
})

test("replaces catalog contents on the next call, including an empty catalog", () => {
  expect(provider([{ id: "new/only", efforts: [] }]).models.map(m => m.id)).toEqual(["new/only"])
  expect(provider([]).models).toEqual([])
})

test("follows host gateway changes without caching an endpoint or key", () => {
  const next = connect({ gateway: { v1: "http://127.0.0.1:3500/v1", key: "synthetic-next-key" }, models: [] })["providers.magpie"]
  expect(next.baseUrl).toBe("http://127.0.0.1:3500/v1")
  expect(next.apiKey).toBe("synthetic-next-key")
})

test("does not mutate host inputs", () => {
  const input = { gateway: { ...gateway }, models: [{ ...model, efforts: [...model.efforts] }] }
  const before = JSON.stringify(input)
  connect(input)
  expect(JSON.stringify(input)).toBe(before)
})
