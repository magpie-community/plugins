import { expect, test } from "bun:test"
import { agent, connect } from "./willdeep.agent.js"

const gateway = { v1: "http://127.0.0.1:3425/v1", key: "magpie-willdeep" }

test("says where WillDeep Desktop keeps its connection", () => {
  expect(agent).toMatchObject({
    id: "willdeep",
    dir: "~/.willdeep/integrations/magpie/desktop",
    config: "~/.willdeep/integrations/magpie/desktop/connection.json",
    format: "json",
    model: "model",
    prefix: "",
  })
})

test("shows the icon the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon).toBe(pkg.magpie.icon)
})

test("writes the v1 connection for a loopback gateway", () => {
  expect(connect({ gateway, model: { id: "deepseek/deepseek-flash" } })).toEqual({
    schema_version: 1,
    client_id: "willdeep",
    enabled: true,
    base_url: "http://127.0.0.1:3425/v1",
    client_marker: "magpie-willdeep",
    context_window: null,
    max_output_tokens: null,
  })
})

test("keeps a valid model window and drops an output larger than it", () => {
  const ok = connect({ gateway, model: { id: "m", context: 128000, output: 8192 } })
  expect([ok.context_window, ok.max_output_tokens]).toEqual([128000, 8192])
  const over = connect({ gateway, model: { id: "m", context: 8000, output: 20000 } })
  expect(over.max_output_tokens).toBeNull()
})

test("refuses a real gateway key instead of forwarding it", () => {
  expect(() => connect({ gateway: { v1: "http://127.0.0.1:3425/v1", key: "real-key" }, model: { id: "m" } })).toThrow(
    /magpie-willdeep/,
  )
})

test("refuses anything but loopback with the exact /v1", () => {
  expect(() => connect({ gateway: { v1: "http://10.0.0.5:3425/v1", key: "magpie-willdeep" }, model: { id: "m" } })).toThrow(
    /loopback/,
  )
  expect(() =>
    connect({ gateway: { v1: "http://127.0.0.1:3425/v1/", key: "magpie-willdeep" }, model: { id: "m" } }),
  ).toThrow(/loopback/)
})

test("refuses a blank model id", () => {
  expect(() => connect({ gateway, model: { id: "  " } })).toThrow(/model\.id/)
})
