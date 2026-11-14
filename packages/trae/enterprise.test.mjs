// An enterprise (SaaS) subscription signs in on the same authorization
// page as a personal one, when the page is not told to hide that sign-in
// (@shad70w0 on X). A host the sign-in names on Trae's own domains is kept
// and used; one anywhere else is not, and a personal sign-in is as before.
// Not tried with a real enterprise account: the hosts below are made up.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

// the console's own answer, as a real enterprise account's is: the seat
// pool in yuan, and each model's cost
const ENT = "https://console.enterprise.trae.cn"
const quota = (over = {}) => json({ code: 0, message: "success", user_model_quota: { tenant_id: "392641536", user_id: "393834752", seat_pool_currency_quota: 800, system_model_quota_granularity: "all", paygo_currency_quota: 9999999999, paygo_model_quota_list: null, custom_model_quota_list: null, seat_pool_token_quota: 5000, paygo_token_quota: 9999999999, paygo_model_token_quota_list: null, has_user_quota: true, ...over } })
const spent = (costs) => json({ code: 0, message: "success", user_usage_list: [{ tenant_id: "392641536", user_id: "393834752", entitlement_id: "443246848", model_usage_detail_list: [], in_seat_detail: { chat_usage_details: costs.map((c, i) => ({ config_name: `m-${i}`, provider: "default", config_source: 1, input_token_usage: 0, output_token_usage: 0, total_token_usage: 100, display_name: `M ${i}`, total_cost_currency: c, input_cost_currency: null, output_cost_currency: null, billing_source: null })), cue_token_usage: 0 }, seat_total_cost_currency: null, extra_total_cost_currency: null }] })
// the consumer credits page as it answers an enterprise account: a real
// allowance that real calls do not touch (measured), shown beside the pool
const page = (over = {}) => json({ is_credits_billing: true, user_entitlement_pack_list: [
  { display_desc: "老用户福利", entitlement_base_info: { quota: { credits_limit: 4000 }, end_time: 1795012095 }, usage: { credits_amount: 4.396 } },
  { display_desc: "每月登录赠送", entitlement_base_info: { quota: { credits_limit: 500 }, end_time: 1796054399 }, usage: {} },
  ...(over.extra ?? []),
] })
const creditsWindow = { name: "Credits", used: (4.396 / 4500) * 100, display: "4.4 / 4500", amount: 4.4, limit: 4500, unit: "credits", aside: true, resetsAt: new Date(1795012095 * 1000).toISOString() }
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

// #1127 (shadow1606, a real Trae CN enterprise seat): the console the
// sign-in names answers every llm_utils_chat with 4245, and its list names
// the tenant's configs, which the consumer gateway refuses. Its models and
// chats go to the gateway, which takes the same login; usage stays on the
// console.
test("an enterprise sign-in naming the console itself chats on the consumer gateway", async () => {
  expect(CN.apiOf({ api: ENT, host: ENT })).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "https://Console.Enterprise.Trae.CN" })).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "https://ent-acme.trae.cn" })).toBe("https://ent-acme.trae.cn")
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
