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

// The 48-char envelope hold makes what's judged end on an arbitrary character,
// and `<tool_call` is what `<tool_calls>` looks like on its way in: a word
// boundary at the end of that window used to latch and kill the answer
// (yetone's review). Every frame size, and the sentence naming the tag.
const MENTIONS = "The response carries a `<tool_calls>` array, and the client reads it before it dispatches anything."
for (const size of [1, 3, 47, 4096]) {
  test(`a tag-shaped word in prose survives ${size}-character frames`, async () => {
    const res = _internal.upstreamToOpenAI(sse(pieces(MENTIONS, size).map((c) => frame(c))), { model: "m" })
    const { content, error } = read(await res.text())
    expect(content).toBe(MENTIONS)
    expect(error).toBeNull()
  })
}

test("and the same sentence is not cut by the non-streamed path", async () => {
  const res = await _internal.upstreamToJSON(sse([frame(MENTIONS)]), { model: "m" })
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe(MENTIONS)
})

// The same sentence without backticks, which is what the guard actually turns
// on: with them it is "quoted" and shown for that reason, so the boundary rule
// was never tested (yetone's review: breaking it left 0 red).
const PLAIN = "The response carries a <tool_calls> array, and the client reads it before it dispatches anything."
for (const size of [1, 3, 47, 4096]) {
  test(`an unquoted tag-shaped word survives ${size}-character frames`, async () => {
    const res = _internal.upstreamToOpenAI(sse(pieces(PLAIN, size).map((c) => frame(c))), { model: "m" })
    const { content, error } = read(await res.text())
    expect(content).toBe(PLAIN)
    expect(error).toBeNull()
  })
}

test("and so does <tool_call_id>, which is not a call at all", async () => {
  const text = "Each message has a <tool_call_id> field beside its role, as the schema says.\n"
  const { content, error } = await asked(text)
  expect(content).toBe(text)
  expect(error).toBeNull()
})

// The tag is written in whatever case the model felt like; the hold list is
// compared lowercased, so the reader must be too.
test("an upper-case <TOOL_CALL> block is refused", async () => {
  const { content, error } = await asked('Sure.\n<TOOL_CALL>{"name":"read"}</TOOL_CALL>')
  expect(content).toBe("Sure.\n")
  expect(error?.code).toBe("text_tool_call")
})

test("an upper-case <Tool_Call> block split across frames is refused", async () => {
  const res = _internal.upstreamToOpenAI(
    sse(pieces('<Tool_Call>{"name":"read"}</Tool_Call>', 1).map((c) => frame(c))),
    { model: "m" },
  )
  const { content, error } = read(await res.text())
  expect(content).toBe("")
  expect(error?.code).toBe("text_tool_call")
})

// A call being shown, not written: inside a code fence or inline code it is
// prose, and trae's reader has always treated it that way (yetone's review).
const FENCED = [
  "Here is the format:",
  "",
  "```xml",
  '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>',
  "```",
  "",
  "That is all.",
].join("\n")

for (const size of [1, 5, 4096]) {
  test(`a fenced call is shown, not refused, in ${size}-character frames`, async () => {
    const res = _internal.upstreamToOpenAI(sse(pieces(FENCED, size).map((c) => frame(c))), { model: "m" })
    const { content, error } = read(await res.text())
    expect(content).toBe(FENCED)
    expect(error).toBeNull()
  })
}

test("a call in backticks is shown too", async () => {
  const text = "Use `<tool_call>` to call a tool.\n"
  const { content, error } = await asked(text)
  expect(content).toBe(text)
  expect(error).toBeNull()
})

test("a fenced call is shown by the non-streamed path as well", async () => {
  const res = await _internal.upstreamToJSON(sse([frame(FENCED)]), { model: "m" })
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe(FENCED)
})

// Thinking is turned into the answer when no text came, so a call carried only
// as thinking must not be handed over as prose either.
test("a call that arrives only as thinking still ends the turn", async () => {
  const res = _internal.upstreamToOpenAI(sse([frame("", CALL)]), { model: "m" })
  const { content, error } = read(await res.text())
  expect(content).toBe("")
  expect(error?.code).toBe("text_tool_call")
})

// And it does so whatever the call sits behind. `answerOf` runs its own
// extractor, which already cuts at the call, so scanning its output for a tag
// said no and the call went out as the answer — the exact harm this change is
// for (yetone's review, must-fix 1).
test("a call behind a line of thinking still ends the turn", async () => {
  const res = _internal.upstreamToOpenAI(sse([frame("", "Let me look at the files.\n" + CALL)]), { model: "m" })
  const { content, error } = read(await res.text())
  expect(content).toBe("Let me look at the files.\n")
  expect(error?.code).toBe("text_tool_call")
})

test("the same thinking-only call is a 502 when the request isn't streamed", async () => {
  const res = await _internal.upstreamToJSON(sse([frame("", "Let me look at the files.\n" + CALL)]), { model: "m" })
  expect(res.status).toBe(502)
})

test("a call inside a thinking envelope is refused too", async () => {
  const envelope = '{"action":"completion","ph_1":"--","taskCompletion":"Reading.\n' + CALL + '"}'
  const res = _internal.upstreamToOpenAI(sse([frame("", envelope)]), { model: "m" })
  const { content, error } = read(await res.text())
  expect(content).toBe("Reading.\n")
  expect(error?.code).toBe("text_tool_call")
})

// A fenced call in the thinking is being shown, not written: the quoted rule
// holds on this path as well, so it is turned into the answer as usual.
test("a fenced call in the thinking is shown, not refused", async () => {
  const res = _internal.upstreamToOpenAI(sse([frame("", FENCED)]), { model: "m" })
  const { content, error } = read(await res.text())
  expect(content).toBe(FENCED)
  expect(error).toBeNull()
})

// The whole reply as one non-streamed body: magpie asks again on a 502.
test("a request that isn't streamed ends as 502, not as a 200 carrying the call", async () => {
  const res = await _internal.upstreamToJSON(sse([frame(CALL)]), { model: "m" })
  expect(res.status).toBe(502)
  const body = await res.json()
  expect(body.error.message).toContain("tool call as text")
})