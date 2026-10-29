// Exercise the real auth hook with two synthetic sign-ins. The fake vendor
// serves at most two Trial requests per sign-in. This does not run Magpie's
// account selection, lane queue, or rest classifier.
import { afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

let ZCodeAuthPlugin, state, originalWaits
const realFetch = globalThis.fetch
const MODEL = "glm-5.3-flash"

beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((p) => homedir().startsWith(p))) {
    throw new Error("run with an isolated HOME under the temporary directory")
  }
  const moduleURL = process.env.ZCODE_TRIAL_TEST_MODULE
    ? pathToFileURL(process.env.ZCODE_TRIAL_TEST_MODULE).href
    : new URL("./index.mjs", import.meta.url).href
  const module = await import(moduleURL)
  ZCodeAuthPlugin = module.ZCodeAuthPlugin
  state = module._internal
  originalWaits = [...state.BUSY_WAITS]
})

afterEach(() => {
  globalThis.fetch = realFetch
  state.routes.clear()
  state.blocked.clear()
  state.BUSY_WAITS.splice(0, state.BUSY_WAITS.length, ...originalWaits)
})

function signIn(account) {
  const jwt = [
    "{}",
    JSON.stringify({ sub: account, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ].map((part) => Buffer.from(part).toString("base64url")).join(".") + ".test"
  const s = { site: "zai", key: `test-plan-${account}`, jwt, device: `test-device-${account}` }
  state.routes.set(s.key + "\0" + s.jwt, {
    start: false,
    gift: { models: [MODEL], allModels: [MODEL] },
    at: Date.now(),
    ttl: 600_000,
  })
  return { type: "oauth", access: s.key, refresh: JSON.stringify(s), expires: 0 }
}

async function client(account, magpie) {
  const auth = signIn(account)
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } }, magpie })
  const loader = await hooks.auth.loader(async () => auth, { id: "zcode" })
  return async (trial = true, { signal } = {}) => {
    const response = await loader.fetch("https://api.z.ai/api/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: trial ? "GLM-5.3-Flash-Trial" : "GLM-5.3",
        max_tokens: 16,
        messages: [{ role: "user", content: "offline test" }],
      }),
    })
    return { status: response.status, body: await response.text() }
  }
}

function accountOf(headers) {
  const value = headers.get("authorization").replace(/^Bearer /i, "")
  return JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).sub
}

function fakeVendor(serve) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.pathname.endsWith("/messages") ||
        !["zcode.z.ai", "api.z.ai", "open.bigmodel.cn"].includes(url.hostname)) {
      throw new Error("unexpected request: no network is allowed in this test")
    }
    return serve(url, new Headers(init.headers))
  }
}

const message = () => Response.json({ type: "message", content: [] })
const busy = (code = 3008) => Response.json({
  code,
  msg: code === 3009 ? "model concurrency limit exceeded" : "user concurrency limit exceeded",
}, { status: 429 })

test("native option controls per-account Trial concurrency and Pro never reads it", async () => {
  let enabled = false
  const reads = []
  const magpie = { option(provider, key) { reads.push([provider, key]); return enabled } }
  const hooks = await ZCodeAuthPlugin({ client: {}, magpie })
  expect(hooks.auth.options).toEqual([{
    key: "start-plan-three-concurrent",
    label: "Start Plan 并发上限",
    description: "关闭：每个账号最多 2 个同时请求；开启：3 个。超出时排队，按顺序发出。只计 Start Plan 请求，Pro 不变。",
    default: false,
  }])
  const a = await client("a", magpie), b = await client("b", magpie)
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const active = { a: 0, b: 0 }
  fakeVendor(async (url, headers) => {
    if (url.hostname !== "zcode.z.ai") return message()
    active[accountOf(headers)]++
    await hold
    return message()
  })
  const pending = [a(), a(), a(), b(), b(), b()]
  try {
    for (let i = 0; i < 100 && reads.length < 6; i++) await Bun.sleep(1)
    expect(reads).toHaveLength(6)
    expect(reads.every(([provider, key]) => provider === "zcode" && key === "start-plan-three-concurrent")).toBe(true)
    expect(active).toEqual({ a: 2, b: 2 })
    expect((await a(false)).status).toBe(200)
    expect(reads).toHaveLength(6)
    enabled = true
    pending.push(a())
    for (let i = 0; i < 100 && (active.a < 3 || active.b < 3); i++) await Bun.sleep(1)
    expect(active).toEqual({ a: 3, b: 3 })
    expect(reads).toHaveLength(7)
  } finally {
    release()
    await Promise.all(pending)
    state.trialPool.setLimit(2)
  }
})

test("six Trial calls use both sign-ins while each fake vendor pool serves two", async () => {
  const existingLanes = state.trialPool?.accounts.size ?? 0
  state.BUSY_WAITS.splice(0, state.BUSY_WAITS.length, 5, 15, 40, 80)
  const a = await client("a"), b = await client("b")
  const active = { a: 0, b: 0 }, peak = { a: 0, b: 0 }, served = { a: 0, b: 0 }
  let combinedPeak = 0, refused = 0
  fakeVendor(async (_url, headers) => {
    const account = accountOf(headers)
    if (active[account] >= 2) {
      refused++
      return busy()
    }
    active[account]++
    peak[account] = Math.max(peak[account], active[account])
    combinedPeak = Math.max(combinedPeak, active.a + active.b)
    try {
      await Bun.sleep(25)
      served[account]++
      return message()
    } finally {
      active[account]--
    }
  })
  const results = await Promise.all([a(), b(), a(), b(), a(), b()])
  expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200, 200])
  expect(peak).toEqual({ a: 2, b: 2 })
  expect(combinedPeak).toBe(4)
  expect(served).toEqual({ a: 3, b: 3 })
  expect(refused).toBe(0)
  expect(state.trialPool?.accounts.size ?? 0).toBe(existingLanes)
  expect(state.blocked.size).toBe(0)
})

test("a busy Trial waits past the old retry budget without emitting a gateway 429", async () => {
  state.BUSY_WAITS.splice(0, state.BUSY_WAITS.length, 1, 1)
  const a = await client("a"), b = await client("b")
  let saturated = true, attempts = 0, notify
  const retried = new Promise((resolve) => { notify = resolve })
  fakeVendor((_url, headers) => {
    if (accountOf(headers) === "a" && saturated) {
      if (++attempts === 4) notify()
      return busy(3009)
    }
    return message()
  })
  const abort = new AbortController()
  const pending = a(true, { signal: abort.signal })
  try {
    await Promise.race([retried, pending.then(() => { throw new Error("Trial emitted a terminal response") })])
    expect(state.blocked.size).toBe(0)
    expect((await b()).status).toBe(200)
    saturated = false
    expect((await pending).status).toBe(200)
    expect(attempts).toBeGreaterThan(3)
    expect((await a()).status).toBe(200)
  } finally {
    abort.abort()
    await pending.catch(() => {})
  }
})

test("cancelling a busy Trial releases its slot and does not mark the gift spent", async () => {
  const existingLanes = state.trialPool.accounts.size
  state.BUSY_WAITS.splice(0, state.BUSY_WAITS.length, 10_000)
  const a = await client("a")
  let notify
  const refused = new Promise((resolve) => { notify = resolve })
  fakeVendor(() => {
    notify()
    return busy()
  })
  const abort = new AbortController()
  const pending = a(true, { signal: abort.signal })
  await refused
  abort.abort()
  await expect(pending).rejects.toThrow()
  expect(state.blocked.size).toBe(0)
  expect(state.trialPool.accounts.size).toBe(existingLanes)
  fakeVendor(message)
  expect((await a()).status).toBe(200)
})

test("the plugin itself lets Pro answer while two Trial calls remain in flight", async () => {
  const a = await client("a")
  let release, announce
  const hold = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { announce = resolve })
  let count = 0
  fakeVendor(async (url, headers) => {
    if (url.hostname !== "zcode.z.ai") {
      expect(headers.get("x-api-key")).toBe("test-plan-a")
      return message()
    }
    if (++count === 2) announce()
    await hold
    return message()
  })
  const pending = [a(), a()]
  try {
    await started
    const pro = await Promise.all(Array.from({ length: 6 }, () => a(false)))
    expect(pro.map((result) => result.status)).toEqual([200, 200, 200, 200, 200, 200])
  } finally {
    release()
    await Promise.all(pending)
  }
})

test("an actually spent gift is held locally, while the other account can still serve", async () => {
  const a = await client("a"), b = await client("b")
  fakeVendor((_url, headers) => accountOf(headers) === "a"
    ? Response.json({ error: { code: "1113", message: "no resource package" } }, { status: 429 })
    : message())
  expect((await a()).status).toBe(429)
  expect(state.blocked.size).toBe(1)
  expect((await b()).status).toBe(200)
})
