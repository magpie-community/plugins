// A lane that can't serve the request now is told to magpie as a wall: a
// 429 with error.code user_model_rate_limited, one of magpie's wallCodes
// (yetone/magpie@067e4c484), sent once and rested briefly while the next
// account is asked. takomitkm (#1020) saw one request tried eight times over
// six minutes: the ZCode 3.16 key read threw "ZCode's Z.ai coding plan key:
// ECONNRESET: The socket connection was closed unexpectedly", a 502 magpie
// asked again, and free first's replay sent to a coding plan whose usage
// read already showed it full. Nothing leaves the machine: fetch is a fake.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  process.env.ZCODE_CREDENTIAL_SECRET = "test-seed"
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})

// the reporter's words, as Bun's fetch gave them
const RESET = "ECONNRESET: The socket connection was closed unexpectedly"
const reset = () => Object.assign(new Error(RESET), { code: "ECONNRESET" })

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
beforeEach(() => {
  _internal.routes.clear()
  _internal.blocked.clear()
  _internal.sidelined.clear()
  _internal.planFull.clear()
  _internal.locatedKeys.clear()
  _internal.lastKeys.clear()
  _internal.edge.until = 0
  _internal.busyHold.until = 0
  _internal.busyHold.hits.length = 0
  _internal.startGate.lanes.clear()
  _internal.startGate.narrow.clear()
})
const ok = (data) => new Response(JSON.stringify({ code: 0, data }))
const body = (model) => JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
const MSG = "https://api.z.ai/api/anthropic/v1/messages"
const post = (opts, model = "GLM-5.3-Flash") => opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body(model) })
const walled = async (res) => {
  expect(res.status).toBe(429)
  const j = JSON.parse(await res.text())
  expect(j.error.code).toBe("user_model_rate_limited")
  expect(j.error.type).toBe("rate_limit_error")
  // magpie's quota and credit words would rest it far longer than a wall
  expect(j.error.message).not.toMatch(/quota|usage.?limit|balance|credit|billing|daily|weekly|monthly|resets? at|limit.?reached|exceeded/i)
  return j.error.message
}

// ---- the key read (ZCode 3.16's key location) ---------------------------------

const dir = () => join(homedir(), ".zcode", "v2")
function enc(text) {
  const key = createHash("sha256").update("test-seed").digest()
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return "enc:v1:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
function zcodeHas(token) {
  const loc = "project-key-location:v1:" + encodeURIComponent(JSON.stringify(["https://api.z.ai", "zai", "u7", null, 1, "non-team"]))
  const store = {
    zcodejwttoken: "Bearer j1",
    "oauth:zai:access_token": token,
    "oauth:zai:user_info": JSON.stringify({ id: "u7", email: "q@example.com" }),
    [loc]: JSON.stringify({ organizationId: "org7", projectId: "proj7", apiKeyId: "k7" }),
  }
  mkdirSync(dir(), { recursive: true })
  writeFileSync(join(dir(), "credentials.json"), JSON.stringify(Object.fromEntries(Object.entries(store).map(([k, v]) => [k, enc(v)]))))
  writeFileSync(join(dir(), "setting.json"), JSON.stringify({}))
}
// the key read answers as keyRead says; the plan's messages are counted
function located(keyRead) {
  const tries = { key: 0, plan: 0 }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith("/api_keys/copy/k7")) {
      tries.key++
      return keyRead(init)
    }
    if (url.pathname === "/api/anthropic/v1/messages") {
      tries.plan++
      return new Response(JSON.stringify({ type: "message", content: [] }), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname.endsWith("/api/biz/subscription/list")) return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname.endsWith("/billing/balance")) return ok({ plans: [] })
    return new Response("{}", { status: 404 })
  }
  return tries
}
async function signedIn(token = "tok-z") {
  zcodeHas(token)
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } }, { freeFirst: false })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode app's sign-in")
  const got = await (await m.authorize()).callback()
  const auth = { ...got, type: "oauth" }
  return { auth, opts: await hooks.auth.loader(async () => auth, { id: "zcode" }) }
}

test("a key read the socket dropped is a wall sent once, not a sign-in to redo", async () => {
  const tries = located(() => {
    throw reset()
  })
  const { opts } = await signedIn()
  const res = await post(opts)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const said = await walled(res)
  expect(said).toContain("ZCode's Z.ai coding plan key: " + RESET)
  expect(said).not.toContain("sign in")
  expect(tries).toEqual({ key: 1, plan: 0 })
  // magpie asks again within the minute: the read's failure is kept, so
  // nothing hangs on the network again
  await walled(await post(opts))
  expect(tries.key).toBe(1)
})

test("a key read that times out is a wall too", async () => {
  located(() => {
    throw new DOMException("The operation timed out.", "TimeoutError")
  })
  const { opts } = await signedIn()
  expect(await walled(await post(opts))).toContain("could not be reached")
})

test("the key read is bounded", async () => {
  let signal
  located((init) => {
    signal = init.signal
    return ok({ secretKey: "sec7" })
  })
  const { auth } = await signedIn()
  await _internal.located(await _internal.stateOf(auth))
  expect(signal).toBeInstanceOf(AbortSignal)
})

test("a key read Z.ai refused still says to sign in again", async () => {
  located(() => new Response(JSON.stringify({ code: 401, msg: "token expired" }), { status: 401 }))
  const { opts } = await signedIn()
  await expect(post(opts)).rejects.toThrow("sign in to ZCode again")
})

test("the last key read serves while a read fails", async () => {
  let fail = false
  const tries = located(() => {
    if (fail) throw reset()
    return ok({ secretKey: "sec7" })
  })
  const first = await signedIn("tok-a")
  expect((await post(first.opts)).status).toBe(200)
  // ZCode renewed its token, and the read with the new one is dropped
  fail = true
  const next = await signedIn("tok-b")
  const s = await _internal.located(await _internal.stateOf(next.auth))
  expect(s.key).toBe("k7.sec7")
  expect((await post(next.opts)).status).toBe(200)
  expect(tries.key).toBe(2)
  expect(tries.plan).toBe(2)
})

test("a socket error is told from an answer and a caller's abort", () => {
  expect(_internal.unreached(reset())).toBe(true)
  expect(_internal.unreached(new Error(RESET))).toBe(true)
  expect(_internal.unreached(new TypeError("fetch failed"))).toBe(true)
  expect(_internal.unreached(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true)
  expect(_internal.unreached(new DOMException("This operation was aborted", "AbortError"))).toBe(false)
  expect(_internal.unreached(new Error("no secret for the key"))).toBe(false)
})

// ---- free first's replay onto the plan ----------------------------------------

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const KEY = "dual.secret"
const now = Math.trunc(Date.now() / 1000)
const balance = {
  server_time: now,
  plans: [{ plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400, entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
  balances: [{ plan_id: "zai-start-plan", user_plan_id: "up1", entitlement_id: "e1", show_name: "Trust Build", capabilities: ["model:glm-5.3-flash"],
    total_units: 1000, used_units: 250, remaining_units: 750, expires_at: now + 3600 }],
}
const coding = { type: "oauth", access: KEY, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", key: KEY, jwt, device: "11111111-2222-4333-8444-555555555555", plan: "GLM Coding Pro" }), expires: 0 }
// the gift answers 503 (so free first replays on the plan), the plan as
// plan() says, the week's window as limit() reads it
function dual({ plan, week }) {
  const tries = { gift: 0, plan: 0 }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === "https://zcode.z.ai" && url.pathname.endsWith("/messages")) {
      tries.gift++
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream unavailable" } }), { status: 503, headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/api/anthropic/v1/messages") {
      tries.plan++
      return plan()
    }
    if (url.pathname.endsWith("/billing/balance")) return ok(balance)
    if (url.pathname.endsWith("/api/biz/subscription/list")) return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname === "/api/monitor/usage/quota/limit")
      return ok({ level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 5000, currentValue: week, remaining: 5000 - week, percentage: Math.round((100 * week) / 5000), nextResetTime: (now + 3 * 86400) * 1000 }] })
    return ok([])
  }
  return tries
}
const planOK = () => new Response(JSON.stringify({ type: "message", content: [] }), { headers: { "content-type": "application/json" } })
const freeHooks = async () => (await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } }, { freeFirst: true })).auth
const freeFirst = async () => (await freeHooks()).loader(async () => coding, { id: "zcode" })
const readUsage = async () => (await freeHooks()).usage(async () => coding, { id: "zcode" })

test("a plan the usage read showed full is not replayed onto", async () => {
  const tries = dual({ plan: planOK, week: 5000 })
  const u = await readUsage()
  expect(u.windows.find((w) => w.display === "5000 / 5000")).toBeTruthy()
  const res = await post(await freeFirst())
  const said = await walled(res)
  expect(said).toContain("not sent")
  expect(tries).toEqual({ gift: 1, plan: 0 })
})

test("a plan the usage read showed room on is replayed onto", async () => {
  const tries = dual({ plan: planOK, week: 1200 })
  await readUsage()
  expect((await post(await freeFirst())).status).toBe(200)
  expect(tries).toEqual({ gift: 1, plan: 1 })
})

test("a full mark is let go once the read shows room again, or once it is old", async () => {
  _internal.notePlan(KEY, [{ name: "Week", used: 100, amount: 5000, limit: 5000, resetsAt: new Date(Date.now() + 86400_000).toISOString() }])
  expect(_internal.planFullUntil(KEY)).toBeGreaterThan(Date.now())
  _internal.notePlan(KEY, [{ name: "Week", used: 20, amount: 1000, limit: 5000, resetsAt: new Date(Date.now() + 86400_000).toISOString() }])
  expect(_internal.planFullUntil(KEY)).toBe(0)
  // a window set aside (MCP calls) or one whose reset has passed never is
  _internal.notePlan(KEY, [{ name: "MCP · Month", used: 100, aside: true, resetsAt: new Date(Date.now() + 86400_000).toISOString() }])
  _internal.notePlan(KEY, [{ name: "Week", used: 100, resetsAt: new Date(Date.now() - 1000).toISOString() }])
  expect(_internal.planFullUntil(KEY)).toBe(0)
  _internal.planFull.set(KEY, { until: Date.now() + 86400_000, at: Date.now() - 31 * 60_000 })
  expect(_internal.planFullUntil(KEY)).toBe(0)
})

test("a replay the socket dropped is a wall sent once", async () => {
  const tries = dual({
    plan: () => {
      throw reset()
    },
    week: 1200,
  })
  const said = await walled(await post(await freeFirst()))
  expect(said).toContain(RESET)
  expect(tries).toEqual({ gift: 1, plan: 1 })
})

test("a replay the caller aborted stays an abort", async () => {
  const ctl = new AbortController()
  dual({
    plan: () => {
      ctl.abort()
      throw new TypeError("fetch failed")
    },
    week: 1200,
  })
  const opts = await freeFirst()
  await expect(opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash"), signal: ctl.signal })).rejects.toThrow()
})

test("the wall's body is what magpie reads as one", async () => {
  const res = _internal.wallAnswer("x")
  expect(res.headers.get("content-type")).toBe("application/json")
  await walled(res)
})
