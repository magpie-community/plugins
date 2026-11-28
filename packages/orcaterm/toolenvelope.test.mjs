// The model answering as the OrcaTerm assistant instead of the OpenAI one it
// was asked to be: a whole agent turn came back as the terminal's own tool
// action envelope — a review with a `tool` payload — and reached the agent as
// the answer text with a 200, which nothing could fail over on. Measured
// 2026-11-19 on `auto/glm-5.3` through magpie; the bytes below are that
// reply's, opener for opener.
//
// Nothing here can honour it: the request went up with `tools: []` (see
// toUpstreamBody), so the `tool` it asks for cannot be run, and the object is
// that client's protocol, not an answer an OpenAI client can use. The envelope
// never streams before it is whole, and the turn ends as the error frame
// magpie fails over on — the same treatment as TEXT_CALL (textcall.test.mjs),
// trae (plugins#38) and qoder (plugins#132).
//
// The same evening measured the run form: a model with more than one thing to
// ask for writes the envelopes one after another, back to back, and the stream
// can end inside any of them.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

process.env.ORCATERM_NO_PACE = "1"

// The reply as it arrived, with the Chinese kept as escapes so the file stays
// ASCII. The second one is from the run form: two envelopes, no separator.
const ENVELOPE = "{\"action\":\"review\",\"ph_1\":\"--\",\"tool\":{\"type\":\"mcp\",\"mcpServer\":\"mcp-server-orcaterm-oauth\",\"name\":\"execute_command\",\"description\":\"\u67e5\u770b codar \u4fee\u590d\u4efb\u52a1\u7559\u4e0b\u7684\u53ef\u590d\u73b0\u6253\u5305\u811a\u672c repack.py\uff0c\u51c6\u5907\u590d\u7528\u5b83\u7ed9\u8865\u4e01\u7248 catpaw \u63d2\u4ef6\u6253 tgz\",\"args\":{\"command\":\"ls \\\"F:/lifeuse/20261023-magpie\u63d2\u4ef6\u62a5\u9519\u6392\u67e5/repack.py\\\" \\\"F:/lifeuse/20261116-magpie-codar\u63d2\u4ef6\u6062\u590d/scripts/\\\" 2>&1; head -60 \\\"F:/lifeuse/20261023-magpie\u63d2\u4ef6\u62a5\u9519\u6392\u67e5/repack.py\\\"\"}}}"
const ENVELOPE2 = "{\"action\":\"review\",\"ph_1\":\"--\",\"tool\":{\"type\":\"mcp\",\"mcpServer\":\"billion-context\",\"name\":\"compress\",\"description\":\"\u538b\u7f29\u5df2\u6d88\u8d39\u7684\u4f1a\u8bdd\u6bb5\u843d\",\"args\":{\"content\":\"m00149\u2013m00165\"}}}"

const frame = (content, reasoningContent = "") =>
  `data: ${JSON.stringify({ content, reasoningContent, type: "ai", code: 0 })}\n\n`

const sse = (frames) =>
  new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f))
      c.close()
    },
  })

const pieces = (s, n) => {
  const out = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

/** What the client would read as the answer, and the error frame if one came. */
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

async function asked(content) {
  const res = _internal.upstreamToOpenAI(sse([frame(content)]), { model: "glm-5.3" })
  return read(await res.text())
}

test("a reply that is only the tool action envelope is not sent out as the answer", async () => {
  const { content, error } = await asked(ENVELOPE)
  expect(content).toBe("")
  expect(error?.code).toBe("text_tool_call")
})

for (const size of [1, 7, 50, 4096]) {
  test(`the same envelope, in ${size}-character frames, never reaches the answer`, async () => {
    const res = _internal.upstreamToOpenAI(sse(pieces(ENVELOPE, size).map(frame)), { model: "m" })
    const { content, error } = read(await res.text())
    expect(content).toBe("")
    expect(error?.code).toBe("text_tool_call")
  })
}

test("prose before the envelope is still the answer, and the envelope still ends the turn", async () => {
  const { content, error } = await asked(`Reading the script first.\n${ENVELOPE}`)
  expect(content).toBe("Reading the script first.\n")
  expect(error?.code).toBe("text_tool_call")
})

test("a fenced envelope after prose is cut with its fence", async () => {
  const { content, error } = await asked("Prose.\n```json\n" + ENVELOPE + "\n```")
  expect(content).toBe("Prose.\n")
  expect(error?.code).toBe("text_tool_call")
})

test("two envelopes back to back are tool traffic together", async () => {
  const { content, error } = await asked(ENVELOPE + ENVELOPE2)
  expect(content).toBe("")
  expect(error?.code).toBe("text_tool_call")
})

test("prose before two back to back keeps only the prose", async () => {
  const { content, error } = await asked(`Reading the script first.\n${ENVELOPE}${ENVELOPE2}`)
  expect(content).toBe("Reading the script first.\n")
  expect(error?.code).toBe("text_tool_call")
})

// The stream can end inside a later member of the run: the complete ones
// before it are tool traffic all the same, and must not go out as text.
test("the stream ending inside the second of two back to back still refuses them", async () => {
  const { content, error } = await asked(`Reading the script first.\n${ENVELOPE}{"action":"review","ph_1"`)
  expect(content).toBe("Reading the script first.\n")
  expect(error?.code).toBe("text_tool_call")
})

test("a whole-reply run the stream ended inside is refused too", async () => {
  const { content, error } = await asked(`${ENVELOPE}{"action":"review","ph_1"`)
  expect(content).toBe("")
  expect(error?.code).toBe("text_tool_call")
})

// The guard must not eat ordinary prose.
test("an envelope shown as an example, with text after it, stays prose", async () => {
  const text = `The format looks like ${ENVELOPE} and that is all.`
  const { content, error } = await asked(text)
  expect(content).toBe(text)
  expect(error).toBeNull()
})

test("a review that carries a taskCompletion is an answer, not tool traffic", async () => {
  const { content, error } = await asked('{"action":"review","ph_1":"--","taskCompletion":"Done."}')
  expect(content).toBe("Done.")
  expect(error).toBeNull()
})

// A truncated envelope on its own keeps the original treatment: nothing
// tool-shaped is visible in it yet, so it stays text, the same way a reply the
// stream ended inside an answer envelope does.
test("a truncated envelope on its own stays text", async () => {
  const text = ENVELOPE.slice(0, 120)
  const { content, error } = await asked(text)
  expect(content).toBe(text)
  expect(error).toBeNull()
})
