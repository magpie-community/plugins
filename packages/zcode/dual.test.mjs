// A dual account (a GLM Coding Plan and gift plans) shows both allowances on
// its card. A plain model always spends the coding plan; the gift is spent
// only through its trial entries (GLM-5.3-Flash-Trial), the user's pick. A
// trial entry whose bucket is spent or blocked answers 429 locally; the
// gift's own quota answers (its 1113, its 1005 inside a 200) become 429 and
// keep the entry off for a minute, while any other gift answer goes on as it
// came. Nothing leaves the machine: the plugin's fetch is the fake here.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
async function setup() {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
}
await setup()

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const KEY = "dual.secret"
const now = Math.trunc(Date.now() / 1000)
// a gift whose only live bucket serves glm-5.3-flash, a quarter used
const balance = {
  server_time: now,
  plans: [{ plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400,
    entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
  balances: [{ plan_id: "zai-start-plan", user_plan_id: "up1", entitlement_id: "e1", show_name: "Trust Build", capabilities: ["model:glm-5.3-flash"],
    total_units: 1000, used_units: 250, remaining_units: 750, expires_at: now + 3600 }],
}
const coding = { type: "oauth", access: KEY, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", key: KEY, jwt, device: DEVICE, plan: "GLM Coding Pro" }), expires: 0 }

const sent = []
const answers = {}
const real = globalThis.fetch
beforeEach(async () => {
  _internal.routes.clear()
  _internal.blocked.clear()
  _internal.refused.clear()
  sent.length = 0
  for (const k of Object.keys(answers)) delete answers[k]
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const c = { path: url.pathname, origin: url.origin, method: init.method ?? (input instanceof Request ? input.method : "GET"), headers: Object.fromEntries(new Headers(init.headers ?? (input instanceof Request ? input.headers : {}))), body: init.body ?? await (input.body ? input.text() : undefined) }
    sent.push(c)
    const a = answers[c.path]
    if (!a) return new Response("", { status: 404 })
    return a instanceof Response ? a.clone() : typeof a === "function" ? await a(c) : a.clone()
  }
})
afterEach(() => (globalThis.fetch = real))
const ok = (data) => new Response(JSON.stringify({ code: 0, data }))

function planAndBalance() {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
}
const hooks = async () => (await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })).auth
const loader = async () => (await hooks()).loader(async () => coding, { id: "zcode" })
async function sendTo(url, body) {
  const opts = await loader()
  return opts.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01" }, body })
}
const MSG = "https://api.z.ai/api/anthropic/v1/messages"
const body = (model) => JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }] })

// freeFirst: a plain model spends the account's live gift first, and falls
// back to the coding plan when the gift cannot serve it. The -Trial entries
// keep their own strict semantics; nothing else changes.
const freePlugin = async (options) => (await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } }, options)).auth

test("free first spends the gift on the plain model while it has quota", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://zcode.z.ai")
  expect(m.path).toBe("/api/v1/zcode-plan/anthropic/v1/messages")
  expect(m.headers.authorization).toBe("Bearer " + jwt)
  expect(m.headers["x-api-key"]).toBeUndefined()
  expect(JSON.parse(m.body).model).toBe("glm-5.3-flash")
})

test("free first falls back to the coding plan once the gift is spent", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], remaining_units: 0, used_units: 1000 }] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  // the balance reads go to zcode.z.ai; no message does
  expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(m.headers["x-api-key"]).toBe(KEY)
  expect(JSON.parse(m.body).model).toBe("GLM-5.3-Flash")
})

test("free first follows the provider's options, and a blocked model waits on the plan", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin().then((h) => h.loader(async () => coding, { id: "zcode", options: { freeFirst: true } }))
  const first = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(first.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
  expect(JSON.parse(sent.at(-1).body).model).toBe("glm-5.3-flash")
  // a refusal the gift gave a moment ago (the blocked map) sends the plain
  // model to the plan until the minute is out
  _internal.blocked.set(KEY + "\0" + jwt + "\0glm-5.3-flash", Date.now() + 60_000)
  const second = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(second.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(JSON.parse(sent.at(-1).body).model).toBe("GLM-5.3-Flash")
})

test("free first leaves a model the gift does not serve on the coding plan", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.2") })
  expect(res.status).toBe(200)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(JSON.parse(m.body).model).toBe("GLM-5.2")
})

test("without freeFirst the plain model goes to the coding plan as before", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: false }).then((h) => h.loader(async () => coding, { id: "zcode", options: {} }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(JSON.parse(sent.at(-1).body).model).toBe("GLM-5.3-Flash")
})

test("free first with no live gift reads the balance once and stays on the plan", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ server_time: now, plans: [], balances: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  for (let i = 0; i < 3; i++) {
    const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
    expect(res.status).toBe(200)
    expect(sent.at(-1).origin).toBe("https://api.z.ai")
  }
  expect(sent.filter((c) => c.path.endsWith("/billing/balance"))).toHaveLength(1)
})

test("free first with a failed balance read stays on the plan", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  for (let i = 0; i < 3; i++) {
    const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
    expect(res.status).toBe(200)
    expect(sent.at(-1).origin).toBe("https://api.z.ai")
  }
  expect(sent.filter((c) => c.path.endsWith("/billing/balance"))).toHaveLength(1)
})

test("free first changes nothing for a gift-only account", async () => {
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const giftOnly = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", jwt, device: DEVICE }) }
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => giftOnly, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.filter((c) => c.path.endsWith("/billing/balance"))).toHaveLength(0)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://zcode.z.ai")
  expect(JSON.parse(m.body).model).toBe("GLM-5.3-Flash")
})

test("a gift that answers spent is answered from the plan in the same request", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "Insufficient balance or no resource package", code: 1113 } }), { status: 429, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  const giftTries = sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))
  expect(giftTries).toHaveLength(1)
  expect(JSON.parse(giftTries[0].body).model).toBe("glm-5.3-flash")
  const planTries = sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))
  expect(planTries).toHaveLength(1)
  expect(JSON.parse(planTries[0].body).model).toBe("GLM-5.3-Flash")
  // the next request skips the spent gift and goes straight to the plan
  await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
})

test("a gift 200 that says the quota is spent is answered from the plan too", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit" }), { headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
})

test("after the minute's rest the plan keeps serving, inside the route's ten", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "Insufficient balance or no resource package", code: 1113 } }), { status: 429, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const first = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(first.status).toBe(200)
  // the minute out, the balance still read live: the gift is tried once
  // more and answered from the plan again, never a 429 of its own
  _internal.blocked.set(KEY + "\0" + jwt + "\0glm-5.3-flash", Date.now() - 1)
  const second = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(second.status).toBe(200)
  expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(2)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(2)
})

test("three requests racing a gift that just ran out all get the plan's answer", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "Insufficient balance or no resource package", code: 1113 } }), { status: 429, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const send = () => opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  const rs = await Promise.all([send(), send(), send()])
  expect(rs.map((r) => r.status)).toEqual([200, 200, 200])
  expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(3)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(3)
})

test("a -Trial entry keeps its local 429 with freeFirst on", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], remaining_units: 0, used_units: 1000 }] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash-Trial") })
  expect(res.status).toBe(429)
  expect(sent.filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
})

test("a provider options object without freeFirst leaves the plugin's on", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode", options: { freeFirst: undefined } }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
})

const giftSaysSpent = () => new Response(JSON.stringify({ error: { message: "Insufficient balance or no resource package", code: 1113 } }), { status: 429, headers: { "content-type": "application/json" } })

test("a replay waits out the plan's own busy cap", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = giftSaysSpent()
  let planTries = 0
  answers["/api/anthropic/v1/messages"] = () => {
    planTries++
    return planTries === 1
      ? new Response(JSON.stringify({ error: { code: "3008", message: "concurrency limit exceeded" } }), { status: 429, headers: { "content-type": "application/json" } })
      : ok({ type: "message", content: [] })
  }
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(planTries).toBe(2)
})

test("a gift that fails for any other reason is answered from the plan too", async () => {
  for (const [status, text] of [[500, "boom"], [401, "token expired or incorrect"], [400, "bad request"]]) {
    planAndBalance()
    _internal.blocked.clear()
    sent.length = 0
    answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(text, { status })
    answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
    const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
    expect(res.status).toBe(200)
    expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
    expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
  }
})

test("the gift's own busy cap, waited out, is answered from the plan too", async () => {
  planAndBalance()
  const waits = _internal.BUSY_WAITS.splice(0)
  _internal.BUSY_WAITS.push(1)
  try {
    answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "3008", msg: "user concurrency limit exceeded" }), { status: 429, headers: { "content-type": "application/json" } })
    answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
    const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
    expect(res.status).toBe(200)
    expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages"))).toHaveLength(2)
    expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
    // a cap is a turn not come, not spent: no minute's rest
    expect(_internal.blocked.get(KEY + "\0" + jwt + "\0glm-5.3-flash")).toBeUndefined()
  } finally {
    _internal.BUSY_WAITS.length = 0
    _internal.BUSY_WAITS.push(...waits)
  }
})

test("a Start Plan block page is answered from the plan too", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "request has been blocked due to unusual activity", code: 3012 } }), { status: 405, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
  // the block rests the model a minute, as a spent answer does
  expect(_internal.blocked.get(KEY + "\0" + jwt + "\0glm-5.3-flash")).toBeGreaterThan(Date.now())
})

const giftUnreachable = (when = () => true) => {
  const under = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (when(url)) throw new TypeError("fetch failed")
    return under(input, init)
  }
}

// giftThrowing replaces fetch with one that throws error() on the gift's
// messages alone — the reads answer as usual — and counts the tries, since
// a request that throws never reaches the fetch fake that fills sent.
const giftThrowing = (error) => {
  const under = globalThis.fetch
  const tries = { gift: 0, plan: 0 }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === "https://zcode.z.ai" && url.pathname.endsWith("/messages")) {
      tries.gift++
      throw await error()
    }
    if (url.origin === "https://api.z.ai" && url.pathname.endsWith("/messages")) tries.plan++
    return under(input, init)
  }
  return tries
}

test("a gift that cannot be asked at all is answered from the plan", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  giftUnreachable((url) => url.origin === "https://zcode.z.ai" && url.pathname.endsWith("/messages"))
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(1)
  // the route is dropped, so the next request's balance read finds out
  // whether the host is back
  expect(_internal.routes.get(KEY + "\0" + jwt)).toBeUndefined()
  const second = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(second.status).toBe(200)
  expect(sent.filter((c) => c.path.endsWith("/billing/balance"))).toHaveLength(2)
})

test("an aborted gift request stays aborted", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const ctl = new AbortController()
  ctl.abort()
  const tries = await giftThrowing(() => new DOMException("This operation was aborted", "AbortError"))
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  await expect(opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash"), signal: ctl.signal })).rejects.toThrow()
  expect(tries.gift).toBe(1)
  expect(tries.plan).toBe(0)
})

test("an abort while the gift is in flight stays an abort", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const ctl = new AbortController()
  // the abort lands while the ask is away: some runtimes surface it as a
  // plain TypeError, and the signal says the caller meant it
  const tries = await giftThrowing(() => {
    ctl.abort()
    return new TypeError("fetch failed")
  })
  const opts = await freePlugin({ freeFirst: true }).then((h) => h.loader(async () => coding, { id: "zcode" }))
  await expect(opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash"), signal: ctl.signal })).rejects.toThrow()
  expect(tries.gift).toBe(1)
  expect(tries.plan).toBe(0)
})

test("a firewall block on the gift shows on the card and rests the gift's models", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response('<!doctypehtml><html lang="zh-cn"><title>405</title>errors.aliyun.com</html>', { status: 405 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", model: "GLM-5.3-Flash", content: [] })
  const h = await freePlugin({ freeFirst: true })
  const opts = await h.loader(async () => coding, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  expect(JSON.parse(sent.at(-1).body).model).toBe("GLM-5.3-Flash")
  // while the block is fresh the gift is skipped entirely: no gift try,
  // the plan answers straight
  const before = sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages")).length
  await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(sent.filter((c) => c.origin === "https://zcode.z.ai" && c.path.endsWith("/messages")).length).toBe(before)
  // the card says why the gift sits idle beside its balance
  const u = await h.usage(async () => coding, { id: "zcode" })
  const line = (u.windows ?? []).find((w) => w.aside && /refusing requests/.test(w.name))
  expect(line.display).toMatch(/coding plan until \d\d:\d\d/)
  expect(line.display).toContain("blocked")
})

test("a spent answer names itself on the card for its minute", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "Insufficient balance or no resource package", code: 1113 } }), { status: 429, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const h = await freePlugin({ freeFirst: true })
  const opts = await h.loader(async () => coding, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  const u = await h.usage(async () => coding, { id: "zcode" })
  const line = (u.windows ?? []).find((w) => w.aside && /refusing requests/.test(w.name))
  expect(line.display).toMatch(/coding plan until \d\d:\d\d/)
  expect(line.display).toContain("spent")
})

test("a gift failure the plan answers shows on the card with the status", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response("boom", { status: 500 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const h = await freePlugin({ freeFirst: true })
  const opts = await h.loader(async () => coding, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  const u = await h.usage(async () => coding, { id: "zcode" })
  const line = (u.windows ?? []).find((w) => w.aside && /refusing requests/.test(w.name))
  expect(line.display).toMatch(/coding plan until \d\d:\d\d/)
  expect(line.display).toContain("500")
})

test("a 3012 says the account is restricted, not the address", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "request has been blocked due to unusual activity", code: 3012 } }), { status: 405, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", model: "GLM-5.3-Flash", content: [] })
  const h = await freePlugin({ freeFirst: true })
  const opts = await h.loader(async () => coding, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  expect(res.status).toBe(200)
  const u = await h.usage(async () => coding, { id: "zcode" })
  const line = (u.windows ?? []).find((w) => w.aside && /refusing requests/.test(w.name))
  expect(line.display).toContain("restricted")
  expect(line.display).not.toContain("blocked")
})

test("a blocked gift's -Trial entry says the network is blocked, not the quota", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response('<!doctypehtml><html lang="zh-cn"><title>405</title>errors.aliyun.com</html>', { status: 405 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const h = await freePlugin({ freeFirst: true })
  const opts = await h.loader(async () => coding, { id: "zcode" })
  await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash-Trial") })
  expect(res.status).toBe(429)
  const said = await res.json()
  expect(said.error.message).toContain("blocked from this network")
  expect(said.error.message).not.toContain("quota")
})

test("a gift success clears the card's refusal line", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response('<!doctypehtml><html lang="zh-cn"><title>405</title>errors.aliyun.com</html>', { status: 405 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const h = await freePlugin({ freeFirst: true })
  const opts = await h.loader(async () => coding, { id: "zcode" })
  await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  // the block out, the gift answers: the line goes with it
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  _internal.blocked.set(KEY + "\0" + jwt + "\0glm-5.3-flash", Date.now() - 1)
  await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
  const u = await h.usage(async () => coding, { id: "zcode" })
  expect((u.windows ?? []).find((w) => w.aside && /refusing requests/.test(w.name))).toBeUndefined()
})

test("the gift's own busy cap is not a refusal for the card", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  const waits = _internal.BUSY_WAITS.splice(0)
  _internal.BUSY_WAITS.push(1)
  try {
    answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "3008", msg: "user concurrency limit exceeded" }), { status: 429, headers: { "content-type": "application/json" } })
    answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    const h = await freePlugin({ freeFirst: true })
    const opts = await h.loader(async () => coding, { id: "zcode" })
    const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("GLM-5.3-Flash") })
    expect(res.status).toBe(200)
    const u = await h.usage(async () => coding, { id: "zcode" })
    expect((u.windows ?? []).find((w) => w.aside && /refusing requests/.test(w.name))).toBeUndefined()
  } finally {
    _internal.BUSY_WAITS.length = 0
    _internal.BUSY_WAITS.push(...waits)
  }
})

for (const [name, paid, gift] of [
  ["a full paid week leaves an available gift usable", 100, 25],
  ["a spent gift leaves the paid plan usable", 20, 100],
  ["two available pools keep their windows apart", 20, 25],
  ["two spent pools keep the paid limit visible", 100, 100],
]) {
  test(name, async () => {
    planAndBalance()
    answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: paid }] })
    answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: gift * 10, remaining_units: 1000 - gift * 10 }] })
    answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
    const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
    expect(u.windows[0].used).toBe(paid)
    expect(u.windows[1].used).toBe(gift)
    expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
    expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
    expect(JSON.stringify(u)).not.toContain("_spent")
    // a plain model spends the coding plan whatever the gift holds
    let before = sent.length
    expect((await sendTo(MSG, body("GLM-5.3-Flash"))).status).toBe(200)
    expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
    expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(1)
    // the trial entry spends the gift while it has quota, and nothing else
    before = sent.length
    const t = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
    if (gift < 100) {
      expect(t.status).toBe(200)
      expect(sent.slice(before).at(-1).origin).toBe("https://zcode.z.ai")
    } else {
      expect(t.status).toBe(429)
      expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
    }
  })
}

test("a spent gift retires its trial entry from the request cache", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3-Flash-Trial")) // warms the ten-minute request cache
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: 1000, remaining_units: 0 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-5.3-Flash-Trial"))).status).toBe(429)
  expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
})

test("fresh usage recognizes a newly replenished gift without waiting for the request cache", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: 1000, remaining_units: 0 }] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3-Flash-Trial")) // refused locally, the bucket spent
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-5.3-Flash-Trial"))).status).toBe(200)
  expect(sent.slice(before).at(-1).origin).toBe("https://zcode.z.ai")
})

test("an expired gift restores the paid windows and retires its cached route", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 20 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("glm-5.3-flash"))
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, plans: [{ ...balance.plans[0], ends_at: now - 1 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows).toHaveLength(1)
  expect(u.windows[0].notModels).toBeUndefined()
  const before = sent.length
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
})

test("a trial entry's quota refusal answers 429 and blocks the entry for a minute", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 }] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "1005", msg: "exceed quota limit" }), { headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  expect((await sendTo(MSG, body("GLM-5.3-Flash-Trial"))).status).toBe(429)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
  expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
  _internal.blocked.clear()
  const renewed = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(renewed.windows[0].notModels).toEqual(["glm-5.3-flash-trial"])
  expect(renewed.windows[1].aside).not.toBe(true)
})

test("blocking one model leaves another model of the same gift bucket usable", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], capabilities: ["model:glm-5.3-flash", "model:GLM-5.2"] }] })
  _internal.blocked.set(KEY + "\0" + jwt + "\0glm-5.3-flash", Date.now() + 60_000)
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial", "glm-5.2-trial"])
  expect(u.windows[1].models).toEqual(["GLM-5.3-Flash-Trial", "GLM-5.2-Trial"])
  expect(u.windows[1].aside).not.toBe(true)
})

test("a spent bucket without remaining_units is skipped using its used and total counts", async () => {
  planAndBalance()
  const spent = { ...balance.balances[0], used_units: "1000", total_units: "1000" }
  delete spent.remaining_units
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [spent] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.filter((c) => c.path === "/api/v1/zcode-plan/anthropic/v1/messages")).toHaveLength(0)
})

test("a spent gift-only account keeps its spent window as a routing limit", async () => {
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ ...balance, balances: [{ ...balance.balances[0], used_units: 1000, remaining_units: 0 }] })
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", jwt, device: DEVICE }), expires: 0 }
  const u = await (await hooks()).usage(async () => only, { id: "zcode" })
  expect(u.windows[0].used).toBe(100)
  expect(u.windows[0].aside).toBeUndefined()
  expect(JSON.stringify(u)).not.toContain("_spent")
})


test("the card shows the Coding windows and the gift's buckets together", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.plan).toBe("GLM Coding Pro")
  expect(u.signIn).toBe("kept")
  expect(u.error).toBeUndefined()
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "Trust Build · Start Plan"])
  expect(u.windows[1]).toMatchObject({ used: 25, display: "250 / 1000", models: ["GLM-5.3-Flash-Trial"] })
  expect(u.until).toBeUndefined()
  expect(u.renew).toBeUndefined()
  expect(u.windows[1].resetsAt).toBe(new Date((now + 3600) * 1000).toISOString())
})

test("a gift read that fails after the gift was known leaves just the Coding card", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  await (await hooks()).usage(async () => coding, { id: "zcode" }) // reads and caches the gift
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours"])
  expect(u.error).toBeUndefined()
  expect(_internal.routes.get(KEY + "\0" + jwt).gift).toBeNull()
  expect(_internal.routes.get(KEY + "\0" + jwt).ttl).toBe(60_000)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const before = sent.length
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
})

test("a trial entry goes to the Start Plan, dressed", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(200)
  expect(sent.length).toBe(3) // the plan list and the balance read, then the message
  const m = sent.at(-1)
  expect(m.origin).toBe("https://zcode.z.ai")
  expect(m.path).toBe("/api/v1/zcode-plan/anthropic/v1/messages")
  expect(m.headers["x-title"]).toBe("Z Code@cli")
  expect(m.headers.authorization).toBe("Bearer " + jwt)
  expect(m.headers["x-api-key"]).toBeUndefined()
  expect(JSON.parse(m.body).system.length).toBeGreaterThan(1) // dressed
  expect(JSON.parse(m.body).model).toBe("glm-5.3-flash") // the entry's own model
})

test("a model the gift does not serve goes to the coding plan as sent", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(200)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(m.path).toBe("/api/anthropic/v1/messages")
  // as sent, but for the sign-in's device and the conversation, as ZCode names them (#387)
  const session = _internal.sessionOf("", DEVICE)
  expect(m.headers["x-session-id"]).toBe(session)
  expect(JSON.parse(m.body)).toEqual({ ...JSON.parse(body("GLM-5.3")), metadata: { user_id: JSON.stringify({ device_id: DEVICE, account_uuid: "", session_id: session }) } })
  expect(m.headers["x-api-key"]).toBe(KEY)
  expect(m.headers["x-title"]).toBeUndefined()
})

test("a spent bucket answers the trial entry 429 without touching the coding plan", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package" } }), { status: 429 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(429)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  // the minute's block keeps the next one off the gift too
  const before = sent.length
  await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(sent.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(0)
})

test("a trial entry's quota error inside a 200 becomes 429", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit", logid: "x" }), { status: 200, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(429)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
})

test("a trial entry's 200 success answers normally: no replay", async () => {
  planAndBalance()
  const sse = new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = sse
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(200)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(sent.filter((c) => c.path === "/api/anthropic/v1/messages").length).toBe(0)
  expect(await res.text()).toBe("data: {}\n\n")
})

test("a gift refusal answers the trial entry as it came, unblocked", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "3012", msg: "unusual activity" }), { status: 405 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(res.status).toBe(405)
  expect(sent.filter((c) => c.origin === "https://api.z.ai" && c.path.endsWith("/messages"))).toHaveLength(0)
  expect(_internal.blocked.size).toBe(0)
  const before = sent.length
  await sendTo(MSG, body("GLM-5.3-Flash-Trial"))
  expect(sent.slice(before).some((c) => c.origin === "https://zcode.z.ai")).toBe(true)
})

test("a ZCode sign-in that expired after the gift was cached goes to the coding plan", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const dead = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
  _internal.routes.set(KEY + "\0" + dead, { start: false, gift: { models: ["glm-5.3-flash"] }, at: Date.now(), ttl: 600_000 })
  const aged = { ...coding, refresh: JSON.stringify({ ...JSON.parse(coding.refresh), jwt: dead }) }
  const opts = await (await hooks()).loader(async () => aged, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode" }, body: body("glm-5.3-flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.at(-1).headers["x-api-key"]).toBe(KEY)
})

// a failed gift read is unknown, not "no gift": a ten-minute "none" hid
// the account's -Trial models for ten minutes after one hiccup
test("a gift read that fails at once is asked again in a minute", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  await sendTo(MSG, body("glm-5.3-flash"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false) // on the coding plan
  expect(r.gift).toBeNull() // the balance read failed: no gift known
  expect(r.ttl).toBe(60_000) // the gift is unknown: a minute
})

test("a coding account with no gift keeps its 10-minute cache", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ server_time: now, plans: [], balances: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false)
  expect(r.gift).toBeNull()
  expect(r.ttl).toBe(600_000) // plan list read fine: 10 minutes, not 1
})

test("a plan-list failure on a key account takes the dual route, not gift-only", async () => {
  answers["/api/biz/subscription/list"] = new Response("", { status: 500 })
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false) // dual: coding first, gift for its models
  expect(r.gift).toMatchObject({ models: ["glm-5.3-flash"] })
  expect(r.ttl).toBe(60_000) // unsure: the plan list failed
})

// several plans can be active at once: the gift is what any live plan's live
// bucket can spend, whatever the plan is named
test("every live plan spends first by its buckets' models, and the card shows them all", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({
    server_time: now,
    plans: [
      { plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400, entitlements: [{ entitlement_id: "e1", period: "daily" }] },
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", name: "GLM Festival Grant", status: "active", ends_at: now + 3 * 86400, entitlements: [{ entitlement_id: "e2", period: "weekly" }] },
      { plan_id: "zai-old-plan", user_plan_id: "up3", name: "Old Grant", status: "active", ends_at: now - 86400, entitlements: [{ entitlement_id: "e3", period: "daily" }] },
    ],
    balances: [
      ...balance.balances,
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", entitlement_id: "e2", show_name: "GLM-5.2", capabilities: ["model:GLM-5.2"], total_units: 100, used_units: 10, remaining_units: 90, expires_at: now + 3600 },
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", entitlement_id: "e2b", show_name: "GLM-5.2 late", capabilities: ["model:glm-5.2"], total_units: 100, used_units: 100, remaining_units: 0, expires_at: now + 3600 },
      { plan_id: "zai-old-plan", user_plan_id: "up3", entitlement_id: "e3", show_name: "Old", capabilities: ["model:glm-4"], total_units: 10, used_units: 0, remaining_units: 10, expires_at: now + 3600 },
    ],
  })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  // plain models stay on the coding plan; the trial entries spend the gift
  for (const [m, origin] of [["glm-5.3-flash", "https://api.z.ai"], ["GLM-5.2", "https://api.z.ai"], ["GLM-5.3-Flash-Trial", "https://zcode.z.ai"], ["GLM-5.2-Trial", "https://zcode.z.ai"]]) {
    const before = sent.length
    expect((await sendTo(MSG, body(m))).status).toBe(200)
    expect(sent.slice(before).at(-1).origin).toBe(origin)
  }
  // the ended plan's bucket does not put GLM-4 on the gift
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-4"))).status).toBe(200)
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
  // the card shows both plans' live buckets, spent ones included, none of the
  // ended plan's, each named after its plan as there are two
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "Trust Build · Start Plan", "GLM-5.2-Trial · GLM Festival Grant", "GLM-5.2 late · GLM Festival Grant"])
  expect(u.windows.some((w) => w.name === "Old")).toBe(false)
  expect(u.windows[0].notModels).toEqual(["glm-5.3-flash-trial", "glm-5.2-trial"])
  expect(u.windows.at(-1).aside).toBe(true) // a spent sibling cannot cap a live bucket
})

test("a gift-only account sends every request to the gift, and reads no balance to do it", async () => {
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", jwt, device: DEVICE }), expires: 0 }
  const opts = await (await hooks()).loader(async () => only, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("glm-5.3-flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
  expect(sent.filter((c) => c.path === "/api/v1/zcode-plan/billing/balance").length).toBe(0)
})

// #369: a GLM Coding Plan account whose plan list read no plan once was sent
// to the Start Plan for ten minutes, and every request answered 405
test("a key's plan list that once reads no plan after reading one is asked again in a minute", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Lite", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const id = KEY + "\0" + jwt
  expect(_internal.routes.get(id)).toMatchObject({ start: false, ttl: 600_000 })
  _internal.routes.get(id).at = 0 // the ten minutes are up
  answers["/api/biz/subscription/list"] = ok([])
  await sendTo(MSG, body("GLM-5.3"))
  expect(_internal.routes.get(id)).toMatchObject({ start: true, ttl: 60_000 })
  // read the same way again, it is known: ten minutes
  _internal.routes.get(id).at = 0
  await sendTo(MSG, body("GLM-5.3"))
  expect(_internal.routes.get(id)).toMatchObject({ start: true, ttl: 600_000 })
})

test("a Start Plan refusal on a key account reads its plans again on the next request", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Lite", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), { status: 405 })
  const id = KEY + "\0" + jwt
  _internal.routes.set(id, { start: true, gift: null, at: Date.now(), ttl: 600_000 })
  let res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(405)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
  res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.at(-1).headers["x-api-key"]).toBe(KEY)
})

// #379: a plan bought, a gift claimed or a plan lapsed reaches the requests
// when the card shows it
test("a card read reads the route again", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 10 }] })
  const id = KEY + "\0" + jwt
  _internal.routes.set(id, { start: true, gift: null, at: Date.now(), ttl: 600_000 })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows[0].used).toBe(10)
  expect(_internal.routes.get(id)).toMatchObject({ start: false, gift: { models: ["glm-5.3-flash"] } })
})
