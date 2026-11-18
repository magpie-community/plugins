import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { agent, connect } from "./thinkrail.agent.js"

const gateway = { v1: "http://127.0.0.1:3499/v1", key: "synthetic-key" }
const selected = { id: "group/vendor/model:variant", name: "Example", context: 65536, output: 4096, images: true, efforts: ["high"] }
const key = "providers.magpie-thinkrail"

test("registers a community agent with the official icon", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  expect(pkg.name).toBe("@magpie-community/agent-thinkrail")
  expect(pkg.magpie).toEqual({ agent: "./thinkrail.agent.js", icon: "https://thinkrail.ai/favicon.svg" })
  expect(agent.icon).toBe(pkg.magpie.icon)
  expect(agent).toMatchObject({ id: "thinkrail", name: "ThinkRail", dir: "~/.thinkrail", config: "~/.pi/agent/models.json" })
})

test("targets the desktop new-chat model and pi's MCP file", () => {
  expect(agent.startup).toEqual({
    config: "~/.thinkrail/config.json", model: "defaultModel.id",
    keys: { "defaultModel.provider": "magpie-thinkrail", "defaultModel.name": "Magpie", "defaultModel.thinkingLevels": [] },
  })
  expect(agent.library).toEqual({ mcp: "~/.pi/agent/mcp.json", mcpFormat: "claude" })
})

test("returns one restorable provider with the host catalog and no duplicate selection", () => {
  const result = connect({ gateway, model: selected, models: [selected, { id: "plain", context: 0, output: -1, efforts: [] }] })
  expect(result).toEqual({
    [key]: {
      baseUrl: gateway.v1, apiKey: gateway.key, api: "openai-completions",
      models: [
        { id: selected.id, name: "Example", contextWindow: 65536, maxTokens: 4096, input: ["text", "image"], reasoning: true },
        { id: "plain", name: "plain" },
      ],
    },
  })
})

test("includes a missing selection without mutating the host catalog", () => {
  const models = Object.freeze([{ id: "old" }])
  const result = connect({ gateway, models, model: selected })
  expect(result[key].models.map(m => m.id)).toEqual(["old", selected.id])
  expect(connect({ gateway, model: selected })[key].models.map(m => m.id)).toEqual([selected.id])
  expect(connect({ gateway })[key].models).toEqual([])
})
