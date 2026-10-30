import { expect, test } from "bun:test"
import { testConnection } from "./probe.mjs"

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const fake = (routes) => async (url) => {
  const path = new URL(url).pathname
  const handler = routes[path]
  if (!handler) throw new Error(`unexpected ${path}`)
  return handler()
}
const mem = { serverUrl: "https://mem.example.com", apiKey: "nmem_probe" }

test("the connection test checks reachability, the key and the Space", async () => {
  const result = await testConnection(mem, fake({
    "/health": () => json({ status: "ok" }),
    "/agent/working-memory": () => json({ exists: true, content: "## Focus Areas\n- Quartz release" }),
  }))
  expect(result.ok).toBe(true)
  expect(result.ms).toBeGreaterThanOrEqual(0)
})

test("the connection test reports fixed codes, not Mem's text", async () => {
  const unauthorized = await testConnection(mem, fake({
    "/health": () => json({ status: "ok" }),
    "/agent/working-memory": () => json({ detail: "invalid key" }, 401),
  }))
  expect(unauthorized).toEqual(expect.objectContaining({ ok: false, code: "unauthorized" }))

  const unbound = await testConnection({ ...mem, spaceId: "space-x" }, fake({
    "/health": () => json({ status: "ok" }),
    "/agent/working-memory": () => json({ detail: "unknown space" }, 400),
  }))
  expect(unbound.ok).toBe(false)
  expect(unbound.code).toBe("unbound")

  const down = await testConnection(mem, async () => { throw new TypeError("fetch failed") })
  expect(down).toEqual(expect.objectContaining({ ok: false, code: "unavailable" }))
})

test("the connection test refuses an invalid endpoint", async () => {
  const result = await testConnection({ serverUrl: "ftp://mem.example.com" }, fake({}))
  expect(result.ok).toBe(false)
  expect(result.code).toBe("invalid")
})
