// Trae Global (trae-global) against a local stand-in for its hosts: the
// international deployment's own authorization page, auth host, model hosts
// (SG and the US one) and its usage page. The shared machinery — the SSE
// events, tool calls, the model list — is covered by the files the two
// realms share; what is here is what only the international realm does:
// the dollar billing's entitlements, the US/SG routing, its own error
// codes, and its own model names. Every host a call goes to is asserted,
// so a call meant for trae.ai can't end up on a trae.cn host.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

const GLOBAL = _internal.SITES["trae-global"]

test("the realm's table is its own: hosts, client and versions differ from CN's", () => {
  const cn = _internal.SITES["trae-cn"]
  expect(GLOBAL.id).toBe("trae-global")
  expect(GLOBAL.hosts.web).toBe("https://www.trae.ai")
  expect(GLOBAL.hosts.auth).toBe("https://growsg-normal.trae.ai")
  expect(GLOBAL.hosts.api).toBe("https://coresg-normal.trae.ai")
  expect(GLOBAL.hosts.us).toBe("https://coreva-normal.trae.ai")
  expect(GLOBAL.hosts.pay).toBe("https://api-sg-central.trae.ai")
  expect(GLOBAL.hosts.usPay).toBe("https://api-us-east.trae.ai")
  // no trae.cn host is reachable from this realm's table
  expect(Object.values(GLOBAL.hosts).some((h) => /trae\.cn|mchost\.guru/.test(h))).toBe(false)
  expect(cn.hosts.web).toBe("https://www.trae.cn")
  expect(cn.hosts.api).toBe("https://trae-api-cn.mchost.guru")
})

test("the model host is the account's region: SG by default, US for a US account", () => {
  expect(GLOBAL.apiOf({ region: "SG" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.apiOf({ region: "" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.apiOf({ region: "US-East" })).toBe(GLOBAL.hosts.us)
  expect(GLOBAL.apiOf({ region: "US" })).toBe(GLOBAL.hosts.us)
  // a sign-in that named a US auth host routes there even without a region
  expect(GLOBAL.apiOf({ api: "https://api-us-east.trae.ai" })).toBe(GLOBAL.hosts.us)
  // and a chat host the sign-in named is taken as it is
  expect(GLOBAL.apiOf({ api: "https://coresg-normal.trae.ai" })).toBe("https://coresg-normal.trae.ai")
})

test("the international realm's own error codes: 20101 is a lapsed sign-in, 4011 a quota", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["error", { code: 20101, message: "token not matched" }]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  let res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["error", { code: 4011, message: "rate limited" }]]))
  res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(429)
})

test("the errors carry the realm's name, not CN's", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["error", { code: 4008, message: "quota exceeded" }]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).error.message).toBe("Trae Global: quota exceeded")
})

test("the usage page is the dollar billing's, and the allowance rides the window", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /trae/api/v1/pay/user_current_entitlement_list", () => json({
    billing_version: 3, is_dollar_usage_billing: true,
    user_entitlement_pack_list: [{
      display_desc: "Free plan",
      entitlement_base_info: {
        charge_amount: 0, currency: 0, end_time: 1793491199, ent_status: 0, start_time: 1790812800, user_id: "u-1",
        quota: { basic_usage_limit: 1, bonus_usage_limit: 0, credits_limit: 0, auto_completion_limit: 5000, advanced_model_request_limit: 1000, premium_model_fast_request_limit: 10, premium_model_slow_request_limit: 50 },
      },
      usage: { basic_usage_amount: 0.01692, bonus_usage_amount: 0, credits_amount: 0 },
    }],
  }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(f.seen[0].path).toBe("/trae/api/v1/pay/user_current_entitlement_list")
  expect(f.seen[0].headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(u.plan).toBe("Free plan")
  expect(u.user).toBe("Ann")
  expect(u.signIn).toBe("kept")
  // the dollar allowance rides the window: $0.01692 of $1 used
  expect(u.windows).toEqual([{ name: "Dollar Usage", used: 1.69, amount: 0.02, limit: 1, unit: "usd", resetsAt: new Date(1793491199 * 1000).toISOString() }])
})

test("a US account asks its own pay host, and bonus usage adds to the allowance", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /trae/api/v1/pay/user_current_entitlement_list", () => json({
    user_entitlement_pack_list: [{
      display_desc: "Pro plan",
      entitlement_base_info: { end_time: 1793491199, quota: { basic_usage_limit: 20, bonus_usage_limit: 5 } },
      usage: { basic_usage_amount: 4.5, bonus_usage_amount: 1.5 },
    }],
  }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn({ region: "US-East", api: "https://api-us-east.trae.ai" }))
  expect(u.windows).toEqual([{ name: "Dollar Usage", used: 24, amount: 6, limit: 25, unit: "usd", resetsAt: new Date(1793491199 * 1000).toISOString() }])
})

test("a 200 carrying an error code says Trae's own message, not \"no entitlement pack\"", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /trae/api/v1/pay/user_current_entitlement_list", () => json({ code: 4008, message: "quota exceeded" }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(u.error).toBe("Trae Global usage: quota exceeded")
  expect(u.signIn).toBe("kept")
})

test("a 401 reading usage marks the account", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /trae/api/v1/pay/user_current_entitlement_list", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("sign in again")
})

test("the international model names are the realm's own fallback list", () => {
  expect(Object.keys(GLOBAL.models)).toEqual(["gpt-5.4", "gemini-3-flash", "kimi-k2.5", "minimax-m2", "deepseek-v3.2"])
  expect(GLOBAL.models["gemini-3-flash"].limit.context).toBe(1_000_000)
  // the CN list is untouched by it
  expect(Object.keys(_internal.MODELS)).toContain("glm-5.2")
  expect(Object.keys(_internal.MODELS)).not.toContain("gpt-5.4")
})

test("the config declares the realm's own provider, at its own host", async () => {
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  expect(Object.keys(cfg.provider)).toEqual(["trae-global"])
  expect(cfg.provider["trae-global"].api).toBe(GLOBAL.hosts.api + "/v1")
  expect(cfg.provider["trae-global"].name).toBe("Trae Global")
})

test("a model the plan locks is still listed: the account keeps what it pays for", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [
      { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4" }, display_contact_config: JSON.stringify({ access: { data: { identity_list: [0, 5, 4, 1, 2, 3] } } }), model_detail_list: [{ model_name: "gpt-5.4__dev", max_tokens: 32000 }] },
      { config_name: "gpt-5.5", usage: "chat_completion", display_config: { display_name: "GPT-5.5" }, display_contact_config: JSON.stringify({ access: { data: { identity_list: [5, 4, 1, 2, 3] } } }), model_detail_list: [{ model_name: "gpt-5.5__dev", max_tokens: 32000 }] },
      { config_name: "gemini-3.1-pro-paygo", usage: "chat_completion", display_config: { display_name: "Gemini 3.1 Pro" }, is_invisible_to_user: true, model_detail_list: [{ model_name: "gemini-3.1-pro-paygo__dev" }] },
    ] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = { models: { ...GLOBAL.models } }
  const live = await hooks.provider.models(p, { auth: signedIn() })
  // gpt-5.5's identities don't hold the 0 (Free), so the IDE greys it out on
  // Free — but the plugin is not told the account's own identity, so it lists
  // it: a paying account keeps the models it pays for. The invisible paygo
  // twin stays out.
  expect(Object.keys(live)).toEqual(["gpt-5.4", "gpt-5.5"])
  const opts = await hooks.auth.loader(async () => signedIn())
  await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] }) })
  expect(f.seen.at(-1).json.config_name).toBe("gpt-5.5")
})

test("Trae CN's lists are served whole: only Global hides is_invisible_to_user", async () => {
  f = fakeTrae("trae-cn")
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [
      { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4" }, model_detail_list: [{ model_name: "gpt-5.4__dev", max_tokens: 32000 }] },
      { config_name: "gemini-3.1-pro-paygo", usage: "chat_completion", display_config: { display_name: "Gemini 3.1 Pro" }, is_invisible_to_user: true, model_detail_list: [{ model_name: "gemini-3.1-pro-paygo__dev" }] },
    ] },
  ] }))
  const { TraeCNAuthPlugin } = await import("./index.mjs")
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const live = await hooks.provider.models({ models: { ..._internal.SITES["trae-cn"].models } }, { auth: signedIn() })
  expect(Object.keys(live)).toContain("gemini-3.1-pro-paygo")
})

test("a US account's request goes to the US chat host, and its sign-in keeps the region", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "us" }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn({ region: "US-East" }))
  expect(opts.baseURL).toBe(f.origin + "/v1") // the US host, which the fake stands in for
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).choices[0].message.content).toBe("us")
})

test("a US callback keeps the region, and its saved auth routes to the US chat host", async () => {
  f = fakeTrae("trae-global")
  const hooks0 = await TraeGlobalAuthPlugin({ client: {} })
  const [method] = hooks0.auth.methods
  const a = await method.authorize()
  const u = new URL(a.url)
  const cb = new URL(u.searchParams.get("auth_callback_url"))
  const jwt = { Token: "jwt-us", RefreshToken: "r-us", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200, ClientID: "ono9krqynydwx5" }
  // a real US account's Host is api-us-east.trae.ai, an auth host; the
  // region is what says where it chats
  const info = { UserID: "u-us", ScreenName: "Bo", AIRegion: "US-East", Host: "https://api-us-east.trae.ai" }
  const url = new URL(cb)
  url.searchParams.set("userJwt", JSON.stringify(jwt))
  url.searchParams.set("userInfo", JSON.stringify(info))
  await fetch(url)
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.region).toBe("US-East")
  expect(got.api).toBe("https://api-us-east.trae.ai")
  // as magpie saves the sign-in: the fields but its type
  const { type, ...saved } = got
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => ({ ...saved, type: "oauth" }))
  expect(opts.baseURL).toBe(f.origin + "/v1") // the US host, which the fake stands in for
})

test("a function that doesn't take the model leaves its read behind with it", async () => {
  // chat_v3 answers "unknown model" and would keep the stream open: the
  // plugin moves to solo_work_lite, and chat_v3's read must close with it
  let cancelled = false
  f = fakeTrae("trae-global")
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    if (r.json.function !== "chat_v3") return sse([["output", { response: "solo" }], ["done", {}]])
    let n = 0
    const body = new ReadableStream({
      async pull(ctl) {
        if (n++ === 0) return ctl.enqueue(new TextEncoder().encode('event: error\ndata: {"code":4023,"message":"model is unknown"}\n\n'))
        await new Promise((r) => setTimeout(r, 10_000)) // the stream would stay open
      },
      cancel() { cancelled = true },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  })
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-3.1-pro", messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).choices[0].message.content).toBe("solo")
  await new Promise((r) => setTimeout(r, 50))
  expect(cancelled).toBe(true)
})

test("an answer the agent walks away from lets Trae's connection go", async () => {
  let cancelled = false
  f = fakeTrae("trae-global")
  f.route("POST /api/agent/v3/llm_utils_chat", () => {
    let n = 0
    const body = new ReadableStream({
      async pull(ctl) {
        if (n++ === 0) return ctl.enqueue(new TextEncoder().encode('event: output\ndata: {"response":"working on it"}\n\n'))
        await new Promise((r) => setTimeout(r, 10_000)) // nothing more comes
      },
      cancel() { cancelled = true },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  })
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }) })
  const reader = res.body.getReader()
  await reader.read() // the opening role chunk
  await reader.read() // "working on it"
  await reader.cancel() // the agent goes away, as making a tool call does
  await new Promise((r) => setTimeout(r, 100))
  expect(cancelled).toBe(true)
})
