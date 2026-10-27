// Device polling tolerates transient failures without restarting authorization.
// Every response and clock is local; no account or network is used.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const success = () => ({ body: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 } })
const reset = () => Object.assign(new Error("reset"), { code: "ECONNRESET" })

async function poll(replies, { deadline = 600_000 } = {}) {
  const saved = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, now: Date.now, warn: console.warn }
  let now = 1_000_000
  let calls = 0
  const waits = []
  const requests = []
  const warnings = []
  Date.now = () => now
  globalThis.setTimeout = (fn, ms) => {
    waits.push(ms)
    now += ms
    queueMicrotask(fn)
    return 0
  }
  console.warn = (message) => warnings.push(message)
  globalThis.fetch = async (url, init) => {
    requests.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) })
    const reply = replies[calls++]
    if (reply instanceof Error) throw reply
    if (reply?.readError) return { ok: true, status: 200, text: async () => { throw reply.readError } }
    if (!reply) throw new Error("unexpected request")
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }
  try {
    const value = await _internal.pollDevice({ account: "http://127.0.0.1" }, {
      intervalMs: 3000,
      deadline: now + deadline,
      poll: { device_code: "test-device" },
      verifier: "test-verifier",
    })
    return { value, calls, waits, requests, warnings }
  } catch (error) {
    return { error, calls, waits, requests, warnings }
  } finally {
    globalThis.fetch = saved.fetch
    globalThis.setTimeout = saved.setTimeout
    Date.now = saved.now
    console.warn = saved.warn
  }
}

test("HTTP 400 authorization_pending remains pending", async () => {
  const r = await poll([{ status: 400, body: { error: "authorization_pending" } }, success()])
  expect(r.error).toBeUndefined()
  expect(r.value.access).toBe("test-access")
  expect(r.calls).toBe(2)
  expect(r.waits).toEqual([3000, 3000])
})

test("a reset retries the same device code and verifier with backoff", async () => {
  const r = await poll([reset(), success()])
  expect(r.error).toBeUndefined()
  expect(r.value.refresh).toBe("test-refresh")
  expect(r.calls).toBe(2)
  expect(r.waits).toEqual([3000, 6000])
  expect(r.requests[1]).toEqual(r.requests[0])
  expect(r.requests[0].form).toMatchObject({ device_code: "test-device", code_verifier: "test-verifier" })
  expect(r.warnings.join(" ")).not.toContain("test-device")
  expect(r.warnings.join(" ")).not.toContain("test-verifier")
})

test("a non-JSON HTTP 400 can recover", async () => {
  const r = await poll([{ status: 400, body: "<html>Bad Request</html>" }, success()])
  expect(r.error).toBeUndefined()
  expect(r.value.access).toBe("test-access")
})

for (const status of [408, 429, 500, 503]) {
  test(`a temporary HTTP ${status} can recover`, async () => {
    const r = await poll([{ status, body: { error: "temporarily_unavailable" } }, success()])
    expect(r.error).toBeUndefined()
    expect(r.calls).toBe(2)
  })
}

for (const error of ["invalid_grant", "access_denied", "expired_token", "invalid_client", "unauthorized_client"]) {
  test(`${error} is not retried`, async () => {
    const r = await poll([{ status: 400, body: { error } }, success()])
    expect(r.error.code).toBe(error)
    expect(r.calls).toBe(1)
  })
}

test("an unknown error is not retried", async () => {
  const r = await poll([new Error("bug"), success()])
  expect(r.error.message).toBe("bug")
  expect(r.calls).toBe(1)
})

test("three consecutive retries exhaust the budget", async () => {
  const r = await poll(Array.from({ length: 20 }, reset))
  expect(r.error.code).toBe("ECONNRESET")
  expect(r.calls).toBe(4)
  expect(r.waits).toEqual([3000, 6000, 12000, 24000])
})

test("no request starts after the device deadline while sleeping", async () => {
  const r = await poll([success()], { deadline: 1000 })
  expect(r.error.code).toBe("expired_token")
  expect(r.calls).toBe(0)
  expect(r.waits).toEqual([1000])
})

test("a pending response resets the consecutive-failure budget", async () => {
  const r = await poll([reset(), reset(), reset(), { status: 400, body: { error: "authorization_pending" } }, reset(), success()])
  expect(r.error).toBeUndefined()
  expect(r.calls).toBe(6)
  expect(r.waits).toEqual([3000, 6000, 12000, 24000, 3000, 6000])
})

test("slow_down increases the normal interval after a retry", async () => {
  const r = await poll([reset(), { status: 400, body: { error: "slow_down" } }, success()])
  expect(r.error).toBeUndefined()
  expect(r.waits).toEqual([3000, 6000, 8000])
})

for (const readError of [reset(), Object.assign(new Error("timeout"), { name: "TimeoutError" })]) {
  test(`a response body ${readError.code ?? readError.name} can recover`, async () => {
    const r = await poll([{ readError }, success()])
    expect(r.error).toBeUndefined()
    expect(r.calls).toBe(2)
  })
}
