import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with an isolated HOME")
const { ZCodeAuthPlugin, _internal } = await import("./index.mjs")
const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const state = { site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: "team.secret", token: "team-token", org: "org", project: "project", jwt, device: "test-device", plan: "Team Max" }
const auth = (s = state) => ({ type: "oauth", access: s.key, refresh: JSON.stringify(s), expires: 0 })
const now = Math.floor(Date.now() / 1000)
const balance = {
  plans: [{ plan_id: "dev-day", name: "ZCode 1024 Dev Day", status: "active", ends_at: now + 86400 }],
  balances: [{ plan_id: "dev-day", show_name: "GLM-5.3", capabilities: ["model:glm-5.3"], total_units: 100, used_units: 25, remaining_units: 75 }],
}
const real = globalThis.fetch
let sent, failGift
const ok = (data) => Response.json({ code: 0, data })
beforeEach(() => {
  _internal.routes.clear()
  _internal.blocked.clear()
  sent = []
  failGift = false
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    sent.push({ url, headers, body: init.body })
    switch (url.pathname) {
      case "/api/v1/zcode-plan/billing/balance": return failGift ? new Response("", { status: 502 }) : ok(balance)
      // A team's personal subscription list is empty; it must stay on its team.
      case "/api/biz/subscription/list": return ok([])
      case "/api/monitor/usage/quota/limit": return ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 90 }] })
      case "/api/biz/team/subscribe/product/querySubscribeDetail": return ok({ hasSubscription: true, status: "EFFECTIVE", memberGrantStatus: "VALID", productName: "Team Max" })
      case "/api/biz/customer-package-reset/list": return ok({})
      case "/api/v1/zcode-plan/billing/preview": return ok({ plans: [{ plan_id: "trust", name: "Trust Build" }] })
      case "/api/anthropic/v1/messages":
      case "/api/v1/zcode-plan/anthropic/v1/messages": return ok({ type: "message", content: [] })
      default: return new Response("", { status: 404 })
    }
  }
})
afterEach(() => { globalThis.fetch = real })
const hooks = () => ZCodeAuthPlugin({ client: {} })

test("a team seat lists personal gift trials even without a resolved team key", async () => {
  const h = await hooks()
  for (const key of [state.key, ""]) {
    const models = await h.provider.models({ models: {} }, { auth: auth({ ...state, key }) })
    expect(models["GLM-5.3-Trial"]).toBeDefined()
    expect(models["GLM-5.3"]).toBeDefined()
    expect((await _internal.plansOf({ ...state, key })).start).toBe(false)
  }
  expect(sent.filter((x) => x.url.pathname === "/api/biz/subscription/list")).toHaveLength(0)
})

test("the team card includes gift buckets and hints, with separate model limits", async () => {
  const h = await hooks()
  const card = await h.auth.usage(async () => auth())
  expect(card.plan).toBe("Team Max")
  expect(card.windows[0]).toMatchObject({ used: 90, notModels: ["glm-5.3-trial"] })
  expect(card.windows.find((w) => w.models?.includes("GLM-5.3-Trial"))).toMatchObject({ used: 25 })
  expect(card.windows.find((w) => w.name === "Gift plans to claim in the ZCode app")).toBeDefined()
})

test("a gift failure preserves the team card and retries within a minute", async () => {
  failGift = true
  const h = await hooks()
  await h.provider.models({ models: {} }, { auth: auth() })
  const card = await h.auth.usage(async () => auth())
  expect(card.error).toBeUndefined()
  expect(card.windows[0].used).toBe(90)
  const route = await _internal.plansOf(state)
  expect(route).toMatchObject({ start: false, gift: null })
  expect(route.ttl).toBeLessThanOrEqual(60000)
})

test("a team without a ZCode session explains the missing trials", async () => {
  const h = await hooks()
  const card = await h.auth.usage(async () => auth({ ...state, jwt: "" }))
  expect(card.windows.find((w) => w.name === "ZCode gift plans (-Trial models) need ZCode's sign-in")).toBeDefined()
  expect(sent.filter((x) => x.url.pathname.includes("/billing/"))).toHaveLength(0)
})

test("ordinary models spend the team; trials spend the personal gift without team credentials", async () => {
  const h = await hooks()
  const loader = await h.auth.loader(async () => auth(), { id: "zcode" })
  for (const model of ["GLM-5.3", "GLM-5.3-Trial"]) {
    expect((await loader.fetch(state.base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) })).status).toBe(200)
  }
  const messages = sent.filter((x) => x.url.pathname.endsWith("/messages"))
  expect(messages).toHaveLength(2)
  expect(messages[0].url.origin).toBe("https://open.bigmodel.cn")
  expect(messages[0].headers.get("x-api-key")).toBe(state.key)
  expect(messages[1].url.origin).toBe("https://zcode.z.ai")
  expect(messages[1].headers.get("authorization")).toBe("Bearer " + jwt)
  expect(messages[1].headers.get("x-api-key")).toBeNull()
  expect(messages[1].headers.get("Bigmodel-Organization")).toBeNull()
  expect(JSON.parse(messages[1].body).model).toBe("glm-5.3")
})
