import "./nonet.mjs"
import { expect, test } from "bun:test"
import { createWebTools } from "./web-tools.mjs"

test("native search forwards filters and account scope to its separate endpoint", async () => {
  const calls = []
  const abort = new AbortController().signal
  const tools = createWebTools(async (...call) => { calls.push(call); return { base_resp: { status_code: 0 }, organic: [{ title: "Source", url: "https://example.com" }] } })
  expect(await tools.web_search.execute({ query: "MiniMax", count: 3, freshness: "week", search_type: "news", site: "minimax-code-global", account: "minimax-code-global#second" }, { abort })).toEqual({ organic: [{ title: "Source", url: "https://example.com" }] })
  expect(calls[0]).toEqual(["minimax-code-global", "/mavis/api/v1/mcp/web_search", { query: "MiniMax", count: 3, freshness: "week", search_type: "news" }, { account: "minimax-code-global#second", signal: abort, timeoutMs: 120000 }])
})

test("invalid search arguments and cancellation are caught before network", async () => {
  let calls = 0
  const tool = createWebTools(async () => { calls++; return {} }).web_search
  for (const value of [null, {}, { query: " " }, { query: "x", count: 0 }, { query: "x", count: 1.5 }, { query: "x", freshness: "today" }, { query: "x", search_type: "image" }, { query: "x", site: "bad" }, { query: "x", headers: {} }]) {
    await expect(tool.execute(value)).rejects.toThrow()
  }
  const controller = new AbortController()
  controller.abort()
  await expect(tool.execute({ query: "x" }, { abort: controller.signal })).rejects.toThrow()
  expect(calls).toBe(0)
})

test("native web tools export only search", () => {
  expect(Object.keys(createWebTools())).toEqual(["web_search"])
})
