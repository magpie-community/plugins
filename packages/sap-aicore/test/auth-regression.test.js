import { it, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { SAPAICorePlugin } from "../src/index.js"

// Resolve mkfifo from absolute candidates at load, independent of process.env.PATH:
// under the monorepo's shared bun-test process a sibling package may narrow PATH,
// and no preload freezes it anymore.
const MKFIFO = ["/usr/bin/mkfifo", "/bin/mkfifo", "/usr/local/bin/mkfifo"].find(existsSync)

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const creds = {
  authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com",
  baseUrl: "https://api.ai.prod.eu10.hana.ondemand.com",
  clientId: "synthetic-id",
  clientSecret: "synthetic-secret",
  resourceGroup: "default",
}
const target = creds.baseUrl + "/responses"
const body = JSON.stringify({ model: "gpt-6-astra", input: "hello" })
const reply = (expires_in = 120) => new Response(JSON.stringify({ access_token: "synthetic-token", expires_in }))
function gate() {
  let resolve
  const promise = new Promise(ok => { resolve = ok })
  return { promise, resolve }
}
async function sandbox(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "aicore-regression-"))
  const file = path.join(dir, "credentials.json")
  await writeFile(file, JSON.stringify(creds), { mode: 0o600 })
  const fetch = globalThis.fetch
  const clock = performance.now
  const timers = globalThis.setTimeout
  try {
    globalThis.fetch = async (href) => {
      if (new URL(String(href)).pathname === "/v2/lm/deployments") return new Response(JSON.stringify({ resources: [] }))
      return reply()
    }
    await run({ dir, file })
  } finally {
    globalThis.fetch = fetch
    performance.now = clock
    globalThis.setTimeout = timers
    await rm(dir, { recursive: true, force: true })
  }
}
async function signed(file) {
  const plugin = await SAPAICorePlugin()
  const result = await plugin.auth.methods[0].authorize({ credentialFile: file })
  assert.equal(result.type, "success")
  const auth = { type: "api", key: result.key, metadata: result.metadata }
  return { plugin, auth }
}

it("wrong method, route and SAP account origin cannot acquire a token", () => sandbox(async ({ file }) => {
  let now = 0
  performance.now = () => now
  const { plugin, auth } = await signed(file)
  const opts = await plugin.auth.loader(async () => auth)
  now = 61000
  let calls = 0
  globalThis.fetch = async () => { calls++; return reply() }
  for (const [url, method] of [[target, "GET"], [target, 42], [target + "/cancel", "POST"], ["https://api.ai.other.eu10.hana.ondemand.com/responses", "POST"], [target + "?", "POST"]]) {
    const response = await opts.fetch(url, { method })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, "destination")
  }
  assert.equal(calls, 0)
}))

it("model initialization failure throws instead of reporting an empty catalog", () => sandbox(async ({ file }) => {
  const { auth } = await signed(file)
  await writeFile(file, "not-json")
  const restored = await SAPAICorePlugin()
  await assert.rejects(restored.provider.models({}, { auth }), { code: "credentials" })
  await writeFile(file, JSON.stringify(creds))
  assert.deepEqual(await restored.provider.models({}, { auth }), {})
  assert.deepEqual(await restored.provider.models({}, {}), {})
}))

it("shared waiter abort rejects before upstream completion and does not abort survivor", () => sandbox(async ({ file }) => {
  let now = 0
  performance.now = () => now
  const { plugin, auth } = await signed(file)
  const opts = await plugin.auth.loader(async () => auth)
  now = 61000
  const started = gate()
  const finish = gate()
  let calls = 0
  let upstream
  globalThis.fetch = async (_, init) => {
    calls++
    upstream = init.signal
    started.resolve()
    await finish.promise
    return reply()
  }
  const controller = new AbortController()
  const first = opts.fetch(target, { method: "POST", body, signal: controller.signal })
  const second = opts.fetch(target, { method: "POST", body })
  await started.promise
  await new Promise(ok => setImmediate(ok))
  controller.abort()
  assert.equal((await first).status, 499)
  assert.equal(upstream.aborted, false)
  assert.equal(calls, 1)
  finish.resolve()
  assert.equal((await second).status, 404)
}))

it("ignored-abort late acquisition cannot warm token cache and next operation recovers", () => sandbox(async ({ file }) => {
  let now = 0
  performance.now = () => now
  const { plugin, auth } = await signed(file)
  const opts = await plugin.auth.loader(async () => auth)
  now = 61000
  const started = gate()
  const finish = gate()
  let upstream
  globalThis.fetch = async (_, init) => { upstream = init.signal; started.resolve(); await finish.promise; return reply() }
  const controller = new AbortController()
  const request = opts.fetch(target, { method: "POST", body, signal: controller.signal })
  await started.promise
  controller.abort()
  assert.equal((await request).status, 499)
  assert.equal(upstream.aborted, true)
  finish.resolve()
  await new Promise(ok => setImmediate(ok))
  let calls = 0
  globalThis.fetch = async () => { calls++; return reply() }
  assert.equal((await opts.fetch(target, { method: "POST", body })).status, 404)
  assert.equal(calls, 1)
}))

it("late OAuth refusal cannot expire an explicitly replaced slot", () => sandbox(async ({ file, dir }) => {
  let now = 0
  performance.now = () => now
  const { plugin, auth } = await signed(file)
  let selected = auth
  const opts = await plugin.auth.loader(async () => selected)
  now = 61000
  const started = gate()
  const finish = gate()
  globalThis.fetch = async () => {
    started.resolve()
    await finish.promise
    return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "www-authenticate": "Basic realm=OAuth" } })
  }
  const pending = opts.fetch(target, { method: "POST", body })
  await started.promise
  const other = path.join(dir, "other.json")
  await writeFile(other, JSON.stringify(creds))
  globalThis.fetch = async () => reply()
  const replacement = await plugin.auth.methods[0].authorize({ credentialFile: other })
  assert.equal(replacement.type, "success")
  selected = { type: "api", key: replacement.key, metadata: replacement.metadata }
  finish.resolve()
  const response = await pending
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.equal((await response.json()).error.code, "superseded")
}))

it("token deadline bounds fetch that ignores abort", () => sandbox(async ({ file }) => {
  const original = setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 15000 ? 20 : ms, ...args)
  let upstream
  globalThis.fetch = async (_, init) => { upstream = init.signal; return new Promise(() => {}) }
  const plugin = await SAPAICorePlugin()
  const result = await plugin.auth.methods[0].authorize({ credentialFile: file })
  assert.equal(result.type, "failed")
  assert.match(result.error, /timed out/)
  assert.equal(upstream.aborted, true)
}))

it.skipIf(process.platform === "win32" || !MKFIFO)("FIFO credentials reject without waiting for a writer", () => sandbox(async ({ dir }) => {
  const file = path.join(dir, "fifo")
  execFileSync(MKFIFO, [file])
  const plugin = await SAPAICorePlugin()
  const result = await plugin.auth.methods[0].authorize({ credentialFile: file })
  assert.equal(result.type, "failed")
  assert.match(result.error, /could not be read/)
}))

it("malformed and wrong OAuth response URLs fail closed", () => sandbox(async ({ file }) => {
  for (const url of ["not-url", creds.authUrl + "/oauth/token?secret=synthetic", creds.authUrl + "/oauth/token#x"]) {
    globalThis.fetch = async () => {
      const response = reply()
      Object.defineProperty(response, "url", { value: url })
      return response
    }
    const plugin = await SAPAICorePlugin()
    assert.equal((await plugin.auth.methods[0].authorize({ credentialFile: file })).type, "failed")
  }
}))
