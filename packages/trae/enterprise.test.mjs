// An enterprise (SaaS) subscription signs in on the same authorization
// page as a personal one, when the page is not told to hide that sign-in
// (@shad70w0 on X). A host the sign-in names on Trae's own domains is kept
// and used; one anywhere else is not, and a personal sign-in is as before.
// Not tried with a real enterprise account: the hosts below are made up.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

// the console's own answer, as a real enterprise account's is: the seat
// pool in yuan, and each model's cost
const ENT = "https://console.enterprise.trae.cn"
const quota = (over = {}) => json({ code: 0, message: "success", user_model_quota: { tenant_id: "392641536", user_id: "393834752", seat_pool_currency_quota: 800, system_model_quota_granularity: "all", paygo_currency_quota: 9999999999, paygo_model_quota_list: null, custom_model_quota_list: null, seat_pool_token_quota: 5000, paygo_token_quota: 9999999999, paygo_model_token_quota_list: null, has_user_quota: true, ...over } })
const spent = (costs) => json({ code: 0, message: "success", user_usage_list: [{ tenant_id: "392641536", user_id: "393834752", entitlement_id: "443246848", model_usage_detail_list: [], in_seat_detail: { chat_usage_details: costs.map((c, i) => ({ config_name: `m-${i}`, provider: "default", config_source: 1, input_token_usage: 0, output_token_usage: 0, total_token_usage: 100, display_name: `M ${i}`, total_cost_currency: c, input_cost_currency: null, output_cost_currency: null, billing_source: null })), cue_token_usage: 0 }, seat_total_cost_currency: null, extra_total_cost_currency: null }] })
// the consumer credits page as it answers an enterprise account: a real
// allowance that real calls do not touch (measured), shown beside the pool
const page = (over = {}) => json({ is_credits_billing: true, user_entitlement_pack_list: [
  { display_desc: "老用户福利", entitlement_base_info: { quota: { credits_limit: 4000 }, end_time: 1895012095 }, usage: { credits_amount: 4.396 } },
  { display_desc: "每月登录赠送", entitlement_base_info: { quota: { credits_limit: 500 }, end_time: 1896054399 }, usage: {} },
  ...(over.extra ?? []),
] })
const creditsWindow = { name: "Credits", used: (4.396 / 4500) * 100, display: "4.4 / 4500", amount: 4.4, limit: 4500, unit: "credits", aside: true, resetsAt: new Date(1895012095 * 1000).toISOString(), runsOutAt: new Date(1895012095 * 1000).toISOString(), runsOut: 3995.6 }
// the console's own period, which the usage page reads its reset date from
const RESET = 1796054400000
const core = (over = {}) => json({ code: 0, message: "", Data: { ChatUsed: 0, ChatTotal: 500, PayAsYouGoUsed: 0, PayAsYouGoTotal: 0, ResetTime: RESET, ChatStartTime: 1793462399000, ChatEndTime: 1796054399000, PayAsYouGoStartTime: 1793462399000, PayAsYouGoEndTime: 1796054399000, TotalSeats: 163, ...over }, count: 0 })
const seatWindow = (over = {}) => ({ name: "Seat Usage", used: 47.72, display: "¥381.73 / ¥800.00", amount: 381.73, limit: 800, unit: "CNY", resetsAt: new Date(RESET).toISOString(), ...over })

async function enterpriseHooks(extra = {}) {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([215.78511296, 112.20407728, 53.74288652]))
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_core_data", () => core())
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => page())
  const hooks = await TraeCNAuthPlugin({ client: {} })
  return { hooks, auth: signedIn({ api: ENT, host: ENT, ...extra }) }
}

const CN = _internal.SITES["trae-cn"]
const GLOBAL = _internal.SITES["trae-global"]

let f
afterEach(() => f?.close())

async function start() {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const a = await hooks.auth.methods[0].authorize()
  return { a, q: new URL(a.url).searchParams, cb: new URL(new URL(a.url).searchParams.get("auth_callback_url")) }
}

async function signIn(info, extra = {}) {
  const { a, cb } = await start()
  const jwt = { Token: "jwt-1", RefreshToken: "r-1", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200, ClientID: "ono9krqynydwx5" }
  const url = new URL(cb)
  url.searchParams.set("userJwt", JSON.stringify(jwt))
  url.searchParams.set("userInfo", JSON.stringify(info))
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  await fetch(url)
  return a.callback()
}

test("the sign-in page doesn't hide the enterprise (SaaS) sign-in", async () => {
  f = fakeTrae()
  const { a, q } = await start()
  expect(q.get("hide_saas_login")).not.toBe("true")
  await fetch(new URL(q.get("auth_callback_url")) + "?error=x")
  await a.callback()
})

// Since November 2026 trae.cn's authorization page sends a signed-out
// browser to a Doubao/Feishu account sign-in with no way to an enterprise
// one (@yalifesign on X). The enterprise way starts on the realm's console's
// own authorization page, which takes the same parameters and calls back the
// same way, naming its Api host (console.enterprise.trae.cn's code, read
// 2026-11-19; not tried with a real seat).
test("the enterprise way opens the console's authorization page with the IDE's parameters", async () => {
  for (const [make, site] of [[TraeCNAuthPlugin, CN], [TraeGlobalAuthPlugin, GLOBAL]]) {
    const hooks = await make({ client: {} })
    const m = hooks.auth.methods[1]
    expect(m.type).toBe("oauth")
    expect(m.label).toBe(`${site.name} enterprise account (browser)`)
    const a = await m.authorize()
    const u = new URL(a.url)
    expect(u.origin).toBe(site.hosts.console)
    expect(u.pathname).toBe("/authorization")
    // what the console's page checks before it calls back
    for (const k of ["auth_from", "login_trace_id", "device_id", "auth_callback_url"]) expect(u.searchParams.get(k)).toBeTruthy()
    expect(["trae", "solo"]).toContain(u.searchParams.get("auth_from"))
    expect(new URL(u.searchParams.get("auth_callback_url")).hostname).toBe("127.0.0.1")
    await fetch(u.searchParams.get("auth_callback_url") + "?error=x")
    expect(await a.callback()).toEqual({ type: "failed", error: "x" })
    // the personal way is still the consumer site's
    const p = await hooks.auth.methods[0].authorize()
    expect(new URL(p.url).origin).toBe(site.hosts.web)
    await fetch(new URL(p.url).searchParams.get("auth_callback_url") + "?error=x")
    await p.callback()
  }
})

test("the console's callback signs in an enterprise seat on its console", async () => {
  f = fakeTrae()
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const a = await hooks.auth.methods[1].authorize()
  const q = new URL(a.url).searchParams
  // the console's callback: _t() in its authorization page
  const url = new URL(q.get("auth_callback_url"))
  const exp = Math.floor(Date.now() / 1000) + 7200
  for (const [k, v] of Object.entries({
    scope: "saas", host: ENT, consoleHost: ENT, coreHost: ENT, isRedirect: "true", loginTraceID: q.get("login_trace_id"),
    userJwt: JSON.stringify({ Token: "jwt-e", TokenExpireAt: exp }),
    userInfo: JSON.stringify({ UserID: "u-e", ScreenName: "Acme", TenantID: "t-1" }),
    refreshToken: "r-e", refreshExpireAt: String(exp + 86400), data: "r-e",
  })) url.searchParams.set(k, v)
  await fetch(url)
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.access).toBe("jwt-e")
  expect(got.refresh).toBe("r-e")
  expect(got.host).toBe(ENT)
  expect(_internal.isEnterprise(got, CN)).toBe(true)
  expect(CN.apiOf(got)).toBe(CN.hosts.console)
  expect(got.deviceId).toBe(q.get("device_id"))
})

test("a console callback naming no host keeps its console as the seat's host", async () => {
  f = fakeTrae()
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const a = await hooks.auth.methods[1].authorize()
  const url = new URL(new URL(a.url).searchParams.get("auth_callback_url"))
  url.searchParams.set("consoleHost", ENT)
  url.searchParams.set("userJwt", JSON.stringify({ Token: "jwt-e", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200 }))
  url.searchParams.set("refreshToken", "r-e")
  await fetch(url)
  const got = await a.callback()
  expect(got.host).toBe(ENT)
  expect(_internal.isEnterprise(got, CN)).toBe(true)
  // the consumer page's callback is not read that way
  const p = await hooks.auth.methods[0].authorize()
  const pu = new URL(new URL(p.url).searchParams.get("auth_callback_url"))
  pu.searchParams.set("consoleHost", ENT)
  pu.searchParams.set("userJwt", JSON.stringify({ Token: "jwt-p", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200 }))
  pu.searchParams.set("refreshToken", "r-p")
  await fetch(pu)
  expect(_internal.isEnterprise(await p.callback(), CN)).toBe(false)
})

test("only an https host on Trae's own domains is taken", () => {
  const t = _internal.traeHost
  expect(t("https://trae-api-cn.mchost.guru")).toBe("https://trae-api-cn.mchost.guru")
  expect(t("https://ent-acme.trae.cn/")).toBe("https://ent-acme.trae.cn")
  expect(t("https://ent.trae.ai")).toBe("https://ent.trae.ai")
  for (const bad of ["http://ent.trae.cn", "https://trae.cn.evil.com", "https://eviltrae.cn", "https://trae-api-cn.evil.com", "https://u:p@ent.trae.cn", "https://ent.trae.cn:8443", "https://ent.trae.cn/?x=1", "ent.trae.cn", "", undefined]) {
    expect(t(bad)).toBe("")
  }
})

test("a sign-in naming an enterprise Trae CN host keeps it, and requests go there", async () => {
  f = fakeTrae()
  const info = { UserID: "u-e", ScreenName: "Acme", Host: "https://ent-acme.trae.cn", TenantID: "t-1", LoginType: "saas", TenantToken: "no" }
  const got = await signIn(info)
  expect(got.type).toBe("success")
  expect(got.api).toBe("https://ent-acme.trae.cn")
  expect(got.host).toBe("https://ent-acme.trae.cn")
  // the account's kind is kept, never a field that looks like a secret
  expect(got.account).toEqual({ TenantID: "t-1", LoginType: "saas" })
  expect(CN.apiOf(got)).toBe("https://ent-acme.trae.cn")
  // a request goes to that host (nonet stops it before it leaves)
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn({ api: got.api }))
  const e = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }) }).catch((e) => e)
  expect(String(e?.message)).toContain("https://ent-acme.trae.cn/api/agent/v3/llm_utils_chat")
})

// An enterprise seat chats on the console its sign-in names, which bills
// the seat pool: #1155's (kenanor) does, and from 0.2.36 to 0.2.38 its
// chats went to the consumer gateway and spent the login's own credits.
// #1127's (shadow1606) console answers every llm_utils_chat with 4245: that
// seat is marked, kept with its sign-in, and chats on the gateway.
test("an enterprise sign-in naming the console chats there, and on the gateway once marked", async () => {
  expect(CN.apiOf({ api: ENT, host: ENT })).toBe(CN.hosts.console)
  expect(CN.apiOf({ api: "https://Console.Enterprise.Trae.CN" })).toBe(CN.hosts.console)
  expect(CN.apiOf({ api: ENT, host: ENT, consoleChat: false })).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "https://ent-acme.trae.cn" })).toBe("https://ent-acme.trae.cn")
})

// the console on its own path of the fake, so the two hosts differ
function consoleApart() {
  f = fakeTrae()
  CN.hosts.console = f.origin + "/console"
  const saved = []
  return { saved, client: { auth: { set: async ({ body }) => { saved.push(body) } } } }
}
async function chat(client, auth) {
  const hooks = await TraeCNAuthPlugin({ client })
  const opts = await hooks.auth.loader(async () => auth)
  return opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }) })
}
const ok = () => sse([["output", { response: "ok" }], ["done", {}]])
const chats = () => f.seen.filter((r) => r.path.endsWith("/api/agent/v3/llm_utils_chat")).map((r) => r.path)

test("a seat whose console takes chats chats there, and nothing is marked", async () => {
  const { saved, client } = consoleApart()
  f.route("POST /console/api/agent/v3/llm_utils_chat", ok)
  f.route("POST /api/agent/v3/llm_utils_chat", ok)
  const res = await chat(client, signedIn({ api: ENT, host: ENT }))
  expect(res.status).toBe(200)
  expect(chats()).toEqual(["/console/api/agent/v3/llm_utils_chat"])
  expect(saved).toEqual([])
})

for (const [how, refusal] of [
  ["in a 200", () => json({ code: 4245, message: "not allowed" })],
  ["as a 400", () => json({ code: 4245, message: "not allowed" }, 400)],
  ["as a stream's error", () => sse([["error", { code: 4245, message: "not allowed" }]])],
]) {
  test(`a console that turns chats away (4245 ${how}) marks the seat, and the gateway answers`, async () => {
    const { saved, client } = consoleApart()
    f.route("POST /console/api/agent/v3/llm_utils_chat", refusal)
    f.route("POST /api/agent/v3/llm_utils_chat", ok)
    const res = await chat(client, signedIn({ api: ENT, host: ENT }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("ok")
    // one ask of the console (not one a function), then the gateway
    expect(chats()).toEqual(["/console/api/agent/v3/llm_utils_chat", "/api/agent/v3/llm_utils_chat"])
    expect(saved.length).toBe(1)
    expect(saved[0].consoleChat).toBe(false)
    expect(saved[0].host).toBe(ENT)
    // the mark is read back: the next run goes to the gateway at once
    f.seen.length = 0
    const again = await chat(client, saved[0])
    expect(again.status).toBe(200)
    expect(chats()).toEqual(["/api/agent/v3/llm_utils_chat"])
  })
}

test("a 4245 from the gateway itself is an error, not a mark", async () => {
  const { saved, client } = consoleApart()
  f.route("POST /api/agent/v3/llm_utils_chat", () => json({ code: 4245, message: "not allowed" }, 400))
  const res = await chat(client, signedIn({ api: ENT, host: ENT, consoleChat: false }))
  expect(res.status).toBe(400)
  expect(await res.text()).toContain("4245")
  expect(saved).toEqual([])
})

test("a personal sign-in is as before", async () => {
  f = fakeTrae()
  const got = await signIn({ UserID: "u-1", ScreenName: "Ann", Region: "CN", Host: "https://api.trae.cn" })
  expect(got.api).toBeUndefined()
  expect(got.authHost).toBeUndefined()
  expect(got.account).toBeUndefined()
  expect(CN.apiOf(got)).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "https://trae-api-cn.mchost.guru" })).toBe("https://trae-api-cn.mchost.guru")
  for (const h of ["https://www.trae.cn", "https://api.trae.cn", "https://growcn-normal.trae.cn"]) expect(CN.modelHost(h)).toBe(false)
  // Global's personal hosts route as they did
  expect(GLOBAL.apiOf({ api: "https://api-us-east.trae.ai" })).toBe(GLOBAL.hosts.us)
  expect(GLOBAL.apiOf({ api: "https://api-sg-central.trae.ai" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.apiOf({ api: "https://growsg-normal.trae.ai" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.apiOf({ api: "https://coresg-normal.trae.ai" })).toBe("https://coresg-normal.trae.ai")
  expect(GLOBAL.apiOf({ api: "https://ent-acme.trae.ai" })).toBe("https://ent-acme.trae.ai")
})

test("a host off Trae's domains is refused, and the consumer one is used", async () => {
  f = fakeTrae()
  const got = await signIn({ UserID: "u-x", ScreenName: "X", Host: "https://trae-api-cn.evil.com" }, { authHost: "https://api.evil.com" })
  expect(got.type).toBe("success")
  expect(got.api).toBeUndefined()
  expect(got.host).toBeUndefined()
  expect(got.authHost).toBeUndefined()
  expect(CN.apiOf({ api: "https://trae-api-cn.evil.com" })).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "http://ent-acme.trae.cn" })).toBe(CN.hosts.api)
  expect(GLOBAL.apiOf({ api: "https://coresg.evil.com" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.modelHost("https://trae.ai.evil.com")).toBe(false)
})

// The usage card for an enterprise (SaaS) account: its console bills in
// yuan, so the card leads with the seat pool in yuan. The consumer page
// answers such an account too, with a credits allowance real calls have
// been measured not to touch — that row is shown beside the pool, aside, so
// the card holds both numbers without the credits reading as routable.
test("an enterprise account's usage is its console's seat pool, in yuan", async () => {
  const { hooks, auth } = await enterpriseHooks()
  const u = await hooks.auth.usage(async () => auth)
  expect(f.seen.map((r) => r.path)).toEqual([
    "/trae/gtm/tob/api/v1/config/get_personal_quota",
    "/trae/gtm/tob/api/v1/config/get_user_model_usage",
    "/trae/gtm/tob/api/v1/config/get_personal_core_data",
    "/trae/api/v2/pay/ide_user_ent_usage",
  ])
  // the console takes an empty body; the consumer page its own
  expect(f.seen.map((r) => r.json)).toEqual([{}, {}, {}, { require_usage: true, req_source: 0 }])
  expect(f.seen[0].headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(u.plan).toBe("Enterprise")
  expect(u.user).toBe("Ann")
  expect(u.signIn).toBe("kept")
  expect(u.balance).toBeUndefined() // the window carries the count
  expect(u.windows).toEqual([seatWindow(), creditsWindow])
})

test("an enterprise account that spent nothing shows the whole pool", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.windows[0].used).toBe(0)
  expect(u.windows[0].display).toBe("¥0.00 / ¥800.00")
  expect(u.windows[0].limit).toBe(800)
})

test("an unlimited seat pool says so rather than showing the console's sentinel", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota({ seat_pool_currency_quota: 9999999999 }))
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([1.5]))
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => page())
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.balance).toBe("unlimited")
  // the pool is no limit; the credits row still stands beside it
  expect(u.windows).toEqual([creditsWindow])
})

// a failed read is not a spend of zero: the pool stands, but the count is
// unknown, so the row says so rather than reading as untouched
test("an enterprise account whose spend page fails shows the pool, not a zero", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => json({ code: 0, message: "success" }, 500))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.error).toBeUndefined()
  expect(u.windows[0].used).toBeNull()
  expect(u.windows[0].amount).toBeUndefined()
  expect(u.windows[0].display).toBe("? / ¥800.00")
  expect(u.windows[0].limit).toBe(800)
})

// the credits row is the card's second row, never the count: when the
// consumer page is the one that fails, the pool stands alone
test("an enterprise account whose credits page fails still shows the pool", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([40]))
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.error).toBeUndefined()
  expect(u.signIn).toBe("kept") // a second row's 401 is not the sign-in's
  expect(u.windows.map((w) => w.name)).toEqual(["Seat Usage"])
})

test("an unlimited credits page adds no row of its own", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([40]))
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ is_credits_billing: true, user_entitlement_pack_list: [
    { entitlement_base_info: { quota: { credits_limit: -1 } }, usage: { credits_amount: 3 } },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.windows.map((w) => w.name)).toEqual(["Seat Usage"])
})

// the console's period is what the usage page's own "席位额度将于 <date>
// 重置" line reads; without it the pool stands with no date
test("a seat pool whose console names no period has no reset date", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([40]))
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_core_data", () => core({ ResetTime: 0 }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.error).toBeUndefined()
  expect(u.windows[0].name).toBe("Seat Usage")
  expect(u.windows[0].resetsAt).toBeUndefined()
})

// a console that cannot answer the period costs the card its date alone
test("an enterprise account whose period page fails still shows the pool", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([40]))
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_core_data", () => json({ code: 0, message: "" }, 500))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.error).toBeUndefined()
  expect(u.signIn).toBe("kept")
  expect(u.windows[0].resetsAt).toBeUndefined()
})

// a console that names no pool at all has said nothing to show, and the card
// says that rather than standing empty
test("a console that names no seat pool is an error, not a blank card", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota({ seat_pool_currency_quota: null }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.error).toBe("Trae CN usage: the console named no seat pool")
  expect(u.windows).toBeUndefined()
})

// #1143 (shex816): a seat pool of nothing and no credits row gave a card
// with a plan, a name and nothing else, and no word of why
for (const [how, credits, says] of [
  ["can't be read", () => json({ code: 0, message: "" }, 500), "could not be read"],
  ["shows no allowance", () => json({ is_credits_billing: true, user_entitlement_pack_list: [] }), "shows no allowance"],
]) {
  test(`a seat pool of nothing, and a credits page that ${how}, is an error naming both`, async () => {
    f = fakeTrae()
    f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota({ seat_pool_currency_quota: 0 }))
    f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([]))
    f.route("POST /trae/gtm/tob/api/v1/config/get_personal_core_data", () => core())
    f.route("POST /trae/api/v2/pay/ide_user_ent_usage", credits)
    const hooks = await TraeCNAuthPlugin({ client: {} })
    const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
    expect(u.error).toBe(`Trae CN usage: the console gives this seat a pool of ¥0, and the credits page ${says}`)
    expect(u.windows).toBeUndefined()
  })
}

test("a seat pool of nothing beside a credits page with an allowance shows the credits", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota({ seat_pool_currency_quota: 0 }))
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([]))
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_core_data", () => core())
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => page())
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.error).toBeUndefined()
  expect(u.windows).toEqual([creditsWindow])
})

// an administrator's console answers with every seat in the tenant: the card
// counts the account's own, not the tenant's
test("an administrator's card counts its own seat, not the tenant's", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => json({ code: 0, message: "success", user_usage_list: [
    { user_id: "393834752", in_seat_detail: { chat_usage_details: [{ total_cost_currency: 100 }] } },
    { user_id: "999999999", in_seat_detail: { chat_usage_details: [{ total_cost_currency: 500 }] } },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.windows[0].amount).toBe(100)
  expect(u.windows[0].display).toBe("¥100.00 / ¥800.00")
})

// the console's reset time is milliseconds, but a seconds value must not
// land the window in 1970
test("a reset time in seconds is read as seconds", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => quota())
  f.route("POST /trae/gtm/tob/api/v1/config/get_user_model_usage", () => spent([40]))
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_core_data", () => core({ ResetTime: RESET / 1000 }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.windows[0].resetsAt).toBe(new Date(RESET).toISOString())
})

test("a personal account still reads the consumer credits page", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ is_credits_billing: false, user_entitlement_pack_list: [
    { entitlement_base_info: { quota: { credits_limit: 300 } }, usage: { credits_amount: 75 } },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(f.seen.map((r) => r.path)).toEqual(["/trae/api/v2/pay/ide_user_ent_usage"])
  expect(u.plan).toBe("Free")
  expect(u.windows[0].unit).toBe("credits")
})

test("the console's own errors are Trae CN's, as the consumer page's are", async () => {
  f = fakeTrae()
  f.route("POST /trae/gtm/tob/api/v1/config/get_personal_quota", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ host: ENT }))
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("sign in again")
})

test("a token host the sign-in named is where the token is renewed", async () => {
  f = fakeTrae()
  const got = await signIn({ UserID: "u-e", ScreenName: "Acme", Host: "https://ent-acme.trae.cn" }, { authHost: "https://auth-acme.trae.cn" })
  expect(got.authHost).toBe("https://auth-acme.trae.cn")
  const hooks = await TraeCNAuthPlugin({ client: {} })
  // nonet stops the renewal before it leaves, naming where it went
  const e = await hooks.auth.refresh(signedIn({ authHost: got.authHost, refresh: "r-ent" })).catch((e) => e)
  expect(String(e?.message)).toContain("https://auth-acme.trae.cn/")
  // a token host off the site's domain is not taken
  const g = await signIn({ UserID: "u-e", ScreenName: "Acme" }, { authHost: "https://auth.trae.ai" })
  expect(g.authHost).toBeUndefined()
})

// plugins#1516 (a real Trae CN SaaS seat, 0.2.53): the console's callback
// names its host bare, "console.enterprise.trae.cn", and the sign-in was
// kept with neither api nor host, so every chat went to the consumer
// gateway (no c-* model, glm-5.4 answered 1005) and the seat pool was never
// read. The callback's fields below are that report's.
const saasJwt = (over = {}) => ["x", Buffer.from(JSON.stringify({ scope: "saas", tenant_id: "tob_online", tob_tenant_id: "t-9", type: "user", exp: Math.floor(Date.now() / 1000) + 7200, ...over })).toString("base64url"), "sig"].join(".")

test("a console callback naming its host bare signs the seat in on its console", async () => {
  f = fakeTrae()
  const hooks = await TraeCNAuthPlugin({ client: {} })
  for (const bare of [{ host: "console.enterprise.trae.cn" }, { consoleHost: "console.enterprise.trae.cn" }, {}]) {
    const a = await hooks.auth.methods[1].authorize()
    const url = new URL(new URL(a.url).searchParams.get("auth_callback_url"))
    for (const [k, v] of Object.entries(bare)) url.searchParams.set(k, v)
    url.searchParams.set("userJwt", JSON.stringify({ Token: saasJwt(), TokenExpireAt: Math.floor(Date.now() / 1000) + 7200 }))
    url.searchParams.set("userInfo", JSON.stringify({ UserID: "u-e", ScreenName: "Seat", IsSetTenant: true, IsAllowLogin: true, LastLoginType: 2 }))
    url.searchParams.set("refreshToken", "r-e")
    await fetch(url)
    const got = await a.callback()
    expect(got.type).toBe("success")
    expect(got.host).toBe(ENT)
    expect(got.api).toBe(ENT)
    expect(_internal.isEnterprise(got, CN)).toBe(true)
    expect(CN.apiOf(got)).toBe(CN.hosts.console)
  }
  // a bare host is read as https only: one off Trae's domains, or another
  // scheme, is still refused
  const { cb } = await start()
  for (const bad of ["trae-api-cn.evil.com", "http://console.enterprise.trae.cn"]) {
    const { a, cb } = await start()
    const url = new URL(cb)
    url.searchParams.set("host", bad)
    url.searchParams.set("userJwt", JSON.stringify({ Token: "jwt-p", RefreshToken: "r-p", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200 }))
    await fetch(url)
    const got = await a.callback()
    expect(got.host).toBeUndefined()
    expect(got.api).toBeUndefined()
  }
  await fetch(cb + "?error=x")
})

test("a seat kept with no host before 0.2.54 is read as its console's, a personal sign-in as before", async () => {
  // the reporter's plugin-auth.json: no api, no host, a SaaS token
  const { client } = consoleApart()
  const ent = { ...signedIn({ access: saasJwt() }), account: { IsSetTenant: true, IsAllowLogin: true, LastLoginType: 2 } }
  f.route("POST /console/api/agent/v3/llm_utils_chat", ok)
  f.route("POST /api/agent/v3/llm_utils_chat", ok)
  expect((await chat(client, ent)).status).toBe(200)
  expect(chats()).toEqual(["/console/api/agent/v3/llm_utils_chat"])
  // a personal token, or a seat that named its own host, is not moved
  f.seen.length = 0
  expect((await chat(client, signedIn({ access: saasJwt({ scope: "personal" }) }))).status).toBe(200)
  expect((await chat(client, signedIn())).status).toBe(200)
  expect(chats()).toEqual(["/api/agent/v3/llm_utils_chat", "/api/agent/v3/llm_utils_chat"])
})
