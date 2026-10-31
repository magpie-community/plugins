import { expect, test } from "bun:test"
import { request } from "node:http"
import service, { _internal } from "./service.mjs"

const req = headers => ({ headers: { get: name => headers[name.toLowerCase()] ?? null } })

test("Host and Origin accept only the service loopback authority or sandbox origin", () => {
  for (const host of ["localhost:3481", "127.0.0.1:3481"]) expect(_internal.hostOK(req({ host }), 3481)).toBe(true)
  for (const host of [undefined, "evil.example:3481", "127.0.0.1:3482", "localhost:3481.evil"]) expect(_internal.hostOK(req({ host }), 3481)).toBe(false)
  for (const origin of [undefined, "null", "http://localhost:3481", "http://127.0.0.1:3481"]) expect(_internal.originOK(req({ origin }), 3481)).toBe(true)
  for (const origin of ["https://localhost:3481", "http://evil.example", "http://localhost:3482"]) expect(_internal.originOK(req({ origin }), 3481)).toBe(false)
})

test("actual Bun loopback service requires a click, CSRF, Host and Origin and probes saved options only", async () => {
  const allocator = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = allocator.port
  allocator.stop(true)
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (init.method === 'GET') return Response.json({ identities: [{ slug: 'saved-person', name: '<script>display name</script>', mainModels: ['gpt-*'] }], selection: 'first_matching_main_model', unmatched: 'memory_off' })
    return Response.json({ memory: "skipped", patch: "", recall_id: null, remember: "none" })
  }
  const send = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers }, response => {
      let data = ""
      response.on("data", chunk => { data += chunk })
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: data }))
    })
    outgoing.on("error", reject)
    outgoing.end(body)
  })
  try {
    expect(service.id).toBe("magpie-aelios")
    expect(await service.server(undefined, { port, serverUrl: "https://saved.example", apiKey: "saved-secret-key", identity: "saved-person" })).toEqual({})
    const own = `127.0.0.1:${port}`
    const page = await send("GET", "/test?lang=zh", { host: own })
    expect(page.status).toBe(200)
    expect(page.body).toContain("测试连接")
    expect(page.body).toContain("history.back()")
    expect(page.body).toContain('addEventListener("click", test)')
    expect(page.body).toContain('cell.textContent = value')
    const automatic = await send('GET', '/test?lang=zh&auto=1', { host: own })
    expect(automatic.status).toBe(200)
    expect(automatic.body).toContain('test();')
    expect((await send('GET', '/test?auto=evil', { host: own })).status).toBe(400)
    expect(page.body).not.toContain("saved-secret-key")
    expect(page.body).not.toContain("saved.example")
    expect(page.headers["cache-control"]).toBe("no-store")
    expect(requests).toHaveLength(0)
    const token = page.body.match(/name="aelios-token" content="([0-9a-f]{64})"/)[1]
    const authorized = { host: own, origin: "null", "x-aelios-token": token }
    expect((await send("GET", "/test?lang=en", { host: own })).body).toContain("Test connection")
    expect((await send("GET", "/test", { host: `evil.example:${port}` })).status).toBe(403)
    for (const headers of [
      { ...authorized, host: `evil.example:${port}` }, { ...authorized, origin: "http://evil.example" },
      { ...authorized, "x-aelios-token": "0".repeat(64) }, { host: own, origin: "null" },
    ]) expect((await send("POST", "/api/test", headers)).status).toBe(403)
    expect((await send("OPTIONS", "/api/test", { host: own, origin: "http://evil.example" })).status).toBe(403)
    expect((await send("OPTIONS", "/api/test", { host: own, origin: "null" })).headers["access-control-allow-origin"]).toBe("null")
    expect((await send("POST", "/api/test?serverUrl=https://evil.example&apiKey=evil", authorized)).status).toBe(400)
    expect((await send("GET", "/test?apiKey=evil", { host: own })).status).toBe(400)
    expect((await send("POST", "/api/test", { ...authorized, "content-type": "application/json" }, JSON.stringify({ apiKey: "evil", serverUrl: "https://evil.example" }))).status).toBe(400)
    expect((await send("GET", "/api/test", authorized)).status).toBe(404)
    expect(requests).toHaveLength(0)
    const result = await send("POST", "/api/test", authorized)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ ok: true, code: "connected", checkedIdentities: 1, ms: expect.any(Number), custom: true, mapping: { available: true, identities: [{ slug: 'saved-person', name: '<script>display name</script>', mainModels: ['gpt-*'] }] } })
    expect(result.headers["access-control-allow-origin"]).toBe("null")
    expect(result.body).not.toContain("saved-secret-key")
    expect(requests).toHaveLength(2)
    expect(requests[1].url).toBe('https://saved.example/v1/hook/identities')
    expect(requests[0].url).toBe("https://saved.example/v1/hook/recall")
    expect(requests[0].init.headers.Authorization).toBe("Bearer saved-secret-key")
    expect(JSON.parse(requests[0].init.body)).toEqual({ protocol: "chat", model: "magpie-aelios-connection-probe", body: { messages: [] }, record: false, identity: "saved-person" })
    await service.server(undefined, { port, serverUrl: "https://updated.example", apiKey: "updated-secret" })
    expect((await send("POST", "/api/test", { ...authorized, origin: `http://${own}` })).status).toBe(200)
    expect(requests[2].url).toBe("https://updated.example/v1/hook/recall")
    globalThis.fetch = async () => new Response("sensitive remote dialogue saved-secret-key", { status: 401 })
    const failure = await send("POST", "/api/test", authorized)
    expect(JSON.parse(failure.body).code).toBe("unauthorized")
    expect(failure.body).not.toContain("sensitive")
    expect(failure.body).not.toContain("secret")
  } finally {
    _internal.stop()
    globalThis.fetch = realFetch
  }
})

test("real fetch refuses redirects without forwarding credentials", async () => {
  let redirected = 0
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { redirected++; return new Response() } })
  const redirector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${destination.port}/stolen` } }) })
  try {
    const { testConnection } = await import("./probe.mjs")
    const result = await testConnection({ serverUrl: `http://127.0.0.1:${redirector.port}`, apiKey: "redirect-secret" })
    expect(result.code).toBe("unavailable")
    expect(redirected).toBe(0)
    expect(JSON.stringify(result)).not.toContain("redirect-secret")
  } finally { redirector.stop(true); destination.stop(true) }
})
