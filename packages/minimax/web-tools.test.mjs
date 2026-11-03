import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { createWebTools } from "./web-tools.mjs"
import { fakeMiniMax, json } from "./fake.mjs"
let f
afterEach(() => { f?.close(); f = undefined })

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

test("web fetch follows redirects and sends no account credential", async () => {
  f = fakeMiniMax()
  f.route("GET /start", () => new Response(null, { status: 302, headers: { location: "/page" } }))
  f.route("GET /page", () => new Response("<html>source text</html>", { headers: { "content-type": "text/html" } }))
  const tool = createWebTools(() => { throw new Error("local fetch must not use account API") }).web_fetch
  const result = await tool.execute({ url: f.origin + "/start" })
  expect(result).toMatchObject({ status: 200, finalUrl: f.origin + "/page", content: "<html>source text</html>", truncated: false, retrievalOutcome: "usable_content" })
  for (const r of f.seen) {
    expect(r.headers.get("authorization")).toBeNull()
    expect(r.headers.get("user-agent")).toBe("MiniMaxAgent")
  }
})

test("HEAD, binary responses and HTTP errors have explicit outcomes", async () => {
  f = fakeMiniMax()
  f.route("HEAD /meta", () => new Response(null, { status: 200, headers: { "content-type": "image/png" } }))
  f.route("GET /binary", () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }))
  f.route("GET /error", () => new Response("Try later", { status: 429, headers: { "content-type": "text/plain", "retry-after": "60" } }))
  const tool = createWebTools().web_fetch
  expect(await tool.execute({ url: f.origin + "/meta", method: "HEAD" })).toMatchObject({ status: 200, bytes: 0, content: "" })
  expect(await tool.execute({ url: f.origin + "/binary" })).toMatchObject({ retrievalOutcome: "non_text", content: "", bytes: 0 })
  expect(await tool.execute({ url: f.origin + "/error" })).toMatchObject({ status: 429, content: "Try later", retrievalOutcome: "http_error", retryAfter: "60" })
})

test("large pages are bounded and malformed URL/method arguments are refused", async () => {
  f = fakeMiniMax()
  f.route("GET /large", () => new Response("x".repeat(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } }))
  const tool = createWebTools().web_fetch
  const result = await tool.execute({ url: f.origin + "/large" })
  expect(result.bytes).toBe(2 * 1024 * 1024)
  expect(result.truncated).toBe(true)
  expect(result.content.length).toBeLessThan(65000)
  for (const value of [{ url: "file:///secret" }, { url: "https://user:pass@example.com" }, { url: "relative" }, { url: f.origin, method: "POST" }, { url: f.origin, token: "x" }]) await expect(tool.execute(value)).rejects.toThrow()
})
