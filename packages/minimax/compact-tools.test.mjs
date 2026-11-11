// The tools plugin's advertised list with compactTools on and off:
// default stays today's twenty tools; on keeps only the four dispatchers,
// with their descriptions and schemas unchanged.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { compactToolsOn } from "./connector-tools.mjs"
import { MiniMaxCodeToolsPlugin } from "./magpie.mjs"
import { createWebTools } from "./web-tools.mjs"

const advertised = (tool) => JSON.stringify(Object.fromEntries(
  Object.entries(tool).map(([name, t]) => [name, { description: t.description, args: t.args }]),
))

test("compactToolsOn is only true for an explicit true", () => {
  expect(compactToolsOn()).toBe(false)
  expect(compactToolsOn({})).toBe(false)
  expect(compactToolsOn({ compactTools: false })).toBe(false)
  expect(compactToolsOn({ compactTools: "true" })).toBe(false)
  expect(compactToolsOn({ compactTools: 1 })).toBe(false)
  expect(compactToolsOn({ compactTools: true })).toBe(true)
})

test("the tools plugin with compactTools off matches today's advertised list", async () => {
  const today = advertised((await MiniMaxCodeToolsPlugin({ directory: "/tmp" })).tool)
  expect(advertised((await MiniMaxCodeToolsPlugin({ directory: "/tmp" }, {})).tool)).toBe(today)
  expect(advertised((await MiniMaxCodeToolsPlugin({ directory: "/tmp" }, { compactTools: false })).tool)).toBe(today)
  const names = Object.keys((await MiniMaxCodeToolsPlugin({ directory: "/tmp" })).tool)
  expect(names.at(-1)).toBe("web_search")
  expect(names).toHaveLength(20)
})

test("the tools plugin with compactTools on lists only the four dispatchers, unchanged", async () => {
  const full = (await MiniMaxCodeToolsPlugin({ directory: "/tmp" })).tool
  const compact = (await MiniMaxCodeToolsPlugin({ directory: "/tmp" }, { compactTools: true })).tool
  expect(Object.keys(compact)).toEqual(["list_tools", "tool_schema", "call_tool", "web_search"])
  for (const name of Object.keys(compact)) {
    expect(compact[name].description).toBe(full[name].description)
    expect(JSON.stringify(compact[name].args)).toBe(JSON.stringify(full[name].args))
  }
  const web = createWebTools(async () => ({})).web_search
  expect(compact.web_search.description).toBe(web.description)
  expect(JSON.stringify(compact.web_search.args)).toBe(JSON.stringify(web.args))
})
