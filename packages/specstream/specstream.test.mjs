import { expect, test } from "bun:test"
import { SpecStreamTools } from "./index.mjs"

const { tool, search } = await SpecStreamTools({})
const ctx = { agent: "test", abort: AbortSignal.timeout(5000) }
const seen = {}
const reply = (status, body) => async (url, init) => {
  seen.url = String(url)
  seen.init = init
  return new Response(JSON.stringify(body), { status })
}
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = impl
  process.env.SPECSTREAM_API_KEY = "sk_test"
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

test("offers both tools and the search hook", () => {
  expect(Object.keys(tool).sort()).toEqual(["extract", "web_search"])
  for (const t of Object.values(tool)) expect(t.args.type).toBe("object")
  expect(typeof search.specstream.execute).toBe("function")
})

test("web_search reads data", async () => {
  const body = { data: { answer: { value: "Paris" }, rows: [], sources: [{ url: "https://a.test", title: "A" }] } }
  const out = await withFetch(reply(200, body), () => tool.web_search.execute({ query: "capital of France", count: 5 }, ctx))
  expect(out.answer.value).toBe("Paris")
  expect(out.sources[0].url).toBe("https://a.test")
  expect(seen.url).toContain("/v1/web-search?q=capital+of+France&num=5")
  expect(seen.init.headers.authorization).toBe("Bearer sk_test")
})

test("the search hook gives title, url, text", async () => {
  const body = { data: { sources: [{ url: "https://a.test", title: "A", snippet: "s", published: "2026-01-01" }] } }
  const out = await withFetch(reply(200, body), () => search.specstream.execute({ query: "x", count: 3, key: "k" }, ctx))
  expect(out).toEqual([{ title: "A", url: "https://a.test", text: "s", age: "2026-01-01" }])
  expect(seen.init.headers.authorization).toBe("Bearer k")
})

test("the search hook trims the sources to count", async () => {
  const body = { data: { sources: [1, 2, 3].map((i) => ({ url: `https://${i}.test`, title: String(i) })) } }
  const out = await withFetch(reply(200, body), () => search.specstream.execute({ query: "x", count: 2, key: "k" }, ctx))
  expect(out.map((s) => s.title)).toEqual(["1", "2"])
  expect(seen.url).toEndWith("?q=x&num=2")
})

test("a count that is no number sends no num", async () => {
  const body = { data: { sources: [{ url: "https://a.test", title: "A" }] } }
  for (const count of ["many", NaN, 0, undefined]) {
    const out = await withFetch(reply(200, body), () => search.specstream.execute({ query: "x", count, key: "k" }, ctx))
    expect(out.length).toBe(1)
    expect(seen.url).toEndWith("/v1/web-search?q=x")
  }
})

test("the search hook uses only the key magpie gives", async () => {
  let asked = false
  const impl = async () => ((asked = true), new Response("{}"))
  await expect(withFetch(impl, () => search.specstream.execute({ query: "x" }, ctx))).rejects.toThrow("needs an API key")
  expect(asked).toBe(false)
})

test("extract posts the urls and reads data.results", async () => {
  const body = { data: { results: [{ url: "https://a.test", status: "ok", text: "hello" }] } }
  const out = await withFetch(reply(200, body), () => tool.extract.execute({ urls: ["https://a.test"], format: "text" }, ctx))
  expect(out.results[0].text).toBe("hello")
  expect(JSON.parse(seen.init.body)).toEqual({ urls: ["https://a.test"], format: "text" })
})

test("an error reply raises error.message with the status", async () => {
  const body = { error: { code: "insufficient_balance", message: "Balance is empty" } }
  const err = await withFetch(reply(402, body), () => search.specstream.execute({ query: "x", key: "k" }, ctx)).catch((e) => e)
  expect(err.message).toBe("Balance is empty")
  expect(err.status).toBe(402)
})

test("extract refuses more than 20 urls and a missing key", async () => {
  await expect(tool.extract.execute({ urls: Array(21).fill("https://a.test") }, ctx)).rejects.toThrow("1 to 20")
  delete process.env.SPECSTREAM_API_KEY
  await expect(tool.web_search.execute({ query: "x" }, ctx)).rejects.toThrow("SPECSTREAM_API_KEY")
})
