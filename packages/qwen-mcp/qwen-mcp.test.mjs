import { expect, test } from "bun:test"
import { agent, connect } from "./qwen-mcp.agent.js"

test("points the Library at Qwen Code's own files", () => {
  expect(agent).toMatchObject({
    id: "qwen-mcp",
    config: "~/.qwen/settings.json",
    format: "json",
    bin: "qwen",
    dir: "~/.qwen",
    library: { mcp: "~/.qwen/settings.json", mcpFormat: "claude", skills: "~/.qwen/skills" },
  })
})

test("shows Qwen's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon.startsWith("data:image/svg+xml;base64,")).toBe(true)
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("writes no model keys, leaving the built-in Qwen Code row in charge", () => {
  expect(connect()).toEqual({})
})