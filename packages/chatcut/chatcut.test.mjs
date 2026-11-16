import { expect, test } from "bun:test"
import { agent, connect } from "./chatcut.agent.js"

test("registers ChatCut with its own model and connection file", () => {
  expect(agent).toMatchObject({ id: "chatcut", name: "ChatCut", model: "model", config: "~/.config/chatcut/magpie.json" })
  expect(agent.config).not.toContain(".codex")
  expect(agent).not.toHaveProperty("launch")
})

test("preserves a custom port, caller key, routing group and known context", () => {
  const gateway = { v1: "http://127.0.0.1:4385/v1", key: "magpie-chatcut" }
  expect(connect({ gateway, model: { id: "group/work", context: 200000 } })).toEqual({
    version: 1, baseUrl: gateway.v1, apiKey: gateway.key, contextWindow: 200000,
  })
})

test("does not invent the context size for an unknown model or routing group", () => {
  expect(connect({ gateway: { v1: "http://localhost:3425/v1", key: "k" }, model: { context: 0 } }).contextWindow).toBeNull()
})

test("publishes a declarative package without runtime dependencies", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.magpie.agent).toBe("./chatcut.agent.js")
  expect(pkg).not.toHaveProperty("main")
  expect(pkg).not.toHaveProperty("dependencies")
})
