import { expect, test } from "bun:test"
import { agent, connect } from "./workreview.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-workreview" }

test("writes through magpie's bridge, not a platform path", () => {
  expect(agent).toMatchObject({
    id: "workreview",
    config: "~/.magpie-workreview/agent.json",
    model: "text_model.model",
    format: "json",
  })
  // the host decides whether Work Review is installed; a fixed dir would be
  // wrong on at least two platforms
  expect(agent.dir).toBeUndefined()
})

test("shows Work Review's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon).toBe("https://raw.githubusercontent.com/wm94i/Work-Review/main/src-tauri/icons/icon.png")
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("points Work Review's OpenAI-compatible provider at magpie", () => {
  const out = connect({ gateway, model: { id: "group/cheap-first" } })
  expect(out).toEqual({
    "text_model.provider": "custom",
    "text_model.endpoint": "http://127.0.0.1:3425/v1",
    "text_model.api_key": "magpie-workreview",
    "text_model.model": "group/cheap-first",
  })
})

test("keeps a provider model id verbatim", () => {
  expect(connect({ gateway, model: { id: "workbuddy/kimi-k3" } })["text_model.model"]).toBe("workbuddy/kimi-k3")
})

test("writes the endpoint without a trailing slash", () => {
  const out = connect({ gateway: { ...gateway, v1: "http://127.0.0.1:3425/v1///" }, model: { id: "group/cheap-first" } })
  expect(out["text_model.endpoint"]).toBe("http://127.0.0.1:3425/v1")
})

test("refuses a missing model or gateway", () => {
  expect(() => connect({ gateway, model: {} })).toThrow(/model id/)
  expect(() => connect({ gateway })).toThrow(/model id/)
  expect(() => connect({ model: { id: "group/cheap-first" } })).toThrow(/gateway address/)
  expect(() => connect({ gateway: { v1: "http://127.0.0.1:3425/v1" }, model: { id: "x" } })).toThrow(/gateway key/)
})
