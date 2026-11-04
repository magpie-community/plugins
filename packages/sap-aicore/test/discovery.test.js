import { test, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import { listDeployments } from "../src/discovery.js"

const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"
const GROUP = "default"
const TIMEOUT_MS = 15000

// Single process under `bun test`: restore every per-test global swap and real
// timers after each test so fetch/PATH/timer state never leaks across files.
const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

function body(text) {
  return new Response(text).body
}

function bytesBody(bytes) {
  return new Response(Uint8Array.from(bytes)).body
}

function streamBody(hooks) {
  return new ReadableStream({ start() { hooks.onStart?.() }, cancel() { hooks.onCancel?.() } })
}

function jsonPage(resources, extra = {}) {
  const payload = extra.count === undefined ? { resources } : { resources, count: extra.count }
  return { ok: true, status: 200, redirected: false, url: "", body: body(JSON.stringify(payload)) }
}

function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (href, init) => {
    calls.push({ href, init })
    return handler(href, init, calls.length - 1)
  }
  cleanups.push(() => { globalThis.fetch = original })
  return calls
}

function base(overrides = {}) {
  return { aiRoot: AI_ROOT, resourceGroup: GROUP, bearer: async () => "tok", ...overrides }
}

function skipOf(href) {
  return new URL(href).searchParams.get("$skip")
}

function assertInvariants(call) {
  const url = new URL(call.href)
  assert.equal(url.origin, AI_ROOT)
  assert.equal(url.pathname, "/v2/lm/deployments")
  assert.equal(url.searchParams.get("scenarioId"), "foundation-models")
  assert.equal(url.searchParams.get("executableIds"), "azure-openai,aws-bedrock")
  assert.equal(url.searchParams.get("status"), "RUNNING")
  assert.equal(url.searchParams.get("$top"), "100")
  assert.equal(call.init.method, "GET")
  assert.equal(call.init.redirect, "error")
  assert.equal(call.init.headers.Authorization, "Bearer tok")
  assert.equal(call.init.headers["AI-Resource-Group"], GROUP)
}

test("collects every page and stops on the empty page", async () => {
  const pages = [
    jsonPage([{ id: "a", url: "x" }, { id: "b" }], { count: 2 }),
    jsonPage([{ id: "c" }]),
    jsonPage([]),
  ]
  const calls = installFetch((_h, _i, n) => pages[n])

  const rows = await listDeployments(base())

  assert.deepEqual(rows, [{ id: "a", url: "x" }, { id: "b" }, { id: "c" }])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(c => skipOf(c.href)), ["0", "2", "3"])
  calls.forEach(assertInvariants)
})

test("a later-page HTTP error rejects without a partial result", async () => {
  const calls = installFetch((_h, _i, n) =>
    n === 0 ? jsonPage([{ id: "a" }]) : { ok: false, status: 500, redirected: false, url: "", body: body("{}") })

  await assert.rejects(listDeployments(base()), err => {
    assert.equal(err.code, "response")
    return true
  })
  assert.equal(calls.length, 2)
})

test("a management 401 is an ordinary discovery error", async () => {
  installFetch(() => ({ ok: false, status: 401, redirected: false, url: "", body: body("{}") }))
  await assert.rejects(listDeployments(base()), err => {
    assert.equal(err.code, "response")
    assert.ok(!("signIn" in err))
    return true
  })
})

test("a malformed envelope rejects", async () => {
  installFetch(() => ({ ok: true, status: 200, redirected: false, url: "", body: body(JSON.stringify({ resources: {} })) }))
  await assert.rejects(listDeployments(base()), { code: "response" })
})

test("a malformed count rejects", async () => {
  installFetch(() => jsonPage([{ id: "a" }], { count: -1 }))
  await assert.rejects(listDeployments(base()), { code: "response" })
})

test("a row without a safe id rejects", async () => {
  installFetch(() => jsonPage([{ id: "" }]))
  await assert.rejects(listDeployments(base()), { code: "response" })
})

test("repeated ids across pages reject", async () => {
  const pages = [jsonPage([{ id: "a" }]), jsonPage([{ id: "a" }])]
  installFetch((_h, _i, n) => pages[n])
  await assert.rejects(listDeployments(base()), { code: "response" })
})

test("a redirected response rejects", async () => {
  installFetch(() => ({ ok: true, status: 200, redirected: true, url: "", body: body(JSON.stringify({ resources: [] })) }))
  await assert.rejects(listDeployments(base()), { code: "destination" })
})

test("a final-URL mismatch rejects", async () => {
  installFetch(() => ({
    ok: true, status: 200, redirected: false,
    url: "https://api.ai.other.hana.ondemand.com/v2/lm/deployments",
    body: body(JSON.stringify({ resources: [] })),
  }))
  await assert.rejects(listDeployments(base()), { code: "destination" })
})

test("a non-AI or non-HTTPS root rejects before any fetch", async () => {
  const calls = installFetch(() => jsonPage([]))
  await assert.rejects(listDeployments(base({ aiRoot: "http://api.ai.eu10.hana.ondemand.com" })), { code: "destination" })
  await assert.rejects(listDeployments(base({ aiRoot: "https://evil.example.com" })), { code: "destination" })
  assert.equal(calls.length, 0)
})

test("row exhaustion rejects instead of truncating", async () => {
  let id = 0
  installFetch(() => jsonPage(Array.from({ length: 100 }, () => ({ id: "d" + id++ }))))
  await assert.rejects(listDeployments(base()), { code: "exhausted" })
})

test("an oversized page body rejects", async () => {
  const huge = "p".repeat(1024 * 1024 + 16)
  installFetch(() => jsonPage([{ id: "a", pad: huge }]))
  await assert.rejects(listDeployments(base()), { code: "exhausted" })
})

test("a pre-aborted caller signal rejects promptly", async () => {
  const calls = installFetch(() => jsonPage([]))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(listDeployments(base({ signal: controller.signal })), { code: "cancelled" })
  assert.equal(calls.length, 0)
})

test("caller cancellation rejects past a fetch that ignores the signal, then recovers", async () => {
  let called
  const seen = new Promise(r => { called = r })
  installFetch(() => { called(); return new Promise(() => {}) })

  const controller = new AbortController()
  const pending = listDeployments(base({ signal: controller.signal }))
  await seen
  controller.abort()
  await assert.rejects(pending, { code: "cancelled" })

  installFetch(() => jsonPage([]))
  assert.deepEqual(await listDeployments(base()), [])
})

test("the 15s deadline wins even when fetch ignores the signal", async () => {
  jest.useFakeTimers()
  let called
  const seen = new Promise(r => { called = r })
  installFetch(() => { called(); return new Promise(() => {}) })

  const pending = listDeployments(base())
  await seen
  jest.advanceTimersByTime(TIMEOUT_MS)
  await assert.rejects(pending, err => {
    assert.equal(err.code, "timeout")
    return true
  })
})

test("error messages leak no tokens, hosts, or bodies", async () => {
  installFetch(() => ({ ok: false, status: 500, redirected: false, url: "", body: body(JSON.stringify({ secret: "leak" })) }))
  await assert.rejects(listDeployments(base()), err => {
    assert.doesNotMatch(err.message, /tok|eu10|hana|leak|Bearer/)
    return true
  })
})

test("a deployment id that is not a bare path segment rejects", async () => {
  let current
  const calls = installFetch(() => jsonPage([{ id: current }]))
  const rejected = ["a/b", "../x", "a\\b", "a?b", "a#b", "a%2f", "a.b", ".", "..", "a".repeat(129), " a", "a b"]
  for (const id of rejected) {
    current = id
    await assert.rejects(listDeployments(base()), { code: "response" })
  }
  assert.equal(calls.length, rejected.length)
})

test("a root that normalizes away a port, traversal, or encoded bytes rejects before any fetch", async () => {
  const calls = installFetch(() => jsonPage([]))
  const rejected = [
    "https://api.ai.eu10.hana.ondemand.com:443",
    "https://api.ai.eu10.hana.ondemand.com/../v2",
    "https://api.ai.eu10.hana.ondemand.com/%2e%2e",
    "https://api.ai.eu10.hana.ondemand.com\\@evil.example.com",
    "https://api.ai.eu10.hana.ondemand.com ",
    "https://api.ai.eu10.hana.ondemand.com/\x01",
    "https://api.ai.eu10.hana.ondemand.com/v2",
  ]
  for (const aiRoot of rejected) {
    await assert.rejects(listDeployments(base({ aiRoot })), { code: "destination" })
  }
  assert.equal(calls.length, 0)
})

test("a malicious bearer error is sanitized to a response error", async () => {
  installFetch(() => jsonPage([]))
  const bearer = async () => { throw Object.assign(new Error("tok=SECRET leak eu10 hana"), { code: "response" }) }
  await assert.rejects(listDeployments(base({ bearer })), err => {
    assert.equal(err.code, "response")
    assert.doesNotMatch(err.message, /SECRET|leak|eu10|hana/)
    return true
  })
})

test("a malicious caller abort reason normalizes to a safe cancellation", async () => {
  const calls = installFetch(() => jsonPage([]))
  for (const code of ["timeout", "network"]) {
    const controller = new AbortController()
    controller.abort(Object.assign(new Error("tok=SECRET leak"), { code }))
    await assert.rejects(listDeployments(base({ signal: controller.signal })), err => {
      assert.equal(err.code, "cancelled")
      assert.doesNotMatch(err.message, /SECRET|leak/)
      return true
    })
  }
  assert.equal(calls.length, 0)
})

test("caller cancellation while the bearer is pending rejects promptly before any fetch", async () => {
  const calls = installFetch(() => jsonPage([]))
  const controller = new AbortController()
  let asked
  const seen = new Promise(r => { asked = r })
  const pending = listDeployments(base({ signal: controller.signal, bearer: () => { asked(); return new Promise(() => {}) } }))
  await seen
  controller.abort()
  await assert.rejects(pending, { code: "cancelled" })
  assert.equal(calls.length, 0)
})

test("the deadline wins while the bearer is pending", async () => {
  jest.useFakeTimers()
  let asked
  const seen = new Promise(r => { asked = r })
  installFetch(() => jsonPage([]))
  const pending = listDeployments(base({ bearer: () => { asked(); return new Promise(() => {}) } }))
  await seen
  jest.advanceTimersByTime(TIMEOUT_MS)
  await assert.rejects(pending, { code: "timeout" })
})

test("caller cancellation during a pending body read rejects and cancels the reader", async () => {
  let cancelled = false
  let reading
  const started = new Promise(r => { reading = r })
  installFetch(() => ({
    ok: true, status: 200, redirected: false, url: "",
    body: streamBody({ onStart: () => reading(), onCancel: () => { cancelled = true } }),
  }))
  const controller = new AbortController()
  const pending = listDeployments(base({ signal: controller.signal }))
  await started
  controller.abort()
  await assert.rejects(pending, { code: "cancelled" })
  assert.equal(cancelled, true)
})

test("the deadline wins during a pending body read and cancels the reader", async () => {
  jest.useFakeTimers()
  let cancelled = false
  let reading
  const started = new Promise(r => { reading = r })
  installFetch(() => ({
    ok: true, status: 200, redirected: false, url: "",
    body: streamBody({ onStart: () => reading(), onCancel: () => { cancelled = true } }),
  }))
  const pending = listDeployments(base())
  await started
  jest.advanceTimersByTime(TIMEOUT_MS)
  await assert.rejects(pending, { code: "timeout" })
  assert.equal(cancelled, true)
})

test("page-count exhaustion rejects", async () => {
  let n = 0
  const calls = installFetch(() => jsonPage([{ id: "d" + n++ }]))
  await assert.rejects(listDeployments(base()), { code: "exhausted" })
  assert.equal(calls.length, 128)
})

test("aggregate body size exhaustion rejects", async () => {
  const pad = "p".repeat(1000000)
  let n = 0
  const calls = installFetch(() => jsonPage([{ id: "d" + n++, pad }]))
  await assert.rejects(listDeployments(base()), { code: "exhausted" })
  assert.equal(calls.length, 17)
})

test("a malformed JSON body rejects", async () => {
  installFetch(() => ({ ok: true, status: 200, redirected: false, url: "", body: body("not json at all") }))
  await assert.rejects(listDeployments(base()), { code: "response" })
})

test("a malformed UTF-8 body rejects", async () => {
  installFetch(() => ({ ok: true, status: 200, redirected: false, url: "", body: bytesBody([0xff, 0xfe, 0xff]) }))
  await assert.rejects(listDeployments(base()), { code: "response" })
})
