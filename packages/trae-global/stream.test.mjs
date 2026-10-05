// What 歧路亡羊 found on magpie's Discord (2026-10-05) and the CN plugin
// fixed in 0.1.9–0.1.14, the international plugin taking the same machinery:
// GLM's own tool-call tags, a call written into a native call's name, answer
// text under an event the stream didn't name as output, reasoning written
// into the text or sent twice, the finish of a reply that failed or was cut
// at its limit, and Trae's Max context.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function ask(body, auth = signedIn()) {
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
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
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
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
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
  expect(callsOf(c)).toEqual([["read", { path: "a" }], ["bash", { command: "ls" }]])
})

test("a call to a tool named otherwise than the request's (case, dashes) goes on under the request's name", async () => {
  stream([["output", { response: '<tool_call>{"name":"Read","arguments":{"path":"a"}}</tool_call>' }], ["done", {}]])
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] }))
  expect(callsOf(c)).toEqual([["read", { path: "a" }]])
})

test("answer text under an event not named output (delta, or none) is the answer's", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () =>
    new Response('event: output\ndata: {"response":"He"}\n\nevent: delta\ndata: {"response":"ll"}\n\ndata: {"content":"o"}\n\nevent: request_wait_in_queue\ndata: {"position":1}\n\nevent: done\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } }))
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }))
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
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }))
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
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("partial")
  expect(finishOf(c)).toEqual([])
  expect(c.at(-2).error.message).toContain("server broke")
  expect(c.at(-1)).toBe("[DONE]")
})

test("a reply cut at its limit says length", async () => {
  stream([["output", { response: "a lot" }], ["done", { finish_reason: "length" }]])
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(finishOf(c)).toEqual(["length"])
  stream([["output", { response: "a lot" }], ["done", { finish_reason: "max_tokens" }]])
  const b = await (await ask({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] })).json()
  expect(b.choices[0].finish_reason).toBe("length")
})

test("a stream that breaks off ends with an error and [DONE]", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => {
    let n = 0
    const body = new ReadableStream({
      async pull(ctl) {
        if (n++ === 0) return ctl.enqueue(new TextEncoder().encode('event: output\ndata: {"response":"half"}\n\n'))
        await new Promise((r) => setTimeout(r, 30)) // the headers and the first event are out
        ctl.error(new Error("connection reset"))
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  })
  const c = await chunks(await ask({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(textOf(c)).toBe("half")
  expect(finishOf(c)).toEqual([])
  expect(c.at(-2).error.message).toContain("Trae Global")
  expect(c.at(-1)).toBe("[DONE]")
})

// The lists needn't agree (trae 0.1.15, ARNO on magpie's Discord): chat_v3's
// entry names the __max model, while the SOLO entry the model is asked
// through names only __dev and gives the windows. Its Max is found across
// them, and asked through the function that names the __max model.
const SPLIT = { function_configs: [
  { function: "chat_v3", config_info_list: [
    { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4 Official" }, model_detail_list: [{ model_name: "gpt-5.4__dev" }, { model_name: "gpt-5.4__max", max_tokens: 128000 }] },
    { config_name: "GPT-5.4-Official", usage: "chat_completion", display_config: { display_name: "GPT-5.4 Official" }, model_detail_list: [{ model_name: "GPT-5.4-Official__dev" }] },
  ] },
  { function: "solo_work_lite", config_info_list: [
    { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4" }, context_window_tokens: { dev: 200000, max: 1000000 }, model_detail_list: [{ model_name: "gpt-5.4__dev", max_tokens: 64000 }] },
  ] },
] }

test("a Max the lists split between them is listed, and asked where its __max model is named", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(SPLIT))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = { models: { ..._internal.MODELS } }
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["gpt-5.4", "gpt-5.4-max", "GPT-5.4-Official"])
  expect(live["gpt-5.4"].limit).toEqual({ context: 200000, output: 64000 })
  expect(live["gpt-5.4"].name).toBe("GPT-5.4")
  expect(live["gpt-5.4-max"].limit).toEqual({ context: 1000000, output: 128000 })
  expect(live["gpt-5.4-max"].name).toBe("GPT-5.4 (Max)")
  const opts = await hooks.auth.loader(async () => signedIn())
  const send = (body) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) })
  await send({ model: "gpt-5.4-max" })
  const b = f.seen.at(-1).json
  expect([b.function, b.config_name, b.model_name, b.max_tokens, b.user_message_context.model_info.prompt_max_tokens]).toEqual(["chat_v3", "gpt-5.4", "gpt-5.4__max", 128000, 872000])
})

const BATCH = { function_configs: [
  { function: "solo_agent", config_info_list: [
    { config_name: "gpt-5.4", usage: "chat_completion", display_config: { display_name: "GPT-5.4" }, context_window_tokens: { dev: 272000, max: 400000 }, model_detail_list: [{ model_name: "gpt-5.4__dev", max_tokens: 32000 }, { model_name: "gpt-5.4__max", max_tokens: 128000 }] },
    { config_name: "gemini-3-flash", usage: "chat_completion", context_window_tokens: { dev: 200000 }, model_detail_list: [{ model_name: "gemini-3-flash__dev", max_tokens: 32000 }] },
  ] },
] }

test("a model with a Max context is listed a second time, as its Max, which asks Trae's __max model with the prompt it has room for", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json(BATCH))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const p = { models: { ..._internal.MODELS } }
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["gpt-5.4", "gpt-5.4-max", "gemini-3-flash"])
  expect(live["gpt-5.4"].limit).toEqual({ context: 272000, output: 32000 })
  expect(live["gpt-5.4-max"].limit).toEqual({ context: 400000, output: 128000 })
  expect(live["gpt-5.4-max"].name).toBe("GPT-5.4 (Max)")
  const opts = await hooks.auth.loader(async () => signedIn())
  const send = (body) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) })
  await send({ model: "gpt-5.4-max", max_tokens: 100000 })
  let b = f.seen.at(-1).json
  expect([b.function, b.config_name, b.model, b.model_name, b.max_tokens]).toEqual(["solo_agent", "gpt-5.4", "gpt-5.4", "gpt-5.4__max", 100000])
  expect(b.user_message_context).toEqual({ model_info: { prompt_max_tokens: 400000 - 100000 } })
  await send({ model: "gpt-5.4-max" })
  b = f.seen.at(-1).json
  expect([b.model_name, b.max_tokens, b.user_message_context.model_info.prompt_max_tokens]).toEqual(["gpt-5.4__max", 128000, 272000])
  // the model itself is asked as before
  await send({ model: "gpt-5.4" })
  b = f.seen.at(-1).json
  expect([b.model_name, b.user_message_context]).toEqual(["gpt-5.4__dev", undefined])
})

test("an answer the agent walks away from lets Trae's connection go", async () => {
  // the agent reads a tool call's name and leaves the rest of the stream
  // (pi/magpie cancels it to make the call): the read to Trae must close,
  // not hang on and leave the reused host one Trae has dropped. The fake
  // sends nothing more, so only aborting Trae's own fetch can release it —
  // a generator's return can't break a read already waiting.
  let cancelled = false
  f = fakeTrae()
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
  const res = await ask({ model: "gpt-5.4", stream: true, messages: [{ role: "user", content: "hi" }] })
  const reader = res.body.getReader()
  await reader.read() // the opening role chunk
  await reader.read() // "working on it"
  await reader.cancel() // the agent goes away, as making a tool call does
  await new Promise((r) => setTimeout(r, 100))
  expect(cancelled).toBe(true)
})
