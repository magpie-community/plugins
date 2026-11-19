// An enterprise's own built-in models (Trae CN's client: config_source 2,
// "Enterprise-builtin" in its picker). They are not Trae's presets, so their
// entries say is_custom_model, and the list dropped them with the personal
// custom models a seat's IDE alone holds the key for. A seat that typed one
// in by hand got a bare 502 with nothing saying what was asked.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

// an enterprise built-in as the detail lists are expected to carry it: the
// fields Trae CN 3.4.20's client reads of one (not yet seen from a real seat)
const ent = { config_name: "custom_model_acme_qwen", usage: "chat_completion", config_source: 2, is_preset: false,
  is_custom_model: true, display_config: { display_name: "Acme Qwen", is_custom_model: true },
  custom_model_id: "cm-42", provider: "volcengine", status: true }
// a personal custom model: its provider key is in the user's IDE only
const own = { config_name: "custom_model_mine", usage: "chat_completion", config_source: 3, is_preset: false,
  is_custom_model: true, display_config: { display_name: "My GPT", is_custom_model: true }, custom_model_id: "cm-7" }
const preset = { config_name: "glm-5", usage: "chat_completion", config_source: 1, is_preset: true, display_config: { display_name: "GLM-5" } }

async function plugin(configs) {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: configs }] }))
  return TraeCNAuthPlugin({ client: {} })
}

test("an enterprise built-in model is listed; a personal custom one and a disabled one are not", async () => {
  const hooks = await plugin([preset, ent, own, { ...ent, config_name: "custom_model_off", status: false }])
  const ms = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  expect(Object.keys(ms).sort()).toEqual(["custom_model_acme_qwen", "glm-5"])
  expect(ms.custom_model_acme_qwen.name).toBe("Acme Qwen")
})

test("chatModel keeps config_source 2 only", () => {
  expect(_internal.chatModel(ent)).toBe(true)
  expect(_internal.chatModel(own)).toBe(false)
  expect(_internal.chatModel({ ...ent, config_source: 3 })).toBe(false)
  expect(_internal.chatModel({ ...ent, usage: "summary" })).toBe(false)
  expect(_internal.chatModel(preset)).toBe(true)
})

// the reporter's own model and error (#1258, 0.2.41, console.enterprise.trae.cn):
// the enterprise config asked without its config_source got 4001 on every function
const REPORTED = "We're sorry, the param is invalid. Please try with a valid param."
const theirs = { ...ent, config_name: "AI/deekseek-v4.1-flash", display_config: { display_name: "deekseek-v4.1-flash", is_custom_model: true } }

test("a chat with an enterprise model says its config_source at the top, as Trae's own llm_utils_chat does; a preset's doesn't", async () => {
  const hooks = await plugin([preset, theirs])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  // Trae as the reporter met it: an enterprise config asked as if it were
  // one of Trae's presets is "the param is invalid"
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => (r.json.config_name === theirs.config_name && r.json.config_source !== 2
    ? sse([["error", { code: 4001, message: REPORTED }]])
    : sse([["output", { response: "ok" }], ["done", {}]])))
  const opts = await hooks.auth.loader(async () => signedIn())
  for (const model of ["AI/deekseek-v4.1-flash", "glm-5"]) {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe("ok")
  }
  const chats = f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat")
  expect(chats.length).toBe(2)
  expect(chats[0].json).toMatchObject({ config_name: "AI/deekseek-v4.1-flash", model: "AI/deekseek-v4.1-flash", config_source: 2, is_custom_model: true, provider: "volcengine" })
  expect(chats[0].json.user_message_context).toBeUndefined()
  for (const k of ["config_source", "is_custom_model", "provider", "user_message_context"]) expect(chats[1].json[k]).toBeUndefined()
})

test("an enterprise entry with no provider sends none", async () => {
  const { provider, ...bare } = theirs
  const body = _internal.chatBody({ model: bare.config_name, messages: [{ role: "user", content: "hi" }] }, "chat_v3", "", 0, null, "s", false, null, bare)
  expect(body.config_source).toBe(2)
  expect(body.is_custom_model).toBe(true)
  expect("provider" in body).toBe(false)
})

test("a refused chat names the model, the functions tried and the host", async () => {
  const hooks = await plugin([preset, ent])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  f.route("POST /api/agent/v3/llm_utils_chat", () => json({ code: 5000, message: "model not found" }))
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = (model) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })

  let res = await ask("custom_model_acme_qwen")
  expect(res.status).toBe(502)
  let msg = (await res.json()).error.message
  expect(msg).toContain("model not found (code 5000)")
  expect(msg).toContain("enterprise built-in model custom_model_acme_qwen asked through chat_v3")
  expect(msg).toContain("127.0.0.1")
  expect(msg).not.toContain("doesn't have")

  // typed in by hand: a name the account's list doesn't have
  res = await ask("Acme-Qwen-72B")
  expect(res.status).toBe(502)
  msg = (await res.json()).error.message
  expect(msg).toContain("model Acme-Qwen-72B asked through chat_v3")
  expect(msg).toContain("this account's model list doesn't have Acme-Qwen-72B")
})

// the reporter's next error (#1258, 0.2.42, console.enterprise.trae.cn): with
// config_source sent, both of their enterprise models got 4023 on every
// function. Trae's list types carry provider and model_name on each
// model_detail_list item, not on the config, and 0.2.42 sent neither. The
// entries' detail values are inferred from the config names they gave
// (provider/model); their real list entry hasn't been seen.
const WENT_WRONG = "We're sorry, something went wrong. Please try again later or contact our support team for assistance."
const listed = [
  { config_name: "AI/deekseek-v4.1-flash", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
    display_config: { display_name: "deekseek-v4.1-flash", is_custom_model: true },
    model_detail_list: [{ model_name: "deekseek-v4.1-flash", provider: "AI", max_tokens: 8192 }] },
  { config_name: "volc/deepseek-v4-1-flash", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
    display_config: { display_name: "deepseek-v4-1-flash", is_custom_model: true },
    model_detail_list: [{ model_name: "deepseek-v4-1-flash", provider: "volc", max_tokens: 8192 }] },
]

test("a chat with an enterprise model sends its detail's model_name and provider", async () => {
  const hooks = await plugin([preset, ...listed])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  // Trae as the reporter met it on 0.2.42: an enterprise config without the
  // model and provider it is served by went wrong
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    const e = listed.find((m) => m.config_name === r.json.config_name)
    const d = e?.model_detail_list[0]
    if (e && (r.json.model_name !== d.model_name || r.json.provider !== d.provider)) return sse([["error", { code: 4023, message: WENT_WRONG }]])
    return sse([["output", { response: "ok" }], ["done", {}]])
  })
  const opts = await hooks.auth.loader(async () => signedIn())
  for (const m of listed) {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: m.config_name, messages: [{ role: "user", content: "hi" }] }) })
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe("ok")
  }
  const chats = f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat")
  expect(chats.length).toBe(2)
  expect(chats[0].json).toMatchObject({ config_name: "AI/deekseek-v4.1-flash", config_source: 2, is_custom_model: true, model_name: "deekseek-v4.1-flash", provider: "AI" })
  expect(chats[1].json).toMatchObject({ config_name: "volc/deepseek-v4-1-flash", config_source: 2, is_custom_model: true, model_name: "deepseek-v4-1-flash", provider: "volc" })
})

test("an enterprise model's __dev detail is the one asked by; a preset's body gains nothing", () => {
  const two = { ...listed[1], model_detail_list: [{ model_name: "deepseek-v4-1-flash__max", provider: "volc" }, { model_name: "deepseek-v4-1-flash__dev", provider: "volc" }] }
  const body = _internal.chatBody({ model: two.config_name, messages: [{ role: "user", content: "hi" }] }, "chat_v3", "", 0, null, "s", false, null, two)
  expect(body.model_name).toBe("deepseek-v4-1-flash__dev")
  expect(body.provider).toBe("volc")
  const p = _internal.chatBody({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }, "chat_v3", "", 0, null, "s", false, null, preset)
  for (const k of ["model_name", "provider", "config_source", "is_custom_model"]) expect(k in p).toBe(false)
})

// the reporter's next case (@liuyuexue2020 on X, 0.2.43, AI/deekseek-v4.1-flash
// on console.enterprise.trae.cn): every reply stopped at exactly 2000 output
// tokens, where the same model in Trae wrote more. Trae's own client sends
// the model detail's max_tokens with every model; the plugin sent the
// agent's limit only, and an enterprise model none at all when the agent
// named none. The fake answers as the reporter met it: a request naming no
// limit gets 2000 tokens.
test("an enterprise model's chat is held to its detail's max_tokens, and sent it when the agent names none", async () => {
  const hooks = await plugin([preset, ...listed])
  const ms = await hooks.provider.models({ models: {} }, { auth: signedIn() })
  expect(ms["AI/deekseek-v4.1-flash"].limit.output).toBe(8192)
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    const out = Math.min(r.json.max_tokens || 2000, 8192)
    return sse([["output", { response: "x" }], ["done", { usage: { prompt_tokens: 10, completion_tokens: out } }]])
  })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (extra) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "AI/deekseek-v4.1-flash", messages: [{ role: "user", content: "write a lot" }], ...extra }) })
    expect(res.status).toBe(200)
    return f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").at(-1).json.max_tokens
  }
  expect(await ask({})).toBe(8192)
  expect(await ask({ max_tokens: 100 })).toBe(100)
  expect(await ask({ max_tokens: 100000 })).toBe(8192)
  expect(await ask({ max_completion_tokens: 3000 })).toBe(3000)
})

test("an enterprise detail with no max_tokens sends the agent's limit or none", () => {
  const bare = { ...listed[0], model_detail_list: [{ model_name: "deekseek-v4.1-flash", provider: "AI" }] }
  const req = { model: bare.config_name, messages: [{ role: "user", content: "hi" }] }
  expect("max_tokens" in _internal.chatBody(req, "chat_v3", "", 0, null, "s", false, null, bare)).toBe(false)
  expect(_internal.chatBody({ ...req, max_tokens: 5000 }, "chat_v3", "", 0, null, "s", false, null, bare).max_tokens).toBe(5000)
})

test("a preset asked with no limit is sent its __dev max_tokens, as Trae's client sends it", () => {
  const req = { model: "glm-5", messages: [{ role: "user", content: "hi" }] }
  expect(_internal.chatBody(req, "chat_v3", "glm-5__dev", 32000, null, "s", false, null, preset).max_tokens).toBe(32000)
  expect(_internal.chatBody({ ...req, max_tokens: 100 }, "chat_v3", "glm-5__dev", 32000, null, "s", false, null, preset).max_tokens).toBe(100)
  // a function whose list doesn't name the model's __dev detail: nothing known, nothing sent
  expect("max_tokens" in _internal.chatBody(req, "solo_agent", "", 0, null, "s", false, null, preset)).toBe(false)
})
