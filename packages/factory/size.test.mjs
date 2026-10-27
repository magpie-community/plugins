// yetone/magpie#2082 (Ziqi-Cui): Codex on Opus 5.5 through the plugin
// gathered nine screenshots, ~4.5 MB of data URLs, and Factory answered
// every request after with 413 "Request Entity Too Large". It is Factory's
// limit on a body's bytes, not the model's context. On a 413 the plugin
// asks once more with every image but the newest left out, as droid 0.239.0
// does, each tool result kept beside its call; failing that, it says what
// the 413 is and what to do.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { leaveOutAttachments, LEFT_OUT, TOO_LARGE_HINT } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// Factory refuses a body over limit bytes, as its edge does: plain text
async function loaded(limit) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    if (String(init.body).length > limit) return new Response("Request Entity Too Large", { status: 413, headers: { "content-type": "text/plain" } })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

const png = (n) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(n) } })

// Codex's turns as magpie's gateway hands them to Factory's Messages: a
// screenshot from a tool, one pasted, and the newest from a tool again
const session = () => ({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  stream: true,
  messages: [
    { role: "user", content: [{ type: "text", text: "look" }, png(3000)] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "view_image", input: { path: "/a.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [png(3000)] }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "view_image", input: { path: "/b.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "b.png" }, { ...png(3000), cache_control: { type: "ephemeral" } }] }] },
  ],
})

test("a 413 is asked once more with the older images left out, tool results kept beside their calls", async () => {
  const { l, seen } = await loaded(5000)
  const res = await l.fetch("https://api.factory.ai/api/llm/a/v1/messages", { method: "POST", headers: { "content-length": "99999" }, body: JSON.stringify(session()) })
  expect(res.status).toBe(200)
  expect(seen.length).toBe(2)
  const sent = JSON.parse(seen[1].body)
  const want = session()
  want.messages[0].content[1] = { type: "text", text: LEFT_OUT }
  want.messages[2].content[0].content[0] = { type: "text", text: LEFT_OUT }
  expect(sent.messages).toEqual(want.messages)
  expect(seen[1].headers.get("content-length")).toBeNull()
})

test("a 413 still there with the older images left out says it is Factory's byte limit, and what to do", async () => {
  const { l, seen } = await loaded(100)
  const res = await l.fetch("https://api.factory.ai/api/llm/a/v1/messages", { method: "POST", body: JSON.stringify(session()) })
  expect(seen.length).toBe(2)
  expect(res.status).toBe(413)
  const e = await res.json()
  expect(e.type).toBe("error")
  expect(e.error.type).toBe("request_too_large")
  expect(e.error.message).toContain("(413: Request Entity Too Large)")
  expect(e.error.message).toContain("limits the size of a request's body in bytes")
  expect(e.error.message).toContain("2 older images or files left out")
  // magpie's gateway finds its own hint and doesn't add it again
  expect(e.error.message).toContain(TOO_LARGE_HINT)
  expect(e.error.message).not.toMatch(/context window|exceed/i)
})

test("a 413 with no older image to leave out is not asked again", async () => {
  const { l, seen } = await loaded(10)
  const res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] }) })
  expect(seen.length).toBe(1)
  expect(res.status).toBe(413)
  const e = await res.json()
  expect(e.error.type).toBe("invalid_request_error")
  expect(e.error.message).not.toContain("left out")
  expect(e.error.message).toContain(TOO_LARGE_HINT)
})

test("Responses, chat completions and Gemini have their older images left out in their own words", () => {
  const img = { type: "input_image", image_url: "data:image/png;base64,AAAA" }
  const responses = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "a" }, img] },
      { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: [img] },
      { role: "user", content: [img] },
    ],
  }
  const r = leaveOutAttachments("/api/llm/o/v1/responses", JSON.stringify(responses))
  expect(r.left).toBe(2)
  const rs = JSON.parse(r.body)
  expect(rs.input[0].content[1]).toEqual({ type: "input_text", text: LEFT_OUT })
  expect(rs.input[2]).toEqual({ type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: LEFT_OUT }] })
  expect(rs.input[3].content[0]).toEqual(img)

  const url = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  const chat = { messages: [{ role: "user", content: [url, { type: "text", text: "x" }] }, { role: "user", content: [url] }] }
  const c = JSON.parse(leaveOutAttachments("/api/llm/o/v1/chat/completions", JSON.stringify(chat)).body)
  expect(c.messages[0].content).toEqual([{ type: "text", text: LEFT_OUT }, { type: "text", text: "x" }])
  expect(c.messages[1].content[0]).toEqual(url)

  const inline = { inlineData: { mimeType: "image/png", data: "AAAA" } }
  const gemini = {
    contents: [
      { role: "user", parts: [inline] },
      { role: "model", parts: [{ functionCall: { name: "view_image", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "view_image", response: {}, parts: [inline] } }] },
      { role: "user", parts: [inline] },
    ],
  }
  const g = JSON.parse(leaveOutAttachments("/api/llm/g/v1/models/gemini-4-argon:streamGenerateContent", JSON.stringify(gemini)).body)
  expect(g.contents[0].parts).toEqual([{ text: LEFT_OUT }])
  // a function response's parts take inline data alone: the image goes, the response stays
  expect(g.contents[2].parts).toEqual([{ functionResponse: { name: "view_image", response: {}, parts: [] } }])
  expect(g.contents[3].parts).toEqual([inline])

  // one image, none to leave out; a body not JSON, or a route with none
  expect(leaveOutAttachments("/api/llm/o/v1/chat/completions", JSON.stringify({ messages: [{ role: "user", content: [url] }] }))).toBeNull()
  expect(leaveOutAttachments("/api/llm/a/v1/messages", "not json")).toBeNull()
  expect(leaveOutAttachments("/api/llm/a/v1/messages/count_tokens", JSON.stringify(session()))).toBeNull()
})
