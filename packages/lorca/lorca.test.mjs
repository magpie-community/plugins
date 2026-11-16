import { expect, test } from "bun:test"
import { agent, connect } from "./lorca.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-lorca" }

test("exports agent metadata for Lorca", () => {
  expect(agent).toMatchObject({
    id: "lorca",
    name: "Lorca",
    config: "~/.lorca/credentials.json",
    format: "json",
    dir: "~/.lorca",
    ua: ["lorca"],
    library: {
      mcp: "~/.lorca/mcp.json",
      mcpFormat: "claude",
    },
    merge: ["custom.custom:magpie"],
  })
})

test("connect maps models, gateway and thinking levels correctly", () => {
  const models = [
    {
      id: "deepseek/pro",
      name: "DeepSeek Pro",
      context: 128000,
      output: 8192,
      images: true,
      efforts: ["none", "minimal", "low", "high", "unknown_level"],
    },
    {
      id: "plain-model",
      efforts: [],
    },
    null,
    {},
  ]

  const out = connect({ gateway, models })
  const provider = out["custom.custom:magpie"]
  expect(provider).toBeDefined()
  expect(provider.name).toBe("Magpie")
  expect(provider.api).toBe("chat-completions")
  expect(provider.base_url).toBe("http://127.0.0.1:3425/v1")
  expect(provider.api_key).toBe("magpie-lorca")
  expect(typeof provider.created_at).toBe("number")

  expect(provider.models).toHaveLength(2)
  expect(provider.models[0]).toEqual({
    id: "deepseek/pro",
    name: "DeepSeek Pro",
    context_window: 128000,
    max_output: 8192,
    images: true,
    levels: ["off", "minimal", "low", "high"],
  })
  expect(provider.models[1]).toEqual({
    id: "plain-model",
    images: false,
  })
})
