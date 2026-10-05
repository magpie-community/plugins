// The usage card: the account's credits from its entitlement packs; and
// the model list, the account's own when Trae answers.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

test("credits are the packs' limits and what they used", async () => {
  f = fakeTrae()
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

test("bonus usage adds to the allowance, a US account asks its own pay host", async () => {
  f = fakeTrae()
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

test("a 401 reading usage marks the account", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v1/pay/user_current_entitlement_list", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("sign in again")
})

async function given(hooks) {
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["trae-global"]
  return { id: "trae-global", models: Object.fromEntries(Object.entries(p.models).map(([id, m]) => [id, { id, ...m }])) }
}

test("the config declares the known models; the live list replaces them", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", () => json({ config_info_list: [
    { config_name: "gpt-5.4", display_name: "GPT-5.4", context_window_size: { max: [400000] } },
    { config_name: "gemini-3-flash", display_name: "Gemini 3 Flash" },
  ] }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(p.models)).toContain("gpt-5.4")
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["gpt-5.4", "gemini-3-flash"])
  expect(live["gpt-5.4"].limit.context).toBe(400000)
  // no batch list (404 here): one function at a time
  expect(f.seen[0].path).toBe("/api/ide/v1/batch_get_detail_param")
  expect(f.seen.slice(1).map((r) => r.json.function).sort()).toEqual(["chat_v3", "solo_agent", "solo_agent_lite", "solo_work_lite"])
})

// what batch_get_detail_param answered TRAE SOLO, cut down: each function's
// own list; gpt-5.4 is the TRAE agent's (solo_agent), where it names its
// __dev model and its __max one; chat_v3 lists gemini-3-flash without one
const BATCH = { function_configs: [
  { function: "chat_v3", config_info_list: [
    { config_name: "gemini-3-flash", usage: "chat_completion", display_config: { display_name: "Gemini 3 Flash" }, context_window_tokens: { dev: 200000 }, model_detail_list: [{ model_name: "gemini-3-flash__dev", max_tokens: 32000 }] },
    { config_name: "summary", usage: "summary" },
    { config_name: "custom_model_200k", usage: "chat_completion" },
  ] },
  { function: "solo_agent", config_info_list: [
    { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4" }, context_window_tokens: { dev: 272000, max: 400000 }, model_detail_list: [{ model_name: "gpt-5.4__max", max_tokens: 128000 }, { model_name: "gpt-5.4__dev", max_tokens: 32000 }] },
  ] },
  { function: "builder", config_info_list: [{ config_name: "builder-only", usage: "chat_completion" }] },
] }

test("the lists are asked in one batch, as TRAE SOLO asks them, and gpt-5.4's Max is a model of its own", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(BATCH))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => sse([["output", { response: r.json.function + " " + (r.json.model_name ?? "-") }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  // one ask, the client SOLO is
  expect(f.seen.map((r) => r.path)).toEqual(["/api/ide/v1/batch_get_detail_param"])
  const r = f.seen[0]
  expect(r.json).toEqual({
    functions: ["chat_v3", "solo_work_lite", "solo_agent", "solo_agent_lite"], agent_type: "", current_config_info: { config_name: "", is_custom_model: false },
    mode_type: 0, access_type: 0, ab_force_vids: "", ab_autotest_advanced_mode: 0, show_custom_model: true,
  })
  expect(r.headers.get("x-ide-version")).toBe("0.1.69")
  expect(r.headers.get("x-ide-version-code")).toBe("20260917")
  expect(r.headers.get("x-app-version-code")).toBe("20260917")
  // the IDE's helpers, custom-model slots, configs switched off and other functions' models aren't models to pick
  // and gpt-5.4's Max a model of its own (gemini-3-flash names no __max model)
  expect(Object.keys(live)).toEqual(["gemini-3-flash", "gpt-5.4", "gpt-5.4-max"])
  expect(live["gpt-5.4-max"].limit).toEqual({ context: 400000, output: 128000 })
  const m = live["gpt-5.4"]
  expect(m.name).toBe("GPT-5.4")
  expect(m.limit).toEqual({ context: 272000, output: 32000 })
  expect(live["gemini-3-flash"].limit).toEqual({ context: 200000, output: 32000 })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (model) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    return (await res.json()).choices[0].message.content
  }
  // asked through the function that serves it, with the model it names there
  expect(await ask("gpt-5.4")).toBe("solo_agent gpt-5.4__dev")
  expect(await ask("gemini-3-flash")).toBe("chat_v3 gemini-3-flash__dev")
})

// the account's plan locks models the IDE greys out (a lock in its own
// picker, a 1005 on a call): the display's access data names the identities
// that may, 0 the Free one. The picker's invisible entries (paygo/auto
// twins, the search agents) aren't entries to pick at all.
const PLAN = { function_configs: [
  { function: "chat_v3", config_info_list: [
    { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4" }, display_contact_config: JSON.stringify({ access: { data: { identity_list: [0, 5, 4, 1, 2, 3] } } }), model_detail_list: [{ model_name: "gpt-5.4__dev", max_tokens: 32000 }] },
    { config_name: "gpt-5.5", usage: "chat_completion", display_config: { display_name: "GPT-5.5" }, display_contact_config: JSON.stringify({ access: { data: { identity_list: [5, 4, 1, 2, 3] } } }), model_detail_list: [{ model_name: "gpt-5.5__dev", max_tokens: 32000 }] },
    { config_name: "glm-5.2", usage: "chat_completion", display_config: { display_name: "GLM-5.2" }, model_detail_list: [{ model_name: "glm-5.2__dev", max_tokens: 32000 }] },
    { config_name: "gemini-3.1-pro-paygo", usage: "chat_completion", display_config: { display_name: "Gemini 3.1 Pro" }, is_invisible_to_user: true, model_detail_list: [{ model_name: "gemini-3.1-pro-paygo__dev", max_tokens: 32000 }] },
    { config_name: "search_agent", usage: "chat_completion", display_config: { display_name: "Search" }, is_invisible_to_user: true, model_detail_list: [{ model_name: "search_agent__dev" }] },
  ] },
] }

test("the plan's locked models are listed too — the account keeps what it pays for — while the picker's invisible ones are not", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(PLAN))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  // gpt-5.4's identities hold the 0 (Free); gpt-5.5's don't, so the IDE
  // greys it out on Free — but the plugin can't read the account's own
  // identity, so it lists it: a paying account (identity 1–5) keeps the
  // models it pays for, and a locked one answers Trae's own 1005 when
  // asked. glm-5.2 says nothing (nothing guessed); the invisible twins
  // (paygo/auto routing, search agents) are the picker's, not the list's
  expect(Object.keys(live)).toEqual(["gpt-5.4", "gpt-5.5", "glm-5.2"])
})

test("a paying account keeps every model its plan has, the locked ones included", async () => {
  // a Pro / paid account (identity 1–5): the models Free can't pick are the
  // ones it pays for — gpt-5.5, the gpt-5.6 family, gpt-6, glm-5.2 — and
  // they must survive the listing, whichever identity the account is
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(PLAN))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  const paid = await hooks.provider.models(p, { auth: signedIn({ accountId: "Pro", uid: "u-pro" }) })
  expect(Object.keys(paid)).toEqual(["gpt-5.4", "gpt-5.5", "glm-5.2"])
  // and the paid model is asked as itself, not refused before it goes out
  const opts = await hooks.auth.loader(async () => signedIn({ accountId: "Pro", uid: "u-pro" }))
  await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] }) })
  expect(f.seen.at(-1).json.config_name).toBe("gpt-5.5")
})

test("a 200 carrying an error code says Trae's own message, not \"no entitlement pack\"", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v1/pay/user_current_entitlement_list", () => json({ code: 4008, message: "quota exceeded" }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(u.error).toBe("Trae Global usage: quota exceeded")
  expect(u.signIn).toBe("kept")
  expect(u.user).toBe("Ann")
})

test("a batch answered with no lists falls back to one function at a time", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ code: 0 }))
  f.route("POST /api/ide/v1/get_detail_param", (r) => json({ config_info_list: r.json.function === "solo_agent" ? [{ config_name: "gpt-5.4" }] : [] }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(await hooks.provider.models(p, { auth: signedIn() }))).toEqual(["gpt-5.4"])
})

test("signed out asking the batch marks the account", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  await expect(hooks.provider.models(p, { auth: signedIn() })).rejects.toThrow("sign in again")
})

test("one function's list failing leaves the other's", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", (r) => r.json.function === "chat_v3"
    ? json({ config_info_list: [{ config_name: "gemini-3-flash" }] })
    : new Response("down", { status: 503 }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(await hooks.provider.models(p, { auth: signedIn() }))).toEqual(["gemini-3-flash"])
})

test("when the list can't be read, the known models stand", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", () => new Response("down", { status: 503 }))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(await hooks.provider.models(p, { auth: signedIn() })).toBe(p.models)
})

// ARNO on magpie's Discord: a reply limit Trae never gives is none (0), and
// magpie then tells agents models.dev's. One Trae gives is kept, and a
// request asking more than it is held to it.
test("a reply limit is Trae's own or none, and a request is held to Trae's", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [
      { config_name: "gpt-5.4", usage: "chat_completion", model_detail_list: [{ model_name: "gpt-5.4__dev", max_tokens: 32000 }] },
      { config_name: "gemini-3-flash", usage: "chat_completion", context_window_tokens: { dev: 200000 }, model_detail_list: [{ model_name: "gemini-3-flash__dev" }] },
      { config_name: "minimax-m2", usage: "chat_completion" },
    ] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => sse([["output", { response: String(r.json.max_tokens) }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(p.models["minimax-m2"].limit.output).toBe(0)
  expect(p.models["deepseek-v3.2"].limit.output).toBe(0)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(live["gpt-5.4"].limit.output).toBe(32000)
  expect(live["gemini-3-flash"].limit).toEqual({ context: 200000, output: 0 })
  expect(live["minimax-m2"].limit.output).toBe(0)
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (model, max_tokens) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, max_tokens, messages: [{ role: "user", content: "hi" }] }) })
    return (await res.json()).choices[0].message.content
  }
  expect(await ask("gpt-5.4", 131072)).toBe("32000")
  expect(await ask("gpt-5.4", 8000)).toBe("8000")
  expect(await ask("gemini-3-flash", 384000)).toBe("384000")
})
