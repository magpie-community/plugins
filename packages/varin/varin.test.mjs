import { expect, test } from "bun:test"
import { agent, connect } from "./varin.agent.js"

test("says where Varin keeps its model", () => {
  expect(agent).toMatchObject({
    id: "varin",
    config: "~/.config/varin/agent-settings.json",
    format: "json",
    model: "defaultModel",
  })
})

test("shows an icon magpie can take without reading files", () => {
  expect(agent.icon.startsWith("data:image/png;base64,")).toBe(true)
  const bytes = Buffer.from(agent.icon.split(",")[1], "base64")
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test("declares every library path, so the Library can give Varin things", () => {
  expect(agent.library).toMatchObject({
    instructions: "~/.config/varin/resources/AGENTS.md",
    mcp: "~/.config/varin/mcp.json",
    mcpFormat: "claude",
    skills: "~/.config/varin/resources/skills",
  })
})

test("writes nothing but the model, as shipped", () => {
  // PROVIDER_ID is empty in the published file, so connect writes no provider and
  // Varin keeps the channel it already had.
  expect(connect({ model: { id: "group/deepseek-v4.1-flash-smart" } })).toEqual({})
  expect(connect({})).toEqual({})
  expect(connect()).toEqual({})
})
