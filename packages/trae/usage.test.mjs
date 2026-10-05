// The usage card: the account's credits from its entitlement packs; and
// the model list, the account's own when Trae answers.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

test("credits are the packs' limits and what they used", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ is_credits_billing: false, user_entitlement_pack_list: [
    { entitlement_base_info: { quota: { credits_limit: 300 }, end_time: 1790000000 }, usage: { credits_amount: 75 } },
    { entitlement_base_info: { quota: {} }, usage: {} }, // a feature pack, no credits
    { entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 25 } },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(f.seen[0].json).toEqual({ require_usage: true, req_source: 0 })
  expect(f.seen[0].headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(u.plan).toBe("Free")
  expect(u.user).toBe("Ann")
  expect(u.signIn).toBe("kept")
  expect(u.balance).toBeUndefined() // the window carries the count (yetone/magpie#694)
  expect(u.windows).toEqual([{ name: "Credits", used: 25, amount: 100, limit: 400, unit: "credits", resetsAt: new Date(1790000000 * 1000).toISOString() }])
})

test("unlimited packs say so", () => {
  expect(_internal.credits({ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: -1 } }, usage: { credits_amount: 3 } }] }).unlimited).toBe(true)
})

test("a 401 reading credits marks the account", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("sign in again")
})

async function given(hooks) {
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["trae-cn"]
  return { id: "trae-cn", models: Object.fromEntries(Object.entries(p.models).map(([id, m]) => [id, { id, ...m }])) }
}

test("the config declares the known models; the live list replaces them", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", () => json({ config_info_list: [
    { config_name: "glm-5.2", display_name: "GLM-5.2", context_window_size: { max: [200000] } },
    { config_name: "DeepSeek-V4-Pro", display_name: "DeepSeek-V4-Pro" },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(p.models)).toContain("kimi-k2.6")
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["glm-5.2", "DeepSeek-V4-Pro"])
  expect(live["glm-5.2"].limit.context).toBe(200000)
  // no batch list (404 here): one function at a time
  expect(f.seen[0].path).toBe("/api/ide/v1/batch_get_detail_param")
  expect(f.seen.slice(1).map((r) => r.json.function).sort()).toEqual(["chat_v3", "solo_agent", "solo_agent_lite", "solo_work_lite"])
})

// what batch_get_detail_param answered TRAE SOLO CN, cut down: each
// function's own list; deepseek-v4.1-flash is the TRAE agent's (solo_agent),
// where it names its __dev model; chat_v3 lists it without one
const BATCH = { function_configs: [
  { function: "chat_v3", config_info_list: [
    { config_name: "glm-5.2", usage: "chat_completion", display_config: { display_name: "GLM-5.2" }, context_window_tokens: { dev: 200000, max: 1000000 }, model_detail_list: [{ model_name: "glm-5.2__dev", max_tokens: 32000 }] },
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4-Flash 正式版" } },
    { config_name: "summary", usage: "summary" },
    { config_name: "custom_model_200k", usage: "chat_completion" },
    { config_name: "kimi-k2", usage: "chat_completion", config_switch: false },
  ] },
  { function: "solo_agent", config_info_list: [
    { config_name: "glm-5.2", usage: "chat_completion", display_config: { display_name: "GLM-5.2" }, model_detail_list: [{ model_name: "glm-5.2__dev" }] },
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4.1-Flash", multimodal: true }, context_window_tokens: { dev: 200000, max: 1000000 }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__max", max_tokens: 128000 }, { model_name: "deepseek-v4.1-flash__dev", max_tokens: 64000 }] },
  ] },
  { function: "builder", config_info_list: [{ config_name: "builder-only", usage: "chat_completion" }] },
] }

test("the lists are asked in one batch, as TRAE SOLO CN asks them, and DeepSeek V4.1 Flash is the TRAE agent's (yetone/magpie#681)", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(BATCH))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => sse([["output", { response: r.json.function + " " + (r.json.model_name ?? "-") }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  // one ask, the client SOLO CN is
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
  expect(Object.keys(live)).toEqual(["glm-5.2", "deepseek-v4.1-flash"])
  const m = live["deepseek-v4.1-flash"]
  expect(m.name).toBe("DeepSeek-V4.1-Flash")
  expect(m.limit).toEqual({ context: 200000, output: 64000 })
  expect(live["glm-5.2"].limit).toEqual({ context: 200000, output: 32000 })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (model) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    return (await res.json()).choices[0].message.content
  }
  // asked through the function that serves it, with the model it names there
  expect(await ask("deepseek-v4.1-flash")).toBe("solo_agent deepseek-v4.1-flash__dev")
  expect(await ask("glm-5.2")).toBe("chat_v3 glm-5.2__dev")
})

test("max context request selects the advertised __max model and budget", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "solo_work_lite", config_info_list: [
      { config_name: "glm-5.3", usage: "chat_completion", context_window_tokens: { dev: 116000, max: 1000000 }, model_detail_list: [
        { model_name: "glm-5.3__dev", max_tokens: 16000 },
        { model_name: "glm-5.3__max", max_tokens: 64000 },
      ] },
    ] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => sse([["output", { response: r.json.model_name }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(live["glm-5.3"].reasoning).toBe(false)
  expect(live["glm-5.3"].capabilities.reasoning).toBe(false)
  expect(live["glm-5.3"].variants).toEqual({})
  expect(live["glm-5.3"].limit.context).toBe(116000)
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3", reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).choices[0].message.content).toBe("glm-5.3__max")
  const request = f.seen.find((r) => r.path === "/api/agent/v3/llm_utils_chat")
  expect(request.json.user_message_context.model_info.prompt_max_tokens).toBe(936000)
})

test("a max request falls back to __dev when the account rejects max metadata", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "solo_work_lite", config_info_list: [
      { config_name: "glm-5.3", usage: "chat_completion", context_window_tokens: { dev: 116000, max: 1000000 }, model_detail_list: [
        { model_name: "glm-5.3__dev", max_tokens: 16000 },
        { model_name: "glm-5.3__max", max_tokens: 64000 },
      ] },
    ] },
  ] }))
  let asks = 0
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    asks++
    return r.json.model_name.endsWith("__max")
      ? json({ code: 4001, message: "max context param is invalid" }, 400)
      : sse([["output", { response: r.json.model_name }], ["done", {}]])
  })
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  await hooks.provider.models(p, { auth: signedIn() })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3", trae_context_mode: "max", messages: [{ role: "user", content: "hi" }] }) })
  expect((await res.json()).choices[0].message.content).toBe("glm-5.3__dev")
  expect(asks).toBe(2)
})

test("a batch answered with no lists falls back to one function at a time", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ code: 0 }))
  f.route("POST /api/ide/v1/get_detail_param", (r) => json({ config_info_list: r.json.function === "solo_agent" ? [{ config_name: "deepseek-v4.1-flash" }] : [] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(await hooks.provider.models(p, { auth: signedIn() }))).toEqual(["deepseek-v4.1-flash"])
})

test("signed out asking the batch marks the account", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  await expect(hooks.provider.models(p, { auth: signedIn() })).rejects.toThrow("sign in again")
})

test("SOLO's and the TRAE agent's models are listed too, and asked through the function that lists them (yetone/magpie#681)", async () => {
  f = fakeTrae()
  const lists = {
    chat_v3: [{ config_name: "glm-5.2", display_name: "GLM-5.2" }],
    solo_work_lite: [{ config_name: "glm-5.2", display_name: "GLM-5.2" }, { config_name: "DeepSeek-V4-Flash-Official", display_name: "DeepSeek-V4-Flash-Official" }],
    solo_agent: [{ config_name: "glm-5.2", display_name: "GLM-5.2" }, { config_name: "deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash", context_window_size: { max: [1000000] } }],
  }
  f.route("POST /api/ide/v1/get_detail_param", (r) => json({ config_info_list: lists[r.json.function] ?? [] }))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => sse([["output", { response: r.json.function }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["glm-5.2", "DeepSeek-V4-Flash-Official", "deepseek-v4.1-flash"])
  expect(live["deepseek-v4.1-flash"].name).toBe("DeepSeek V4.1 Flash")
  expect(live["deepseek-v4.1-flash"].limit.context).toBe(1000000)
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (model) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    return (await res.json()).choices[0].message.content
  }
  expect(await ask("deepseek-v4.1-flash")).toBe("solo_agent")
  expect(await ask("DeepSeek-V4-Flash-Official")).toBe("solo_work_lite")
  expect(await ask("glm-5.2")).toBe("chat_v3")
})

test("one function's list failing leaves the other's", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", (r) => r.json.function === "chat_v3"
    ? json({ config_info_list: [{ config_name: "glm-5.2" }] })
    : new Response("down", { status: 503 }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(await hooks.provider.models(p, { auth: signedIn() }))).toEqual(["glm-5.2"])
})

test("when the list can't be read, the known models stand", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", () => new Response("down", { status: 503 }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(await hooks.provider.models(p, { auth: signedIn() })).toBe(p.models)
})

// as Trae CN answered the reporter (yetone/magpie#681): chat_v3 lists
// deepseek-v4.1-flash with its __dev model but under DeepSeek-V4-Flash-Official's
// name, and Trae's usage page books it under that name; SOLO's lists name it
// DeepSeek-V4.1-Flash
const SAME_NAME = { function_configs: [
  { function: "chat_v3", config_info_list: [
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4-Flash 正式版" }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev" }, { model_name: "deepseek-v4.1-flash__max" }] },
    { config_name: "DeepSeek-V4-Flash-Official", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4-Flash 正式版" }, model_detail_list: [{ model_name: "DeepSeek-V4-Flash-Official__dev" }] },
  ] },
  { function: "solo_work_lite", config_info_list: [
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4.1-Flash" }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev" }] },
    { config_name: "DeepSeek-V4-Flash-Official", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4-Flash 正式版" }, model_detail_list: [{ model_name: "DeepSeek-V4-Flash-Official__dev" }] },
  ] },
  { function: "solo_agent", config_info_list: [
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4.1-Flash" }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev" }] },
  ] },
] }

test("a model chat_v3 gives another's name is named and asked as SOLO lists it (yetone/magpie#681)", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(SAME_NAME))
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => sse([["output", { response: r.json.function + " " + (r.json.model_name ?? "-") }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(live["deepseek-v4.1-flash"].name).toBe("DeepSeek-V4.1-Flash")
  expect(live["DeepSeek-V4-Flash-Official"].name).toBe("DeepSeek-V4-Flash 正式版")
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (model) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    return (await res.json()).choices[0].message.content
  }
  // the first list that names it rightly, with its __dev model
  expect(await ask("deepseek-v4.1-flash")).toBe("solo_work_lite deepseek-v4.1-flash__dev")
  // named alike everywhere: kept on chat_v3, as before
  expect(await ask("DeepSeek-V4-Flash-Official")).toBe("chat_v3 DeepSeek-V4-Flash-Official__dev")
})
