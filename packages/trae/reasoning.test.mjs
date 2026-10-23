// A model's reasoning levels: Trae's list entry carries a
// reasoning_effort_config (its options, its default), and the request takes
// the same names as reasoning_effort. The plugin used to hand agents no
// levels at all and send none, which read as "Trae takes no level": a routing
// group whose members carry no level loses reasoning for the whole group.
//
// The names differ once: OpenCode knows light/high/extra_high as
// low/high/xhigh, so the map goes both ways — offered as variants, sent as
// Trae spells them.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

const { LEVELS, levelsOf, variantsOf, effortOf, chatBody } = _internal

// an entry of an account's list, with the levels it takes
const entry = (name, options, extra = {}) => ({
  config_name: name, usage: "chat_completion",
  display_config: { display_name: name },
  context_window_tokens: { dev: 1_000_000 },
  model_detail_list: [{ model_name: name + "__dev", max_tokens: 32000 }],
  ...(options === undefined ? {} : { reasoning_effort_config: { options, ...extra } }),
})

// live serves the account's list and hands back the models the
// provider.models hook built from it
async function live(configs) {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: configs },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  return hooks.provider.models({ models: {} }, { auth: signedIn() })
}

test("an entry's levels are offered as the variants agents pick, named as OpenCode names them", async () => {
  const ms = await live([entry("deepseek-v4.1-flash", ["light", "high", "extra_high"], { default_level: "high" })])
  const m = ms["deepseek-v4.1-flash"]
  expect(Object.keys(m.variants)).toEqual(["low", "high", "xhigh"])
  // the value is what OpenCode writes into the body, so it is this plugin's
  // name for the level; effortOf turns it into Trae's on the way out
  expect(m.variants.low).toEqual({ reasoningEffort: "low" })
  expect(m.variants.high).toEqual({ reasoningEffort: "high" })
  expect(m.variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
  // the model reasons, as it did before the levels came
  expect(m.capabilities.reasoning).toBe(true)
})

test("an entry with no levels carries no variants: Trae serves it at its own default", async () => {
  const ms = await live([entry("glm-5.3", undefined)])
  expect(ms["glm-5.3"].variants).toEqual({})
  expect(ms["glm-5.3"].capabilities.reasoning).toBe(true)
})

test("an entry naming levels this build can't spell carries no variants, and is not read as none", async () => {
  // null is "it names levels, none of them ours" — distinct from [] ("none")
  expect(levelsOf({ reasoning_effort_config: { options: ["ultra"] } })).toBe(null)
  expect(levelsOf({ reasoning_effort_config: { options: [] } })).toEqual([])
  expect(levelsOf({})).toEqual([])
  expect(variantsOf(null)).toEqual({})
})

test("the levels an agent picks are sent as Trae's own names, and left out when the model has none", () => {
  const levels = ["low", "high", "xhigh"]
  const req = (effort) => ({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], ...(effort ? { reasoning_effort: effort } : {}) })
  expect(chatBody(req("low"), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort).toBe("light")
  expect(chatBody(req("high"), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort).toBe("high")
  expect(chatBody(req("xhigh"), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort).toBe("extra_high")
  // a level the model doesn't take is not sent: Trae has no entry for it
  expect(chatBody(req("max"), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort).toBeUndefined()
  // no effort asked, or a model with no levels: nothing sent
  expect(chatBody(req(), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort).toBeUndefined()
  expect(chatBody(req("high"), "chat_v3", "", 0, null, "s", false, []).reasoning_effort).toBeUndefined()
  expect(chatBody(req("high"), "chat_v3", "", 0, null, "s", false, null).reasoning_effort).toBeUndefined()
})

test("the effort an agent picks reaches Trae's request, spelled as Trae names it", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [entry("deepseek-v4.1-flash", ["light", "high", "extra_high"], { default_level: "high" })] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  await opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "xhigh" }),
  })
  const sent = f.seen.find((r) => r.path === "/api/agent/v3/llm_utils_chat")
  expect(sent.json.reasoning_effort).toBe("extra_high")
})

// In OpenCode the variant's value is what reaches the body: @ai-sdk/openai-
// compatible writes it as reasoning_effort, and the plugin's fetch reads it
// back. So every variant the plugin offers has to survive that round trip, not
// just the one whose OpenCode name happens to equal Trae's.
test("every variant's own value survives the round trip to Trae's request", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [entry("deepseek-v4.1-flash", ["light", "high", "extra_high"], { default_level: "high" })] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const ms = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const variants = ms["deepseek-v4.1-flash"].variants
  const opts = await hooks.auth.loader(async () => signedIn())

  const expectSent = { low: "light", high: "high", xhigh: "extra_high" }
  for (const [name, v] of Object.entries(variants)) {
    await opts.fetch(opts.baseURL + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: v.reasoningEffort }),
    })
    const sent = f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").at(-1)
    // the level reaches Trae spelled as Trae spells it, whichever variant it was
    expect(sent.json.reasoning_effort).toBe(expectSent[name])
  }
})

// magpie's host fills in `variants: m.variants ?? was?.variants ?? {}` for
// every model of the config, so provider.models is handed `{}` for models in
// the fallback table as well as ones the list named. An empty variants says
// nothing about the model, and must not overwrite the levels its entry names.
test("a model in the fallback table keeps the levels its entry names", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [
      entry("glm-5.2", ["high", "extra_high"]),
      entry("glm-5.3", ["light", "high", "extra_high"]),
    ] },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["trae-cn"]
  // the shape the host hands over: every model carries a variants, empty where
  // the config had none
  const provider = { ...p, models: Object.fromEntries(Object.entries(p.models).map(([k, m]) => [k, { ...m, variants: m.variants ?? {} }])) }

  const ms = await hooks.provider.models(provider, { auth: signedIn() })
  // glm-5.2 is in the fallback table, so its config entry is the empty one
  expect(Object.keys(ms["glm-5.2"].variants)).toEqual(["high", "xhigh"])
  expect(Object.keys(ms["glm-5.3"].variants)).toEqual(["low", "high", "xhigh"])
})

test("a request for a model with no levels carries no reasoning_effort", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [entry("glm-5.3", undefined)] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  await opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  })
  const sent = f.seen.find((r) => r.path === "/api/agent/v3/llm_utils_chat")
  expect(sent.json.reasoning_effort).toBeUndefined()
})

test("a request for a model whose levels this build can't spell goes out with no level", async () => {
  // levelsOf says null for such an entry, and the fetch path reads that as
  // "no level" rather than crashing on it: Trae is asked for the model and
  // serves its default, as it does for one that names none
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [entry("glm-5.3", ["ultra"])] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  // the list read first, as a host reads it before it chats: the entry is
  // then known, and its levels are the unspellable null
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const opts = await hooks.auth.loader(async () => signedIn())
  const r = await opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  })
  expect(r.status).toBe(200)
  const sent = f.seen.find((x) => x.path === "/api/agent/v3/llm_utils_chat")
  expect(sent.json.reasoning_effort).toBeUndefined()
})

test("the model list is read once for a level-less model, not on every request", async () => {
  // the effort asks for levels the entry doesn't name: the first request
  // reads the list to find that out, the second is answered from it
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [entry("glm-5.3", undefined)] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = () => opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  })
  await ask()
  await ask()
  const lists = f.seen.filter((x) => x.path === "/api/ide/v1/batch_get_detail_param")
  expect(lists.length).toBe(1)
})

test("a list that fails is read once across requests, not on every request", async () => {
  // both list endpoints answer 500: the effort's read learns nothing, but that
  // attempt is remembered, so the next requests don't each wait out the batch
  // and per-function timeouts before the chat — which needs no list to answer
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => new Response("down", { status: 500 }))
  f.route("POST /api/ide/v1/get_detail_param", () => new Response("down", { status: 500 }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = () => opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  })
  for (let i = 0; i < 3; i++) await ask()
  const lists = f.seen.filter((x) => x.path === "/api/ide/v1/batch_get_detail_param")
  expect(lists.length).toBe(1)
  expect(f.seen.filter((x) => x.path === "/api/agent/v3/llm_utils_chat").length).toBe(3)
})

test("a model the list doesn't name is read for once, not on every request", async () => {
  // the account still has kimi-k2.5's id after Trae dropped it from the list:
  // the first effort reads the list, finds no entry, and that answer stands
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [entry("glm-5.3", ["light", "high"])] },
  ] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = () => opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "kimi-k2.5", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  })
  for (let i = 0; i < 3; i++) await ask()
  const lists = f.seen.filter((x) => x.path === "/api/ide/v1/batch_get_detail_param")
  expect(lists.length).toBe(1)
  const sent = f.seen.filter((x) => x.path === "/api/agent/v3/llm_utils_chat")
  expect(sent.length).toBe(3)
  // the model takes no level the list names, so none is sent
  expect(sent[0].json.reasoning_effort).toBeUndefined()
})

test("two parallel requests for a Max ride one list read and are both sent under its base name", async () => {
  // agents send parallel requests at a session's start (a title request beside
  // the first turn, subagents). The second used to skip the first one's read —
  // the stamp said "tried" — so `named` stayed empty and the request went out
  // under the agent's own `-max` id, which Trae's list does not name.
  const max = { config_name: "deepseek-v4.1-flash", usage: "chat_completion",
    display_config: { display_name: "DeepSeek V4.1 Flash" },
    context_window_tokens: { dev: 200000, max: 1_000_000 },
    reasoning_effort_config: { options: ["light", "high"], default_level: "high" },
    model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev", max_tokens: 32000 },
      { model_name: "deepseek-v4.1-flash__max", max_tokens: 64000 }] }
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", async () => {
    await new Promise((r) => setTimeout(r, 100))
    return json({ function_configs: [{ function: "chat_v3", config_info_list: [max] }] })
  })
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = () => opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash-max", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" }),
  })
  await Promise.all([ask(), ask()])
  // one read served both, and neither went out under the unlisted -max id
  expect(f.seen.filter((x) => x.path === "/api/ide/v1/batch_get_detail_param").length).toBe(1)
  const sent = f.seen.filter((x) => x.path === "/api/agent/v3/llm_utils_chat")
  expect(sent.length).toBe(2)
  for (const s of sent) {
    expect(s.json.config_name).toBe("deepseek-v4.1-flash")
    expect(s.json.reasoning_effort).toBe("light")
  }
})

test("a host refresh and a request that wants levels share one list read", async () => {
  // the host refreshing the catalog and a request asking for levels both want
  // the list. They must ride one read: two reads would race, and the request
  // could read the maps before the refresh's own read filled them.
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", async () => {
    await new Promise((r) => setTimeout(r, 100))
    return json({ function_configs: [
      { function: "chat_v3", config_info_list: [entry("glm-5.3", ["light", "high"])] },
    ] })
  })
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { content: "ok" }], ["finish", { finish_reason: "stop" }]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const provider = cfg.provider["trae-cn"]
  const opts = await hooks.auth.loader(async () => signedIn())
  // a model the list doesn't name, so the request goes through the effort read
  const chat = opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "not-listed-xyz", stream: true, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  })
  const listing = hooks.provider.models(provider, { auth: signedIn() })
  const [, ms] = await Promise.all([chat, listing])
  expect(f.seen.filter((x) => x.path === "/api/ide/v1/batch_get_detail_param").length).toBe(1)
  // and the refresh still got the list it was asking for
  expect(Object.keys(ms).sort()).toEqual(["glm-5.3"])
})

test("the level of a model's Max is its base model's", async () => {
  const max = { config_name: "deepseek-v4.1-flash", usage: "chat_completion",
    display_config: { display_name: "DeepSeek V4.1 Flash" },
    context_window_tokens: { dev: 200000, max: 1_000_000 },
    reasoning_effort_config: { options: ["light", "high"], default_level: "high" },
    model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev", max_tokens: 32000 },
      { model_name: "deepseek-v4.1-flash__max", max_tokens: 64000 }] }
  const ms = await live([max])
  expect(Object.keys(ms["deepseek-v4.1-flash-max"].variants)).toEqual(["low", "high"])
  expect(effortOf(LEVELS && ["low", "high"], "low")).toBe("light")
})

test("of two entries a model has, the one naming levels is kept, so its levels are offered", async () => {
  // Trae answers one model under several functions' lists, and they needn't
  // agree about its levels: the entry the plugin keeps is the one the request
  // is asked through, and so the one whose reasoning_effort_config the request
  // is held to. Keeping the level-less entry left the model with none to pick.
  f = fakeTrae()
  const shared = { config_name: "glm-5.3", usage: "chat_completion",
    display_config: { display_name: "GLM-5.3" }, context_window_tokens: { dev: 200000 },
    model_detail_list: [{ model_name: "glm-5.3__dev", max_tokens: 32000 }] }
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [shared] },
    { function: "solo_work_lite", config_info_list: [{ ...shared, reasoning_effort_config: { options: ["light", "high", "extra_high"], default_level: "high" } }] },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const ms = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  expect(Object.keys(ms["glm-5.3"].variants)).toEqual(["low", "high", "xhigh"])
})

test("a name the lists agree on still outranks an entry's levels", async () => {
  // the levels only break a tie: the entry Trae's own client asks through —
  // the name its lists agree on, with a __dev model — is kept even when
  // another entry names levels
  f = fakeTrae()
  const named = { config_name: "glm-5.3", usage: "chat_completion",
    display_config: { display_name: "GLM-5.3" }, model_detail_list: [{ model_name: "glm-5.3__dev", max_tokens: 32000 }] }
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [
    { function: "chat_v3", config_info_list: [named] },
    { function: "solo_work_lite", config_info_list: [named] },
    // a third entry, misnamed and without a __dev model, that does name levels
    { function: "solo_agent", config_info_list: [{ ...named, display_config: { display_name: "GLM-5.3 正式版" }, model_detail_list: [], reasoning_effort_config: { options: ["light", "high"] } }] },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const ms = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  expect(Object.keys(ms["glm-5.3"].variants)).toEqual([])
  expect(ms["glm-5.3"].name).toBe("GLM-5.3")
})
