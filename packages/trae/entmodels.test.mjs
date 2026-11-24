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
  // a test that asks twice closes the first fake: a second over it would
  // keep the first's origin as the hosts to put back
  f?.close()
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

// the reporter's next case (@liuyuexue2020 on X, 0.2.44), their own request:
// volc/deepseek-v4-1-flash asked for 120 long lines with max_tokens 4096 and
// stream false. Four enterprise models each answered exactly 2000
// completion tokens with finish_reason "stop", mid-answer. The fake is Trae
// as inferred from its client (libharness 3.4.22): an enterprise model's
// limit is read from enterprise_custom_hyper_params, a top-level max_tokens
// is not, and a reply cut at the limit still says "stop".
const LINE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const theirAsk = { model: "volc/deepseek-v4-1-flash", messages: [{ role: "user", content: `Generate exactly 120 numbered lines. Each line must be in this format: LINE-001: ${LINE}. Continue through LINE-120. Do not summarize, do not explain, and do not stop early.` }], max_tokens: 4096, temperature: 0, stream: false }
const cutAt = (r) => r.json.enterprise_custom_hyper_params?.max_tokens || 2000
const answer = (out, finish = "stop") => sse([["output", { response: "LINE-001: " + LINE }], ["done", { finish_reason: finish, usage: { prompt_tokens: 80, completion_tokens: out } }]])

test("an enterprise model's chat names its limit in enterprise_custom_hyper_params, as Trae's client does", async () => {
  const hooks = await plugin([preset, ...listed.map((m) => ({ ...m, multimodal: false, model_detail_list: m.model_detail_list.map((d) => ({ ...d, prompt_max_tokens: 120000 })) }))])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => answer(Math.min(cutAt(r), 3100)))
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(theirAsk) })
  expect(res.status).toBe(200)
  const b = await res.json()
  expect(b.usage.completion_tokens).toBe(3100)
  expect(b.choices[0].finish_reason).toBe("stop")
  const sent = f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").at(-1).json
  expect(sent.max_tokens).toBe(4096)
  expect(sent.enterprise_custom_hyper_params).toEqual({ max_tokens: 4096, prompt_max_tokens: 120000, multimodal: false })
  // a preset is sent no enterprise params
  expect("enterprise_custom_hyper_params" in _internal.chatBody({ model: "glm-5", messages: [], max_tokens: 4096 }, "chat_v3", "glm-5__dev", 32000, null, "s", false, null, preset)).toBe(false)
  // nor an enterprise model with no limit known
  const bare = { ...listed[0], model_detail_list: [{ model_name: "deekseek-v4.1-flash", provider: "AI" }] }
  expect("enterprise_custom_hyper_params" in _internal.chatBody({ model: bare.config_name, messages: [] }, "chat_v3", "", 0, null, "s", false, null, bare)).toBe(false)
})

test("a reply Trae cut at its limit ends for length, not stop, in a body and in a stream", async () => {
  const hooks = await plugin([preset, ...listed])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  let out = 2000
  f.route("POST /api/agent/v3/llm_utils_chat", () => answer(out))
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (extra) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ ...theirAsk, ...extra }) })
    expect(res.status).toBe(200)
    if (!extra.stream) return (await res.json()).choices[0].finish_reason
    const lines = (await res.text()).split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    return lines.map((x) => x.choices?.[0]?.finish_reason).filter(Boolean)
  }
  // Trae's own 2000, whatever was asked
  expect(await ask({})).toBe("length")
  expect(await ask({ stream: true })).toEqual(["length"])
  // the limit sent, used up
  out = 1000
  expect(await ask({ max_tokens: 1000 })).toBe("length")
  // a reply that ended short of both is whole
  out = 1999
  expect(await ask({})).toBe("stop")
  expect(await ask({ stream: true })).toEqual(["stop"])
  // a preset's reply of exactly 2000 under a bigger limit was not seen cut
  out = 2000
  expect(await ask({ model: "glm-5" })).toBe("stop")
})

test("cutFinish keeps what Trae said of a reply it didn't cut", () => {
  const u = (c) => ({ completion_tokens: c })
  expect(_internal.cutFinish("stop", u(2000), 4096, _internal.TRAE_CUT)).toBe("length")
  expect(_internal.cutFinish("", u(2000), 4096, _internal.TRAE_CUT)).toBe("length")
  expect(_internal.cutFinish("stop", u(2000), 4096, 0)).toBe("stop")
  expect(_internal.cutFinish("content_filter", u(2000), 4096, _internal.TRAE_CUT)).toBe("content_filter")
  expect(_internal.cutFinish("stop", u(4096), 4096, 0)).toBe("length")
  expect(_internal.cutFinish("stop", null, 4096, _internal.TRAE_CUT)).toBe("stop")
})

// the reporter's next case (plugins#1366, 0.2.47, debug log): max_tokens
// 32768 sent, completion_tokens exactly 2000, one call, finish_sent
// tool_calls, and the client sent no next request. Trae cut the reply in
// the call's arguments, and the half call went on as a whole one. The call
// comes as Trae's native tool_calls do (an id and index, the arguments so
// far in each event), its arguments the write a long reply is.
const WRITE = [{ type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } }]
const lines = (n) => Array.from({ length: n }, (_, k) => `LINE-${String(k + 1).padStart(3, "0")}: ${LINE}`).join("\\n")
const cutCall = (out, args) => sse([
  ["output", { response: "Writing the file." }],
  ["output", { tool_calls: [{ id: "call_w1", index: 0, function: { name: "write", arguments: "" } }] }],
  ["output", { tool_calls: [{ id: "call_w1", index: 0, function: { name: "write", arguments: args.slice(0, 40) } }] }],
  ["output", { tool_calls: [{ id: "call_w1", index: 0, function: { name: "write", arguments: args } }] }],
  ["done", { usage: { prompt_tokens: 42032, completion_tokens: out } }],
])
// a message's text, as Trae is sent it
const said = (m) => (Array.isArray(m?.content) ? m.content.map((c) => c.text ?? "").join("") : m?.text ?? m?.content)
const HALF = `{"path":"lines.txt","content":"${lines(60)}`
const WHOLE = `{"path":"lines.txt","content":"${lines(3)}"}`

test("a call Trae cut at 2000 goes out as no call: the reply ends for length, its text kept, in a body and in a stream", async () => {
  const hooks = await plugin([preset, ...listed])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  let out = 2000
  let args = HALF
  // the next ask of a cut reply (continued) is turned away here: the reply
  // ends as one ask cut it
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => said(r.json.messages.at(-1)) === _internal.GO_ON ? json({ code: 500, message: "busy" }, 502) : cutCall(out, args))
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (extra = {}) => {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ ...theirAsk, max_tokens: 32768, tools: WRITE, ...extra }) })
    expect(res.status).toBe(200)
    if (!extra.stream) {
      const c = (await res.json()).choices[0]
      return { finish: c.finish_reason, text: c.message.content, calls: (c.message.tool_calls ?? []).map((t) => t.function.arguments) }
    }
    const ds = (await res.text()).split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6))).filter((x) => x.choices?.length)
    return {
      finish: ds.map((x) => x.choices[0].finish_reason).filter(Boolean).join(),
      text: ds.map((x) => x.choices[0].delta.content ?? "").join(""),
      calls: ds.flatMap((x) => x.choices[0].delta.tool_calls ?? []).map((t) => t.function.arguments),
    }
  }
  // cut in the call: no call, length, the text before it kept
  expect(await ask()).toEqual({ finish: "length", text: "Writing the file.", calls: [] })
  expect(await ask({ stream: true })).toEqual({ finish: "length", text: "Writing the file.", calls: [] })
  // the limit sent, used up in the call: the same
  out = 1000
  expect(await ask({ max_tokens: 1000 })).toEqual({ finish: "length", text: "Writing the file.", calls: [] })
  // a whole call at 2000 is the model's and goes out as one
  out = 2000
  args = WHOLE
  expect(await ask()).toEqual({ finish: "tool_calls", text: "Writing the file.", calls: [WHOLE] })
  expect(await ask({ stream: true })).toEqual({ finish: "tool_calls", text: "Writing the file.", calls: [WHOLE] })
  // a reply short of the cut goes out as it came, whole or not
  out = 1999
  args = HALF
  expect((await ask()).calls).toEqual([HALF])
  expect(await ask({ stream: true })).toEqual({ finish: "tool_calls", text: "Writing the file.", calls: [HALF] })
})

test("ending drops only the cut calls of a cut reply", () => {
  const u = (c) => ({ completion_tokens: c })
  const whole = { id: "a", name: "read", arguments: '{"path":"a"}' }
  const half = { id: "b", name: "write", arguments: '{"path":"b","content":"x' }
  const cut = _internal.TRAE_CUT
  expect(_internal.ending([whole, half], "", u(2000), 32768, cut)).toEqual({ calls: [whole], finish: "length", dropped: 1 })
  expect(_internal.ending([half], "length", u(1500), 32768, cut)).toEqual({ calls: [], finish: "length", dropped: 1 })
  expect(_internal.ending([whole], "", u(2000), 32768, cut)).toEqual({ calls: [whole], finish: "tool_calls", dropped: 0 })
  expect(_internal.ending([half], "", u(2000), 32768, 0)).toEqual({ calls: [half], finish: "tool_calls", dropped: 0 })
  expect(_internal.ending([], "", u(2000), 32768, cut)).toEqual({ calls: [], finish: "length", dropped: 0 })
  expect(_internal.ending([], "", u(10), 32768, cut)).toEqual({ calls: [], finish: "stop", dropped: 0 })
})

// the reporter's last ask (plugins#1366, 0.2.48): Trae's llm_utils_chat
// stops an enterprise model's reply at exactly 2000 output tokens with
// max_tokens 32768 sent, top-level and in enterprise_custom_hyper_params,
// and Trae's own requests there carry no limit field to send instead. The
// LINE-001…LINE-120 ask needs more than 2000, so a cut reply is asked on:
// the same request with the text so far as the assistant's and GO_ON
// after it, and the rounds go out as one reply.
const part = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => `LINE-${String(from + k).padStart(3, "0")}: ${LINE}\n`).join("")
const round = (text, out, finish = "stop", prompt = 80) => sse([["output", { response: text }], ["done", { finish_reason: finish, usage: { prompt_tokens: prompt, completion_tokens: out } }]])

async function carried(answers) {
  const hooks = await plugin([preset, ...listed.map((m) => ({ ...m, model_detail_list: m.model_detail_list.map((d) => ({ ...d, max_tokens: 32768 })) }))])
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const asks = []
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    asks.push(r.json)
    return answers(asks.length, r.json)
  })
  const opts = await hooks.auth.loader(async () => signedIn())
  const ask = async (extra = {}) => {
    asks.length = 0
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ ...theirAsk, max_tokens: 32768, ...extra }) })
    expect(res.status).toBe(200)
    if (!extra.stream) {
      const b = await res.json()
      const c = b.choices[0]
      return { finish: c.finish_reason, text: c.message.content, calls: (c.message.tool_calls ?? []).map((t) => t.function.arguments), usage: b.usage, asks: asks.length }
    }
    const ds = (await res.text()).split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const cs = ds.filter((x) => x.choices?.length)
    return {
      finish: cs.map((x) => x.choices[0].finish_reason).filter(Boolean).join(),
      text: cs.map((x) => x.choices[0].delta.content ?? "").join(""),
      calls: cs.flatMap((x) => x.choices[0].delta.tool_calls ?? []).map((t) => t.function.arguments),
      usage: ds.find((x) => x.usage)?.usage,
      asks: asks.length,
    }
  }
  return { ask, asks }
}

test("a reply Trae cut at 2000 is asked on and goes out whole, in a body and in a stream", async () => {
  const { ask, asks } = await carried((n) => n === 1 ? round(part(1, 40), 2000) : n === 2 ? round(part(41, 80), 2000, "") : round(part(81, 120), 900, "stop", 95))
  for (const stream of [false, true]) {
    const got = await ask({ stream })
    expect(got.text).toBe(part(1, 120))
    expect(got.finish).toBe("stop")
    expect(got.calls).toEqual([])
    expect(got.asks).toBe(3)
    expect(got.usage.completion_tokens).toBe(4900)
    expect(got.usage.prompt_tokens).toBe(255)
    // each next ask: the same session and model, the text so far as the
    // assistant's turn, GO_ON after it, and what is left of the limit
    expect(asks[1].session_id).toBe(asks[0].session_id)
    expect(asks[1].config_name).toBe(asks[0].config_name)
    expect(asks[1].messages.slice(0, -2)).toEqual(asks[0].messages)
    expect(asks[1].messages.at(-2).role).toBe("assistant")
    expect(said(asks[1].messages.at(-2))).toBe(part(1, 40))
    expect(asks[1].messages.at(-1).role).toBe("user")
    expect(said(asks[1].messages.at(-1))).toBe(_internal.GO_ON)
    expect(said(asks[2].messages.at(-2))).toBe(part(1, 80))
    expect(asks[1].max_tokens).toBe(32768 - 2000)
    expect(asks[1].enterprise_custom_hyper_params.max_tokens).toBe(32768 - 2000)
    expect(asks[2].max_tokens).toBe(32768 - 4000)
  }
  // GO_ON names neither magpie nor Trae nor a limit: it goes to the vendor
  expect(_internal.GO_ON).not.toMatch(/magpie|trae|2000|token|limit|cut/i)
})

test("a cut reply is asked on only while the limit lasts, and still cut it ends for length", async () => {
  const { ask } = await carried(() => round(part(1, 40), 2000))
  // 4096 asked: 2000, then 2000 of the 2096 left, then 96 left: a third ask,
  // which Trae answers with 2000 again; nothing is left after it
  expect(await ask({ max_tokens: 4096 })).toMatchObject({ finish: "length", asks: 3, text: part(1, 40).repeat(3) })
  // 2000 asked is spent by the first answer
  expect(await ask({ max_tokens: 2000 })).toMatchObject({ finish: "length", asks: 1 })
  // with the limit far off, CUT_ROUNDS bounds the asks
  expect(await ask({ max_tokens: 32768, stream: true })).toMatchObject({ finish: "length", asks: _internal.CUT_ROUNDS })
})

test("a cut reply's call is written whole by the next ask; a whole call ends the asking", async () => {
  const { ask } = await carried((n) => n === 1 ? cutCall(2000, HALF) : sse([
    ["output", { tool_calls: [{ id: "call_w2", index: 0, function: { name: "write", arguments: WHOLE } }] }],
    ["done", { usage: { prompt_tokens: 90, completion_tokens: 300 } }],
  ]))
  for (const stream of [false, true]) {
    expect(await ask({ tools: WRITE, stream })).toMatchObject({ finish: "tool_calls", text: "Writing the file.", calls: [WHOLE], asks: 2 })
  }
  // a whole call at the cut is the model's: it goes out, nothing asked on
  const { ask: once } = await carried(() => cutCall(2000, WHOLE))
  expect(await once({ tools: WRITE })).toMatchObject({ finish: "tool_calls", calls: [WHOLE], asks: 1 })
})

test("a cut reply with no text, a short one and a preset's are not asked on", async () => {
  // only reasoning, or a call cut with nothing written before it: there is
  // nothing to go on from
  let { ask } = await carried(() => sse([["output", { reasoning_content: "thinking" }], ["done", { usage: { prompt_tokens: 80, completion_tokens: 2000 } }]]))
  expect(await ask()).toMatchObject({ finish: "length", asks: 1 })
  ;({ ask } = await carried(() => round(part(1, 3), 1999)))
  expect(await ask()).toMatchObject({ finish: "stop", asks: 1 })
  ;({ ask } = await carried(() => round(part(1, 40), 2000)))
  expect(await ask({ model: "glm-5" })).toMatchObject({ finish: "stop", asks: 1 })
  // a next ask that fails mid-answer leaves the reply as Trae cut it
  ;({ ask } = await carried((n) => n === 1 ? round(part(1, 40), 2000) : sse([["output", { response: "LINE-041" }], ["error", { code: 500, message: "busy" }]])))
  const got = await ask({ stream: true })
  expect(got).toMatchObject({ finish: "length", asks: 2 })
  expect(got.text.startsWith(part(1, 40))).toBe(true)
})

// the reporter's 0.2.49 debug log (plugins#1366): a non-stream LINE ask
// with max_tokens 8192. Round 1: completion_tokens=2000, text_chars=1834,
// reasoning_chars=1363, finish_sent=length. Round 2, asked with
// max_tokens=6192 and the text as the assistant's: completion_tokens=2000,
// text_chars=0, reasoning_chars=7683, finish_sent=length, and no round 3,
// so the reply stopped mid-line. Trae's events here are as in the fake's
// other rounds (output, then done with no finish), at those lengths.
const ALL = part(1, 120)
const THINK = "The user wants exactly 120 numbered lines in a fixed format; keep counting from where the text stopped. "
const thinking = (n) => THINK.repeat(Math.ceil(n / THINK.length)).slice(0, n)
const reasoned = (reasoning, text, out, finish = "") => sse([
  ["output", { reasoning_content: reasoning }],
  ...(text ? [["output", { response: text }]] : []),
  ["done", { ...(finish ? { finish_reason: finish } : {}), usage: { prompt_tokens: 120, completion_tokens: out } }],
])

test("a round Trae cut in the model's reasoning is asked on once text was written, in a body and in a stream", async () => {
  const { ask, asks } = await carried((n) => n === 1 ? reasoned(thinking(1363), ALL.slice(0, 1834), 2000)
    : n === 2 ? reasoned(thinking(7683), "", 2000)
    : reasoned(thinking(400), ALL.slice(1834), 1500, "stop"))
  for (const stream of [false, true]) {
    const got = await ask({ max_tokens: 8192, stream })
    expect(got).toMatchObject({ finish: "stop", text: ALL, calls: [], asks: 3 })
    expect(got.usage.completion_tokens).toBe(5500)
    // round 2 is sent what the log says; round 3 goes on from the same
    // text, the rounds' 4000 tokens spent
    expect(asks[1].max_tokens).toBe(6192)
    expect(said(asks[1].messages.at(-2))).toBe(ALL.slice(0, 1834))
    expect(asks[2].max_tokens).toBe(4192)
    expect(said(asks[2].messages.at(-2))).toBe(ALL.slice(0, 1834))
    expect(said(asks[2].messages.at(-1))).toBe(_internal.GO_ON)
  }
})

test("rounds cut in the reasoning stop after THOUGHT_ROUNDS in a row, and the reply ends for length", async () => {
  const { ask } = await carried((n) => n === 1 ? reasoned(thinking(1363), ALL.slice(0, 1834), 2000) : reasoned(thinking(7683), "", 2000))
  for (const stream of [false, true]) {
    expect(await ask({ stream })).toMatchObject({ finish: "length", text: ALL.slice(0, 1834), asks: 1 + _internal.THOUGHT_ROUNDS })
  }
  // a round that writes text again starts the count over
  const { ask: again } = await carried((n) => n % 3 === 1 ? round(part(1, 2), 2000) : reasoned(thinking(500), "", 2000))
  expect(await again({ max_tokens: 32768 })).toMatchObject({ finish: "length", asks: _internal.CUT_ROUNDS })
})

test("a round that is only a call Trae cut is asked on once text was written; its call is written whole next", async () => {
  const cutOnly = () => sse([
    ["output", { tool_calls: [{ id: "call_w1", index: 0, function: { name: "write", arguments: HALF } }] }],
    ["done", { usage: { prompt_tokens: 90, completion_tokens: 2000 } }],
  ])
  const whole = () => sse([
    ["output", { tool_calls: [{ id: "call_w2", index: 0, function: { name: "write", arguments: WHOLE } }] }],
    ["done", { usage: { prompt_tokens: 90, completion_tokens: 300 } }],
  ])
  const { ask } = await carried((n) => n === 1 ? round("Writing the file.", 2000, "") : n === 2 ? cutOnly() : whole())
  for (const stream of [false, true]) {
    expect(await ask({ tools: WRITE, stream })).toMatchObject({ finish: "tool_calls", text: "Writing the file.", calls: [WHOLE], asks: 3 })
  }
})

test("an enterprise model's stream is sent a keepalive while the next ask of a cut reply waits", async () => {
  const was = _internal.tune.keepEvery
  _internal.tune.keepEvery = 20
  try {
    let release
    const held = new Promise((r) => (release = r))
    const hooks = await plugin([preset, ...listed.map((m) => ({ ...m, model_detail_list: m.model_detail_list.map((d) => ({ ...d, max_tokens: 32768 })) }))])
    await hooks.provider.models({ models: {} }, { auth: signedIn() })
    let asks = 0
    f.route("POST /api/agent/v3/llm_utils_chat", async () => {
      if (++asks === 1) return round(part(1, 40), 2000)
      await held // round 2 answers only once the agent was kept alive
      return round(part(41, 42), 300, "stop")
    })
    const opts = await hooks.auth.loader(async () => signedIn())
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ ...theirAsk, max_tokens: 32768, stream: true }) })
    const rd = res.body.getReader()
    const dec = new TextDecoder()
    let got = ""
    for (;;) {
      const { value, done } = await rd.read()
      if (done) break
      got += dec.decode(value, { stream: true })
      if (got.includes(": keepalive\n\n")) release()
    }
    expect(asks).toBe(2)
    // the comment came between the rounds, and the reply is whole after it
    expect(got.indexOf(": keepalive")).toBeGreaterThan(got.indexOf("LINE-040"))
    expect(got.indexOf(": keepalive")).toBeLessThan(got.indexOf("LINE-041"))
    const ds = got.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6))).filter((x) => x.choices?.length)
    expect(ds.map((x) => x.choices[0].delta.content ?? "").join("")).toBe(part(1, 42))
    expect(ds.map((x) => x.choices[0].finish_reason).filter(Boolean)).toEqual(["stop"])
  } finally {
    _internal.tune.keepEvery = was
  }
})

test("addUsage counts both asks", () => {
  const a = { prompt_tokens: 80, completion_tokens: 2000, total_tokens: 2080, prompt_tokens_details: { cached_tokens: 10 } }
  const b = { prompt_tokens: 90, completion_tokens: 5, total_tokens: 95, magpie_cache_unknown: true }
  expect(_internal.addUsage(a, b)).toEqual({ prompt_tokens: 170, completion_tokens: 2005, total_tokens: 2175, prompt_tokens_details: { cached_tokens: 10 }, magpie_cache_unknown: true })
  expect(_internal.addUsage(null, b)).toBe(b)
  expect(_internal.addUsage(a, null)).toBe(a)
})

// the reporter's 0.2.50 report (plugins#1366): after text was written, a
// later round of a cut reply answered with nothing to go on with, and the
// reply went to the agent as a 502 with the text lost. Whatever a later
// round answers, the text written stays and the reply ends for length:
// a round that is only reasoning but stops short of the cut, one that says
// nothing at all, one whose stream breaks off, and one that is an error.
const broken = (reasoning) => new Response(new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode(`event: output\ndata: ${JSON.stringify({ reasoning_content: reasoning })}\n\n`))
    // after the headers went out: the read breaks, not the fetch
    setTimeout(() => c.error(new Error("connection reset")), 20)
  },
}), { status: 200, headers: { "content-type": "text/event-stream" } })
for (const [how, later, asks = 2] of [
  ["only reasoning, short of the cut", () => reasoned(thinking(2000), "", 1500, "stop")],
  ["only reasoning, with no usage", () => sse([["output", { reasoning_content: thinking(2000) }], ["done", {}]])],
  ["nothing at all", () => sse([["done", {}]])],
  ["a stream that breaks off", () => broken(thinking(500))],
  ["an empty reply's error", () => sse([["error", { code: 500, message: "an empty reply" }]])],
  // round 2 spends its 2000 on reasoning and is asked on; round 3 says nothing
  ["nothing, after a round spent reasoning", (n) => n === 2 ? reasoned(thinking(2000), "", 2000) : sse([["done", {}]]), 3],
]) {
  test(`a later round that answers ${how} keeps the text written and ends for length, in a body and in a stream`, async () => {
    const { ask } = await carried((n) => n === 1 ? reasoned(thinking(1363), ALL.slice(0, 1834), 2000) : later(n))
    for (const stream of [false, true]) {
      const got = await ask({ max_tokens: 8192, stream })
      expect(got).toMatchObject({ finish: "length", text: ALL.slice(0, 1834), calls: [], asks })
      expect(got.usage.completion_tokens).toBeGreaterThanOrEqual(2000)
    }
  })
}

test("a first round whose stream breaks off is still an error", async () => {
  const { ask } = await carried(() => broken(thinking(500)))
  const got = await ask({ stream: true })
  expect(got.finish).toBe("")
  expect(got.text).toBe("")
})
