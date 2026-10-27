import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run in an isolated home")
const { ZCodeAuthPlugin, _internal } = await import("./index.mjs")
const now = Math.trunc(Date.now() / 1000)
const jwt = ["{}", JSON.stringify({ exp: now + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".synthetic"
const state = { site: "zai", base: "https://api.z.ai/api/anthropic", key: "synthetic-key", jwt, device: "11111111-2222-4333-8444-555555555555", plan: "GLM Coding Pro" }
const auth = { type: "oauth", access: state.key, refresh: JSON.stringify(state), expires: 0 }
const original = "glm-limited-preview"
const alias = original + "-Trial"
const MSG = "https://api.z.ai/api/anthropic/v1/messages"
const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } })
const real = globalThis.fetch
const sent = []
let balance, paid, giftReply

beforeEach(() => {
  _internal.routes.clear()
  _internal.blocked.clear()
  sent.length = 0
  paid = 100
  giftReply = new Response(JSON.stringify({ type: "message", content: [] }), { headers: { "content-type": "application/json" } })
  balance = {
    server_time: now,
    plans: [{ plan_id: "grant", user_plan_id: "g1", name: "Festival Grant", status: "active", ends_at: now + 86400 }],
    balances: [{ plan_id: "grant", user_plan_id: "g1", show_name: "Limited credit", capabilities: ["model:" + original], total_units: 100, used_units: 25, remaining_units: 75, expires_at: now + 3600 }],
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/biz/subscription/list") return ok([{ productName: "GLM Coding Pro", status: "VALID" }])
    if (url.pathname === "/api/monitor/usage/quota/limit") return ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: paid, nextResetTime: (now + 86400) * 1000 }] })
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return ok(balance)
    if (url.pathname.endsWith("/messages")) {
      const text = init.body ?? (input instanceof Request ? await input.text() : undefined)
      sent.push({ origin: url.origin, path: url.pathname, body: JSON.parse(text) })
      return url.origin === "https://zcode.z.ai" ? giftReply.clone() : ok({ type: "message", content: [] })
    }
    throw new Error("unmocked request blocked: " + url.pathname)
  }
})
afterEach(() => { globalThis.fetch = real })
const hooks = async () => (await ZCodeAuthPlugin({ client: {} }))
const send = async (model = alias, credentials = auth) => {
  const loader = await (await hooks()).auth.loader(async () => credentials, { id: "zcode" })
  return loader.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 10 }) })
}

test("real balance data adds a gift model absent from the coding catalog", async () => {
  const h = await hooks()
  const plan = await h.provider.models({ models: {} }, { auth: { type: "api", key: state.key } })
  const models = await h.provider.models({ models: {} }, { auth })
  expect(plan[original]).toBeUndefined()
  expect(models[alias]).toMatchObject({ id: alias, name: alias, api: { id: alias } })
  for (const [id, m] of Object.entries(plan)) expect(models[id]).toEqual(m)
  expect(Object.keys(models).filter((id) => id.endsWith("-Trial"))).toEqual([alias])
})

test("an exhausted but active limited grant remains discoverable", async () => {
  Object.assign(balance.balances[0], { used_units: 100, remaining_units: 0 })
  const models = await (await hooks()).provider.models({ models: {} }, { auth })
  expect(models[alias]?.name).toBe(alias)
})

test("gift model names come from every live grant, not a fixed Flash model", async () => {
  balance.balances[0].capabilities = ["model:" + original, "model:glm-another-preview", "tool:web-search"]
  const models = await (await hooks()).provider.models({ models: {} }, { auth })
  expect(Object.keys(models).filter((id) => id.endsWith("-Trial")).sort()).toEqual(["glm-another-preview-Trial", alias].sort())
  expect(Object.keys(models).some((id) => id.includes("tool:"))).toBe(false)
})

test("expired grants do not add gift model entries", async () => {
  balance.plans[0].ends_at = now - 1
  const models = await (await hooks()).provider.models({ models: {} }, { auth })
  expect(models[alias]).toBeUndefined()
})

test("fresh usage keeps gift discovery available after a bucket is spent", async () => {
  const h = await hooks()
  await h.auth.usage(async () => auth, { id: "zcode" })
  Object.assign(balance.balances[0], { used_units: 100, remaining_units: 0 })
  await h.auth.usage(async () => auth, { id: "zcode" })
  const models = await h.provider.models({ models: {} }, { auth })
  expect(models[alias]?.name).toBe(alias)
})

test("a gift alias sends the original model only to the limited-quota endpoint", async () => {
  expect((await send()).status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ origin: "https://zcode.z.ai", body: { model: original } })
  expect(JSON.stringify(sent[0].body)).not.toContain(alias)
})

test("a gift alias in a Request body is restored before sending upstream", async () => {
  const loader = await (await hooks()).auth.loader(async () => auth, { id: "zcode" })
  const request = new Request(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: alias, messages: [{ role: "user", content: "hi" }] }) })
  expect((await loader.fetch(request)).status).toBe(200)
  expect(sent[0]).toMatchObject({ origin: "https://zcode.z.ai", body: { model: original } })
})

test("a gift refusal does not spend the paid plan", async () => {
  paid = 0
  giftReply = new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 403, headers: { "content-type": "application/json" } })
  expect((await send()).status).toBe(403)
  expect(sent).toHaveLength(1)
  expect(sent[0].origin).toBe("https://zcode.z.ai")
})

test("a gift quota error inside HTTP 200 becomes 429 without paid fallback", async () => {
  paid = 0
  giftReply = new Response(JSON.stringify({ code: "1005", msg: "exceed quota limit" }), { headers: { "content-type": "application/json" } })
  expect((await send()).status).toBe(429)
  expect(sent).toHaveLength(1)
  expect(sent[0].origin).toBe("https://zcode.z.ai")
})

test("an exhausted gift alias is refused locally without a paid request", async () => {
  paid = 0
  Object.assign(balance.balances[0], { used_units: 100, remaining_units: 0 })
  expect((await send()).status).toBe(429)
  expect(sent).toHaveLength(0)
})

test("gift-only accounts can use their real gift alias", async () => {
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ ...state, key: undefined, plan: undefined }), expires: 0 }
  expect((await send(alias, only)).status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0].body.model).toBe(original)
})

test("gift quota applies to the alias without the paid-week constraint", async () => {
  const u = await (await hooks()).auth.usage(async () => auth, { id: "zcode" })
  expect(u.windows[0].notModels).toContain(alias.toLowerCase())
  expect(u.windows[1].models).toContain(alias)
  expect(u.windows[1].used).toBe(25)
})

test("an exhausted gift remains scoped to its alias while paid quota stays usable", async () => {
  paid = 20
  Object.assign(balance.balances[0], { used_units: 100, remaining_units: 0 })
  const u = await (await hooks()).auth.usage(async () => auth, { id: "zcode" })
  expect(u.windows[0].notModels).toContain(alias.toLowerCase())
  expect(u.windows[1].models).toEqual([alias])
  expect(u.windows[1].used).toBe(100)
  expect(u.windows[1].aside).not.toBe(true)
})

test("a spent sibling does not exhaust a gift alias with a live bucket", async () => {
  balance.balances.push({ ...balance.balances[0], show_name: "Spent sibling", used_units: 100, remaining_units: 0 })
  const u = await (await hooks()).auth.usage(async () => auth, { id: "zcode" })
  expect(u.windows[1].models).toContain(alias)
  expect(u.windows[2].aside).toBe(true)
})

test("a temporary gift block never turns an alias into a paid request", async () => {
  paid = 0
  _internal.blocked.set(state.key + "\0" + jwt + "\0" + original, Date.now() + 60_000)
  expect((await send()).status).toBe(429)
  expect(sent).toHaveLength(0)
})

test("case variants of the same grant model keep one stable gift entry after usage refresh", async () => {
  balance.balances[0].capabilities = ["model:" + original.toUpperCase()]
  balance.balances.push({ ...balance.balances[0], capabilities: ["model:" + original], used_units: 100, remaining_units: 0 })
  const h = await hooks()
  const before = await h.provider.models({ models: {} }, { auth })
  await h.auth.usage(async () => auth, { id: "zcode" })
  const after = await h.provider.models({ models: {} }, { auth })
  const ids = (m) => Object.keys(m).filter((id) => id.endsWith("-Trial"))
  expect(ids(before)).toEqual([original.toUpperCase() + "-Trial"])
  expect(ids(after)).toEqual(ids(before))
})

test("a grant ending before the normal route TTL is removed on the next model read", async () => {
  balance.plans[0].ends_at = now + 30
  const clientStart = now * 1000 + 1500
  const clock = spyOn(Date, "now").mockReturnValue(clientStart)
  try {
    const h = await hooks()
    expect((await h.provider.models({ models: {} }, { auth }))[alias]).toBeDefined()
    balance.server_time = now + 31
    clock.mockReturnValue(clientStart + 31_000)
    expect((await h.provider.models({ models: {} }, { auth }))[alias]).toBeUndefined()
  } finally {
    clock.mockRestore()
  }
})

test("a gift-only account's spent Start Plan bucket doesn't hold up a model its Trust Build still has", async () => {
  // ganlerk's account (Discord): Trust Build's GLM-5.3-Flash 14.5% used,
  // the Start Plan's GLM-5.3-Flash all used, its GLM-5.3 untouched
  balance.plans = [
    { plan_id: "trust", user_plan_id: "t1", name: "ZCode Trust Build", status: "active", ends_at: now + 86400 },
    { plan_id: "start", user_plan_id: "s1", name: "ZCode Start Plan", status: "active", ends_at: now + 7 * 86400 },
  ]
  balance.balances = [
    { plan_id: "start", user_plan_id: "s1", show_name: "GLM-5.3", capabilities: ["model:GLM-5.3"], total_units: 3_000_000, used_units: 0, remaining_units: 3_000_000 },
    { plan_id: "start", user_plan_id: "s1", show_name: "GLM-5.3-Flash", capabilities: ["model:GLM-5.3-Flash"], total_units: 5_000_000, used_units: 5_000_000, remaining_units: 0 },
    { plan_id: "trust", user_plan_id: "t1", show_name: "GLM-5.3-Flash", capabilities: ["model:GLM-5.3-Flash"], total_units: 100_000_000, used_units: 14_501_196, remaining_units: 85_498_804, expires_at: now + 3600 },
  ]
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ ...state, key: undefined, plan: undefined }), expires: 0 }
  const u = await (await hooks()).auth.usage(async () => only, { id: "zcode" })
  const counting = (m) => u.windows.filter((w) => !w.aside && w.models?.some((x) => x.toLowerCase() === m.toLowerCase()))
  for (const m of ["GLM-5.3-Flash", "GLM-5.3-Flash-Trial"]) {
    expect(counting(m)).toHaveLength(1)
    expect(counting(m)[0].used).toBeCloseTo(14.5, 1)
  }
  expect(counting("GLM-5.3")[0].used).toBe(0)
  // the spent bucket is still on the card, as ZCode shows it
  expect(u.windows.find((w) => w.used === 100)).toMatchObject({ name: "ZCode Start Plan · GLM-5.3-Flash", aside: true })
  expect(u.windows).toHaveLength(3)
})

test("a gift-only account lists its gift's models by their own names, as ZCode does (#1261)", async () => {
  // sun1090's account: no GLM Coding Plan, the Start Plan's GLM-5.3 and
  // GLM-5.3-Flash buckets; the card counted GLM-5.3 while the list had only
  // GLM-5.3-Trial, as the Start Plan's config leaves GLM-5.3 out
  balance.plans = [{ plan_id: "start", user_plan_id: "s1", name: "ZCode Start Plan", status: "active", ends_at: now + 7 * 86400 }]
  balance.balances = [
    { plan_id: "start", user_plan_id: "s1", show_name: "GLM-5.3", capabilities: ["model:GLM-5.3"], total_units: 3_000_000, used_units: 41_030, remaining_units: 2_958_970 },
    { plan_id: "start", user_plan_id: "s1", show_name: "GLM-5.3-Flash", capabilities: ["model:GLM-5.3-Flash"], total_units: 5_000_000, used_units: 170_088, remaining_units: 4_829_912 },
  ]
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ ...state, key: undefined, plan: undefined }), expires: 0 }
  const h = await hooks()
  const models = await h.provider.models({ models: {} }, { auth: only })
  expect(models["GLM-5.3"]).toMatchObject({ id: "GLM-5.3", name: "GLM-5.3", api: { id: "GLM-5.3" } })
  expect(Object.keys(models["GLM-5.3"].variants ?? {})).toEqual(["low", "high", "max"])
  // the trial entries a user may have picked stay, and nothing is listed twice
  expect(models["GLM-5.3-Trial"]).toBeDefined()
  expect(models["GLM-5.3-Flash-Trial"]).toBeDefined()
  const ids = Object.keys(models).map((id) => id.toLowerCase())
  expect(new Set(ids).size).toBe(ids.length)
  // every model the card counts is one the list has
  const u = await h.auth.usage(async () => only, { id: "zcode" })
  for (const w of u.windows) for (const m of w.models ?? []) expect(models[m]).toBeDefined()
  // and a request for it goes to the Start Plan
  const loader = await h.auth.loader(async () => only, { id: "zcode" })
  await loader.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }], max_tokens: 10 }) })
  expect(sent.at(-1)).toMatchObject({ origin: "https://zcode.z.ai", body: { model: "GLM-5.3" } })
})

test("a coding plan account's gift stays on its trial entries alone", async () => {
  balance.balances[0].capabilities = ["model:GLM-5.3"]
  const coding = await (await hooks()).provider.models({ models: {} }, { auth: { type: "api", key: state.key } })
  const models = await (await hooks()).provider.models({ models: {} }, { auth })
  expect(Object.keys(models).filter((id) => !(id in coding))).toEqual(["GLM-5.3-Trial"])
})

// 01huadalang's account (Discord, 10-24): the new-user Start Plan and the
// 1024 Dev Day plan both give GLM-5.3, and the new-user one is spent. The
// 1024 plan's id, name, show_names, capabilities and grant_units are the
// real /billing/preview bytes of an account it was offered to; its balance
// rows are written in the shape the balance gives (no 1024 balance was
// read), with the Start Plan's name as ganlerk's balance has it.
const twoPlans = () => {
  balance.plans = [
    { plan_id: "zcode-v3-start-plan", user_plan_id: "s1", name: "ZCode Start Plan", status: "active", ends_at: now + 7 * 86400 },
    { plan_id: "zcode-v3-start-plan-1024", user_plan_id: "d1", name: "ZCode 1024 Dev Day", status: "active", ends_at: now + 30 * 86400 },
  ]
  balance.balances = [
    { plan_id: "zcode-v3-start-plan", user_plan_id: "s1", show_name: "GLM-5.3", capabilities: ["model:glm-5.3"], total_units: 3_000_000, used_units: 3_000_000, remaining_units: 0 },
    { plan_id: "zcode-v3-start-plan", user_plan_id: "s1", show_name: "GLM-5.3-Flash", capabilities: ["model:glm-5.3-flash"], total_units: 5_000_000, used_units: 0, remaining_units: 5_000_000 },
    { plan_id: "zcode-v3-start-plan-1024", user_plan_id: "d1", entitlement_id: "ent-zcode-v3-start-plan-1024-1", show_name: "GLM-5.3-Flash", capabilities: ["model:glm-5.3-flash"], total_units: 300_000_000, used_units: 30_000_000, remaining_units: 270_000_000 },
    { plan_id: "zcode-v3-start-plan-1024", user_plan_id: "d1", entitlement_id: "ent-zcode-v3-start-plan-1024-2", show_name: "GLM-5.3", capabilities: ["model:glm-5.3"], total_units: 200_000_000, used_units: 50_000_000, remaining_units: 150_000_000 },
  ]
}

test("two gift plans' GLM-5.3 each show, named by plan, the live one first (01huadalang)", async () => {
  twoPlans()
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ ...state, key: undefined, plan: undefined }), expires: 0 }
  const u = await (await hooks()).auth.usage(async () => only, { id: "zcode" })
  const names = u.windows.map((w) => w.name)
  expect(new Set(names).size).toBe(names.length)
  // the 1024 plan's GLM-5.3 shows its own amount left, and counts the model
  expect(u.windows.find((w) => w.name === "ZCode 1024 Dev Day · GLM-5.3")).toMatchObject({ used: 25, amount: 50_000_000, limit: 200_000_000, models: ["glm-5.3", "GLM-5.3-Trial"] })
  expect(u.windows.find((w) => w.name === "ZCode 1024 Dev Day · GLM-5.3").aside).toBeUndefined()
  // the spent new-user plan's GLM-5.3 still shows, used up, set aside
  expect(u.windows.find((w) => w.name === "ZCode Start Plan · GLM-5.3")).toMatchObject({ used: 100, amount: 3_000_000, aside: true })
  // magpie's account row shows a card's first two windows: what is spent now
  expect(u.windows.slice(0, 2).every((w) => !w.aside)).toBe(true)
  expect(u.windows.slice(0, 2).some((w) => w.name === "ZCode 1024 Dev Day · GLM-5.3")).toBe(true)
})

test("a coding plan account's two gift plans' GLM-5.3 each show, named by plan", async () => {
  twoPlans()
  const u = await (await hooks()).auth.usage(async () => auth, { id: "zcode" })
  const gift = u.windows.slice(1)
  expect(gift.map((w) => w.name)).toEqual([
    "ZCode Start Plan · GLM-5.3-Flash-Trial",
    "ZCode 1024 Dev Day · GLM-5.3-Trial",
    "ZCode Start Plan · GLM-5.3",
    "ZCode 1024 Dev Day · GLM-5.3-Flash",
  ])
  expect(gift[1]).toMatchObject({ used: 25, models: ["GLM-5.3-Trial"] })
  expect(gift[2]).toMatchObject({ used: 100, aside: true })
})

// bigsteven (Discord, 10-24): GLM Coding Plan spent, no GLM-5.3-Trial in
// the list. ZCode's config out of reach marks the list a fallback, and
// magpie then keeps the list it was told last, from before the gift: the
// -Trial entries just read went with it. A list with trial entries is
// told as it is.
test("ZCode's config out of reach still tells a gift's -Trial entries, not a fallback", async () => {
  _internal.config(null)
  try {
    balance.balances[0].capabilities = ["model:glm-5.3"]
    const models = await (await hooks()).provider.models({ models: {} }, { auth })
    expect(models["GLM-5.3-Trial"]?.name).toBe("GLM-5.3-Trial")
    expect(models[Symbol.for("magpie.fellBack")]).toBeUndefined()
    // with no gift there is nothing new to tell: still a fallback
    _internal.routes.clear()
    balance.plans = []
    const none = await (await hooks()).provider.models({ models: {} }, { auth })
    expect(Object.keys(none).some((id) => id.endsWith("-Trial"))).toBe(false)
    expect(none[Symbol.for("magpie.fellBack")]).toBe(true)
  } finally {
    _internal.config(undefined)
  }
})

test("a gift read that failed lists its -Trial entries again a minute later", async () => {
  balance.balances[0].capabilities = ["model:glm-5.3"]
  const good = balance
  balance = null
  const was = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (balance === null && new URL(String(input)).pathname === "/api/v1/zcode-plan/billing/balance") return new Response("", { status: 502 })
    return was(input, init)
  }
  const h = await hooks()
  expect((await h.provider.models({ models: {} }, { auth }))["GLM-5.3-Trial"]).toBeUndefined()
  balance = good
  const r = _internal.routes.get(state.key + "\0" + jwt)
  r.at -= 61_000
  expect((await h.provider.models({ models: {} }, { auth }))["GLM-5.3-Trial"]?.name).toBe("GLM-5.3-Trial")
})

// a key, or a sign-in whose ZCode session ran out, reads no gift: the card
// says why there are no -Trial entries instead of leaving them out unsaid
test("a coding plan with no live ZCode session says its gift plans need ZCode's sign-in", async () => {
  const line = (u) => u.windows.find((w) => w.name === "ZCode gift plans (-Trial models) need ZCode's sign-in")
  const h = await hooks()
  const key = await h.auth.usage(async () => ({ type: "api", key: state.key }), { id: "zcode" })
  expect(line(key)).toEqual({ name: "ZCode gift plans (-Trial models) need ZCode's sign-in", used: 0, aside: true, display: "not read with an API key: add the account with a ZCode sign-in" })
  expect(Object.keys(await h.provider.models({ models: {} }, { auth: { type: "api", key: state.key } })).some((id) => id.endsWith("-Trial"))).toBe(false)
  const dead = ["{}", JSON.stringify({ exp: now - 60 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".synthetic"
  const aged = { ...auth, refresh: JSON.stringify({ ...state, jwt: dead }) }
  const u = await h.auth.usage(async () => aged, { id: "zcode" })
  expect(u.error).toBeUndefined()
  expect(line(u)?.display).toBe("ZCode's sign-in has expired: sign in again")
  expect(Object.keys(await h.provider.models({ models: {} }, { auth: aged })).some((id) => id.endsWith("-Trial"))).toBe(false)
  // a live session reads the gift: no such line, its -Trial entries listed
  const live = await h.auth.usage(async () => auth, { id: "zcode" })
  expect(line(live)).toBeUndefined()
  expect(live.windows.some((w) => w.name.includes("-Trial") || (w.models ?? []).some((m) => m.endsWith("-Trial")))).toBe(true)
})
