// A tool call the model wrote into the answer text, when the request carried no
// tools at all for it to be a call to. Measured 2026-11-11 on
// `auto/deepseek-v4.1-flash` through magpie: three turns came back as the raw
// block, one of them 2477 characters, and the agent read it as prose. The bytes
// below are that reply's, opener for opener.
//
// Nothing here can honour a call, so the block must not go out as the answer:
// the text stops where the call begins, and the turn ends with the error frame
// magpie fails over on — as trae (plugins#38) and qoder (plugins#132) already do.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

process.env.ORCATERM_NO_PACE = "1"

// DeepSeek writes the tag with two full-width bars on each side:
// <｜｜DSML｜｜ invoke name="…">. Kept as an escape so the file stays ASCII.
const BAR = "\uFF5C\uFF5C"
const CALL = [
  `<${BAR}DSML${BAR} calls>`,
  `<${BAR}DSML${BAR} invoke name="pwsh">`,
  `<${BAR}DSML${BAR} parameter name="command" string="true">Get-ChildItem</${BAR}DSML${BAR} parameter>`,
  `<${BAR}DSML${BAR} parameter name="description" string="true">List files</${BAR}DSML${BAR} parameter>`,
  `</${BAR}DSML${BAR} invoke>`,
  `</${BAR}DSML${BAR} calls>`,
  "",
  "```json",
  '{"action": "review", "ph_1": "--"}',
  "```",
].join("\n")

const frame = (content) => `data: ${JSON.stringify({ content, reasoningContent: "", type: "ai", code: 0 })}\n\n`

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
  const res = _internal.upstreamToOpenAI(sse([frame(content)]), { model: "deepseek-chat-latest" })
  return read(await res.text())
}

test("a reply that is only a text-form call is not sent out as the answer", async () => {
  const { content, error } = await asked(CALL)
  expect(content).toBe("")
  expect(error?.code).toBe("text_tool_call")
})

for (const size of [1, 7, 50, 4096]) {
  test(`the same call, in ${size}-character frames, never reaches the answer`, async () => {
    const res = _internal.upstreamToOpenAI(sse(pieces(CALL, size).map(frame)), { model: "m" })
    const { content, error } = read(await res.text())
    expect(content).toBe("")
    expect(error?.code).toBe("text_tool_call")
  })
}

test("prose before the call is still the answer, and the call still ends the turn", async () => {
  const { content, error } = await asked(`Here is what I found.\n${CALL}`)
  expect(content).toBe("Here is what I found.\n")
  expect(error?.code).toBe("text_tool_call")
})

test("a <tool_call> block is refused the same way", async () => {
  const { content, error } = await asked('Sure.\n<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>')
  expect(content).toBe("Sure.\n")
  expect(error?.code).toBe("text_tool_call")
})

// A call cut short at the end of the stream is still a call: the opening tag is
// the whole signal, whatever follows it.
test("a call the stream ended inside is refused too", async () => {
  const { content, error } = await asked(`Reading.\n<${BAR}DSML${BAR} invoke name="pwsh">\n<${BAR}DSML${BAR} param`)
  expect(content).toBe("Reading.\n")
  expect(error?.code).toBe("text_tool_call")
})

// The guard must not eat ordinary prose: a `<` that starts no tag stays, and so
// does a tag-shaped word that never opens a block.
test("a lone < in prose is answered, not held back", async () => {
  const { content, error } = await asked("if a < b then the answer is a.\n")
  expect(content).toBe("if a < b then the answer is a.\n")
  expect(error).toBeNull()
})

test("a reply that mentions the words tool_call without a tag is left alone", async () => {
  const { content, error } = await asked("The tool_call field is described in the schema.\n")
  expect(content).toBe("The tool_call field is described in the schema.\n")
  expect(error).toBeNull()
})

test("a reply that ends on < keeps it", async () => {
  const { content, error } = await asked("a <")
  expect(content).toBe("a <")
  expect(error).toBeNull()
})

// The whole reply as one non-streamed body: magpie asks again on a 502.
test("a request that isn't streamed ends as 502, not as a 200 carrying the call", async () => {
  const res = await _internal.upstreamToJSON(sse([frame(CALL)]), { model: "m" })
  expect(res.status).toBe(502)
  const body = await res.json()
  expect(body.error.message).toContain("tool call as text")
})