import { expect, test } from "bun:test"
import { agent, connect } from "./craft.agent.js"

const gateway = { v1: "http://127.0.0.1:3425/v1" }

test("locates Craft's connection model without advertising unsupported instructions", () => {
  expect(agent).toMatchObject({ id: "craft-agents", config: "~/.craft-agent/config.json", format: "json", model: "llmConnections.0.defaultModel" })
  expect(agent.library).toBeUndefined()
  expect(agent.icon).toMatch(/^data:image\//)
})

test("creates a localhost connection and maps model capabilities without mutating inputs", () => {
  const models = [{ id: "vision", name: "Vision", context: 128000, images: true }, { id: "text", images: false }, { id: "unknown" }]
  const before = structuredClone(models)
  const output = connect({ gateway, model: models[0], models })
  expect(output.defaultLlmConnection).toBe("magpie")
  expect(output.llmConnections).toHaveLength(1)
  expect(output.llmConnections[0]).toEqual({
    slug: "magpie", name: "Magpie", providerType: "pi_compat", authType: "none",
    baseUrl: gateway.v1, defaultModel: "vision", customEndpoint: { api: "openai-completions" },
    createdAt: expect.any(Number), models: [
      { id: "vision", name: "Vision", contextWindow: 128000, supportsImages: true },
      { id: "text", name: "text", supportsImages: false },
      { id: "unknown", name: "unknown" },
    ],
  })
  expect(models).toEqual(before)
})

test("handles an absent model and an omitted catalog", () => {
  expect(connect({ gateway })).toEqual({})
  expect(connect({ gateway, model: { id: "text" } }).llmConnections[0].models).toEqual([])
})
