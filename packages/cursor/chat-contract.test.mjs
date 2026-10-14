// Synthetic, offline Chat contract fixtures. Nothing authenticates, starts a
// Cursor Run, fetches an image, or executes a tool.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import {
  CHAT_CONTRACT_POLICY, ChatContractError, normalizeChatRequest,
  normalizeGenerationOptions, normalizeToolResult, buildChatConversation,
  parseToolArguments, encodeCursorToolCallId, decodeCursorToolCallId,
  validateChatStep, enforceChatStep,
} from "./chat-contract.mjs"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const image = (url = `data:image/png;base64,${PNG}`) => ({ type: "image_url", image_url: { url } })
const tool = (name = "read") => ({ type: "function", function: { name, description: "Read synthetic input", parameters: { type: "object", properties: { path: { type: "string" } } } } })
const call = (id = "call_a", name = "read", args = '{"path":"synthetic.txt"}') => ({ id, type: "function", function: { name, arguments: args } })
const chat = (extra = {}) => ({ model: "grok-4.7@256k", messages: [{ role: "user", content: "Inspect synthetic input." }], ...extra })
const normalized = (extra = {}) => normalizeChatRequest(chat(extra))
const transcript = (contract) => buildChatConversation(contract).msgs.map((b) => JSON.parse(b.toString()))
const nativeStep = (name = "read", id = "call_a", index = 0) => ({ tool: { name, id, index, args: '{"path":"synthetic.txt"}' } })
const terminal = (calls = true) => ({ stop: calls ? "tool_calls" : "stop", usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
async function* pieces(events) { for (const event of events) yield event }
const collect = async (events) => { const out = []; for await (const e of events) out.push(e); return out }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function rejection(fn, param, status = 400) {
  let caught
  try { fn() } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(ChatContractError)
  expect(caught.status).toBe(status)
  expect(caught.param).toBe(param)
  return caught
}

test("chat-contract keeps system/developer updates in place and reports role equivalence", () => {
  const request = chat({ messages: [
    { role: "system", content: "Initial instruction." },
    { role: "user", content: "First request." },
    { role: "assistant", content: "First answer." },
    { role: "developer", content: [{ type: "text", text: "Apply this update." }] },
    { role: "user", content: "Second request." },
    { role: "system", content: "Latest instruction." },
  ] })
  const before = JSON.stringify(request)
  const contract = normalizeChatRequest(request)
  const got = transcript(contract)
  expect(got.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user", "system"])
  expect(got[3].content).toBe("Apply this update.")
  expect(got[5].content).toBe("Latest instruction.")
  expect(contract.advisories).toContainEqual({
    field: "messages[3].role", code: "developer_as_system", enforced: false,
    message: "Developer instructions keep their position and use the system role; separate role precedence is not available.",
  })
  const old = _internal.conversation(request, []).msgs.map((b) => JSON.parse(b.toString()))
  expect(old[0].content).toContain("Latest instruction.")
  expect(old.map((m) => m.role)).not.toEqual(got.map((m) => m.role))
  expect(JSON.stringify(request)).toBe(before)
})

test("chat-contract preserves reasoning_text, alias precedence, and split-call parts", () => {
  const request = chat({ messages: [
    { role: "user", content: "Inspect two fixtures." },
    { role: "assistant", content: [{ type: "text", text: "A." }, { type: "text", text: "B." }], reasoning_text: "Plan A.", tool_calls: [call("call_a")] },
    { role: "assistant", content: [{ type: "reasoning", text: "Inline thought." }, { type: "text", text: "C." }], reasoning: "Plan B.", tool_calls: [call("call_b")] },
    { role: "tool", tool_call_id: "call_a", content: "A result." },
    { role: "tool", tool_call_id: "call_b", content: "B result." },
  ] })
  const got = transcript(normalizeChatRequest(request))
  const assistant = got.find((m) => m.role === "assistant")
  expect(assistant.content.slice(0, 6)).toEqual([
    { type: "reasoning", text: "Plan A." },
    { type: "text", text: "A." }, { type: "text", text: "B." },
    { type: "reasoning", text: "Plan B." },
    { type: "reasoning", text: "Inline thought." }, { type: "text", text: "C." },
  ])
  expect(assistant.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId)).toEqual(["call_a", "call_b"])
  expect(got.at(-1).content.map((p) => p.experimental_content[0].text)).toEqual(["A result.", "B result."])
  expect(_internal.conversation(request, []).msgs.some((b) => b.toString().includes("Plan A."))).toBe(false)
  const canonical = normalized({ messages: [{ role: "assistant", content: null, reasoning_content: "Canonical.", reasoning: "Alias.", reasoning_text: "Other." }] })
  expect(transcript(canonical)[0].content).toEqual([{ type: "reasoning", text: "Canonical." }])
  expect(canonical.advisories.filter((a) => a.code === "reasoning_alias_shadowed")).toHaveLength(2)
  expect(normalized({ messages: [{ role: "assistant", content: null, reasoning_content: " ", reasoning_text: "Fallback." }] }).chat.messages[0].reasoning_content).toBe("Fallback.")
})

test("chat-contract preserves tool text/image/text and the error flag in transcript and native MCP", () => {
  const result = { role: "tool", tool_call_id: "call_a", is_error: true, content: [
    { type: "text", text: "Before image." }, image(), { type: "text", text: "After image." },
  ] }
  const request = chat({ messages: [{ role: "assistant", content: null, tool_calls: [call()] }, result] })
  const part = transcript(normalizeChatRequest(request)).at(-1).content[0]
  expect(part.isError).toBe(true)
  expect(part.experimental_content).toEqual([
    { type: "text", text: "Before image." }, { type: "image", mimeType: "image/png", data: PNG }, { type: "text", text: "After image." },
  ])
  const native = normalizeToolResult(result).mcpResult.result
  expect(native.case).toBe("success")
  expect(native.value.isError).toBe(true)
  expect(native.value.content.map((p) => p.content.case)).toEqual(["text", "image", "text"])
  expect(Buffer.from(native.value.content[1].content.value.data).toString("base64")).toBe(PNG)
  expect(native.value.content[1].content.value.mimeType).toBe("image/png")
  const old = JSON.parse(_internal.conversation(request, []).msgs.at(-1).toString()).content[0]
  expect(old.experimental_content).toEqual([{ type: "text", text: "Before image.After image." }])
  expect(old.isError).toBeUndefined()
  expect(normalizeToolResult({ ...result, is_error: undefined, isError: true }).isError).toBe(true)
  expect(normalizeToolResult({ role: "tool", tool_call_id: "call_a", content: '{"ok":true}' }).transcript.result).toEqual({ ok: true })
  rejection(() => normalizeToolResult({ ...result, isError: false }), "tool_result")
})

test("chat-contract preserves image-only tool results and user images as bytes", () => {
  const result = { role: "tool", tool_call_id: "call_a", content: [image()] }
  const got = transcript(normalized({ messages: [
    { role: "user", content: [image(), { type: "text", text: "Describe it." }] },
    { role: "assistant", content: null, tool_calls: [call()] }, result,
  ] }))
  expect(got[0].content[0]).toEqual({ type: "image", mimeType: "image/png", image: { __type: "Uint8Array", hex: Buffer.from(PNG, "base64").toString("hex") } })
  expect(got.at(-1).content[0].experimental_content).toEqual([{ type: "image", mimeType: "image/png", data: PNG }])
  const detailed = normalizeToolResult({ role: "tool", tool_call_id: "call_a", content: [{ ...image(), detail: "high" }] })
  expect(detailed.advisories[0].code).toBe("image_detail_ignored")
  expect(detailed.advisories[0].enforced).toBe(false)
  for (const part of [
    { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "high" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ]) expect(transcript(normalized({ messages: [{ role: "user", content: [part] }] }))[0].content[0].image.hex).toBe(Buffer.from(PNG, "base64").toString("hex"))
})

test("chat-contract rejects remote images without fetching or revealing credentials", () => {
  let fetched = false
  globalThis.fetch = async () => { fetched = true; throw new Error("network forbidden") }
  const url = "https://synthetic-user:synthetic-password@image.invalid/a.png?key=synthetic-secret"
  const request = chat({ messages: [{ role: "user", content: [image(url)] }] })
  const e = rejection(() => normalizeChatRequest(request), "messages[0].content[0].image_url")
  expect(e.message).toContain("base64")
  for (const secret of [url, "synthetic-user", "synthetic-password", "synthetic-secret"]) expect(e.message).not.toContain(secret)
  expect(fetched).toBe(false)
  expect(JSON.parse(_internal.conversation(request, []).msgs[0].toString()).content[0].text).toContain("attachment image")
})

test("chat-contract rejects invalid encodings, MIME mismatch, detail values, and image bounds", () => {
  for (const url of ["data:image/png;base64,!!!!", "data:image/png;base64,A", "data:image/png;base64,AAAA", "data:image/jpeg;base64," + PNG, "data:image/svg+xml;base64,PHN2Zz4=", "file:///synthetic.png"])
    rejection(() => normalized({ messages: [{ role: "user", content: [image(url)] }] }), "messages[0].content[0].image_url")
  rejection(() => normalized({ messages: [{ role: "assistant", content: [image()] }] }), "messages[0].content[0]")
  rejection(() => normalized({ messages: [{ role: "user", content: [{ ...image(), detail: "ultra" }] }] }), "messages[0].content[0].detail")
  const bytes = Buffer.alloc(CHAT_CONTRACT_POLICY.images.maxImageBytes + 1)
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes)
  rejection(() => normalized({ messages: [{ role: "user", content: [image(`data:image/png;base64,${bytes.toString("base64")}`)] }] }), "messages[0].content[0].image_url")
  const bounded = bytes.subarray(0, 8 * 1024 * 1024).toString("base64")
  rejection(() => normalized({ messages: [{ role: "user", content: [image(`data:image/png;base64,${bounded}`), image(`data:image/png;base64,${bounded}`), image(`data:image/png;base64,${bounded}`)] }] }), "messages[0].content[2].image_url")
})

test("chat-contract rejects files/audio/video/unknown parts instead of losing their payloads", () => {
  for (const part of [
    { type: "file", file: { filename: "synthetic.pdf", file_data: "synthetic bytes" } },
    { type: "input_audio", input_audio: { format: "wav", data: "synthetic bytes" } },
    { type: "video", video_url: "https://video.invalid/synthetic.mp4" },
    { type: "unknown", data: "synthetic bytes" },
  ]) {
    rejection(() => normalized({ messages: [{ role: "user", content: [{ type: "text", text: "Keep this." }, part] }] }), "messages[0].content[1].type")
    rejection(() => normalizeToolResult({ role: "tool", tool_call_id: "call_a", content: [part] }), "tool_result.content[0].type")
  }
})

test("chat-contract validates request shapes, roles, reasoning types, and tool linkage", () => {
  rejection(() => normalizeChatRequest(null), "request")
  rejection(() => normalized({ messages: [] }), "messages")
  rejection(() => normalized({ messages: [{ role: "function", content: "legacy" }] }), "messages[0].role")
  rejection(() => normalized({ messages: [{ role: "assistant", content: null, reasoning_text: 42 }] }), "messages[0].reasoning_text")
  rejection(() => normalized({ messages: [{ role: "tool", content: "orphan", tool_call_id: "call_a" }] }), "messages[0].tool_call_id")
  const messages = [{ role: "assistant", content: null, tool_calls: [call()] }, { role: "tool", tool_call_id: "call_a", content: "result" }]
  rejection(() => normalized({ messages: [...messages, messages[1]] }), "messages[2].tool_call_id")
  rejection(() => normalized({ messages: [messages[0], messages[0]] }), "messages[1].tool_calls[0].id")
  rejection(() => normalized({ messages: [{ role: "user", content: "text", tool_calls: [call()] }] }), "messages[0]")
  rejection(() => normalized({ messages: [{ role: "assistant", content: null, tool_calls: [call("bad id")] }] }), "messages[0].tool_calls[0].id")
})

test("chat-contract handles unanswered split calls without dropping an intervening instruction", () => {
  const contract = normalized({ messages: [
    { role: "user", content: "Inspect both." },
    { role: "assistant", content: null, tool_calls: [call("call_a")] },
    { role: "assistant", content: "Inspecting.", tool_calls: [call("call_b")] },
    { role: "system", content: "Keep chronology." },
    { role: "tool", tool_call_id: "call_b", content: "B result." },
  ] })
  const got = transcript(contract)
  expect(got.map((m) => m.role)).toEqual(["user", "assistant", "system", "tool"])
  expect(got.at(-1).content.map((p) => p.toolCallId)).toEqual(["call_b", "call_a"])
  expect(got.at(-1).content[1].isError).toBe(true)
  expect(got.at(-1).content[1].experimental_content[0].text).toContain("interrupted")
  const interrupted = transcript(normalized({ messages: [
    { role: "assistant", content: null, tool_calls: [call("call_a")] },
    { role: "developer", content: "Instruction between call fragments." },
    { role: "assistant", content: null, tool_calls: [call("call_b")] },
    { role: "tool", tool_call_id: "call_a", content: "A result." },
    { role: "tool", tool_call_id: "call_b", content: "B result." },
  ] }))
  expect(interrupted.map((m) => m.role)).toEqual(["assistant", "system", "assistant", "tool"])
  expect(interrupted.at(-1).content.map((p) => p.experimental_content[0].text)).toEqual(["A result.", "B result."])
  expect(JSON.stringify(interrupted)).not.toContain("interrupted and did not produce")
  const withReasoning = (r) => normalized({ messages: [{ role: "assistant", content: null, reasoning_text: r }] })
  expect(buildChatConversation(withReasoning("x".repeat(400))).estimate - buildChatConversation(withReasoning("")).estimate).toBe(100)
})

test("chat-contract uses reversible safe Cursor IDs and restores existing newline IDs", () => {
  for (const id of ["toolu_a", "call_a", "call_a\nfc_b", "native:opaque#id", "cursorid_YQ", "cursorid_", "call_literal__fc_value"])
    expect(decodeCursorToolCallId(encodeCursorToolCallId(id))).toBe(id)
  expect(encodeCursorToolCallId("call_a\nfc_b")).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(decodeCursorToolCallId("call_a__fc_b")).toBe("call_a\nfc_b")
  const id = encodeCursorToolCallId("call_a\nfc_b")
  const got = transcript(normalized({ messages: [
    { role: "assistant", content: null, tool_calls: [call(id)] },
    { role: "tool", content: "result", tool_call_id: id },
  ] }))
  expect(got[0].content[0].toolCallId).toBe("call_a\nfc_b")
  expect(got[1].content[0].toolCallId).toBe("call_a\nfc_b")
  expect(normalizeToolResult({ role: "tool", tool_call_id: id, content: "result" }).toolCallId).toBe("call_a\nfc_b")
  rejection(() => normalized({ messages: [{ role: "assistant", content: null, tool_calls: [call(id), call("call_a__fc_b")] }] }), "messages[0].tool_calls[1].id")
})

test("chat-contract rejects malformed arguments rather than silently replacing them with {}", () => {
  for (const args of ["{broken", "[]", "null", "42", '"text"', "", undefined, [], null])
    rejection(() => parseToolArguments(args), "tool.arguments")
  expect(_internal.conversation(chat({ messages: [{ role: "assistant", content: null, tool_calls: [call("call_a", "read", "{broken")] }] }), []).msgs[0].toString()).toContain('"arguments":{}')
  const args = parseToolArguments('{"__proto__":{"polluted":true},"nested":[1,null,true]}')
  expect(Object.hasOwn(args, "__proto__")).toBe(true)
  expect({}.polluted).toBeUndefined()
  expect(JSON.parse(JSON.stringify(args))).toEqual(JSON.parse('{"__proto__":{"polluted":true},"nested":[1,null,true]}'))
  rejection(() => parseToolArguments({ key: undefined }), "tool.arguments.key")
  rejection(() => normalized({ tools: [tool('bad"name')] }), "tools[0].function.name")
  rejection(() => normalized({ tools: [tool(), tool()] }), "tools[1].function.name")
  rejection(() => normalized({ tools: [{ ...tool(), function: { ...tool().function, strict: true } }] }), "tools[0].function.strict")
  expect(normalized({ tools: [{ ...tool(), function: { ...tool().function, strict: false } }] }).tools).toHaveLength(1)
})

test("chat-contract reports ignored sampling/token caps and accepts ordinary Pi/OpenCode options", () => {
  const pi = normalized({
    stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
    temperature: 0.2, top_p: 0.95, reasoning_effort: "high", service_tier: "default",
    prompt_cache_key: "synthetic-pi-session", tools: [tool()], tool_choice: "auto",
    messages: [
      { role: "system", content: "Synthetic Pi instruction." },
      { role: "user", content: "Inspect a fixture." },
      { role: "assistant", content: "Inspecting.", reasoning_content: "Need evidence.", tool_calls: [call()] },
      { role: "tool", tool_call_id: "call_a", content: "Synthetic result." },
      // Pi moves a tool's screenshot into a following user message.
      { role: "user", content: [{ type: "text", text: "Tool screenshot." }, image()] },
    ],
  })
  expect(pi.advisories.filter((a) => a.code === "generation_option_ignored").map((a) => a.field)).toEqual(["temperature", "top_p", "max_tokens"])
  expect(pi.advisories.every((a) => a.enforced === false)).toBe(true)
  expect(pi.chat.max_tokens).toBeUndefined()
  expect(pi.advisories.find((a) => a.field === "max_tokens").message).toContain("NOT enforced")
  expect(pi.chat.reasoning_effort).toBe("high")
  expect(pi.chat.prompt_cache_key).toBe("synthetic-pi-session")
  expect(transcript(pi).at(-1).content.at(-1).type).toBe("image")
  const opencode = normalized({ stream: true, max_completion_tokens: 8192, tools: [tool()], tool_choice: "auto", parallel_tool_calls: true, messages: [
    { role: "system", content: "Synthetic OpenCode instruction." }, { role: "user", content: "Inspect a fixture." },
    { role: "assistant", content: null, tool_calls: [call()] }, { role: "tool", tool_call_id: "call_a", content: "Result." },
  ] })
  expect(opencode.advisories[0].field).toBe("max_completion_tokens")
  expect(opencode.chat.max_completion_tokens).toBeUndefined()
  expect(opencode.tools[0].schemaText).toBe(JSON.stringify(tool().function.parameters))
  expect(CHAT_CONTRACT_POLICY.options.max_completion_tokens).toContain("NOT enforced")
})

test("chat-contract validates advisory ranges before ignoring and rejects unsupported positive constraints", () => {
  for (const [key, value] of [
    ["temperature", -1], ["temperature", "1"], ["temperature", Infinity], ["top_p", 2], ["max_tokens", 0], ["max_completion_tokens", 1.5],
    ["n", 2], ["seed", 1], ["stop", "END"], ["response_format", { type: "json_object" }], ["response_format", { type: "json_schema", json_schema: { name: "synthetic", strict: true, schema: { type: "object" } } }],
    ["logprobs", true], ["top_logprobs", 1], ["logit_bias", { "12": 1 }], ["presence_penalty", 0.2], ["frequency_penalty", -0.5],
    ["modalities", ["text", "audio"]], ["audio", { format: "wav", voice: "alloy" }], ["verbosity", "low"], ["store", true],
    ["min_tokens", 4], ["parallel_tool_calls", "false"],
  ]) rejection(() => normalized({ [key]: value }), key)
  const inert = normalized({
    n: 1, stop: [], response_format: { type: "text" }, logprobs: false, top_logprobs: 0,
    logit_bias: {}, presence_penalty: 0, frequency_penalty: 0, store: false, modalities: ["text"],
    max_tokens: null, temperature: null, seed: null,
  })
  expect(inert.advisories).toEqual([])
  expect(normalized({ stop: "" }).advisories).toEqual([])
  rejection(() => normalizeGenerationOptions(chat({ logit_bias: { "12": 101 } })), "logit_bias")
})

test("chat-contract validates required/named choices and filters the available tools", () => {
  rejection(() => normalized({ tool_choice: "required" }), "tool_choice")
  rejection(() => normalized({ tools: [tool()], tool_choice: { type: "function", function: { name: "missing" } } }), "tool_choice.function.name")
  rejection(() => normalized({ tool_choice: "sometimes" }), "tool_choice")
  rejection(() => normalized({ tools: [tool()], tool_choice: "named" }), "tool_choice")
  const required = normalized({ tools: [tool()], tool_choice: "required" })
  rejection(() => validateChatStep([{ text: "No tool." }, terminal(false)], required), "tool_choice", 502)
  const named = normalized({ tools: [tool(), tool("write")], tool_choice: { type: "function", function: { name: "read" } } })
  expect(named.tools.map((t) => t.name)).toEqual(["read"])
  expect(validateChatStep([nativeStep(), terminal()], named).map((e) => e.tool?.name ?? e.stop)).toEqual(["read", "tool_calls"])
  rejection(() => validateChatStep([nativeStep("write"), terminal()], named), "tool.name", 502)
  rejection(() => validateChatStep([terminal(false)], named), "tool_choice", 502)
  const none = normalized({ tools: [tool()], tool_choice: "none" })
  expect(none.tools).toEqual([])
  rejection(() => validateChatStep([nativeStep(), terminal()], none), "tool.name", 502)
  expect(normalized({ tools: [tool()], tool_choice: { type: "none" } }).tools).toEqual([])
})

test("chat-contract rejects parallel=false violations without dropping an extra call", () => {
  const serial = normalized({ tools: [tool()], parallel_tool_calls: false })
  expect(validateChatStep([nativeStep(), terminal()], serial)).toHaveLength(2)
  rejection(() => validateChatStep([nativeStep(), nativeStep("read", "call_b", 1), terminal()], serial), "parallel_tool_calls", 502)
  expect(validateChatStep([nativeStep(), nativeStep("read", "call_b", 1), terminal()], normalized({ tools: [tool()], parallel_tool_calls: true }))).toHaveLength(3)
})

test("chat-contract validates the complete step, output IDs/names/arguments, and terminal integrity", () => {
  const contract = normalized({ tools: [tool()] })
  for (const events of [
    [nativeStep()], [nativeStep(), terminal(false)], [nativeStep(), terminal(), { text: "late" }],
    [nativeStep(), nativeStep("read", "call_a", 1), terminal()], [nativeStep("missing"), terminal()],
    [{ tool: { ...nativeStep().tool, args: "{broken" } }, terminal()],
    [{ tool: { ...nativeStep().tool, id: "unsafe\nid" } }, terminal()],
    [nativeStep("read", "call_a", 2), terminal()],
    [{ ...nativeStep(), text: "Must not discard this." }, terminal()],
    [nativeStep("read", "call_a__fc_b"), nativeStep("read", encodeCursorToolCallId("call_a\nfc_b"), 1), terminal()],
  ]) expect(() => validateChatStep(events, contract)).toThrow(ChatContractError)
})

test("chat-contract withholds every tool delta until the complete step passes", async () => {
  let sourceFinished = false, invalidations = 0
  const events = (async function* () {
    yield { reasoning: "Synthetic reasoning." }
    yield nativeStep()
    yield nativeStep("read", "call_b", 1)
    yield terminal()
    sourceFinished = true
  })()
  const it = enforceChatStep(events, normalized({ tools: [tool()], tool_choice: "required" }), { invalidate: async () => { invalidations++ } })
  const first = await it.next()
  expect(sourceFinished).toBe(true)
  expect(first.value.reasoning).toBe("Synthetic reasoning.")
  const rest = await collect(it)
  expect(rest.filter((e) => e.tool)).toHaveLength(2)
  expect(invalidations).toBe(0)
})

test("chat-contract invalid output cancels/evicts before rejecting and leaks no tool deltas", async () => {
  const observed = [], invalidations = []
  let sourceClosed = false
  const events = (async function* () {
    try { yield nativeStep(); yield nativeStep("read", "call_b", 1); yield terminal() }
    finally { sourceClosed = true }
  })()
  let caught
  try {
    for await (const e of enforceChatStep(events, normalized({ tools: [tool()], parallel_tool_calls: false }), {
      invalidate: async (reason) => { invalidations.push(reason) },
    })) observed.push(e)
  } catch (e) { caught = e }
  expect(caught.status).toBe(502)
  expect(caught.param).toBe("parallel_tool_calls")
  expect(sourceClosed).toBe(true)
  expect(observed).toEqual([])
  expect(invalidations).toEqual([{ reason: "chat_contract", reusable: false, error: { status: 502, code: "cursor_output_contract", param: "parallel_tool_calls" } }])
  expect(JSON.stringify(invalidations)).not.toContain("synthetic.txt")
})

test("chat-contract also invalidates on required-without-call, native error, source failure, and delivery cancellation", async () => {
  const required = normalized({ tools: [tool()], tool_choice: "required" })
  let count = 0
  const invalidate = async () => { count++ }
  await expect(collect(enforceChatStep(pieces([{ text: "No tool." }, terminal(false)]), required, { invalidate }))).rejects.toThrow(ChatContractError)
  expect(count).toBe(1)
  const nativeError = { error: { status: 429, message: "Synthetic quota error." } }
  expect(await collect(enforceChatStep(pieces([nativeStep(), nativeError]), required, { invalidate }))).toEqual([nativeError])
  expect(count).toBe(2)
  const broken = (async function* () { yield nativeStep(); throw new Error("Synthetic stream failure.") })()
  await expect(collect(enforceChatStep(broken, required, { invalidate }))).rejects.toThrow("Synthetic stream failure.")
  expect(count).toBe(3)
  const cancelled = enforceChatStep(pieces([nativeStep(), terminal()]), required, { invalidate })
  await cancelled.next()
  await cancelled.return()
  expect(count).toBe(4)
  await expect(collect(enforceChatStep(pieces([nativeStep(), terminal()]), required))).rejects.toThrow("invalidate hook")
})

test("chat-contract streams ordinary text/thinking before the source completes but withholds the tool batch", async () => {
  let release, finished = false
  const gate = new Promise((resolve) => { release = resolve })
  const source = (async function* () {
    yield { reasoning: "First thought." }
    yield { text: "First text." }
    await gate
    yield nativeStep()
    yield terminal()
    finished = true
  })()
  let invalidations = 0
  const it = enforceChatStep(source, normalized({ tools: [tool()] }), { invalidate: async () => { invalidations++ } })
  expect((await it.next()).value).toEqual({ reasoning: "First thought." })
  expect((await it.next()).value).toEqual({ text: "First text." })
  expect(finished).toBe(false)
  release()
  expect((await it.next()).value.tool.name).toBe("read")
  expect(finished).toBe(true)
  await collect(it)
  expect(invalidations).toBe(0)
})

test("chat-contract bounds buffered steps and invalidates the source before exposing content", async () => {
  let closed = false, evictions = 0
  const source = (async function* () {
    try { yield { text: "x".repeat(CHAT_CONTRACT_POLICY.maxBufferedStepBytes) }; yield terminal(false) }
    finally { closed = true }
  })()
  await expect(collect(enforceChatStep(source, normalized({ parallel_tool_calls: false }), { invalidate: async () => { evictions++ } }))).rejects.toThrow("16 MiB")
  expect(closed).toBe(true)
  expect(evictions).toBe(1)
})

test("chat-contract does not mask cancellation/eviction failures or retry the model source", async () => {
  let started = 0, evicted = 0
  const events = (async function* () { started++; yield terminal(false) })()
  await expect(collect(enforceChatStep(events, normalized({ tools: [tool()], tool_choice: "required" }), {
    invalidate: async () => { evicted++; throw new Error("Synthetic eviction failure.") },
  }))).rejects.toThrow("Synthetic eviction failure.")
  expect(started).toBe(1)
  expect(evicted).toBe(1)
})
