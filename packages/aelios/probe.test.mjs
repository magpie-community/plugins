import { expect, test } from "bun:test"
import { readIdentities, testConnection, textsFor } from "./probe.mjs"

const saved = { serverUrl: "https://aelios.example/base/", apiKey: "secret-test-key" }
const quiet = (memory = "skipped") => Response.json({ memory, patch: "", recall_id: null, remember: "none" })
const noEnv = {}

test('matching list uses authenticated read-only endpoint and projects display metadata only', async () => {
  const result = await readIdentities(saved, async (url, init) => {
    expect(String(url)).toBe('https://aelios.example/base/v1/hook/identities')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.redirect).toBe('error')
    expect(init.headers.Authorization).toBe('Bearer secret-test-key')
    return Response.json({ identities: [{ slug: 'first', name: 'Assistant', mainModels: ['gpt-*'], namespace: 'never-display' }], secret: 'never-display' })
  }, 1000, noEnv)
  expect(result).toEqual({ available: true, identities: [{ slug: 'first', name: 'Assistant', mainModels: ['gpt-*'] }] })
  expect(JSON.stringify(result)).not.toContain('never-display')
})

test('matching list tolerates older Workers and bounds malformed or hanging responses', async () => {
  expect(await readIdentities(saved, async () => new Response('private', { status: 404 }), 1000, noEnv)).toEqual({ available: false, code: 'unsupported' })
  for (const data of [{ identities: [{}] }, { identities: Array(257).fill({}) }, { identities: [{ slug: 'ok', name: 'ok', mainModels: [1] }] }]) {
    expect((await readIdentities(saved, async () => Response.json(data), 1000, noEnv)).available).toBe(false)
  }
  expect(await readIdentities(saved, async () => new Promise(() => {}), 10, noEnv)).toEqual({ available: false, code: 'timeout' })
})

test("empty-input probe checks every distinct route identity plus fallback without records or dialogue", async () => {
  const requests = []
  const options = { ...saved, identity: "fallback", record: true, routes: [
    { identity: "first", models: ["model-*"] }, { identity: "second", agents: ["agent"] },
    { identity: "first", models: ["other"] },
  ] }
  const result = await testConnection(options, async (url, init) => {
    requests.push({ url: String(url), init })
    return quiet(requests.length % 2 ? "off" : "skipped")
  }, 1000, noEnv)
  expect(result).toEqual({ ok: true, code: "connected", checkedIdentities: 3, ms: expect.any(Number) })
  expect(requests.map(r => JSON.parse(r.init.body).identity)).toEqual(["first", "second", "fallback"])
  for (const { url, init } of requests) {
    expect(url).toBe("https://aelios.example/base/v1/hook/recall")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    expect(init.headers.Authorization).toBe("Bearer secret-test-key")
    expect(JSON.parse(init.body)).toEqual({ protocol: "chat", model: "magpie-aelios-connection-probe", body: { messages: [] }, record: false, identity: expect.any(String) })
  }
  expect(JSON.stringify(result)).not.toContain(saved.apiKey)
})

test("automatic identity reports connection-only scope", async () => {
  const result = await testConnection(saved, async (_url, init) => {
    expect(JSON.parse(init.body).identity).toBeUndefined()
    return quiet("off")
  }, 1000, noEnv)
  expect(result).toEqual(expect.objectContaining({ ok: true, code: "connection_only", checkedIdentities: 1 }))
  expect(textsFor("en").scope).toContain("cannot verify all model mappings")
  expect(textsFor("zh").scope).toContain("无法验证所有模型映射")
})

test("API keys resolve from saved key, selected environment, or default environment and are required", async () => {
  for (const [options, env, expected] of [
    [saved, { AELIOS_API_KEY: "other" }, "Bearer secret-test-key"],
    [{ serverUrl: saved.serverUrl, apiKeyEnv: "SELECTED" }, { SELECTED: "env-key" }, "Bearer env-key"],
    [{ serverUrl: saved.serverUrl }, { AELIOS_API_KEY: "Bearer default-key" }, "Bearer default-key"],
  ]) {
    expect((await testConnection(options, async (_url, init) => {
      expect(init.headers.Authorization).toBe(expected)
      return quiet()
    }, 1000, env)).ok).toBe(true)
  }
  let calls = 0
  const result = await testConnection({ serverUrl: saved.serverUrl }, async () => { calls++; return quiet() }, 1000, noEnv)
  expect(result.code).toBe("unauthorized")
  expect(calls).toBe(0)
})

test("URL validation permits HTTPS or loopback HTTP only, without credentials, query or fragment", async () => {
  for (const serverUrl of ["https://example.com", "http://localhost:1234", "http://127.0.0.1:1234", "http://[::1]:1234"]) {
    expect((await testConnection({ ...saved, serverUrl }, async () => quiet(), 1000, noEnv)).ok).toBe(true)
  }
  for (const serverUrl of ["", "invalid", "ftp://example.com", "http://example.com", "http://localhost.evil", "https://user:pass@example.com", "https://example.com/?apiKey=secret", "https://example.com/#fragment"]) {
    let called = false
    const result = await testConnection({ ...saved, serverUrl }, async () => { called = true; return quiet() }, 1000, noEnv)
    expect(result.code).toBe("invalid")
    expect(called).toBe(false)
  }
})

test("fixed status codes never expose remote bodies or errors", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [404, "endpoint404"], [400, "invalid"], [302, "invalid"], [429, "unavailable"], [503, "unavailable"]]) {
    const result = await testConnection(saved, async () => new Response(`remote dialogue ${saved.apiKey}`, { status }), 1000, noEnv)
    expect(result).toEqual({ ok: false, code, checkedIdentities: 0, ms: expect.any(Number) })
    expect(JSON.stringify(result)).not.toContain(saved.apiKey)
  }
  expect((await testConnection(saved, async () => { throw new Error(`sensitive ${saved.apiKey}`) }, 1000, noEnv)).code).toBe("unavailable")
})

test("invalid response shape and non-quiet outcomes are rejected", async () => {
  for (const body of [{}, { memory: "injected", patch: "private dialogue" }, { memory: "off" }, { memory: "skipped", patch: "private", recall_id: null, remember: "none" }, { memory: "off", patch: "", recall_id: "record", remember: "none" }]) {
    expect((await testConnection(saved, async () => Response.json(body), 1000, noEnv)).code).toBe("invalid")
  }
  expect((await testConnection(saved, async () => new Response("invalid JSON"), 1000, noEnv)).code).toBe("invalid")
})

test("read bound cancels oversized streams, including declared lengths", async () => {
  for (const declared of [false, true]) {
    let cancelled = false
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16385)) },
      cancel() { cancelled = true },
    }), { headers: declared ? { "content-length": "16385" } : {} })
    expect((await testConnection(saved, async () => response, 1000, noEnv)).code).toBe("invalid")
    expect(cancelled).toBe(true)
  }
})

test("deadline bounds hung fetch and streaming body, aborts and cancels reads", async () => {
  let signal
  const hung = await testConnection(saved, async (_url, init) => { signal = init.signal; return new Promise(() => {}) }, 20, noEnv)
  expect(hung.code).toBe("timeout")
  expect(signal.aborted).toBe(true)
  let cancelled = false
  const streamed = await testConnection(saved, async () => new Response(new ReadableStream({ cancel() { cancelled = true } })), 20, noEnv)
  expect(streamed.code).toBe("timeout")
  expect(cancelled).toBe(true)
  expect(streamed.ms).toBeLessThan(500)
})

test("routes are limited to 64 plus fallback, malformed saved routes fail before fetch", async () => {
  const routes = Array.from({ length: 64 }, (_, i) => ({ identity: `identity-${i}`, models: ["*"] }))
  expect((await testConnection({ ...saved, routes, identity: "fallback" }, async () => quiet(), 1000, noEnv)).checkedIdentities).toBe(65)
  for (const routes of [Array(65).fill({ identity: "valid", models: ["*"] }), [{ identity: "admin", models: ["*"] }], [{ identity: "valid" }], [{ identity: "valid", models: [] }], "bad"]) {
    const result = await testConnection({ ...saved, routes }, async () => { throw new Error("must not fetch") }, 1000, noEnv)
    expect(result.code).toBe("invalid")
  }
})

test("failure after a successful identity preserves only count and fixed status", async () => {
  let calls = 0
  const result = await testConnection({ ...saved, identity: "fallback", routes: [{ identity: "first", models: ["*"] }] }, async () => ++calls === 1 ? quiet() : new Response("secret second identity", { status: 403 }), 1000, noEnv)
  expect(result).toEqual({ ok: false, code: "forbidden", checkedIdentities: 1, ms: expect.any(Number) })
})
