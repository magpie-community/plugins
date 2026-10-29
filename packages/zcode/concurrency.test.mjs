// ZCode serves one account a few requests at a time, and past that answers
// 429 code 3008 "user concurrency limit exceeded" or 3009 "model concurrency
// limit exceeded". magpie sends every agent's and every session's requests of
// this computer through this one plugin process and queues them by the number
// the plugin declares, so a request the vendor refuses anyway is asked again a
// moment later. The requests go to a local Bun.serve; nothing reaches z.ai or
// bigmodel.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { readFileSync, realpathSync } from "node:fs"
import { ZCodeAuthPlugin, _internal } from "./index.mjs"

const { busy, spentUp, BUSY_WAITS } = _internal
const WAITS = [...BUSY_WAITS]

let server
const got = []
let answer = null // what the fake answers, when set
beforeAll(() => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() })
      if (answer) return answer()
      return Response.json({ type: "message", content: [] })
    },
  })
})
afterAll(() => server?.stop(true))

// the plugin's requests to the plans go to the fake; anything else fails
const real = globalThis.fetch
const HOSTS = ["https://zcode.z.ai", "https://api.z.ai", "https://open.bigmodel.cn"]
function routeToFake() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const host = HOSTS.find((h) => url.startsWith(h + "/"))
    if (!host) throw new Error("no network in tests: " + url)
    return real(`http://127.0.0.1:${server.port}/${new URL(host).host}${url.slice(host.length)}`, init)
  }
}
beforeEach(() => {
  routeToFake()
  got.length = 0
  answer = null
  // the plans read is this process's: each test starts from none, as the
  // other suites do (dual.test.mjs)
  _internal.routes.clear()
  _internal.blocked.clear()
})
afterEach(() => {
  globalThis.fetch = real
  answer = null
  BUSY_WAITS.splice(0, BUSY_WAITS.length, ...WAITS)
})

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const auth = () => ({ type: "oauth", access: jwt, refresh: JSON.stringify({ site: "https://zcode.z.ai", device: DEVICE, jwt, plan: "Start Plan" }), expires: 0 })
const BODY = JSON.stringify({ model: "GLM-5.3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })

// ask sends one request through the plugin and returns its answer unread
async function ask({ signal, pro = false } = {}) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => pro
    ? { type: "api", key: "test-pro", metadata: { site: "zai" } }
    : auth(), { id: "zcode" })
  const headers = { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01", "user-agent": "ai-sdk/anthropic/3.0.81" }
  return opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers, body: BODY, signal })
}

// one is a whole request, read out, as an agent's client does
async function one(options) {
  const res = await ask(options)
  return { status: res.status, text: await res.text() }
}

const CAP = { code: 3008, msg: "user concurrency limit exceeded" }

test("a cap refusal is asked again and the answer served", async () => {
  let n = 0
  answer = () => (++n === 1 ? Response.json(CAP, { status: 429 }) : Response.json({ type: "message", content: [] }))
  const res = await one()
  expect(res.status).toBe(200)
  expect(JSON.parse(res.text)).toEqual({ type: "message", content: [] })
  // the same request, byte for byte, and no third ask
  expect(got.length).toBe(2)
  expect(got[1].path).toBe(got[0].path)
  expect(got[1].body).toBe(got[0].body)
  expect(got[1].headers["authorization"]).toBe(got[0].headers["authorization"])
  expect(got[1].headers["x-zcode-app-version"]).toBe(got[0].headers["x-zcode-app-version"])
})

test("the cap's own codes are not a gift spent", () => {
  expect(spentUp(JSON.stringify(CAP), 429)).toBe(false)
  expect(spentUp('{"code":3009,"msg":"model concurrency limit exceeded"}', 429)).toBe(false)
  expect(spentUp('{"error":{"code":"3008","message":"user concurrency limit exceeded"}}', 429)).toBe(false)
  // a 429 that is a rate limit or a spent plan is as it was
  expect(spentUp('{"code":1302,"msg":"rate limit reached"}', 429)).toBe(true)
  expect(spentUp('{"error":{"code":"1113"}}', 429)).toBe(true)
  expect(spentUp("", 429)).toBe(true)
  expect(spentUp('{"code":1005}', 200)).toBe(true)
})

test("a rate limit is not asked again", async () => {
  answer = () => Response.json({ code: 1302, msg: "rate limit reached" }, { status: 429 })
  const res = await one()
  expect(res.status).toBe(429)
  expect(got.length).toBe(1)
  expect(res.text).toContain("rate limit reached")
  expect(res.text).not.toContain("ZCode serves one account")
})

test("a Pro cap that outlasts the waits keeps its original bounded retry", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  answer = () => Response.json(CAP, { status: 429 })
  const res = await one({ pro: true })
  expect(res.status).toBe(429)
  expect(got.length).toBe(3)
  const said = JSON.parse(res.text).msg
  expect(said).toContain("user concurrency limit exceeded (429, code 3008)")
  expect(said).toContain("ZCode serves one account a few requests at a time")
})

test("Pro 1308 and 1310 responses pass through unchanged", async () => {
  for (const code of [1308, 1310]) {
    const envelope = { error: { type: "rate_limit_error", code, message: "vendor limit", reset_time: "2030-01-01" } }
    answer = () => Response.json(envelope, { status: 429 })
    got.length = 0
    const res = await one({ pro: true })
    expect(res.status).toBe(429)
    expect(JSON.parse(res.text)).toEqual(envelope)
    expect(got.length).toBe(1)
  }
})

// bodyThatFails is this plugin's fetch answered with a head and one chunk,
// then a body that fails while it is being read: a connection the vendor
// dropped mid-body, or the abort magpie sends when an agent's request goes
// away
function bodyThatFails(status) {
  let sent = 0
  return new Response(
    new ReadableStream({
      pull(c) {
        if (sent++ === 0) return c.enqueue(new TextEncoder().encode('{"msg":"half a body'))
        c.error(new Error("the connection dropped mid-body"))
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  )
}

test("a body read that fails is the agent's error, and the account goes on", async () => {
  // magpie aborts this fetch when the agent's request goes away, and the
  // vendor's connection can drop mid-body: the failure goes back to the agent
  // as the error it is, and the next request of the same account is served
  const routed = globalThis.fetch
  globalThis.fetch = async () => bodyThatFails(429)
  expect(await ask().then(() => "served", () => "threw")).toBe("threw")
  globalThis.fetch = routed
  expect((await one()).status).toBe(200)
})

test("a failed read of the no-plan answer is the agent's error too", async () => {
  // the other read a request takes: a key with no plan behind it reads what
  // Z.ai said, and that read can fail the same way
  const key = async () => {
    const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
    const opts = await hooks.auth.loader(async () => ({ type: "api", key: "sk-probe", metadata: { site: "zai" } }), { id: "zcode" })
    return opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode" }, body: BODY })
  }
  const routed = globalThis.fetch
  globalThis.fetch = async () => bodyThatFails(400)
  expect(await key().then(() => "served", () => "threw")).toBe("threw")
  globalThis.fetch = routed
  expect((await key()).status).toBe(200)
})

test("the cap is read by its words when the envelope carries no code", () => {
  expect(busy(429, '{"error":{"type":"rate_limit_error","message":"model concurrency limit exceeded"}}')).toBe(true)
  expect(busy(200, JSON.stringify(CAP))).toBe(false)
  expect(busy(429, "<html>blocked</html>")).toBe(false)
  expect(busy(429, '{"code":1302,"msg":"rate limit reached"}')).toBe(false)
})

test("the plugin declares no account-wide cap that would throttle Pro", async () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  expect(hooks.auth.maxConcurrency).toBeUndefined()
  expect(pkg.magpie?.maxConcurrency).toBeUndefined()
  expect(_internal.trialPool.limit).toBe(2)
})
