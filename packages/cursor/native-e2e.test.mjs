import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import http2 from "node:http2"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { CursorAuthPlugin, _internal } from "./index.mjs"
import { NATIVE_LIMITS, nativeSessions } from "./native-session.mjs"
import { message, bin, text, uint, readWire, nest, number, string, envelope, update, end, tool, setBlob, getBlob, checkpoint, abortExec, readResult } from "./native-test-wire.mjs"

const savedFetch = globalThis.fetch
const limits = { ...NATIVE_LIMITS }
const agents = []
beforeEach(async () => { await nativeSessions.clear() })
afterEach(async () => {
  await nativeSessions.clear()
  for (const a of agents.splice(0)) {
    for (const timer of a.timers) clearTimeout(timer)
    for (const s of a.sessions) s.destroy()
    await new Promise((r) => a.server.close(r))
  }
  globalThis.fetch = savedFetch
  for (const key of Object.keys(NATIVE_LIMITS)) if (!(key in limits)) delete NATIVE_LIMITS[key]
  Object.assign(NATIVE_LIMITS, limits)
})
const until = async (predicate) => {
  const deadline = Date.now() + 1200
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach its expected state")
    await new Promise((r) => setTimeout(r, 5))
  }
}
const auth = () => ({ type: "oauth", access: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, sub: "synthetic-" + randomUUID() })).toString("base64url")}.fixture`, refresh: "", accountId: "fixture@example.invalid" })
const tools = [{ type: "function", function: { name: "audit_echo", description: "synthetic echo", parameters: { type: "object", properties: { value: { type: "string" } } } } }]
const initial = (extra = {}) => ({ model: "fixture-model", tools, messages: [{ role: "system", content: "synthetic instructions" }, { role: "user", content: "perform two synthetic calls" }], ...extra })
const continueWith = (chat, reply, values) => ({
  ...chat,
  messages: [...chat.messages, reply.choices[0].message, ...reply.choices[0].message.tool_calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: values[i] }))],
})
const choice = (response) => response.body.choices[0]

// The fake only advances on an independently decoded native McpResult followed
// by the numeric exec close. Replaying a Chat transcript in a fresh Run cannot
// make the second call or final answer succeed.
async function agent(options = {}) {
  const firstID = options.omitZeroID ? 0 : 7
  const a = { runs: [], results: [], closes: [], kv: [], errors: [], sessions: new Set(), timers: [], closedStreams: 0 }
  a.server = http2.createServer()
  a.server.on("session", (s) => { a.sessions.add(s); s.on("error", () => {}); s.on("close", () => a.sessions.delete(s)) })
  a.server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.on("close", () => a.closedStreams++)
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buffer = Buffer.alloc(0)
    let began = false
    let phase = 0
    const received = new Map()
    const closed = new Set()
    let marker = ""
    const send = (b) => { if (!stream.destroyed && !stream.closed) stream.write(b) }
    a.push = send
    const delay = (fn, ms = 20) => a.timers.push(setTimeout(() => { if (!stream.destroyed && !stream.closed) fn() }, ms))
    const state = (pending, terminal = false) => {
      const root = Buffer.from("fixture-root")
      const user = Buffer.from("fixture-user")
      const thinking = Buffer.from("fixture-thinking-" + phase)
      const turn = Buffer.from("fixture-turn")
      const callID = "call_a\nfc_b"
      const step = bin(3, message(text(1, "server-generated thinking phase " + phase), uint(2, 11)))
      const stepRefs = [thinking]
      const extras = []
      if (terminal) {
        const call = Buffer.from("fixture-tool-step")
        const final = Buffer.from("fixture-answer-step")
        const nativeArgs = message(text(1, "magpie-audit_echo"), text(3, callID), text(4, "magpie"), text(5, "audit_echo"))
        const success = bin(1, bin(1, bin(1, text(1, marker))))
        extras.push([call, bin(2, bin(15, message(bin(1, nativeArgs), bin(2, success))))], [final, bin(1, text(1, marker))])
        stepRefs.push(call, final)
      }
      const turnBytes = bin(1, message(bin(1, user), ...stepRefs.map((id) => bin(2, id))))
      const stateBytes = message(bin(1, root), bin(8, turn), ...(pending ? [text(4, callID)] : []), uint(10, 1), text(22, "cli"))
      send(checkpoint(stateBytes)) // a candidate before its reference closure
      delay(() => {
        const blobs = [[root, Buffer.from('{"role":"system","content":"synthetic root"}')], [user, text(1, "synthetic input")], [thinking, step], ...extras, [turn, turnBytes]]
        for (const [i, [id, b]] of blobs.entries()) send(setBlob(100 + phase * 10 + i, id, b))
        send(getBlob(199 + phase * 10, thinking))
      }, options.stateDelay ?? 20)
    }
    const first = () => {
      if (options.stallInitial) return
      send(update(4, text(1, options.initialReasoning ?? "native planning one")))
      if (options.toolDisplay) {
        const at = Math.floor(options.toolDisplay.length / 2)
        send(update(1, text(1, options.toolDisplay.slice(0, at))))
        send(update(1, text(1, options.toolDisplay.slice(at))))
      }
      if (options.thinkingOnly) return
      if (options.progressiveFinal || options.finalOnly) {
        send(update(1, text(1, "progressive answer")))
        a.finish = () => {
          send(update(14, message(uint(1, 23), uint(2, 7), uint(3, 10), uint(4, 0))))
          stream.end(end())
        }
        if (options.finalOnly) a.finish()
        return
      }
      const count = options.parallel || options.truncated ? 2 : 1
      const listed = () => { if (!options.noCount) send(update(27, uint(1, count))) }
      if (!options.countAfter) listed()
      const c = options.execMessage ? envelope(bin(2, options.execMessage)) : tool(firstID, "call_a\nfc_b", "seed", { ...options, omitID: options.omitZeroID })
      send(c)
      if (options.duplicate) send(c)
      if (options.parallel) send(tool(8, "call_a__fc_b", "other"))
      if (options.countAfter) listed()
      if (options.truncated) return stream.end(end())
      state(true)
      if (options.serverAbort) delay(() => send(abortExec(7)), 35)
    }
    const advance = () => {
      const expected = phase === 0 && options.parallel ? [firstID, 8] : [phase === 0 ? firstID : 8]
      if (!expected.every((id) => closed.has(id))) return
      if (phase === 0 && !options.parallel && !options.finalAfterFirst) {
        marker = received.get(firstID).content[0].text
        phase = 1
        send(update(4, text(1, "native planning two")))
        send(tool(8, "call_a__fc_b", marker)) // call-before-count in phase two
        send(update(27, uint(1, 1)))
        state(true)
        return
      }
      marker = options.finalAfterFirst ? received.get(firstID).content[0].text : options.parallel ? [7, 8].map((id) => received.get(id).content[0].text).join("|") : received.get(8).content[0].text
      phase = 2
      if (options.stallFinal) return
      send(update(4, text(1, "native final thinking")))
      send(update(1, text(1, marker)))
      const usage = options.zeroUsage ? message(uint(1, 0), uint(2, 0), uint(5, 0)) : message(uint(1, 23), uint(2, 7), uint(3, 10), uint(4, 0), uint(5, 4))
      send(update(14, usage))
      state(false, true) // late state after TurnEnded must still be retained
      if (!options.noEnd) delay(() => stream.end(end()), 55)
    }
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
          const n = buffer.readUInt32BE(1)
          const b = buffer.subarray(5, 5 + n)
          buffer = buffer.subarray(5 + n)
          const fs = readWire(b)
          if (fs.some((f) => f.no === 1)) {
            if (began) throw new Error("more than one RunRequest on retained transport")
            began = true
            a.runs.push(nest(b, 1))
            first()
          } else if (fs.some((f) => f.no === 2)) {
            const r = readResult(b)
            if (received.has(r.id)) throw new Error("duplicate native result submission")
            if (r.execID !== "exec-" + r.id || r.content[0]?.type !== "text") throw new Error("incorrect native result routing/content")
            received.set(r.id, r)
            a.results.push(r)
          } else if (fs.some((f) => f.no === 5)) {
            const control = nest(b, 5)
            const close = readWire(control).find((f) => f.no === 1)
            if (!close) continue
            const id = number(close.data, 1)
            if (!received.has(id)) throw new Error("exec close arrived before McpResult")
            if (closed.has(id)) throw new Error("duplicate exec close")
            closed.add(id)
            a.closes.push(id)
            advance()
          } else if (fs.some((f) => f.no === 3)) {
            const kv = nest(b, 3)
            a.kv.push({ id: number(kv, 1), fields: readWire(kv) })
          }
        }
      } catch (e) {
        a.errors.push(e.message)
        if (!stream.destroyed) stream.end(envelope(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: e.message } })), 2))
      }
    })
  })
  await new Promise((r) => a.server.listen(0, "127.0.0.1", r))
  a.base = `http://127.0.0.1:${a.server.address().port}`
  agents.push(a)
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: a.base } })
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: [{ modelId: "fixture-model", displayName: "Synthetic" }] })
    if (u.endsWith("/aiserver.v1.AiService/AvailableModels") && options.picker) return Response.json({ models: options.picker })
    throw new Error("unexpected fake API request: " + u)
  }
  a.firstID = firstID
  a.ask = async (account, chat, { signal, session = "fixture-session" } = {}) => {
    const plugin = await CursorAuthPlugin()
    const loader = await plugin.auth.loader(async () => account)
    const res = await loader.fetch(a.base + "/v1/chat/completions", { method: "POST", headers: { "x-magpie-cursor-session": session }, body: JSON.stringify(chat), signal })
    if (chat.stream) return res
    return { status: res.status, body: await res.json(), diagnostic: res.headers.get("X-Magpie-Cursor-Continuity") }
  }
  return a
}

async function twoRounds(a, account, chat = initial(), options) {
  const first = await a.ask(account, chat, options)
  expect(first.status).toBe(200)
  expect(choice(first).finish_reason).toBe("tool_calls")
  const firstRuns = a.runs.length
  const marker = "synthetic-" + randomUUID() + "\n精确结果"
  const secondChat = continueWith(chat, first.body, [marker])
  const second = await a.ask(account, secondChat)
  expect(second.status).toBe(200)
  expect(choice(second).finish_reason).toBe("tool_calls")
  expect(JSON.parse(choice(second).message.tool_calls[0].function.arguments)).toEqual({ value: marker })
  const secondRuns = a.runs.length
  const finalChat = continueWith(secondChat, second.body, [marker])
  const final = await a.ask(account, finalChat)
  expect(final.status).toBe(200)
  expect(choice(final).finish_reason).toBe("stop")
  expect(choice(final).message.content).toBe(marker)
  expect(choice(final).message.tool_calls).toBeUndefined()
  expect(a.runs).toHaveLength(1)
  expect([firstRuns, secondRuns - firstRuns, a.runs.length - secondRuns]).toEqual([1, 0, 0])
  expect(a.results.map((r) => r.id)).toEqual([a.firstID, 8])
  expect(a.closes).toEqual([a.firstID, 8])
  expect(a.results.every((r) => r.content[0].text === marker)).toBe(true)
  expect(a.errors).toEqual([])
  return { first, second, final, finalChat, secondChat, marker }
}

// Generated offline by Cursor CLI 2026.08.11-e8db854's actual
// ExecServerMessage serializer with id=0; it omits nonoptional scalar field 1.
const ZERO_EXEC = Buffer.from("5a370a116d61677069652d61756469745f6563686f1a0e73796e7468657469632d63616c6c22066d61677069652a0a61756469745f6563686f7a1373796e7468657469632d657865632d7a65726f", "hex")

test("native exec: actual descriptor golden omits id=0 and routes to numeric zero", () => {
  expect(readWire(ZERO_EXEC).some((f) => f.no === 1)).toBe(false)
  const call = _internal.exec(ZERO_EXEC, [{ name: "audit_echo" }], () => { throw new Error("unexpected native write") }, () => {}, null, true)
  expect(call).toMatchObject({ requestID: 0, execID: "synthetic-exec-zero", nativeID: "synthetic-call", name: "audit_echo", args: "{}" })
})

test("native exec: malformed explicit id is rejected instead of defaulting to zero", () => {
  for (const id of [bin(1, Buffer.from([0])), uint(1, 2 ** 32)]) {
    expect(() => _internal.exec(message(id, ZERO_EXEC), [{ name: "audit_echo" }], () => {}, () => {}, null, true)).toThrow("invalid native exec request ID")
  }
})

test("native HTTP/2: omitted-zero exec ID survives two result roundtrips on one Run", async () => {
  const a = await agent({ omitZeroID: true })
  const { final } = await twoRounds(a, auth())
  expect(final.body.usage.prompt_tokens_details).toEqual({ cached_tokens: 10, cache_write_tokens: 0 })
  expect(a.results[0].execID).toBe("exec-0")
})

test("native loader: instructions/images/all last-user text reach buildRun and advisories/effective model reach the caller", async () => {
  const a = await agent()
  const png = Buffer.from("89504e470d0a1a0a", "hex")
  const chat = initial({ temperature: 0.2, max_tokens: 100, messages: [
    { role: "system", content: "Original instruction." },
    { role: "user", content: "Old question." },
    { role: "assistant", content: "Old answer.", reasoning_text: "Old thinking." },
    { role: "developer", content: "Later instruction." },
    { role: "user", content: [{ type: "text", text: "First text." }, { type: "image_url", image_url: { url: "data:image/png;base64," + png.toString("base64") } }, { type: "text", text: "Last text." }] },
  ] })
  const first = await a.ask(auth(), chat)
  expect(first.status).toBe(200)
  const owner = [...nativeSessions.entries][0]
  const state = nest(a.runs[0], 1)
  const transcript = readWire(state).filter((f) => f.no === 1).map((f) => JSON.parse(owner.blobs.get(f.data.toString("hex")).toString()))
  expect(transcript.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "system", "user"])
  expect(transcript[4].content).toBe("Later instruction.")
  expect(transcript[3].content[0]).toEqual({ type: "reasoning", text: "Old thinking." })
  expect(transcript[5].content[1].image.hex).toBe(png.toString("hex"))
  const turn = owner.blobs.get(nest(state, 8).toString("hex"))
  const user = owner.blobs.get(nest(nest(turn, 1), 1).toString("hex"))
  expect(string(user, 1)).toBe("First text.Last text.")
  const diagnostic = first.body.magpie_cursor
  expect(diagnostic.effective_model).toEqual({ id: "fixture-model", parameters: [], max_mode: false })
  expect(diagnostic.advisories.map((d) => [d.field, d.enforced])).toEqual([["temperature", false], ["max_tokens", false], ["messages[3].role", false]])
  expect(diagnostic.advisories.find((d) => d.field === "max_tokens").message).toContain("NOT enforced")
  expect(owner.chat.temperature).toBeUndefined()
  expect(owner.chat.max_tokens).toBeUndefined()
})

test("native loader: unsupported options and remote images reject before opening a Run", async () => {
  const a = await agent()
  for (const options of [
    { response_format: { type: "json_object" } }, { seed: 1 }, { stop: "END" },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://synthetic-secret@image.invalid/a.png" } }] }] },
  ]) {
    const result = await a.ask(auth(), initial(options))
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe("invalid_chat_request")
    expect(result.body.error.param).toBeDefined()
    expect(result.body.error.message).not.toContain("synthetic-secret")
  }
  expect(a.runs).toHaveLength(0)
  expect(nativeSessions.entries.size).toBe(0)
})

test("native loader: served off capability reaches the catalog, native request, and response diagnostics", async () => {
  const en = (...values) => ({ enumParameter: { values: values.map((value) => ({ value })) } })
  const variant = (values, legacySlug, isDefaultNonMaxConfig = false) => ({ parameterValues: Object.entries(values).map(([id, value]) => ({ id, value })), legacySlug, isDefaultNonMaxConfig })
  const picker = [
    { name: "claude-opus-5-5", supportsNonMaxMode: true, parameterDefinitions: [{ id: "context", parameterType: en("300k") }, { id: "effort", parameterType: en("low", "high") }],
      variants: [variant({ context: "300k", effort: "high" }, "claude-opus-5-5-high", true)] },
    { name: "claude-sonnet-5-5", supportsNonMaxMode: true, parameterDefinitions: [{ id: "context", parameterType: en("300k") }, { id: "reasoning_effort", parameterType: en("low", "high") }],
      variants: [variant({ context: "300k", reasoning_effort: "high" }, "claude-sonnet-5-5-high", true)] },
    { name: "claude-haiku-5-5", supportsNonMaxMode: true, parameterDefinitions: [{ id: "context", parameterType: en("300k") }, { id: "thinking", parameterType: en("false", "true") }, { id: "reasoning_effort", parameterType: en("low", "high") }],
      variants: [variant({ thinking: "true", context: "300k", reasoning_effort: "high" }, "claude-haiku-5-5-thinking-high", true), variant({ thinking: "false", context: "300k", reasoning_effort: "high" }, "claude-haiku-5-5-high")] },
  ]
  const a = await agent({ picker, finalOnly: true })
  const account = auth()
  const plugin = await CursorAuthPlugin()
  const catalog = await plugin.provider.models({ models: {} }, { auth: account })
  expect(catalog["claude-opus-5-5@300k"].variants.none).toBeUndefined()
  expect(catalog["claude-sonnet-5-5@300k"].variants.none).toBeUndefined()
  expect(catalog["claude-haiku-5-5@300k"].variants.none).toEqual({ reasoningEffort: "none" })
  for (const model of ["claude-opus-5-5@300k", "claude-sonnet-5-5@300k"])
    for (const reasoning_effort of ["none", "off"]) {
      const rejected = await a.ask(account, initial({ model, reasoning_effort }))
      expect(rejected.status).toBe(400)
      expect(rejected.body.error).toMatchObject({ code: "unsupported_reasoning_effort", param: "reasoning_effort" })
    }
  expect(a.runs).toHaveLength(0)
  expect(nativeSessions.entries.size).toBe(0)
  const accepted = await a.ask(account, initial({ model: "claude-haiku-5-5@300k", reasoning_effort: "off" }))
  expect(accepted.status).toBe(200)
  expect(a.runs).toHaveLength(1)
  const requested = nest(a.runs[0], 9)
  expect(string(requested, 1)).toBe("claude-haiku-5-5-high")
  const params = readWire(requested).filter((f) => f.no === 3).map((f) => ({ id: string(f.data, 1), value: string(f.data, 2) }))
  expect(Object.fromEntries(params.map((p) => [p.id, p.value]))).toEqual({ thinking: "false", context: "300k", reasoning_effort: "high" })
  expect(accepted.body.magpie_cursor.effective_model).toEqual({ id: "claude-haiku-5-5-high", parameters: params, max_mode: false })
  expect(accepted.body.magpie_cursor.advisories).toEqual([])
})

test("native loader: exact thinking-only high/off mappings avoid fitted advisories while low/xhigh remain disclosed", async () => {
  const variant = (thinking, legacySlug, isDefaultNonMaxConfig = false) => ({ parameterValues: [{ id: "thinking", value: thinking }], legacySlug, isDefaultNonMaxConfig })
  const picker = [{ name: "synthetic-thinking-only", supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "thinking", parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } } }],
    variants: [variant("true", "synthetic-thinking-on", true), variant("false", "synthetic-thinking-off")],
  }]
  const a = await agent({ picker, finalOnly: true })
  const account = auth()
  for (const effort of ["high", "none", "low", "xhigh"]) {
    const response = await a.ask(account, initial({ model: "synthetic-thinking-only", reasoning_effort: effort }))
    expect(response.status).toBe(200)
    const expected = effort === "none" ? "false" : "true"
    expect(response.body.magpie_cursor.effective_model.parameters).toEqual([{ id: "thinking", value: expected }])
    const advisories = response.body.magpie_cursor.advisories.filter((a) => a.code === "reasoning_effort_fitted")
    expect(advisories).toHaveLength(["high", "none"].includes(effort) ? 0 : 1)
    if (advisories.length) expect(advisories[0]).toMatchObject({ field: "reasoning_effort", enforced: false })
  }
  expect(a.runs).toHaveLength(4)
})

test("native loader: real matched tool result preserves text/image/text and isError on the same exec", async () => {
  const a = await agent()
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  const png = Buffer.from("89504e470d0a1a0a", "hex")
  const next = continueWith(chat, first.body, [[{ type: "text", text: "before" }, { type: "image_url", image_url: { url: "data:image/png;base64," + png.toString("base64") } }, { type: "text", text: "after" }]])
  next.messages.at(-1).isError = true
  const second = await a.ask(account, next)
  expect(second.status).toBe(200)
  expect(a.results[0]).toEqual({ id: 7, execID: "exec-7", isError: true, content: [
    { type: "text", text: "before" }, { type: "image", data: png, mimeType: "image/png" }, { type: "text", text: "after" },
  ] })
  expect(a.runs).toHaveLength(1)
})

// Saved output from an actual offline invocation of Pi's installed converter.
// The fixture records its source SHA and compatibility options; tests never
// load the installed SDK or access authentication/configuration.
const PI_CONVERTER = JSON.parse(readFileSync(new URL("./testdata/pi-screenshot-converter.json", import.meta.url), "utf8"))
const PI_SCREENSHOT = PI_CONVERTER.messages.at(-1).content[1].image_url.url.slice("data:image/png;base64,".length)
const piAttachment = (images) => {
  const message = structuredClone(PI_CONVERTER.messages.at(-1))
  if (images) message.content = [message.content[0], ...images]
  return message
}

test("native loader: saved actual Pi converter messages complete one screenshot Run", async () => {
  const messages = structuredClone(PI_CONVERTER.messages)
  const a = await agent({ name: "screenshot", omitArguments: true, initialReasoning: messages[1].reasoning_content, finalAfterFirst: true })
  const account = auth()
  const screenshotTools = [{ type: "function", function: { name: "screenshot", parameters: { type: "object", properties: {}, additionalProperties: false } } }]
  const chat = initial({ tools: screenshotTools, messages: [messages[0]] })
  const first = await a.ask(account, chat)
  expect(first.status).toBe(200)
  const call = choice(first).message.tool_calls[0]
  expect(call.function).toEqual(messages[1].tool_calls[0].function)
  expect(choice(first).message.reasoning_content).toBe(messages[1].reasoning_content)
  // Only the Run-owned handle changes. Content, call arguments/name and the
  // complete converter-produced user/assistant/tool/user payload are retained.
  messages[1].tool_calls[0].id = call.id
  messages[2].tool_call_id = call.id
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"])
  const final = await a.ask(account, { ...chat, messages })
  expect(final.body.error).toBeUndefined()
  expect(final.status).toBe(200)
  expect(choice(final).finish_reason).toBe("stop")
  expect(choice(final).message.content).toBe(messages[2].content)
  expect(choice(final).message.tool_calls).toBeUndefined()
  expect(a.results).toEqual([{ id: 7, execID: "exec-7", isError: false, content: [
    { type: "text", text: messages[2].content },
    { type: "image", data: Buffer.from(PI_SCREENSHOT, "base64"), mimeType: "image/png" },
  ] }])
  expect(a.closes).toEqual([7])
  expect(a.runs).toHaveLength(1)
  expect(a.errors).toEqual([])
})
test("native loader: exact Pi screenshot suffix joins one complete result, keeps image order/error flag, and continues one Run", async () => {
  const a = await agent()
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  const next = continueWith(chat, first.body, ["Synthetic screenshot captured."])
  next.messages.at(-1).is_error = true
  const gif = Buffer.from("GIF89a synthetic image")
  next.messages.push(piAttachment([
    { type: "image_url", image_url: { url: "data:image/png;base64," + PI_SCREENSHOT } },
    { type: "image_url", image_url: { url: "data:image/gif;base64," + gif.toString("base64") } },
  ]))
  const before = JSON.stringify(next)
  const second = await a.ask(account, next)
  expect(second.status).toBe(200)
  expect(JSON.stringify(next)).toBe(before)
  expect(a.results[0]).toEqual({ id: 7, execID: "exec-7", isError: true, content: [
    { type: "text", text: "Synthetic screenshot captured." },
    { type: "image", data: Buffer.from(PI_SCREENSHOT, "base64"), mimeType: "image/png" },
    { type: "image", data: gif, mimeType: "image/gif" },
  ] })
  const replay = await a.ask(account, next)
  expect(replay.status).toBe(200)
  expect(replay.body.usage.total_tokens).toBe(0)
  const final = await a.ask(account, continueWith(next, second.body, ["screenshot checked"]))
  expect(final.status).toBe(200)
  expect(a.runs).toHaveLength(1)
  expect(a.results.map((r) => r.id)).toEqual([7, 8])
})

test("native loader: Pi parallel screenshot aggregation rejects field-specifically without guessing result ownership", async () => {
  const a = await agent({ parallel: true })
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  const next = continueWith(chat, first.body, ["left", "right"])
  next.messages.push(piAttachment())
  const rejected = await a.ask(account, next)
  expect(rejected.status).toBe(400)
  expect(rejected.body.error.param).toBe(`messages[${next.messages.length - 1}].content`)
  expect(rejected.body.error.message).toContain("parallel")
  expect(a.results).toEqual([])
  const explicit = continueWith(chat, first.body, ["left", [{ type: "text", text: "right" }, piAttachment().content[1]]])
  expect((await a.ask(account, explicit)).status).toBe(200)
  expect(a.results[0].content).toEqual([{ type: "text", text: "left" }])
  expect(a.results[1].content[1]).toEqual({ type: "image", data: Buffer.from(PI_SCREENSHOT, "base64"), mimeType: "image/png" })
  expect(a.runs).toHaveLength(1)
})

for (const kind of ["changed marker", "extra user text", "incomplete batch"]) test(`native loader: Pi suffix normalization keeps ${kind} blocked while results are pending`, async () => {
  const a = await agent({ parallel: kind === "incomplete batch" })
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  const next = continueWith(chat, first.body, kind === "incomplete batch" ? ["left", "right"] : ["captured"])
  if (kind === "incomplete batch") next.messages.pop()
  const suffix = piAttachment()
  if (kind === "changed marker") suffix.content[0].text = "A genuine new user screenshot request."
  if (kind === "extra user text") suffix.content.push({ type: "text", text: "Please branch this request." })
  next.messages.push(suffix)
  expect([400, 409]).toContain((await a.ask(account, next)).status)
  expect(a.results).toEqual([])
  expect(a.runs).toHaveLength(1)
})

for (const representation of ["empty-array", "text-parts", "reasoning-parts", "split-pieces"]) test(`native loader: canonical assistant ${representation} matches current output and accepted history`, async () => {
  const a = await agent({ toolDisplay: representation === "empty-array" ? "" : "First piece.Second piece." })
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  const next = continueWith(chat, first.body, ["canonical display"])
  const assistant = next.messages.at(-2)
  const text = assistant.content, reasoning = assistant.reasoning_content
  if (representation === "empty-array") assistant.content = []
  else if (representation === "text-parts") assistant.content = [{ type: "text", text: text.slice(0, 5) }, { type: "text", text: text.slice(5) }]
  else if (representation === "reasoning-parts") {
    assistant.content = [{ type: "reasoning", text: reasoning }, { type: "text", text }]
    delete assistant.reasoning_content
  } else {
    next.messages.splice(-2, 1,
      { role: "assistant", content: text.slice(0, 5), reasoning_content: reasoning.slice(0, 5) },
      { ...assistant, content: text.slice(5), reasoning_content: reasoning.slice(5) })
  }
  const changed = structuredClone(next)
  changed.messages.at(-2).content = [{ type: "text", text: text + "changed" }]
  expect([400, 409]).toContain((await a.ask(account, changed)).status)
  expect(a.results).toEqual([])
  const second = await a.ask(account, next)
  expect(second.status).toBe(200)
  const finalChat = continueWith(next, second.body, ["canonical display"])
  if (representation === "split-pieces") {
    for (const m of finalChat.messages.slice(chat.messages.length, chat.messages.length + 2)) m.content = [{ type: "text", text: m.content }]
  } else finalChat.messages[chat.messages.length] = choice(first).message
  const final = await a.ask(account, finalChat)
  expect(final.status).toBe(200)
  expect(a.runs).toHaveLength(1)
  expect(a.results.map((r) => r.id)).toEqual([7, 8])
})

test("native loader: streamed ordinary text/thinking arrives before the server permits completion", async () => {
  const a = await agent({ progressiveFinal: true })
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("progressive output waited for completion")), 1000) })
  try {
    const response = await Promise.race([a.ask(auth(), initial({ stream: true })), timeout])
    expect(response.status).toBe(200)
    const reader = response.body.getReader()
    let sse = ""
    while (!sse.includes("progressive answer")) sse += new TextDecoder().decode((await Promise.race([reader.read(), timeout])).value)
    expect(sse).toContain("native planning one")
    expect(sse).toContain("magpie_cursor")
    expect(sse).not.toContain("[DONE]")
    expect([...nativeSessions.entries][0].terminal).toBe(false)
    a.finish()
    while (true) {
      const item = await reader.read()
      if (item.done) break
      sse += new TextDecoder().decode(item.value)
    }
    expect(sse).toContain("[DONE]")
    expect(JSON.parse(response.headers.get("X-Magpie-Cursor-Model")).id).toBe("fixture-model")
  } finally { clearTimeout(timer) }
})

test("native loader: required output failure cancels and evicts without exposing text or tools", async () => {
  const a = await agent({ finalOnly: true })
  const response = await a.ask(auth(), initial({ tool_choice: "required" }))
  expect(response.status).toBe(502)
  expect(response.body.choices).toBeUndefined()
  expect(nativeSessions.entries.size).toBe(0)
  expect(nativeSessions.handles.size).toBe(0)
  await until(() => a.closedStreams === 1)
})

test("native HTTP/2: two external thinking/tool/result roundtrips and final answer use one Run", async () => {
  const a = await agent()
  const account = auth()
  const { first, second, final } = await twoRounds(a, account)
  expect(first.body.usage.magpie_native.accounting).toBe("pending")
  expect(second.body.usage.total_tokens).toBe(0)
  expect(final.body.usage).toEqual({ prompt_tokens: 23, completion_tokens: 7, total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 4 } })
  expect(final.diagnostic).toContain("restart=unsupported")
  const owner = [...nativeSessions.entries][0]
  expect(owner.checkpoint.status).toBe("complete")
  expect(owner.checkpoint.terminal).toBe(true)
  expect(owner.blobs.get(Buffer.from("fixture-thinking-0").toString("hex"))).toEqual(bin(3, message(text(1, "server-generated thinking phase 0"), uint(2, 11))))
  expect(owner.blobs.has(Buffer.from("fixture-tool-step").toString("hex"))).toBe(true)
  expect(owner.blobs.has(Buffer.from("fixture-answer-step").toString("hex"))).toBe(true)
  expect(a.kv.some((k) => k.id === 219)).toBe(true) // terminal GetBlob completed
})

for (const bound of ["bytes", "messages"]) test(`native loader HTTP/2: stalled writes bound queued parked KV ${bound}`, async () => {
  NATIVE_LIMITS.outboundBytes = 4 << 20
  NATIVE_LIMITS.outboundMessages = bound === "messages" ? 4 : 256
  const a = await agent({ stateDelay: 10_000 })
  const connect = http2.connect
  let req
  http2.connect = (...args) => {
    const session = connect(...args)
    const request = session.request
    session.request = function (...args) { req = request.apply(this, args); return req }
    return session
  }
  try {
    const first = await a.ask(auth(), initial())
    expect(first.status).toBe(200)
    const owner = [...nativeSessions.entries][0]
    const blobID = Buffer.from("synthetic-h2-queued-blob")
    a.push(setBlob(90, blobID, Buffer.alloc(bound === "bytes" ? 1 << 20 : 1)))
    await until(() => a.kv.some((k) => k.id === 90))
    const stalledWrites = []
    req.write = (chunk) => { stalledWrites.push(chunk); return false }
    for (let i = 0; i < 10; i++) a.push(getBlob(91 + i, blobID))
    await until(() => !!owner.error)
    expect(owner.error.status).toBe(503)
    expect(owner.error.message).toContain("outbound")
    expect(owner.error.message).toContain(bound)
    expect(stalledWrites).toHaveLength(1)
    expect(owner.transport.outbound).toEqual({ bytes: 0, messages: 0 })
    await until(() => a.closedStreams === 1)
    expect(a.results).toEqual([])
    expect(a.runs).toHaveLength(1)
  } finally { http2.connect = connect }
})

for (const stream of [false, true]) test(`native loader HTTP/2: ${stream ? "streamed" : "JSON"} synchronous result-close admission overflow preserves 503 and prohibits retry`, async () => {
  const a = await agent({ stateDelay: 10_000 })
  const connect = http2.connect
  let req
  http2.connect = (...args) => {
    const session = connect(...args)
    const request = session.request
    session.request = function (...args) { req = request.apply(this, args); return req }
    return session
  }
  try {
    const account = auth(), chat = initial()
    const first = await a.ask(account, chat)
    expect(first.status).toBe(200)
    const owner = [...nativeSessions.entries][0]
    const batch = owner.segment
    await until(() => owner.transport.outbound.messages === 0)
    NATIVE_LIMITS.outboundMessages = 1
    const writes = []
    req.write = (packet) => { writes.push(packet); return false }
    const next = { ...continueWith(chat, first.body, ["synthetic admitted H2 result"]), stream }
    const response = await a.ask(account, next)
    expect(response.status).toBe(503)
    const body = stream ? await response.json() : response.body
    expect(body.error.message).toContain("native outbound messages limit reached")
    expect(body.error.message).toContain("uncertain")
    expect(body.error.message).toContain("cannot be replayed")
    expect(body.choices).toBeUndefined()
    expect(body.magpie_cursor.effective_model.id).toBe("fixture-model")
    expect(owner.error.status).toBe(503)
    expect(owner.state).toBe("failed")
    expect(owner.ac.signal.aborted).toBe(true)
    expect(owner.transport.outbound).toEqual({ bytes: 0, messages: 0 })
    expect(batch.resultDigest).toBeTruthy()
    expect(batch.calls[0].submitted).toBe(true)
    expect(writes).toHaveLength(1)
    expect(readResult(writes[0].subarray(5))).toMatchObject({ id: 7, execID: "exec-7", content: [{ type: "text", text: "synthetic admitted H2 result" }] })
    expect(nativeSessions.entries.size).toBe(0)
    expect(nativeSessions.handles.size).toBe(0)
    await until(() => a.closedStreams === 1)
    expect((await a.ask(account, { ...next, stream: false })).status).toBe(410)
    expect(writes).toHaveLength(1)
    expect(a.results).toEqual([])
    expect(a.closes).toEqual([])
    expect(a.runs).toHaveLength(1)
    expect(a.errors).toEqual([])
  } finally { http2.connect = connect }
})

test("native loader HTTP/2: an uncertain result write failure submits once, sends no exec close, and rejects retry", async () => {
  const a = await agent({ stateDelay: 10_000 })
  const connect = http2.connect
  let req
  http2.connect = (...args) => {
    const session = connect(...args)
    const request = session.request
    session.request = function (...args) { req = request.apply(this, args); return req }
    return session
  }
  try {
    const account = auth(), chat = initial()
    const first = await a.ask(account, chat)
    const write = req.write
    req.write = function (packet, callback) {
      const result = readWire(packet.subarray(5)).some((f) => f.no === 2)
      return write.call(this, packet, (e) => {
        if (result) setImmediate(() => callback(Object.assign(new Error("synthetic H2 result write failed; outcome uncertain"), { status: 503 })))
        else callback(e)
      })
    }
    const next = continueWith(chat, first.body, ["synthetic uncertain H2 result"])
    const failed = await a.ask(account, next)
    expect(failed.status).toBe(503)
    expect(failed.body.error.message).toContain("outcome uncertain")
    await until(() => a.results.length === 1 && a.closedStreams === 1)
    expect(a.closes).toEqual([])
    expect((await a.ask(account, next)).status).toBe(410)
    expect(a.results).toHaveLength(1)
    expect(a.runs).toHaveLength(1)
    expect(nativeSessions.entries.size).toBe(0)
  } finally { http2.connect = connect }
})

test("native loader HTTP/2: write callback alone does not bypass false-write backpressure; drain preserves the result loop", async () => {
  const a = await agent({ stateDelay: 10_000 })
  const connect = http2.connect
  let req
  http2.connect = (...args) => {
    const session = connect(...args)
    const request = session.request
    session.request = function (...args) { req = request.apply(this, args); return req }
    return session
  }
  try {
    const account = auth(), chat = initial()
    const first = await a.ask(account, chat)
    const write = req.write
    const writes = []
    req.write = (chunk, callback) => { writes.push(chunk); queueMicrotask(() => callback?.()); return false }
    a.push(getBlob(90, Buffer.from("missing-a")))
    a.push(getBlob(91, Buffer.from("missing-b")))
    await until(() => writes.length > 0)
    await new Promise((r) => setTimeout(r, 15))
    expect(writes).toHaveLength(1)
    req.emit("drain")
    await until(() => writes.length === 2)
    req.write = write
    req.emit("drain")
    const secondChat = continueWith(chat, first.body, ["after drain"])
    const second = await a.ask(account, secondChat)
    const final = await a.ask(account, continueWith(secondChat, second.body, ["after drain"]))
    expect(final.status).toBe(200)
    expect(a.results.map((r) => r.id)).toEqual([7, 8])
    expect(a.closes).toEqual([7, 8])
    expect(a.runs).toHaveLength(1)
  } finally { http2.connect = connect }
})

test("native HTTP/2: background reader retains/ACKs late blobs and closes checkpoint references while parked", async () => {
  const a = await agent({ stateDelay: 60 })
  const first = await a.ask(auth(), initial())
  expect(first.status).toBe(200)
  const owner = [...nativeSessions.entries][0]
  expect(owner.checkpoint.status).toBe("incomplete")
  await until(() => a.kv.some((k) => k.id === 199))
  expect(owner.state).toBe("awaiting-results")
  expect(owner.checkpoint.status).toBe("complete")
  const response = a.kv.find((k) => k.id === 199).fields.find((f) => f.no === 2).data
  expect(nest(response, 1)).toEqual(owner.blobs.get(Buffer.from("fixture-thinking-0").toString("hex")))
  expect(a.closedStreams).toBe(0)
})

for (const countAfter of [false, true]) test(`native HTTP/2: parallel calls count ${countAfter ? "after" : "before"}, colliding raw IDs, reverse results, exactly one submission`, async () => {
  const a = await agent({ parallel: true, countAfter, duplicate: true })
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  expect(first.status).toBe(200)
  const calls = choice(first).message.tool_calls
  expect(calls).toHaveLength(2)
  expect(new Set(calls.map((c) => c.id)).size).toBe(2)
  const continuation = continueWith(chat, first.body, ["result-7", "result-8"])
  continuation.messages.splice(-2, 2, ...continuation.messages.slice(-2).reverse())
  const final = await a.ask(account, continuation)
  expect(final.status).toBe(200)
  expect(choice(final).message.content).toBe("result-7|result-8")
  const replay = await a.ask(account, continuation)
  expect(choice(replay).message.content).toBe(choice(final).message.content)
  expect(replay.body.usage.magpie_native.accounting).toBe("replayed")
  expect(replay.body.usage.total_tokens).toBe(0)
  expect(a.results.map((r) => r.id).sort()).toEqual([7, 8])
  expect(a.runs).toHaveLength(1)
  expect(a.errors).toEqual([])
})

test("native HTTP/2: whole parallel result validation writes nothing for missing, duplicate, or unknown IDs", async () => {
  const a = await agent({ parallel: true })
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  const valid = continueWith(chat, first.body, ["A", "B"])
  for (const kind of ["missing", "duplicate", "unknown", "unsupported-content"]) {
    const bad = structuredClone(valid)
    if (kind === "missing") bad.messages.pop()
    if (kind === "duplicate") bad.messages.at(-1).tool_call_id = bad.messages.at(-2).tool_call_id
    if (kind === "unknown") bad.messages.at(-1).tool_call_id = "unrelated"
    if (kind === "unsupported-content") bad.messages.at(-1).content = [{ type: "file", file: {} }]
    const r = await a.ask(account, bad)
    expect(r.status).toBe(400)
    expect(a.results).toHaveLength(0)
    expect(a.runs).toHaveLength(1)
  }
  expect((await a.ask(account, valid)).status).toBe(200)
})

test("native HTTP/2: account, model, parameter, tool, and history/branch changes cannot reuse a pending Run", async () => {
  const a = await agent()
  const account = auth()
  const chat = initial({ reasoning_effort: "low" })
  const first = await a.ask(account, chat)
  const valid = continueWith(chat, first.body, ["matching"])
  const alien = await a.ask(auth(), valid)
  expect(alien.status).toBe(409)
  const changes = [
    (c) => c.model = "other-model",
    (c) => c.reasoning_effort = "high",
    (c) => c.service_tier = "priority",
    (c) => c.tools[0].function.description = "changed schema boundary",
    (c) => c.messages[0].content = "different instructions",
    (c) => c.messages.splice(0, 1),
    (c) => c.messages.at(-2).tool_calls[0].function.arguments = '{"value":"changed"}',
    (c) => c.messages.push({ role: "user", content: "branch while pending" }),
  ]
  for (const change of changes) {
    const bad = structuredClone(valid)
    change(bad)
    const r = await a.ask(account, bad)
    expect([400, 409]).toContain(r.status)
    expect(a.results).toHaveLength(0)
    expect(a.runs).toHaveLength(1)
  }
  expect((await a.ask(account, valid, { session: "other-session" })).status).toBe(409)
  expect((await a.ask(account, valid)).status).toBe(200)
})

test("native HTTP/2: identical completed retry replays output, concurrent retry conflicts, changed accepted result conflicts", async () => {
  const a = await agent()
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  const continuation = continueWith(chat, first.body, ["once"])
  const competing = await Promise.all([a.ask(account, continuation), a.ask(account, continuation)])
  expect(competing.map((r) => r.status).sort()).toEqual([200, 409])
  const accepted = competing.find((r) => r.status === 200)
  const replay = await a.ask(account, continuation)
  expect(choice(replay).message).toEqual(choice(accepted).message)
  expect(a.results).toHaveLength(1)
  const changed = structuredClone(continuation)
  changed.messages.at(-1).content = "different result"
  expect((await a.ask(account, changed)).status).toBe(409)
  const final = await a.ask(account, continueWith(continuation, accepted.body, ["once"]))
  expect(final.status).toBe(200)
  expect(a.results).toHaveLength(2)
})

for (const cancelBody of [true, false]) test(`native loader: cancelling a cached streamed replay ${cancelBody ? "through its body" : "through its request signal"} preserves the active owner`, async () => {
  const a = await agent()
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  const secondChat = continueWith(chat, first.body, ["replay-safe"])
  const second = await a.ask(account, secondChat)
  const owner = [...nativeSessions.entries][0]
  const handles = [...nativeSessions.handles.keys()]
  const ac = new AbortController()
  const replay = await a.ask(account, { ...secondChat, stream: true }, { signal: ac.signal })
  expect(replay.status).toBe(200)
  if (cancelBody) await replay.body.cancel()
  else { ac.abort(); await replay.body.cancel() }
  expect(owner.state).toBe("awaiting-results")
  expect(owner.error).toBeUndefined()
  expect(owner.transportClosed).not.toBe(true)
  expect([...nativeSessions.handles.keys()]).toEqual(handles)
  const final = await a.ask(account, continueWith(secondChat, second.body, ["replay-safe"]))
  expect(final.status).toBe(200)
  expect(choice(final).message.content).toBe("replay-safe")
  expect(a.results.map((r) => r.id)).toEqual([7, 8])
  expect(a.runs).toHaveLength(1)
})

test("native loader: cancellation after the transport head but before bind closes the late transport", async () => {
  const a = await agent({ stallInitial: true })
  const ac = new AbortController()
  const connect = http2.connect
  http2.connect = (...args) => {
    const session = connect(...args)
    const request = session.request
    session.request = function (...args) {
      const req = request.apply(this, args)
      req.once("response", () => queueMicrotask(() => ac.abort()))
      return req
    }
    return session
  }
  try {
    const reply = await a.ask(auth(), initial(), { signal: ac.signal })
    expect(reply.status).toBe(410)
    await until(() => a.closedStreams === 1 && a.sessions.size === 0)
    expect(a.runs).toHaveLength(0)
    expect(nativeSessions.entries.size).toBe(0)
    expect(nativeSessions.handles.size).toBe(0)
  } finally { http2.connect = connect }
})

test("native HTTP/2: allowed display-reasoning omission and argument key/whitespace equivalence retain the Run", async () => {
  const a = await agent()
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  const continuation = continueWith(chat, first.body, ["equivalent"])
  const assistant = continuation.messages.at(-2)
  delete assistant.reasoning_content
  assistant.content = null
  assistant.tool_calls[0].function.arguments = ' { "value" : "seed" } '
  const second = await a.ask(account, continuation)
  expect(second.status).toBe(200)
  expect(a.runs).toHaveLength(1)
})

test("native HTTP/2: a clean streamed handoff detaches the old signal; later abort does not kill its continuation", async () => {
  const a = await agent()
  const account = auth()
  const ac = new AbortController()
  const chat = initial({ stream: true })
  const res = await a.ask(account, chat, { signal: ac.signal })
  const sse = await res.text()
  expect(sse).toContain("[DONE]")
  const chunks = sse.split("\n\n").filter((s) => s.startsWith("data: {")).map((s) => JSON.parse(s.slice(6)))
  const toolCalls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...c }) => c)
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("")
  ac.abort()
  const next = { ...chat, stream: false, messages: [...chat.messages, { role: "assistant", content: "", reasoning_content: reasoning, tool_calls: toolCalls }, { role: "tool", tool_call_id: toolCalls[0].id, content: "after-old-abort" }] }
  expect((await a.ask(account, next)).status).toBe(200)
  expect(a.results).toHaveLength(1)
  expect(a.closedStreams).toBe(0)
})

for (const blocked of [false, true]) test(`native HTTP/2: streaming cancellation ${blocked ? "interrupts a blocked read" : "before reading"} settles transport/pump`, async () => {
  const a = await agent({ thinkingOnly: true })
  const res = await a.ask(auth(), initial({ stream: true }))
  const owner = [...nativeSessions.entries][0]
  const before = Date.now()
  if (blocked) {
    const reader = res.body.getReader()
    await reader.read()
    await reader.read()
    const pending = reader.read()
    await reader.cancel()
    await pending
  } else await res.body.cancel()
  await owner.pumpTask
  await until(() => a.closedStreams === 1)
  expect(Date.now() - before).toBeLessThan(1000)
  expect(owner.state).toBe("cancelled")
  expect(owner.transportClosed).toBe(true)
})

test("native loader: abort during metadata lookup leaves no opening owner or transport", async () => {
  const a = await agent()
  const ac = new AbortController()
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) ac.abort()
    return response
  }
  const response = await a.ask(auth(), initial(), { signal: ac.signal })
  expect(response.status).toBe(410)
  expect(a.runs).toHaveLength(0)
  expect(a.sessions.size).toBe(0)
  expect(nativeSessions.entries.size).toBe(0)
  expect(nativeSessions.handles.size).toBe(0)
})

test("native HTTP/2: already-aborted request never opens Run; abort while awaiting initial output closes it", async () => {
  const a = await agent({ stallInitial: true })
  const account = auth()
  const ac = new AbortController()
  ac.abort()
  expect((await a.ask(account, initial(), { signal: ac.signal })).status).toBe(410)
  expect(a.runs).toHaveLength(0)
  const live = new AbortController()
  const pending = a.ask(account, initial(), { signal: live.signal })
  await until(() => a.runs.length === 1)
  live.abort()
  expect((await pending).status).toBe(410)
  await until(() => a.closedStreams === 1)
})

test("native HTTP/2: result deadline expires despite parked housekeeping and rejects late results without a new Run", async () => {
  NATIVE_LIMITS.resultWait = 60
  const a = await agent()
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  await until(() => [...nativeSessions.entries][0].state === "expired")
  expect((await a.ask(account, continueWith(chat, first.body, ["late"]))).status).toBe(410)
  expect(a.results).toHaveLength(0)
  expect(a.runs).toHaveLength(1)
})

test("native HTTP/2: admission pressure rejects another active Run and preserves the admitted owner", async () => {
  NATIVE_LIMITS.perAccount = 1
  const a = await agent()
  const account = auth()
  const first = await a.ask(account, initial(), { session: "one" })
  expect(first.status).toBe(200)
  expect((await a.ask(account, initial(), { session: "two" })).status).toBe(503)
  expect(a.runs).toHaveLength(1)
  expect([...nativeSessions.entries][0].state).toBe("awaiting-results")
})

for (const options of [{ truncated: true }, { noCount: true }]) test(`native HTTP/2: ${options.truncated ? "truncated declared batch" : "missing batch count"} cannot yield successful partial calls`, async () => {
  NATIVE_LIMITS.batchWait = 55
  const a = await agent(options)
  const r = await a.ask(auth(), initial())
  expect(r.status).toBe(502)
  expect(r.body.choices).toBeUndefined()
  expect(a.results).toHaveLength(0)
})

test("native HTTP/2: server abort invalidates an exposed exec; no late native success", async () => {
  const a = await agent({ serverAbort: true })
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  await until(() => [...nativeSessions.entries][0].error)
  const r = await a.ask(account, continueWith(chat, first.body, ["late-success"]))
  expect(r.status).toBe(410)
  expect(a.results).toHaveLength(0)
})

const protobufDouble = (value) => {
  const data = Buffer.alloc(8)
  data.writeDoubleLE(value)
  return message(Buffer.from([0x11]), data)
}
const MALFORMED_VALUES = [
  ["truncated string", Buffer.from("1a0561", "hex")],
  ["dangling tail", Buffer.from("1a017880", "hex")],
  ["nested struct tail", bin(5, bin(1, message(text(1, "nested"), bin(2, Buffer.from("1a017880", "hex")))))],
  ["nested list truncation", bin(6, bin(1, Buffer.from("1a0561", "hex")))],
  ["wrong string wire", uint(3, 1)],
  ["wrong number wire", uint(2, 1)],
  ["wrong boolean wire", bin(4, Buffer.alloc(0))],
  ["wrong struct wire", uint(5, 0)],
  ["wrong list wire", uint(6, 0)],
  ["wrong struct entry wire", bin(5, uint(1, 0))],
  ["wrong struct key wire", bin(5, bin(1, message(uint(1, 0), bin(2, text(3, "x")))))],
  ["wrong struct value wire", bin(5, bin(1, message(text(1, "k"), uint(2, 0))))],
  ["wrong list item wire", bin(6, uint(1, 0))],
  ["nonfinite double", protobufDouble(NaN)],
  ["invalid UTF-8", bin(3, Buffer.from([0xff]))],
  ["invalid NullValue", uint(1, 1)],
  ["excessive nesting", Array.from({ length: 66 }).reduce((v) => bin(6, bin(1, v)), text(3, "nested"))],
]
const REPEATED_MCP_EXEC = Buffer.from("08075a0c2a0a61756469745f6563686f5a030a0561", "hex")
const mcpEntry = (key, value) => bin(2, message(text(1, key), bin(2, value)))
for (const [label, execMessage] of [
  ["truncated second envelope", REPEATED_MCP_EXEC],
  ["wrong second wire", message(uint(1, 7), bin(11, text(5, "audit_echo")), uint(11, 0))],
  ["recursive second value", message(uint(1, 7), bin(11, text(5, "audit_echo")), bin(11, message(text(5, "audit_echo"), mcpEntry("value", bin(6, bin(1, Buffer.from("1a0561", "hex")))))))],
  ["excessive second depth", message(uint(1, 7), bin(11, text(5, "audit_echo")), bin(11, message(text(5, "audit_echo"), mcpEntry("value", MALFORMED_VALUES.find(([label]) => label === "excessive nesting")[1]))))],
  ["differing valid arguments", message(uint(1, 7), bin(11, text(5, "audit_echo")), bin(11, message(text(5, "audit_echo"), mcpEntry("value", text(3, "changed")))))],
  ["differing valid identity", message(uint(1, 7), bin(11, text(5, "audit_echo")), bin(11, message(text(5, "audit_echo"), text(3, "different-native-call"))))],
]) test(`native loader: repeated MCP ${label} fails before exposing tools or retaining handles`, async () => {
  const a = await agent({ execMessage, stateDelay: 10_000 })
  const response = await a.ask(auth(), initial())
  expect(response.status).toBe(502)
  expect(response.body.choices).toBeUndefined()
  expect(a.results).toEqual([])
  expect(a.closes).toEqual([])
  expect(a.runs).toHaveLength(1)
  expect(nativeSessions.entries.size).toBe(0)
  expect(nativeSessions.handles.size).toBe(0)
  await until(() => a.closedStreams === 1)
  expect(a.errors).toEqual([])
})

for (const reordered of [false, true]) test(`native loader: repeated MCP ${reordered ? "canonically equal" : "identical"} envelopes expose one call and submit one result`, async () => {
  const entries = [mcpEntry("first", text(3, "one")), mcpEntry("nested", bin(5, bin(1, message(text(1, "__proto__"), bin(2, text(3, "safe"))))))]
  const identity = message(text(5, "audit_echo"), text(3, "same-native-call"))
  const execMessage = message(uint(1, 7), text(15, "exec-7"), bin(11, message(identity, ...entries)), bin(11, message(identity, ...(reordered ? [...entries].reverse() : entries))))
  const a = await agent({ execMessage, finalAfterFirst: true })
  const account = auth(), chat = initial()
  const first = await a.ask(account, chat)
  expect(first.status).toBe(200)
  expect(choice(first).message.tool_calls).toHaveLength(1)
  expect(JSON.parse(choice(first).message.tool_calls[0].function.arguments)).toEqual({ first: "one", nested: JSON.parse('{"__proto__":"safe"}') })
  const final = await a.ask(account, continueWith(chat, first.body, ["same call once"]))
  expect(final.status).toBe(200)
  expect(choice(final).message.content).toBe("same call once")
  expect(a.results).toHaveLength(1)
  expect(a.closes).toEqual([7])
  expect(a.runs).toHaveLength(1)
  expect(a.errors).toEqual([])
})

for (const [label, argumentValue] of MALFORMED_VALUES) test(`native loader: strict arguments reject ${label} without publishing calls or submitting results`, async () => {
  const a = await agent({ argumentValue })
  const response = await a.ask(auth(), initial())
  expect(response.status).toBe(502)
  expect(response.body.choices).toBeUndefined()
  expect(a.results).toHaveLength(0)
  expect(nativeSessions.entries.size).toBe(0)
  expect(nativeSessions.handles.size).toBe(0)
  await until(() => a.closedStreams === 1)
})

for (const limit of ["argumentBytes", "argumentFields"]) test(`native loader: strict arguments enforce the ${limit} bound`, async () => {
  const previous = NATIVE_LIMITS[limit]
  NATIVE_LIMITS[limit] = 32
  try {
    const argumentValue = limit === "argumentBytes" ? text(3, "x".repeat(64)) : bin(6, message(...Array.from({ length: 40 }, () => bin(1, Buffer.alloc(0)))))
    const a = await agent({ argumentValue })
    const response = await a.ask(auth(), initial())
    expect(response.status).toBe(502)
    expect(response.body.choices).toBeUndefined()
    expect(a.results).toHaveLength(0)
    expect(nativeSessions.handles.size).toBe(0)
  } finally {
    if (previous === undefined) delete NATIVE_LIMITS[limit]
    else NATIVE_LIMITS[limit] = previous
  }
})

for (const [label, argumentValue, expected] of [
  ["unset Value", Buffer.alloc(0), null],
  ["explicit null", uint(1, 0), null],
  ["empty Struct", bin(5, Buffer.alloc(0)), {}],
  ["default map entry", bin(5, bin(1, Buffer.alloc(0))), { "": null }],
  ["default list entries", bin(6, message(bin(1, Buffer.alloc(0)), bin(1, uint(4, 0)))), [null, false]],
  ["proto key", bin(5, bin(1, message(text(1, "__proto__"), bin(2, text(3, "safe"))))), JSON.parse('{"__proto__":"safe"}')],
  ["last oneof value", message(text(3, "old"), uint(4, 1)), true],
  ["finite double", protobufDouble(-12.5), -12.5],
  ["literal UTF-8 BOM", text(3, "\uFEFFexact"), "\uFEFFexact"],
  ["nested Struct/List", bin(5, bin(1, message(text(1, "items"), bin(2, bin(6, message(bin(1, protobufDouble(0)), bin(1, uint(4, 1)), bin(1, text(3, "精确")))))))), { items: [0, true, "精确"] }],
]) test(`native loader: strict arguments preserve protobuf ${label}`, async () => {
  const a = await agent({ argumentValue })
  const response = await a.ask(auth(), initial())
  expect(response.status).toBe(200)
  expect(JSON.parse(choice(response).message.tool_calls[0].function.arguments)).toEqual({ value: expected })
})

for (const options of [{ name: "unregistered" }, { provider: "foreign" }, { approval: true }]) test("native HTTP/2: unsupported/foreign/approval-only MCP forms fail before publication", async () => {
  const a = await agent(options)
  const r = await a.ask(auth(), initial())
  expect(r.status).toBe(502)
  expect(r.body.choices).toBeUndefined()
})

test("native HTTP/2: constraint failure buffers the complete step and cancels before exposing parallel calls", async () => {
  const a = await agent({ parallel: true })
  const r = await a.ask(auth(), initial({ parallel_tool_calls: false }))
  expect(r.status).toBe(502)
  expect(r.body.choices).toBeUndefined()
  expect(a.results).toHaveLength(0)
  expect([...nativeSessions.entries].every((e) => e.state === "failed")).toBe(true)
})

test("native HTTP/2: explicit native zero usage is authoritative, including zero reasoning", async () => {
  const a = await agent({ zeroUsage: true })
  const { final } = await twoRounds(a, auth())
  expect(final.body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } })
})

test("native HTTP/2: terminal drain is bounded when server does not send an end frame", async () => {
  NATIVE_LIMITS.drain = 90
  const a = await agent({ noEnd: true })
  const { final } = await twoRounds(a, auth())
  expect(final.status).toBe(200)
  expect([...nativeSessions.entries][0].state).toBe("complete")
})

test("native HTTP/2: lost process owner rejects pending results rather than building a new Run", async () => {
  const a = await agent()
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  await nativeSessions.clear()
  const r = await a.ask(account, continueWith(chat, first.body, ["after-restart"]))
  expect(r.status).toBe(410)
  expect(a.runs).toHaveLength(1)
  expect(a.results).toHaveLength(0)
})

for (const forgotten of [false, true]) for (const crossAccount of [false, true]) for (const contentArray of [false, true]) {
  test(`native HTTP/2: ${forgotten ? "forgotten" : "retained"} completed tool history ${contentArray ? "text-part array" : "string"} bootstraps a later user on ${crossAccount ? "another" : "the original"} account`, async () => {
    const a = await agent()
    const account = auth()
    const { final, finalChat } = await twoRounds(a, account)
    const completedOwner = [...nativeSessions.entries][0]
    if (forgotten) nativeSessions.forget(completedOwner)
    const finalMessage = structuredClone(choice(final).message)
    if (contentArray) finalMessage.content = [{ type: "text", text: finalMessage.content }]
    const newUser = { ...finalChat, messages: [...finalChat.messages, finalMessage, { role: "user", content: "a later synthetic user turn" }] }
    const reply = await a.ask(crossAccount ? auth() : account, newUser)
    expect(reply.status).toBe(200)
    expect(choice(reply).finish_reason).toBe("tool_calls")
    expect(reply.diagnostic).toContain("bootstrap=imported-history")
    expect(a.runs).toHaveLength(2)
    expect(a.results).toHaveLength(2) // historical results never submitted again
    expect([...nativeSessions.entries].find((e) => e.state === "awaiting-results")).not.toBe(completedOwner)
  })
}

test("native HTTP/2: replay-retention expiry permits a new user, while stale result-tail replay remains expired", async () => {
  NATIVE_LIMITS.replayWait = 35
  const a = await agent()
  const account = auth()
  const { final, finalChat } = await twoRounds(a, account)
  await until(() => nativeSessions.entries.size === 0)
  const stale = await a.ask(account, finalChat)
  expect(stale.status).toBe(410)
  expect(a.runs).toHaveLength(1)
  const later = { ...finalChat, messages: [...finalChat.messages, choice(final).message, { role: "user", content: "new user after retention expiry" }] }
  expect((await a.ask(account, later)).status).toBe(200)
  expect(a.runs).toHaveLength(2)
  expect(a.results).toHaveLength(2)
})

test("native HTTP/2: an unresolved branch stays closed to new-user and cross-account bootstrap after owner loss", async () => {
  const a = await agent()
  const account = auth()
  const chat = initial()
  const first = await a.ask(account, chat)
  const branch = { ...chat, messages: [...chat.messages, choice(first).message, { role: "user", content: "branch before resolving the current call" }] }
  expect((await a.ask(account, branch)).status).toBe(400)
  expect((await a.ask(auth(), branch)).status).toBe(409)
  await nativeSessions.clear()
  expect((await a.ask(account, branch)).status).toBe(410)
  expect((await a.ask(auth(), branch)).status).toBe(410)
  expect(a.runs).toHaveLength(1)
  expect(a.results).toHaveLength(0)
})
