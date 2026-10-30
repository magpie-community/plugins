import { expect, test } from "bun:test"
import { _internal } from "./service.mjs"

const req = (headers) => ({ headers: { get: (name) => headers[name.toLowerCase()] ?? null } })
const port = 3479

test("the test service only answers on a loopback Host", () => {
  expect(_internal.hostOK(req({ host: "127.0.0.1:3479" }), port)).toBe(true)
  expect(_internal.hostOK(req({ host: "localhost:3479" }), port)).toBe(true)
  expect(_internal.hostOK(req({ host: "evil.example:3479" }), port)).toBe(false)
  expect(_internal.hostOK(req({ host: "127.0.0.1:1" }), port)).toBe(false)
  expect(_internal.hostOK(req({}), port)).toBe(false)
})

test("the test service only takes the sandbox or its own Origin", () => {
  expect(_internal.originOK(req({ origin: "null" }), port)).toBe(true)
  expect(_internal.originOK(req({ origin: "http://127.0.0.1:3479" }), port)).toBe(true)
  expect(_internal.originOK(req({}), port)).toBe(true)
  expect(_internal.originOK(req({ origin: "http://evil.example" }), port)).toBe(false)
  expect(_internal.originOK(req({ origin: "https://localhost:3479" }), port)).toBe(false)
})

test("the running service answers 403 to a foreign Host, a foreign Origin and a wrong token", async () => {
  const { default: service } = await import("./service.mjs")
  const { request } = await import("node:http")
  // A port the system just handed out; the service needs a fixed one.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const free = probe.port
  probe.stop(true)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("{}", { status: 503 })
  await service.server(undefined, { port: free, serverUrl: "https://mem.example.com", apiKey: "nmem_x" })
  const send = (method, path, headers) => new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: free, method, path, headers }, (res) => {
      let body = ""
      res.on("data", (c) => { body += c })
      res.on("end", () => resolve({ status: res.statusCode, body }))
    })
    r.on("error", reject)
    r.end()
  })
  try {
    const own = `127.0.0.1:${free}`
    const page = await send("GET", "/test", { host: own })
    expect(page.status).toBe(200)
    const token = page.body.match(/name="nm-token" content="([0-9a-f]+)"/)[1]

    expect((await send("GET", "/test", { host: `evil.example:${free}` })).status).toBe(403)
    expect((await send("POST", "/api/test", { host: `evil.example:${free}`, origin: "null", "x-nmem-token": token })).status).toBe(403)
    expect((await send("POST", "/api/test", { host: own, origin: "http://evil.example", "x-nmem-token": token })).status).toBe(403)
    expect((await send("OPTIONS", "/api/test", { host: own, origin: "http://evil.example" })).status).toBe(403)
    expect((await send("POST", "/api/test", { host: own, origin: "null", "x-nmem-token": "0".repeat(64) })).status).toBe(403)
    expect((await send("POST", "/api/test", { host: own, origin: "null" })).status).toBe(403)

    const ok = await send("POST", "/api/test", { host: own, origin: "null", "x-nmem-token": token })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).ok).toBe(false)
  } finally {
    _internal.stop()
    globalThis.fetch = realFetch
  }
})
