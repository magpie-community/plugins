// Codex desktop offers codex_app's automation_update, whose parameters are
// a union at the root whose create and update branches are unions
// themselves (testdata: what ChatGPT.app 26.930's zod builds). Grok turned
// the request away: "tool parameter root must be an object type (root
// schema is an anyOf/oneOf union with a non-object branch)" (magpie#1271).
import { noRealGrok } from "./nocli.mjs"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { _internal } from "./index.mjs"

noRealGrok()

const SCHEMA = readFileSync(new URL("./testdata/codex_automation_update_schema.json", import.meta.url), "utf8")

const body = (parameters) =>
  JSON.stringify({
    model: "grok-4.7",
    tools: [
      { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      { type: "function", name: "mcp__codex_app__automation_update", strict: false, parameters },
    ],
  })

test("a root union goes to Grok as an object, the nested branches' fields kept", () => {
  const sent = JSON.parse(_internal.rewrite(body(JSON.parse(SCHEMA))))
  const ps = sent.tools[1].parameters
  expect(ps.type).toBe("object")
  expect(ps.anyOf).toBeUndefined()
  expect(ps.oneOf).toBeUndefined()
  for (const k of ["mode", "id", "name", "prompt", "rrule", "status", "kind", "projectId", "model", "targetThreadId", "executionEnvironment"])
    expect(Object.keys(ps.properties)).toContain(k)
  expect(ps.required).toEqual(["mode"])
  const mode = JSON.stringify(ps.properties.mode)
  for (const v of ["view", "delete", "__schema11"]) expect(mode).toContain(v)
  // the plain tool goes as it came
  expect(sent.tools[0]).toEqual({ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } })
})

test("a body with no root union is passed on byte for byte", () => {
  const b = body({ type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } })
  expect(_internal.rewrite(b)).toBe(b)
})

test("a Chat function's parameters are folded too", () => {
  const b = JSON.stringify({ tools: [{ type: "function", function: { name: "t", parameters: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] } } }] })
  expect(JSON.parse(_internal.rewrite(b)).tools[0].function.parameters).toEqual({ type: "object", properties: { a: { type: "string" } } })
})
