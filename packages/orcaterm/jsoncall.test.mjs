// plugins#1114, the sibling of qoder's #1113: a reply that writes its call
// as one JSON object in OpenAI's own wire shape, {"tool_calls":[{…}]}, went
// out as the answer. OrcaTerm is sent no tools, so, as with a <tool_call>
// block here, the text stops where the object begins and the turn ends with
// the text_tool_call error. The object is #1113's, byte for byte. JSON in
// prose or code, and other objects, stay the answer.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

process.env.ORCATERM_NO_PACE = "1"

const BARE = '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.go"}},{"name":"viking_search","arguments":{"query":"x"}}]}'
const frame = (content) => `data: ${JSON.stringify({ content, reasoningContent: "", type: "ai", code: 0 })}\n\n`
const sse = (frames) => new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close() } })
const pieces = (s, n) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n))

function read(text) {
  let content = ""
  let error = null
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue
    const j = JSON.parse(line.slice(6))
    if (j.error) error = j.error
    content += j.choices?.[0]?.delta?.content ?? ""
  }
  return { content, error }
}
const asked = async (s, n = 4096) => read(await _internal.upstreamToOpenAI(sse(pieces(s, n).map(frame)), { model: "m" }).text())

for (const n of [1, 5, 4096]) {
  test(`a bare {"tool_calls":[…]} reply in ${n}-character frames is refused, never sent as the answer`, async () => {
    const a = await asked(BARE, n)
    expect(a.content).toBe("")
    expect(a.error?.code).toBe("text_tool_call")
    const b = await asked("Reading it.\n  " + BARE, n)
    expect(b.content).toBe("Reading it.\n")
    expect(b.error?.code).toBe("text_tool_call")
  })
}

test("the same shape in prose, in code, or with no calls is the answer", async () => {
  for (const t of [
    'The API answers {"tool_calls":[{"name":"a"}]} there.',
    "```json\n" + BARE + "\n```",
    '{"tool_calls":[]}',
    '{"total": 3}',
  ]) {
    for (const n of [1, 4096]) {
      const a = await asked(t, n)
      expect(a.error).toBeNull()
      expect(a.content).toBe(t)
    }
  }
  expect(_internal.textCallIn(BARE)).toBe(0)
  expect(_internal.textCallHold('ok\n{"tool')).toBe(3)
  expect(_internal.textCallHold('ok\n{"total"')).toBe(-1)
})
