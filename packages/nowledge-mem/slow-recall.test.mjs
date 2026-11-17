// A deep recall slower than the old 5000 ms ceiling (plugins#926,
// aboat0625-cpu): a local fixture server answers a search after 6100 ms,
// and a hook given requestTimeoutMs 15000 adds what it found; the caller
// going away still cancels it at once.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { onRequest, reset } from "./nowledge-mem.hooks.mjs"
import { resolveOptions } from "./mem.mjs"

const delay = 6100
let server, searches, aborted

beforeEach(() => {
  reset()
  searches = 0
  aborted = Promise.withResolvers()
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/memories/search") return new Response("", { status: 404 })
      searches++
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay)
        req.signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
      })
      return Response.json([{ memory: { id: "mem-slow", node_type: "Memory", title: "Deep recall", content: "The deep answer is QUARTZ-8413." }, similarity_score: 0.9 }])
    },
  })
})
afterEach(() => server.stop(true))

const options = () => ({ serverUrl: `http://127.0.0.1:${server.port}`, apiKey: "nmem_test", contextBundle: false, requestTimeoutMs: 15000 })
const chat = () => ({ messages: [{ role: "user", content: "Quartz codename?" }] })
const ctx = (signal) => ({ protocol: "chat", origin: "local", agent: "codex", query: "Quartz codename?", session: "slow", signal, options: options(), report() {} })

test("requestTimeoutMs takes up to 30000", () => {
  expect(resolveOptions({ serverUrl: "http://127.0.0.1:14242", requestTimeoutMs: 15000 }).requestTimeoutMs).toBe(15000)
  expect(resolveOptions({ serverUrl: "http://127.0.0.1:14242", requestTimeoutMs: 30000 }).requestTimeoutMs).toBe(30000)
  expect(() => resolveOptions({ serverUrl: "http://127.0.0.1:14242", requestTimeoutMs: 30001 })).toThrow(/invalid/)
  expect(resolveOptions({ serverUrl: "http://127.0.0.1:14242" }).requestTimeoutMs).toBe(1500)
})

test("a search answered after 6100 ms is recalled with requestTimeoutMs 15000", async () => {
  const body = chat()
  const started = performance.now()
  const out = await onRequest(body, ctx(AbortSignal.timeout(20000)))
  expect(performance.now() - started).toBeGreaterThanOrEqual(delay - 100)
  expect(searches).toBe(1)
  expect(out).toBe(body)
  expect(body.messages[0].content).toContain("QUARTZ-8413")
}, 20000)

test("the caller going away cancels a long recall at once", async () => {
  const caller = new AbortController()
  const body = chat()
  const run = onRequest(body, ctx(caller.signal))
  while (searches === 0) await Bun.sleep(10)
  const started = performance.now()
  caller.abort(new Error("client went away"))
  await expect(run).rejects.toThrow()
  await aborted.promise
  // the search was cut, not waited for: well under its 6100 ms
  expect(performance.now() - started).toBeLessThan(3000)
  expect(body.messages[0].content).toBe("Quartz codename?")
}, 20000)
