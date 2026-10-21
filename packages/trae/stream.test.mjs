// What 歧路亡羊 found on magpie's Discord (2026-10-05): GLM's own tool-call
// tags, a call written into a native call's name, answer text under an
// event the stream didn't name as output, reasoning written into the text
// or sent twice, the finish of a reply that failed or was cut at its
// limit, and Trae's Max context.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function ask(body, auth = signedIn()) {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  return opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
}

async function chunks(res) {
  const out = []
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue
    const d = line.slice(6)
    out.push(d === "[DONE]" ? d : JSON.parse(d))
  }
  return out
}

const deltasOf = (c) => c.filter((x) => x !== "[DONE]" && x.choices?.length).map((x) => x.choices[0].delta)
const callsOf = (c) => deltasOf(c).flatMap((d) => d.tool_calls ?? []).map((t) => [t.function.name, JSON.parse(t.function.arguments)])
const textOf = (c) => deltasOf(c).map((d) => d.content ?? "").join("")
const reasoningOf = (c) => deltasOf(c).map((d) => d.reasoning_content ?? "").join("")
const finishOf = (c) => c.filter((x) => x !== "[DONE]" && x.choices?.[0]?.finish_reason).map((x) => x.choices[0].finish_reason)

const TOOLS = [
  { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } } },
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
]

const stream = (events) => {
  f?.close()
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse(events))
}

test("GLM's own <arg_key>/<arg_value> call is a call, split over events, a string kept as written and a number read as one", async () => {
  stream([
    ["output", { response: "Reading.\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_va" }],
    ["output", { response: "lue>007.txt</arg_value>\n<arg_key>limit</arg_key>\n<arg_value>20</arg_value>\n</tool_call>" }],
    ["output", { response: '<tool_call>bash<arg_key>command</arg_key><arg_value>echo "a\nb"</arg_value></tool_call>' }],
    ["done", {}],
  ])
  const c = await chunks(await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("Reading.\n")
  expect(callsOf(c)).toEqual([["read", { path: "007.txt", limit: 20 }], ["bash", { command: 'echo "a\nb"' }]])
  expect(finishOf(c)).toEqual(["tool_calls"])
})

test("a native call whose name holds the whole call, as JSON or GLM's tags, is that call", async () => {
  stream([
    ["output", { tool_calls: [{ id: "n1", function: { name: '{"name":"read","arguments":{"path":"a"}}', arguments: "" } }] }],
    ["output", { tool_calls: [{ id: "n2", function: { name: "bash<arg_key>command</arg_key><arg_value>ls</arg_value>", arguments: "{}" } }] }],
    ["done", {}],
  ])
  const c = await chunks(await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
  expect(callsOf(c)).toEqual([["read", { path: "a" }], ["bash", { command: "ls" }]])
})

test("a call to a tool named otherwise than the request's (case, dashes) goes on under the request's name", async () => {
  stream([["output", { response: '<tool_call>{"name":"Read","arguments":{"path":"a"}}</tool_call>' }], ["done", {}]])
  const c = await chunks(await ask({ model: "glm-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
  expect(callsOf(c)).toEqual([["read", { path: "a" }]])
})

test("answer text under an event not named output (delta, or none) is the answer's", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () =>
    new Response('event: output\ndata: {"response":"He"}\n\nevent: delta\ndata: {"response":"ll"}\n\ndata: {"content":"o"}\n\nevent: request_wait_in_queue\ndata: {"position":1}\n\nevent: done\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } }))
  const c = await chunks(await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("Hello")
})

test("reasoning written into the text as JSON is reasoning, and reasoning sent again isn't sent twice", async () => {
  stream([
    ["output", { reasoning_content: "The user wants a greeting, so" }],
    ["output", { reasoning_content: "The user wants a greeting, so" }],
    ["output", { reasoning_content: "The user wants a greeting, so I say hi." }],
    ["output", { response: "Hi there." }],
    ["output", { response: '{"reasoning_' }],
    ["output", { response: 'content":"The user wants a greeting, so I say hi."}' }],
    ["output", { response: '{"reasoning_content":"one more thought"}' }],
    ["done", {}],
  ])
  const c = await chunks(await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("Hi there.")
  expect(reasoningOf(c)).toBe("The user wants a greeting, so I say hi.one more thought")
})

test("text holding braces that aren't reasoning goes through whole", () => {
  const t = new _internal.TextTools()
  const a = t.push('x = {"reasoning": 1} and {"a":')
  const b = t.push("2}", true)
  expect(a.text + b.text).toBe('x = {"reasoning": 1} and {"a":2}')
})

test("a reply that fails mid-way ends with the error and [DONE], not a stop", async () => {
  stream([["output", { response: "partial" }], ["error", { code: 500, message: "server broke" }]])
  const c = await chunks(await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("partial")
  expect(finishOf(c)).toEqual([])
  expect(c.at(-2).error.message).toContain("server broke")
  expect(c.at(-1)).toBe("[DONE]")
})

// the realm answering names itself in its errors, so a Global account's
// failure doesn't read as Trae CN's
test("a Global reply that fails names Trae Global, not Trae CN", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "partial" }], ["error", { code: 500, message: "server broke" }]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const c = await chunks(await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }) }))
  expect(c.at(-2).error.message).toBe("Trae Global: server broke")
  expect(c.at(-1)).toBe("[DONE]")
})

test("an empty reasoning_content leaves the reasoning the event carries", async () => {
  stream([
    ["output", { reasoning_content: "", reasoning: "the real thought" }],
    ["output", { response: "hi" }],
    ["done", {}],
  ])
  const c = await chunks(await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("hi")
  expect(reasoningOf(c)).toBe("the real thought")
})

test("a reply cut at its limit says length", async () => {
  stream([["output", { response: "a lot" }], ["done", { finish_reason: "length" }]])
  const c = await chunks(await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(finishOf(c)).toEqual(["length"])
  stream([["output", { response: "a lot" }], ["done", { finish_reason: "max_tokens" }]])
  const b = await (await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })).json()
  expect(b.choices[0].finish_reason).toBe("length")
})

test("a stream that breaks off ends with an error and [DONE]", async () => {
  // the connection breaks only once the caller has the first event, so the
  // plugin has read it: a reset timed by the clock alone can beat that read
  // on a busy machine, and Bun then drops the event it had (#124). The fake
  // breaks it by stopping its server mid-body, not by erroring the body:
  // Bun prints a body's error on every run, and that read as a red (#268)
  let reset
  const caught = new Promise((r) => (reset = r))
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => {
    let n = 0
    const body = new ReadableStream({
      async pull(ctl) {
        if (n++ === 0) return ctl.enqueue(new TextEncoder().encode('event: output\ndata: {"response":"half"}\n\n'))
        await caught
        f.close()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  })
  const res = await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let text = ""
  while (!text.includes('"half"')) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  reset()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  const c = await chunks(new Response(text))
  expect(textOf(c)).toBe("half")
  expect(finishOf(c)).toEqual([])
  expect(c.at(-2).error.message).toContain("Trae CN")
  expect(c.at(-1)).toBe("[DONE]")
})

const BATCH = { function_configs: [
  { function: "solo_agent", config_info_list: [
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4.1-Flash" }, context_window_tokens: { dev: 116000, max: 1000000 }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev", max_tokens: 16000 }, { model_name: "deepseek-v4.1-flash__max", max_tokens: 64000 }] },
    { config_name: "glm-5.2", usage: "chat_completion", context_window_tokens: { dev: 200000 }, model_detail_list: [{ model_name: "glm-5.2__dev", max_tokens: 32000 }] },
  ] },
] }

test("a model with a Max context is listed a second time, as its Max, which asks Trae's __max model with the prompt it has room for", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(BATCH))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = { models: { ..._internal.MODELS } }
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash-max", "glm-5.2"])
  expect(live["deepseek-v4.1-flash"].limit).toEqual({ context: 116000, output: 16000 })
  expect(live["deepseek-v4.1-flash-max"].limit).toEqual({ context: 1000000, output: 64000 })
  expect(live["deepseek-v4.1-flash-max"].name).toBe("DeepSeek-V4.1-Flash (Max)")
  const opts = await hooks.auth.loader(async () => signedIn())
  const send = (body) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) })
  await send({ model: "deepseek-v4.1-flash-max", max_tokens: 100000 })
  let b = f.seen.at(-1).json
  expect([b.function, b.config_name, b.model, b.model_name, b.max_tokens]).toEqual(["solo_agent", "deepseek-v4.1-flash", "deepseek-v4.1-flash", "deepseek-v4.1-flash__max", 64000])
  expect(b.user_message_context).toEqual({ model_info: { prompt_max_tokens: 1000000 - 64000 } })
  await send({ model: "deepseek-v4.1-flash-max" })
  b = f.seen.at(-1).json
  expect([b.model_name, b.max_tokens, b.user_message_context.model_info.prompt_max_tokens]).toEqual(["deepseek-v4.1-flash__max", 64000, 936000])
  // the model itself is asked as before
  await send({ model: "deepseek-v4.1-flash" })
  b = f.seen.at(-1).json
  expect([b.model_name, b.user_message_context]).toEqual(["deepseek-v4.1-flash__dev", undefined])
})

// ARNO on magpie's Discord: 0.1.14 listed no deepseek-v4.1-flash-max. Trae CN
// lists the model in several functions (yetone/magpie#681), and they needn't
// agree: chat_v3's entry names the __max model, while the SOLO entry the model
// is asked through names only __dev and gives the windows. Its Max is found
// across them, and asked through the function that names the __max model.
const SPLIT = { function_configs: [
  { function: "chat_v3", config_info_list: [
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4-Flash 正式版" }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev" }, { model_name: "deepseek-v4.1-flash__max", max_tokens: 128000 }] },
    { config_name: "DeepSeek-V4-Flash-Official", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4-Flash 正式版" }, model_detail_list: [{ model_name: "DeepSeek-V4-Flash-Official__dev" }] },
  ] },
  { function: "solo_work_lite", config_info_list: [
    { config_name: "deepseek-v4.1-flash", usage: "chat_completion", display_config: { display_name: "DeepSeek-V4.1-Flash" }, context_window_tokens: { dev: 200000, max: 1000000 }, model_detail_list: [{ model_name: "deepseek-v4.1-flash__dev", max_tokens: 64000 }] },
  ] },
] }

test("a Max the lists split between them is listed, and asked where its __max model is named", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(SPLIT))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = { models: { ..._internal.MODELS } }
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash-max", "DeepSeek-V4-Flash-Official"])
  expect(live["deepseek-v4.1-flash"].limit).toEqual({ context: 200000, output: 64000 })
  expect(live["deepseek-v4.1-flash-max"].limit).toEqual({ context: 1000000, output: 128000 })
  expect(live["deepseek-v4.1-flash-max"].name).toBe("DeepSeek-V4.1-Flash (Max)")
  const opts = await hooks.auth.loader(async () => signedIn())
  const send = (body) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) })
  await send({ model: "deepseek-v4.1-flash-max" })
  let b = f.seen.at(-1).json
  expect([b.function, b.config_name, b.model_name, b.max_tokens, b.user_message_context.model_info.prompt_max_tokens]).toEqual(["chat_v3", "deepseek-v4.1-flash", "deepseek-v4.1-flash__max", 128000, 872000])
  await send({ model: "deepseek-v4.1-flash" })
  b = f.seen.at(-1).json
  expect([b.function, b.model_name, b.user_message_context]).toEqual(["solo_work_lite", "deepseek-v4.1-flash__dev", undefined])
})

test("a __max model with no bigger window in any list is no Max", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [SPLIT.function_configs[0]] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const live = await hooks.provider.models({ models: { ..._internal.MODELS } }, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["deepseek-v4.1-flash", "DeepSeek-V4-Flash-Official"])
})
