import { expect, test } from "bun:test"
import { agent, connect } from "./pine.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-pine" }

test("says where Pine keeps its providers and the model it starts on", () => {
  expect(agent).toMatchObject({
    id: "pine",
    bin: "pine",
    dir: "~/.pine",
    config: "~/.pine/models.json",
    prefix: "magpie/",
    startup: { config: "~/.pine/pine.json", model: "defaults.model" },
    library: { skills: "~/.pine/skills" },
  })
})

test("is the package the Agents page loads, with Pine's own icon", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.magpie.agent).toBe("./pine.agent.js")
  expect(pkg.magpie.icon).toBe(agent.icon)
  expect(pkg.files).toContain("pine.agent.js")
})

test("writes the gateway as one provider object, not as leaf keys", () => {
  const out = connect({ gateway, models: [] })
  expect(Object.keys(out)).toEqual(["providers.magpie"])
  expect(out["providers.magpie"]).toMatchObject({
    name: "Magpie",
    baseUrl: gateway.v1,
    api: "openai-responses",
    apiKey: gateway.key,
    compat: { supportsStrictMode: true },
  })
})

test("lists magpie's models by the id the gateway answers to", () => {
  const out = connect({
    gateway,
    models: [
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", context: 1000000, output: 8192, images: false, efforts: [] },
      { id: "anthropic/claude-sonnet-4-5", name: "", context: 200000, output: 64000, images: true, efforts: ["low", "medium", "high"] },
      { id: "unknown/model", name: "Unknown", context: 0, output: 0, images: false },
    ],
  })
  expect(out["providers.magpie"].models).toEqual([
    {
      id: "deepseek/deepseek-chat",
      name: "DeepSeek Chat",
      input: ["text"],
      reasoning: false,
      contextWindow: 1000000,
      maxTokens: 8192,
    },
    {
      id: "anthropic/claude-sonnet-4-5",
      name: "anthropic/claude-sonnet-4-5",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 200000,
      // a known output limit is capped at the window it comes out of
      maxTokens: 64000,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    },
    // limits the catalog does not know are left out, never 0
    { id: "unknown/model", name: "Unknown", input: ["text"], reasoning: false },
  ])
})

test("caps an output limit above the model's window", () => {
  const out = connect({ gateway, models: [{ id: "x/y", context: 32768, output: 65536, efforts: [] }] })
  expect(out["providers.magpie"].models[0].maxTokens).toBe(32768)
})

test("keeps a model without efforts out of pi's thinking levels", () => {
  const out = connect({ gateway, models: [{ id: "x/y", efforts: [] }] })
  expect(out["providers.magpie"].models[0].reasoning).toBe(false)
  expect(out["providers.magpie"].models[0].thinkingLevelMap).toBeUndefined()
})

test("off maps to none only where the model takes it", () => {
  const out = connect({ gateway, models: [{ id: "x/y", efforts: ["none", "high"] }] })
  expect(out["providers.magpie"].models[0].thinkingLevelMap).toEqual({
    off: "none",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  })
})
