// lib/chat.mjs on its own: the fold that turns Anthropic's Messages into the
// one turn Doubao's web endpoint takes, the payload it goes in, and the SSE
// that comes back turned into Anthropic's events. Nothing here reaches the
// network — a stream is fed as bytes and read back as frames.
import { describe, expect, test } from "bun:test"

import {
  anthropicSSE,
  buildPayload,
  chatHeaders,
  chatURL,
  estimateTokens,
  foldHistory,
  readFrame,
  sseFrames,
  textOf,
} from "./lib/chat.mjs"

// ---------------------------------------------------------------------------
// textOf / foldHistory
// ---------------------------------------------------------------------------

describe("textOf", () => {
  test("a plain string is itself", () => {
    expect(textOf("hello")).toBe("hello")
  })

  test("text blocks join in order", () => {
    expect(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb")
  })

  test("a tool result keeps its id and error mark", () => {
    const s = textOf([{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: true }])
    expect(s).toContain("[tool result t1 (error)]")
    expect(s).toContain("ok")
  })

  test("a tool use says which tool and what it was given", () => {
    const s = textOf([{ type: "tool_use", name: "Read", input: { path: "/x" } }])
    expect(s).toContain("[called Read]")
    expect(s).toContain("/x")
  })

  test("an image is named, not silently dropped", () => {
    expect(textOf([{ type: "image", source: {} }])).toContain("text only")
  })

  test("anything else is skipped, not thrown on", () => {
    expect(textOf([null, 1, { type: "nope" }])).toBe("")
    expect(textOf(undefined)).toBe("")
  })
})

describe("foldHistory", () => {
  test("one user turn goes as itself, with no transcript framing", () => {
    expect(foldHistory({ messages: [{ role: "user", content: "hi" }] })).toBe("hi")
  })

  test("a system prompt goes before the question", () => {
    const s = foldHistory({ system: "Be brief.", messages: [{ role: "user", content: "hi" }] })
    expect(s).toBe("Be brief.\n\nhi")
  })

  test("a system prompt given as blocks is read too", () => {
    const s = foldHistory({ system: [{ type: "text", text: "Be brief." }], messages: [{ role: "user", content: "hi" }] })
    expect(s).toBe("Be brief.\n\nhi")
  })

  test("many turns become one labelled transcript", () => {
    const s = foldHistory({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    })
    expect(s).toContain("User: a")
    expect(s).toContain("Assistant: b")
    expect(s).toContain("User: c")
  })

  test("empty turns are left out rather than becoming blank labels", () => {
    const s = foldHistory({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "" }] })
    expect(s).not.toContain("Assistant:")
  })

  test("the tools' contract rides between system and turns", () => {
    const s = foldHistory({ system: "S", toolContract: "TOOLS", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] })
    expect(s.indexOf("S")).toBeLessThan(s.indexOf("TOOLS"))
    expect(s.indexOf("TOOLS")).toBeLessThan(s.indexOf("User: a"))
  })

  test("no messages at all is an empty request, not a crash", () => {
    expect(foldHistory({ messages: [] })).toBe("")
    expect(foldHistory({})).toBe("")
  })
})

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------

describe("buildPayload", () => {
  const p = buildPayload({ text: "hi" })

  // Verified against a live account: this endpoint takes the flat shape, and
  // `content` is a JSON *string*. Sending the object (or the client_meta shape
  // newer endpoints use) answers `unexpected end of JSON input [biz error]`
  // with a perfectly valid cookie — a dead end that looks like an auth bug.
  test("the text rides in messages[].content as a JSON string", () => {
    const m = p.messages[0]
    expect(m.content_type).toBe(2001)
    expect(typeof m.content).toBe("string")
    expect(JSON.parse(m.content)).toEqual({ text: "hi" })
    expect(m.attachments).toEqual([])
    expect(m.references).toEqual([])
  })

  test("the client_meta shape is not sent at all", () => {
    expect(p.client_meta).toBeUndefined()
    expect(p.messages[0].content_block).toBeUndefined()
    expect(p.chat_ability).toBeUndefined()
    expect(p.option).toBeUndefined()
  })

  test("no conversation id creates one, and says so", () => {
    expect(p.completion_option.need_create_conversation).toBe(true)
    expect(p.local_conversation_id).toMatch(/^local_[0-9a-f]{16}$/)
  })

  test("an existing conversation is continued, not recreated", () => {
    const q = buildPayload({ text: "again", conversationId: "397193850580994" })
    expect(q.local_conversation_id).toBe("397193850580994")
    expect(q.completion_option.need_create_conversation).toBe(false)
  })

  test("deep think sets the flag the page's toggle sets", () => {
    expect(p.completion_option.use_deep_think).toBe(false)
    expect(buildPayload({ text: "x", deepThink: 1 }).completion_option.use_deep_think).toBe(true)
  })

  test("a bot id is only sent when asked for", () => {
    expect(p.bot_id).toBeUndefined()
    expect(buildPayload({ text: "x", botId: "123" }).bot_id).toBe("123")
  })

  test("every id in one payload is its own", () => {
    expect(p.local_message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.local_message_id).not.toBe(p.local_conversation_id)
  })
})

describe("chatURL / chatHeaders", () => {
  test("the security params are the client's, and the device ids are the account's", () => {
    const u = new URL(chatURL({ deviceId: "714003710229497", webId: "7604137868021548590" }))
    expect(u.origin + u.pathname).toBe("https://www.doubao.com/samantha/chat/completion")
    expect(u.searchParams.get("aid")).toBe("582478")
    expect(u.searchParams.get("device_id")).toBe("714003710229497")
    expect(u.searchParams.get("web_id")).toBe("7604137868021548590")
    expect(u.searchParams.get("samantha_web")).toBe("1")
  })

  test("no msToken unless there is a real one", () => {
    expect(new URL(chatURL({ deviceId: "1", webId: "2" })).searchParams.get("msToken")).toBeNull()
    expect(new URL(chatURL({ deviceId: "1", webId: "2", msToken: "abc" })).searchParams.get("msToken")).toBe("abc")
  })

  test("the headers the endpoint turns a request away without", () => {
    const h = chatHeaders({ cookie: "sessionid=x", csrfToken: "c1" })
    expect(h["Agw-Js-Conv"]).toBe("str")
    expect(h.Accept).toBe("text/event-stream")
    expect(h.Cookie).toBe("sessionid=x")
    expect(h["x-tt-passport-csrf-token"]).toBe("c1")
  })

  test("no csrf header when the cookie has none", () => {
    expect(chatHeaders({ cookie: "sessionid=x" })["x-tt-passport-csrf-token"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// sseFrames / readFrame
// ---------------------------------------------------------------------------

describe("sseFrames", () => {
  test("event and data are paired, blank line ends a frame", () => {
    const f = [...sseFrames('event: SSE_ACK\ndata: {"a":1}\n\n')]
    expect(f).toHaveLength(1)
    expect(f[0]).toEqual({ event: "SSE_ACK", data: '{"a":1}' })
  })

  test("multi-line data joins with a newline, as the spec says", () => {
    const f = [...sseFrames("data: a\ndata: b\n\n")]
    expect(f[0].data).toBe("a\nb")
  })

  test("a comment line is skipped", () => {
    expect([...sseFrames(": keepalive\n\n")]).toHaveLength(0)
  })

  test("a frame with no blank line at the end still comes out", () => {
    expect([...sseFrames('data: {"x":1}')]).toHaveLength(1)
  })

  test("crlf is the same as lf", () => {
    const f = [...sseFrames('event: e\r\ndata: {"a":1}\r\n\r\n')]
    expect(f[0]).toEqual({ event: "e", data: '{"a":1}' })
  })
})

describe("readFrame", () => {
  const read = (event, obj) => readFrame({ event, data: JSON.stringify(obj) })

  test("a bare text delta", () => {
    expect(read("", { text: "你" })).toEqual({ kind: "text", text: "你" })
  })

  test("a 10000 block's text is the answer, and ends any thinking before it", () => {
    const ev = read("", { patch_op: [{ patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: "hi" } } }] } }] })
    expect(ev).toEqual({ kind: "text", text: "hi", endsThinking: true })
  })

  test("a 10040 block says thinking has begun", () => {
    const ev = read("", { content: { content_block: [{ block_type: 10040, content: {} }] } })
    expect(ev.kind).toBe("thinking")
  })

  test("a search or tool block is progress, not answer text", () => {
    expect(read("", { content: { content_block: [{ block_type: 10025, content: { search_query_result_block: { queries: ["x"] } } }] } }).kind).toBe("ignore")
    expect(read("", { content: { content_block: [{ block_type: 10101, content: { loading_block: { text_loading: { text: "thinking…" } } } }] } }).kind).toBe("ignore")
  })

  test("SSE_ACK hands out the conversation id", () => {
    expect(read("SSE_ACK", { ack_client_meta: { conversation_id: "397193850580994" } })).toEqual({ kind: "conversation", id: "397193850580994" })
    expect(read("SSE_ACK", { ack_client_meta: { conversation_id: "0" } }).kind).toBe("ignore")
  })

  test("a gateway-error is fatal and carries its code", () => {
    const ev = read("gateway-error", { code: "Internal", message: "ErrorX:code=710012000 [user invalid]" })
    expect(ev.kind).toBe("error")
    expect(ev.fatal).toBe(true)
    expect(ev.message).toContain("710012000")
  })

  test("a STREAM_ERROR is fatal only when it is a risk code", () => {
    expect(read("STREAM_ERROR", { error_code: 710022004, error_msg: "captcha" }).fatal).toBe(true)
    expect(read("STREAM_ERROR", { error_code: 1234, error_msg: "odd" }).fatal).toBe(false)
  })

  test("a body that isn't JSON is one skipped frame, not a dead stream", () => {
    expect(readFrame({ event: "", data: "<html>oops</html>" }).kind).toBe("ignore")
  })

  test("an error payload is never mistaken for text", () => {
    const ev = read("", { text: "", error_code: 9 })
    expect(ev.kind).toBe("error")
    expect(ev.fatal).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// anthropicSSE
// ---------------------------------------------------------------------------

function streamOf(chunks) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch))
      c.close()
    },
  })
}

async function readAll(body) {
  const text = await new Response(body).text()
  return [...sseFrames(text)].map((f) => ({ event: f.event, data: JSON.parse(f.data) }))
}

describe("anthropicSSE", () => {
  test("one text delta becomes message_start, a start, a delta, and a stop", async () => {
    const body = streamOf(['data: {"text":"你好"}\n\n'])
    const ev = await readAll(anthropicSSE(body, { model: "doubao" }))
    const names = ev.map((e) => e.event)
    expect(names).toEqual([
      "message_start", "content_block_start", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ])
    expect(ev[2].data.delta).toEqual({ type: "text_delta", text: "你好" })
    expect(ev[1].data.content_block).toEqual({ type: "text", text: "" })
  })

  test("the message says the model it was asked for", async () => {
    const ev = await readAll(anthropicSSE(streamOf(['data: {"text":"x"}\n\n']), { model: "doubao-deep-think" }))
    expect(ev[0].data.message.model).toBe("doubao-deep-think")
  })

  test("many deltas share one content block", async () => {
    const body = streamOf(['data: {"text":"a"}\n\n', 'data: {"text":"b"}\n\n', 'data: {"text":"c"}\n\n'])
    const ev = await readAll(anthropicSSE(body, {}))
    expect(ev.filter((e) => e.event === "content_block_start")).toHaveLength(1)
    const deltas = ev.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)
    expect(deltas).toEqual(["a", "b", "c"])
  })

  test("a frame split across two reads is still one delta", async () => {
    const body = streamOf(['data: {"te', 'xt":"split"}\n\n'])
    const ev = await readAll(anthropicSSE(body, {}))
    const deltas = ev.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)
    expect(deltas).toEqual(["split"])
  })

  test("a thinking block's text is not sent as the answer", async () => {
    const body = streamOf([
      'data: {"content":{"content_block":[{"block_type":10040,"content":{}}]}}\n\n',
      'data: {"text":"思考中"}\n\n',
      'data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"答案"}}}]}}\n\n',
      'data: {"text":"。"}\n\n',
    ])
    const ev = await readAll(anthropicSSE(body, { thinking: false }))
    const texts = ev.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)
    expect(texts).toEqual(["答案", "。"])
  })

  test("with thinking asked for, it is sent as text rather than a fake signed block", async () => {
    const body = streamOf([
      'data: {"content":{"content_block":[{"block_type":10040,"content":{}}]}}\n\n',
      'data: {"text":"我在想"}\n\n',
      'data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"答案"}}}]}}\n\n',
    ])
    const ev = await readAll(anthropicSSE(body, { thinking: true }))
    const texts = ev.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)
    expect(texts).toEqual(["我在想", "答案"])
    // and never as a thinking block, which would need a signature it can't give
    expect(ev.some((e) => e.data?.delta?.type === "thinking_delta")).toBe(false)
  })

  test("a fatal error ends the stream with an Anthropic error event", async () => {
    const body = streamOf([
      'data: {"text":"partial"}\n\n',
      'event: gateway-error\ndata: {"code":"Internal","message":"710012000 user invalid"}\n\n',
    ])
    const ev = await readAll(anthropicSSE(body, {}))
    const err = ev.find((e) => e.event === "error")
    expect(err).toBeTruthy()
    expect(err.data.error.message).toContain("710012000")
    expect(ev.at(-1).event).toBe("error")
  })

  test("a non-fatal stream error is swallowed and the answer continues", async () => {
    const body = streamOf([
      'event: STREAM_ERROR\ndata: {"error_code":1234,"error_msg":"odd"}\n\n',
      'data: {"text":"still here"}\n\n',
    ])
    const ev = await readAll(anthropicSSE(body, {}))
    expect(ev.some((e) => e.event === "error")).toBe(false)
    expect(ev.filter((e) => e.event === "content_block_delta").at(-1).data.delta.text).toBe("still here")
  })

  test("an empty stream still answers a well-formed message", async () => {
    const ev = await readAll(anthropicSSE(streamOf([]), {}))
    expect(ev.map((e) => e.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ])
  })

  test("the conversation id is reported for the ledger to keep", async () => {
    const seen = []
    const body = streamOf(['event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"397193850580994"}}\n\n', 'data: {"text":"x"}\n\n'])
    await readAll(anthropicSSE(body, { onConversation: (id) => seen.push(id) }))
    expect(seen).toEqual(["397193850580994"])
  })

  test("output tokens are estimated, not left at zero", async () => {
    const ev = await readAll(anthropicSSE(streamOf(['data: {"text":"一段不短的回答内容"}\n\n']), {}))
    const md = ev.find((e) => e.event === "message_delta")
    expect(md.data.usage.output_tokens).toBeGreaterThan(0)
  })
})

describe("estimateTokens", () => {
  test("empty is zero", () => expect(estimateTokens("")).toBe(0))
  test("cjk counts more per character than ascii", () => {
    expect(estimateTokens("中文中文")).toBeGreaterThan(estimateTokens("abcd"))
  })
})
