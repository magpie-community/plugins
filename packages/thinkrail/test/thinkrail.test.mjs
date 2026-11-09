import { expect, test } from "bun:test"

import pkg from "../package.json"
import { agent, connect } from "../thinkrail.agent.js"

test("descriptor", () => {
  expect(agent.id).toBe("thinkrail")
  expect(agent.config).toBe("~/.pi/agent/models.json")
  expect(agent.format).toBe("json")
  expect(agent.dir.startsWith("~/")).toBe(true)
  expect(typeof agent.notice === "string" && agent.notice.length > 0).toBe(true)
})

test("connect writes the whole magpie provider as one unit", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "magpie-thinkrail" },
    models: [
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", images: false, context: 128000, output: 8192, efforts: [] },
    ],
  })

  expect(Object.keys(out)).toEqual(["providers.magpie"])
  const p = out["providers.magpie"]
  expect(p.name).toBe("Magpie")
  expect(p.baseUrl).toBe("http://127.0.0.1:3425/v1")
  expect(p.apiKey).toBe("magpie-thinkrail")
  expect(p.api).toBe("openai-completions")
  expect(p.models.length).toBe(1)

  const m = p.models[0]
  expect(m.id).toBe("deepseek/deepseek-chat")
  expect(m.input).toEqual(["text"])
  expect(m.reasoning).toBe(false)
  expect(m.contextWindow).toBe(128000)
  expect(m.maxTokens).toBe(8192)
  expect(m.thinkingLevelMap).toBeUndefined()
})

test("output limit never exceeds the context window", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "k" },
    models: [{ id: "x/y", name: "X", images: false, context: 32000, output: 999999, efforts: ["low", "high"] }],
  })
  const m = out["providers.magpie"].models[0]
  expect(m.maxTokens).toBe(32000)
  expect(m.reasoning).toBe(true)
  // pig semantics: a level maps to the pi effort name when the model
  // publishes it, otherwise null ("off" asks for the "none" effort).
  expect(m.thinkingLevelMap.off).toBe(null)
  expect(m.thinkingLevelMap.low).toBe("low")
  expect(m.thinkingLevelMap.high).toBe("high")
  expect(m.thinkingLevelMap.minimal).toBe(null)
})

test("image-capable model advertises image input", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "k" },
    models: [{ id: "x/img", name: "X", images: true, context: 0, output: 0, efforts: [] }],
  })
  const m = out["providers.magpie"].models[0]
  expect(m.input).toEqual(["text", "image"])
  expect(m.contextWindow).toBeUndefined()
  expect(m.maxTokens).toBeUndefined()
})

test("icon is the same data URI in the descriptor and package.json", () => {
  expect(agent.icon).toBe(pkg.magpie.icon)
  expect(pkg.magpie.icon.startsWith("data:image/svg+xml;base64,")).toBe(true)
})
