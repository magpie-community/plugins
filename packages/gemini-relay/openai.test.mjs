// The OpenAI face, offline: a fake ask (no browser, no network) drives
// both reply shapes. The contract is index.mjs's call site — flatten of
// the request body, completion over the final { text, reasoning }, sse
// over an ask that reports through onUpdate and resolves with the whole.
// The protocol pieces (model table, inner slots, tool fences, session
// continuation) are tested against stub pages — nothing dials out.
import { expect, test } from "bun:test"
import { completion, sse, parseToolCalls } from "./openai.mjs"
import { flatten, lastUserText, TOOL_SYSTEM } from "./prompt.mjs"
import { MODELS, buildInner, modelHeader, thinkingByte, RelaySession, GeminiError, errorFromText } from "./relay.mjs"
import { modelHeaderBin, servedMismatch } from "./webchannel.mjs"
import { SessionPool, historyKey, fullKey } from "./session_pool.mjs"
import { CookieRotator } from "./rotate.mjs"

const newId = () => "call_" + Math.random().toString(36).slice(2, 14)

// ---- a) the model table: the picker's hex ids and mode bytes ----
test("the model table carries the measured hex ids and mode bytes", () => {
  expect(MODELS["gemini-4-hydrogen"]).toMatchObject({ hex: "56fdd199312815e2", mode: 1 })
  expect(MODELS["gemini-3.5-flash-lite"]).toMatchObject({ hex: "cf41b0e0dd7d53e5", mode: 6 })
  expect(MODELS["gemini-4-neon"]).toMatchObject({ hex: "e6fa609c3fa255c0", mode: 3, needsLogin: true })
  expect(MODELS["gemini-4-carbon"]).toMatchObject({ hex: "95a4c0abcba24364", mode: 8, needsLogin: true })
  expect(MODELS["gemini-3.6-flash"]).toMatchObject({ hex: "fbb127bbb056c959", mode: 1 })
  // the old id stays as an alias of 4 Neon
  expect(MODELS["gemini-3.1-pro"].hex).toBe(MODELS["gemini-4-neon"].hex)
  expect(MODELS["gemini-auto"].hex).toBe("")
})

// ---- b) the model header: think bit at 15, two distinct uuids ----
test("modelHeader carries the mode, the thinking depth and its own uuid", () => {
  const h = JSON.parse(modelHeader({ ...MODELS["gemini-4-neon"], think: 2 }))
  expect(h[4]).toBe("e6fa609c3fa255c0")
  expect(h[14]).toBe(3) // the mode byte
  expect(h[15]).toBe(2) // the thinking depth (high)
  expect(typeof h[16]).toBe("string")
  expect(h[16]).toMatch(/[0-9a-f-]{36}/)
  // the header's uuid is its own; buildInner's inner[59] is another one
  const inner = buildInner({ mode: 3, think: 2 })
  expect(h[16]).not.toBe(inner[59])
  // a second header makes a second uuid
  expect(JSON.parse(modelHeader({}))[16]).not.toBe(h[16])
})

test("modelHeaderBin encodes the mode (field 15) and think (field 16)", () => {
  const bin = atob(modelHeaderBin("e6fa609c3fa255c0", 3, 2))
  const bytes = [...bin].map((c) => c.charCodeAt(0))
  expect(bytes[0]).toBe(8)
  expect(bytes[1]).toBe(1)
  expect(bytes[2]).toBe(42) // field 5, the hex id
  expect(bytes[3]).toBe(16)
  expect(bin.includes(String.fromCharCode(0x78, 3))).toBe(true) // field 15 = mode 3
  expect(bin.includes(String.fromCharCode(0x80, 0x01, 2))).toBe(true) // field 16 = think 2
})

// ---- inner slots: the measured layout, mode 8's differences ----
test("buildInner fills the 99-slot request for a temporary chat", () => {
  const inner = buildInner({ prompt: "hi", mode: 1, think: 1 })
  expect(inner.length).toBe(99)
  expect(inner[0][0]).toBe("hi")
  expect(inner[1]).toEqual(["en"])
  expect(inner[2]).toEqual(["", "", "", null, null, null, null, null, null, ""])
  expect(inner[17]).toEqual([[0]])
  expect(inner[45]).toBe(1) // temporary chat
  expect(inner[79]).toBe(1) // the mode
  expect(inner[80]).toBe(1) // normal thinking
  expect(inner[96]).toBe(0)
})

test("buildInner applies 4 Carbon's mode-8 slot differences", () => {
  const inner = buildInner({ mode: 8, think: 1 })
  expect(inner[6]).toEqual([1])
  expect(inner[30]).toEqual([])
  expect(inner[49]).toBe(40)
  expect(inner[68]).toBe(2)
  expect(inner[83]).toBe(1)
  expect(inner[91]).toBe(1)
  expect(inner[96]).toBe(1)
  expect(inner[98]).toBe(1)
  expect(inner[45]).toBe(1)
})

test("buildInner carries the continuation metadata and drops slot 45", () => {
  const inner = buildInner({
    prompt: "next",
    metadata: ["cid1", "rid1", "rc1", null, null, null, null, null, null, "tok26"],
    turn: 3,
    temporary: false,
    mode: 1,
    think: 1,
  })
  expect(inner[2]).toEqual(["cid1", "rid1", "rc1", null, null, null, null, null, null, "tok26"])
  expect(inner[17]).toEqual([[3]])
  expect(inner[45]).toBeFalsy() // a continued turn is an ordinary chat (no slot 45)
})

test("reasoning_effort maps to the thinking byte (low=1, high=2, medium=4)", () => {
  expect(thinkingByte("low")).toBe(1)
  expect(thinkingByte("high")).toBe(2)
  expect(thinkingByte("medium")).toBe(4)
  expect(thinkingByte(undefined)).toBeUndefined()
  // non-normal thinking sets inner[96]
  expect(buildInner({ think: 2 })[96]).toBe(1)
  expect(buildInner({ think: 4 })[96]).toBe(1)
  expect(buildInner({ think: 1 })[96]).toBe(0)
})

// ---- c) tool calls: injection, rendering, parsing ----
test("history flattens into one prompt, systems first, tool context fenced", () => {
  const prompt = flatten([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "42" },
    { role: "user", content: [{ type: "text", text: "now what?" }] },
  ])
  expect(prompt).toContain("[System]\nbe brief")
  expect(prompt).toContain("hi")
  expect(prompt).toContain('```tool_call\n{"name":"f","arguments":{}}\n```')
  expect(prompt).toContain("[Tool result for c1]\n42")
  expect(prompt).toContain("now what?")
  expect(prompt.indexOf("be brief")).toBeLessThan(prompt.indexOf("hi"))
  // empty parts drop out; blank messages leave nothing behind
  expect(flatten([{ role: "user", content: "" }])).toBe("")
  expect(flatten([])).toBe("")
  expect(flatten(undefined)).toBe("")
})

test("declared tools inject the fence protocol at the top of the prompt", () => {
  const prompt = flatten(
    {
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "weather", parameters: {} } }],
    },
  )
  expect(prompt).toContain("[System]\n" + TOOL_SYSTEM)
  expect(prompt).toContain("```tool_call")
  expect(prompt).toContain("weather?")
  // no tools, no protocol
  expect(flatten({ messages: [{ role: "user", content: "hi" }] })).not.toContain("tool_call")
})

test("parseToolCalls extracts fences, tolerates bad JSON, keeps the rest", () => {
  const { calls, text } = parseToolCalls(
    'let me check.\n```tool_call\n{"name":"a","arguments":{"x":1}}\n```\nand\n```tool_call\n{"name":"b","arguments":{"y":2}}\n```\ndone',
  )
  expect(calls).toEqual([
    { name: "a", arguments: '{"x":1}' },
    { name: "b", arguments: '{"y":2}' },
  ])
  expect(text).toBe("let me check.\nand\ndone")
  // a fence that is not JSON keeps its raw text as the arguments
  const bad = parseToolCalls('```tool_call\nnot json at all\n```')
  expect(bad.calls).toEqual([{ name: "", arguments: "not json at all" }])
  expect(bad.text).toBe("")
  // no fences: everything stays text
  const none = parseToolCalls("plain answer")
  expect(none.calls).toEqual([])
  expect(none.text).toBe("plain answer")
})

test("completion turns fences into OpenAI tool_calls with null content", () => {
  const body = completion({
    id: "chatcmpl-t1",
    model: "gemini-4-neon",
    final: { text: '```tool_call\n{"name":"weather","arguments":{"city":"上海"}}\n```', reasoning: "" },
    promptTokens: 5,
  })
  const choice = body.choices[0]
  expect(choice.finish_reason).toBe("tool_calls")
  expect(choice.message.content).toBeNull()
  expect(choice.message.tool_calls).toHaveLength(1)
  const call = choice.message.tool_calls[0]
  expect(call.type).toBe("function")
  expect(call.id).toMatch(/^call_/)
  expect(call.function.name).toBe("weather")
  expect(JSON.parse(call.function.arguments)).toEqual({ city: "上海" })
})

test("completion keeps text alongside tool calls when the model wrote both", () => {
  const body = completion({
    id: "chatcmpl-t2",
    model: "m",
    final: { text: 'checking...\n```tool_call\n{"name":"a","arguments":{}}\n```', reasoning: "" },
    promptTokens: 0,
  })
  expect(body.choices[0].message.content).toBe("checking...")
  expect(body.choices[0].message.tool_calls).toHaveLength(1)
  expect(body.choices[0].finish_reason).toBe("tool_calls")
})

// ---- d) sse: tool_calls arrive as deltas before the finish chunk ----
async function readSSE(res) {
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const text = await res.text()
  const lines = text.split("\n").filter((l) => l.startsWith("data: "))
  return {
    text,
    chunks: lines.slice(0, -1).map((l) => JSON.parse(l.slice(6))),
    done: lines[lines.length - 1],
  }
}

test("sse emits one tool_calls delta per call, then finish_reason tool_calls", async () => {
  const res = await sse({
    id: "chatcmpl-s1",
    model: "gemini-4-neon",
    promptTokens: () => 6,
    signal: new AbortController().signal,
    ask: async (onUpdate) => {
      onUpdate({ text: "checking ", reasoning: "" })
      onUpdate({
        text: 'checking ```tool_call\n{"name":"a","arguments":{"x":1}}\n```\n```tool_call\n{"name":"b","arguments":{}}\n```',
        reasoning: "",
      })
      return { text: 'checking ```tool_call\n{"name":"a","arguments":{"x":1}}\n```\n```tool_call\n{"name":"b","arguments":{}}\n```', reasoning: "" }
    },
  })
  const { chunks, done } = await readSSE(res)
  expect(done).toBe("data: [DONE]")
  const deltas = chunks.map((c) => c.choices[0].delta)
  const toolDeltas = deltas.filter((d) => d.tool_calls)
  expect(toolDeltas).toHaveLength(2)
  expect(toolDeltas[0].tool_calls[0].index).toBe(0)
  expect(toolDeltas[0].tool_calls[0].function.name).toBe("a")
  expect(JSON.parse(toolDeltas[0].tool_calls[0].function.arguments)).toEqual({ x: 1 })
  expect(toolDeltas[1].tool_calls[0].index).toBe(1)
  expect(toolDeltas[1].tool_calls[0].function.name).toBe("b")
  // the content deltas still concatenate to the prose part
  const content = deltas.map((d) => d.content ?? "").join("")
  expect(content).toContain("checking")
  // the finish chunks carry tool_calls, not stop
  const finishes = chunks.map((c) => c.choices[0].finish_reason).filter(Boolean)
  expect(finishes).toEqual(["tool_calls", "tool_calls"])
})

test("sse streams a plain reply as deltas and closes with [DONE]", async () => {
  const res = await sse({
    id: "chatcmpl-s2",
    model: "gemini-3.6-flash",
    promptTokens: () => 6,
    signal: new AbortController().signal,
    ask: async (onUpdate) => {
      onUpdate({ text: "hello world", reasoning: "thinking" })
      return { text: "hello world", reasoning: "thinking" }
    },
  })
  const { chunks, done } = await readSSE(res)
  expect(done).toBe("data: [DONE]")
  const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
  const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content ?? "").join("")
  expect(content).toBe("hello world")
  expect(reasoning).toBe("thinking")
  const last = chunks[chunks.length - 1]
  expect(last.choices[0].finish_reason).toBe("stop")
  expect(last.usage.prompt_tokens).toBe(6)
})

test("sse surfaces an ask failure instead of a silent empty stream", async () => {
  const boom = new Error("Gemini 拒绝了请求")
  await expect(
    sse({ id: "chatcmpl-s3", model: "m", promptTokens: () => 0, newId, ask: async () => { throw boom } }),
  ).rejects.toBe(boom)
})

// ---- sse first-token semantics: the Response is returned before the
// whole answer is ready, so a slow generation cannot trip magpie's
// first-token deadline (the bug "no answer in 1m0s" came from) ----
test("sse returns the Response as soon as the first delta lands, before ask resolves", async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const res = await sse({
    id: "chatcmpl-s4",
    model: "gemini-4-hydrogen",
    promptTokens: () => 3,
    signal: new AbortController().signal,
    ask: async (onUpdate) => {
      onUpdate({ text: "first ", reasoning: "" })
      await gate // the generation runs on well past the first delta
      return { text: "first second", reasoning: "" }
    },
  })
  // the Response is already here while ask() is still awaiting the gate
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  // the first delta was already readable without the gate releasing
  const reader = res.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toContain("first ")
  release({ text: "first second", reasoning: "" })
  const rest = new TextDecoder().decode((await reader.read()).value)
  expect(rest).toContain("second")
})

test("sse holds back a tail that may be the start of a tool_call fence", async () => {
  // two backticks arrive: they may grow into a fence, so they are held
  // until the read proves them prose or completes the fence
  const res = await sse({
    id: "chatcmpl-s5",
    model: "m",
    promptTokens: () => 0,
    signal: new AbortController().signal,
    ask: async (onUpdate) => {
      onUpdate({ text: "code: ``", reasoning: "" })
      return { text: "code: ```js\nx()", reasoning: "" }
    },
  })
  const { chunks } = await readSSE(res)
  const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
  // nothing premature leaked, and the whole text still lands by the end
  expect(content).toBe("code: ```js\nx()")
})

test("sse aborts the relay when the client cancels the stream", async () => {
  const ctl = new AbortController()
  let observed
  const res = await sse({
    id: "chatcmpl-s6",
    model: "m",
    promptTokens: () => 0,
    signal: ctl.signal,
    ask: async (onUpdate, signal) => {
      observed = signal
      onUpdate({ text: "hi", reasoning: "" })
      await new Promise(() => {}) // keeps generating until cancelled
    },
  })
  const reader = res.body.getReader()
  await reader.read() // the first delta
  await reader.cancel()
  // the relay's ask saw the cancel (its own signal, not the request's)
  expect(observed.aborted).toBe(true)
})

// ---- e) session continuation: pool hit sends only the new text ----

// a stub page: answers whatever eval string it is handed, pulling the
// inner request out of it — no browser, no network. Two shapes exist:
// the WebChannel call `return await f("<hex>", <mode>, <depth>, <inner>)`
// and the StreamGenerate call `return f(<inner>, "<hex>")`. In both, the
// first top-level JSON-array argument is the inner request.
function innerOf(expr) {
  const m = expr.match(/return (?:await )?f\(/)
  if (!m) throw new Error("no page call in eval: " + expr.slice(0, 80))
  let i = m.index + m[0].length
  let depth = 0
  let inStr = false
  let esc = false
  let arg = ""
  const args = []
  for (; i < expr.length; i++) {
    const c = expr[i]
    if (inStr) {
      arg += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      arg += c
      continue
    }
    if (c === "[" || c === "{") depth++
    if (c === "]" || c === "}") depth--
    if (c === "," && depth === 0) {
      args.push(arg)
      arg = ""
      continue
    }
    arg += c
    if (c === ")" && depth === 0) break // the call's closing paren
  }
  args.push(arg)
  const raw = args.find((a) => a.trim().startsWith("[["))
  if (!raw) throw new Error("no inner request argument in eval")
  return JSON.parse(raw)
}

function stubPage(plan) {
  return {
    eval: async (expr) => plan.respond(innerOf(expr)),
  }
}

// a stub browser whose ensure() answers the stub page and records closes
function stubBrowser(page) {
  return {
    profileDir: "C:/fake/profile",
    ensure: async () => page,
    started: () => true,
    stop: async () => {},
  }
}

test("a pooled follow-up continues the server conversation: only the new text, no slot 45", async () => {
  const pool = new SessionPool()
  const seen = []
  const page = {
    eval: async (expr) => {
      seen.push(innerOf(expr))
      return {
        served: ["4 Hydrogen"],
        reply: "second answer",
        reasoning: "",
        model: "4 Hydrogen",
        cid: "cid-2",
        rid: "rid-2",
        rcid: "rc-2",
        finalMarker: "tok-2",
      }
    },
  }
  const session = new RelaySession({ browser: stubBrowser(page), pool, accountKey: "acct" })
  const model = MODELS["gemini-4-hydrogen"]
  const firstMessages = [
    { role: "system", content: "sys" },
    { role: "user", content: "first question" },
  ]
  const first = await session.ask(flatten(firstMessages), { model, messages: firstMessages })
  expect(first.text).toBe("second answer")
  expect(seen).toHaveLength(1)
  expect(seen[0][45]).toBe(1) // the first turn is a temporary chat
  expect(seen[0][0][0]).toContain("first question")

  // the second turn's history is the first + the reply + the new question
  const secondMessages = [
    ...firstMessages,
    { role: "assistant", content: "second answer" },
    { role: "user", content: "second question" },
  ]
  const second = await session.ask(flatten(secondMessages), { model, messages: secondMessages })
  expect(second.text).toBe("second answer")
  expect(seen).toHaveLength(2)
  const inner = seen[1]
  expect(inner[45]).toBeFalsy() // a continued turn is not temporary
  expect(inner[2][0]).toBe("cid-2") // the server conversation ids
  expect(inner[2][1]).toBe("rid-2")
  expect(inner[2][2]).toBe("rc-2")
  expect(inner[2][9]).toBe("tok-2") // the previous final marker
  expect(inner[17]).toEqual([[1]]) // the second turn
  expect(inner[0][0]).toBe("second question") // only the new text rides
  expect(inner[0][0]).not.toContain("first question")
})

test("a pool miss (or a failed continuation) falls back to the full temporary chat", async () => {
  const pool = new SessionPool()
  const seen = []
  const page = {
    eval: async (expr) => {
      seen.push(innerOf(expr))
      return { served: ["4 Hydrogen"], reply: "fresh answer", reasoning: "", model: "4 Hydrogen", cid: "c", rid: "r", rcid: "rc", finalMarker: "t" }
    },
  }
  const session = new RelaySession({ browser: stubBrowser(page), pool, accountKey: "acct" })
  const model = MODELS["gemini-4-hydrogen"]
  // no pool entry: the whole history rides a temporary chat
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
  ]
  await session.ask(flatten(messages), { model, messages })
  expect(seen[0][45]).toBe(1)
  expect(seen[0][0][0]).toContain("q1")

  // a continuation the server refuses (1096-style error) falls back to a
  // full temporary resend of the same history
  seen.length = 0
  let calls = 0
  page.eval = async (expr) => {
    seen.push(innerOf(expr))
    calls++
    if (calls === 1) throw new GeminiError("请求被拒绝（错误码 1096）", { code: "request_rejected", status: 400 })
    return { served: ["4 Hydrogen"], reply: "recovered", reasoning: "", model: "4 Hydrogen" }
  }
  const messages2 = [...messages, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }]
  // seed the pool as the first turn would have
  pool.remember([...messages, { role: "assistant", content: "a1" }], { cid: "c", rid: "r", rcid: "rc", tok26: "t", turn: 1 }, { account: "acct", browserKey: "C:/fake/profile", modelKey: model.hex + ":1" })
  const r = await session.ask(flatten(messages2), { model, messages: messages2 })
  expect(r.text).toBe("recovered")
  expect(seen.length).toBe(2)
  expect(seen[0][45]).toBeFalsy() // the continuation attempt
  expect(seen[1][45]).toBe(1) // the fallback rebuilt the temporary chat
  expect(seen[1][0][0]).toContain("q1") // the whole history, flattened
  expect(seen[1][0][0]).toContain("q2")
})

// ---- f) reasoning_effort end to end through the loader ----
test("the loader maps reasoning_effort onto the model's think byte", async () => {
  const { createPlugin } = await import("./index.mjs")
  const { RelaySession: RS } = await import("./relay.mjs")
  const plugin = createPlugin()
  const auth = async () => ({ type: "oauth", access: JSON.stringify({ profileDir: "C:/fake/profile" }) })
  const opts = await plugin.auth.loader(auth)
  const seen = []
  const real = RS.prototype.ask
  RS.prototype.ask = async function (prompt, { model } = {}) {
    seen.push(model)
    return { text: "ok", reasoning: "" }
  }
  try {
    const ask = (extra) =>
      opts.fetch("https://gemini-relay.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-4-neon", messages: [{ role: "user", content: "hi" }], ...extra }),
      })
    for (const effort of ["low", "medium", "high"]) {
      const r = await ask({ reasoning_effort: effort })
      expect(r.status).toBe(200)
    }
    expect(seen.map((m) => m.think)).toEqual([1, 4, 2]) // low, medium, high
    expect(seen.every((m) => m.name === "4 Neon")).toBe(true)
    // the header and the inner slots agree with the requested depth
    expect(JSON.parse(modelHeader(seen[1]))[15]).toBe(4)
    // an unknown depth is a 400, not a silent default
    const bad = await ask({ reasoning_effort: "ultra" })
    expect(bad.status).toBe(400)
    // a valid depth on a model without depths is a 400 too: the client's
    // requested constraint must never be silently ignored
    const notNeon = await opts.fetch("https://gemini-relay.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
    })
    expect(notNeon.status).toBe(400)
    // unset stays the app's own default
    const plain = await ask({})
    expect(plain.status).toBe(200)
    expect(seen[seen.length - 1].think).toBeUndefined()
  } finally {
    RS.prototype.ask = real
  }
  await plugin.dispose()
})

// ---- the plugin's shape, offline ----
test("the plugin's shape serves config, models and a loader fetch", async () => {
  const { createPlugin } = await import("./index.mjs")
  const plugin = createPlugin()
  const cfg = { provider: {} }
  await plugin.config(cfg)
  expect(cfg.provider["gemini-relay"]).toBeTruthy()
  expect(plugin.auth.provider).toBe("gemini-relay")
  expect(plugin.provider.id).toBe("gemini-relay")
  // a visitor's catalog is the anonymous Auto only; a signed-in profile's
  // catalog is the full table
  const ms = await plugin.provider.models({}, { auth: { access: "anonymous" } })
  expect(Object.keys(ms)).toEqual(["gemini-auto"])
  const msAuthed = await plugin.provider.models({}, { auth: { access: JSON.stringify({ profileDir: "x" }) } })
  expect(Object.keys(msAuthed).length).toBeGreaterThan(3)
  // the loader answers with a fetch for the chat/completions route
  const opts = await plugin.auth.loader(async () => ({ type: "oauth", access: "anonymous" }))
  expect(typeof opts.fetch).toBe("function")
  const miss = await opts.fetch("https://gemini-relay.invalid/v1/other", { method: "POST" })
  expect(miss.status).toBe(404)
  const bad = await opts.fetch("https://gemini-relay.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  })
  expect(bad.status).toBe(400)
  const unknown = await opts.fetch("https://gemini-relay.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
  })
  expect(unknown.status).toBe(404)
  await plugin.dispose()
})

test("the loader's fetch answers a chat request through a stubbed ask", async () => {
  const { createPlugin } = await import("./index.mjs")
  const { RelaySession: RS } = await import("./relay.mjs")
  const plugin = createPlugin()
  const auth = async () => ({ type: "oauth", access: JSON.stringify({ profileDir: "C:/fake/profile" }) })
  const opts = await plugin.auth.loader(auth)
  const calls = []
  const real = RS.prototype.ask
  RS.prototype.ask = async function (prompt, { model, signal, strictModel, messages } = {}) {
    calls.push({ prompt, model: model?.name, strictModel, continued: Array.isArray(messages) && messages.length > 1 })
    return { text: "17*23 = 391", reasoning: "" }
  }
  try {
    const body = {
      model: "gemini-4-neon",
      messages: [
        { role: "system", content: "You are a calculator. Answer with just the number." },
        { role: "user", content: "What is 17*23?" },
      ],
    }
    const whole = await opts.fetch("https://gemini-relay.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
    })
    expect(whole.status).toBe(200)
    const data = await whole.json()
    expect(data.object).toBe("chat.completion")
    expect(data.choices[0].message.content).toBe("17*23 = 391")
    expect(data.choices[0].finish_reason).toBe("stop")
    expect(calls[0].strictModel).toBe(true) // strict by default
    expect(calls[0].prompt).toContain("What is 17*23?")
    expect(calls[0].prompt).toContain("[System]")

    calls.length = 0
    const streamed = await opts.fetch("https://gemini-relay.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    })
    expect(streamed.status).toBe(200)
    expect(streamed.headers.get("content-type")).toBe("text/event-stream")
    const text = await streamed.text()
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    expect(text).toContain("17*23 = 391")
    expect(calls.length).toBe(1)
  } finally {
    RS.prototype.ask = real
  }
  await plugin.dispose()
})

// ---- error code mapping ----
test("server error codes map onto OpenAI-shaped failures", () => {
  const cases = [
    ["错误码 1037", 429, "usage_limit_exceeded"],
    ["code 1052", 400, "model_header_invalid"],
    ["1060", 403, "ip_blocked"],
    ["1096", 400, "request_rejected"],
    ["1013", 502, "temporary_error"],
  ]
  for (const [text, status, code] of cases) {
    const e = errorFromText(`Gemini 拒绝了请求：出错了 [${text}]`)
    expect(e).toBeInstanceOf(GeminiError)
    expect(e.status).toBe(status)
    expect(e.code).toBe(code)
  }
  // the __sm__ statuses map too
  expect(errorFromText('{"__sm__":{"status":16}}').status).toBe(401)
  expect(errorFromText('{"__sm__":{"status":7}}').code).toBe("api_key_invalid")
  // an unmapped error stays unmapped
  expect(errorFromText("something else")).toBeNull()
})

test("servedMismatch holds the tier check per mode", () => {
  expect(servedMismatch(["4 Hydrogen"], MODELS["gemini-4-hydrogen"])).toBeNull()
  expect(servedMismatch(["4 Neon"], MODELS["gemini-4-neon"])).toBeNull()
  expect(servedMismatch(["4 Carbon"], MODELS["gemini-4-carbon"])).toBeNull()
  expect(servedMismatch(["3.5 Flash-Lite"], MODELS["gemini-3.5-flash-lite"])).toBeNull()
  expect(servedMismatch(["4 Hydrogen"], MODELS["gemini-4-neon"])).toContain("降级")
  expect(servedMismatch(["anything"], MODELS["gemini-auto"])).toBeNull() // auto exempt
})

// ---- the session pool itself ----
test("the session pool keys, binds and invalidates conversations", () => {
  const pool = new SessionPool()
  const msgs1 = [{ role: "user", content: "a" }]
  const msgs2 = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]
  const binding = { account: "acct", browserKey: "br", modelKey: "hex:1" }
  expect(pool.find(msgs2, binding)).toBeNull()
  pool.remember(msgs2, { cid: "c", rid: "r", rcid: "rc", tok26: "t", turn: 1 }, binding)
  // a lookup drops the trailing user turn: the history before it matches
  const hit = pool.find([...msgs2, { role: "user", content: "c" }], binding)
  expect(hit).toMatchObject({ cid: "c", rid: "r", rcid: "rc", tok26: "t", turn: 1 })
  // another account/browser/model cannot reuse it
  expect(pool.find([...msgs2, { role: "user", content: "c" }], { ...binding, account: "other" })).toBeNull()
  // invalidation makes the next lookup a miss
  pool.invalidate(msgs2)
  expect(pool.find([...msgs2, { role: "user", content: "c" }], binding)).toBeNull()
  // the keys are stable and content-dependent
  expect(fullKey(msgs1)).toBe(fullKey([{ role: "user", content: "a" }]))
  expect(fullKey(msgs1)).not.toBe(fullKey(msgs2))
  expect(historyKey(msgs2)).toBe(fullKey(msgs1)) // history = all but last
})

// ---- the cookie rotator (timer logic, no network) ----
test("the cookie rotator schedules, guards and stops without firing early", async () => {
  let calls = 0
  const rotator = new CookieRotator({
    page: { eval: async () => { calls++; return { status: 200 } } },
    cookies: async () => ({ "__Secure-1PSIDTS": "v" + calls }),
    intervalMs: 50,
    jitterMs: 5,
    minGapMs: 0, // the test's short cycle is not throttled
  })
  rotator.start()
  await new Promise((r) => setTimeout(r, 180))
  await rotator.stop()
  expect(calls).toBeGreaterThanOrEqual(2) // it re-arms itself
  const after = calls
  await new Promise((r) => setTimeout(r, 120))
  expect(calls).toBe(after) // stop() ends the cycle
})

test("the cookie rotator reports a 401 through onError and guards double-fire", async () => {
  const errors = []
  let calls = 0
  const rotator = new CookieRotator({
    page: { eval: async () => { calls++; return { status: 401 } } },
    cookies: async () => ({}),
    intervalMs: 50,
    jitterMs: 5,
    onError: (e) => errors.push(String(e.message)),
  })
  await rotator.rotateOnce()
  expect(calls).toBe(1)
  expect(errors[0]).toContain("401")
  // the 60s guard: an immediate second call does not hit the page again
  await rotator.rotateOnce()
  expect(calls).toBe(1)
  await rotator.stop()
})

// ---- lastUserText: what a continuation sends ----
test("lastUserText answers only the newest user message", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]
  expect(lastUserText(messages)).toBe("second")
  expect(lastUserText([{ role: "user", content: "only" }])).toBe("only")
  expect(lastUserText([])).toBe("")
  // an image part degrades to the placeholder, as flatten does
  expect(lastUserText([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] }])).toContain("图片")
})
