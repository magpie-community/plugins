import { expect, test } from "bun:test"
import { fitTool, fitTools, toolBudget, DEFAULT_TOOL_BUDGET } from "../tool-budget.mjs"

const size = (t) => JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length
const small = { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
const big = (n = 20, wordy = 400) => ({
  name: "big",
  description: "Does a lot. ".repeat(wordy),
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string", description: "param ".repeat(80), default: "x", title: "T" }])),
    required: ["p0"],
  },
})

test("a small tool is returned as is", () => {
  const { tool, lost } = fitTool(small)
  expect(tool).toBe(small)
  expect(lost.steps).toEqual([])
})

test("a large tool is shortened under the budget and keeps required parameters", () => {
  const { tool, lost } = fitTool(big())
  expect(size(tool)).toBeLessThanOrEqual(DEFAULT_TOOL_BUDGET)
  expect(tool.inputSchema.properties.p0).toBeDefined()
  expect(tool.inputSchema.required).toEqual(["p0"])
  expect(lost.steps.length).toBeGreaterThan(0)
})

test("shortening comes before dropping: descriptions go, parameters stay", () => {
  const t = { name: "t", description: "d".repeat(3000), inputSchema: { type: "object", properties: { a: { type: "string", description: "x".repeat(500), default: "q" }, b: { type: "string" } } } }
  const { tool, lost } = fitTool(t)
  expect(lost.dropped).toEqual([])
  expect(Object.keys(tool.inputSchema.properties)).toEqual(["a", "b"])
  expect(tool.inputSchema.properties.a.default).toBeUndefined()
})

test("a parameter named like a keyword is not mistaken for the keyword", () => {
  const t = { name: "t", description: "d".repeat(3000), inputSchema: { type: "object", properties: { description: { type: "string" }, default: { type: "string" }, title: { type: "string" } }, required: ["description", "default", "title"] } }
  const { tool } = fitTool(t)
  expect(Object.keys(tool.inputSchema.properties)).toEqual(["description", "default", "title"])
})

test("optional parameters go last, largest first, and are named", () => {
  const { tool, lost } = fitTool(big(60, 1), 1200)
  expect(size(tool)).toBeLessThanOrEqual(1200)
  expect(lost.dropped.length).toBeGreaterThan(0)
  expect(tool.inputSchema.properties.p0).toBeDefined()
})

test("fitTools reports each changed tool once and leaves the rest", () => {
  const rows = []
  const out = fitTools([small, big()], { report: (r) => rows.push(r) })
  expect(out[0]).toBe(small)
  expect(rows.length).toBe(1)
  expect(rows[0].tool).toBe("big")
  expect(rows[0].stillOver).toBe(false)
})

test("a tool that cannot fit is reported as still over", () => {
  const rows = []
  const t = { name: "n", description: "", inputSchema: { type: "object", properties: { a: { type: "string", enum: Array.from({ length: 500 }, (_, i) => "value" + i) } }, required: ["a"] } }
  fitTools([t], { report: (r) => rows.push(r) })
  expect(rows[0].stillOver).toBe(true)
})

test("72 realistic tools all end under the budget", () => {
  const tools = Array.from({ length: 72 }, (_, i) => (i % 5 === 0 ? { ...big(15, 200), name: `t${i}` } : { ...small, name: `t${i}` }))
  for (const t of fitTools(tools)) expect(size(t)).toBeLessThanOrEqual(DEFAULT_TOOL_BUDGET)
})

test("AGY_BRIDGE_TOOL_BUDGET changes the budget, 0 turns it off", () => {
  expect(toolBudget({ AGY_BRIDGE_TOOL_BUDGET: "900" })).toBe(900)
  expect(toolBudget({})).toBe(DEFAULT_TOOL_BUDGET)
  const b = big()
  expect(fitTool(b, toolBudget({ AGY_BRIDGE_TOOL_BUDGET: "0" })).tool).toBe(b)
})
