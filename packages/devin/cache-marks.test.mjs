// Claude Code marks the end of what it wants cached with cache_control on
// a block, and a growing history (its Auto mode's classifier asks) moves
// the mark onto the block it adds. On chat completions the blocks were
// joined into one text with no mark, so a grown history read only ~558
// tokens from the cache (plugins#566, zelong77). Devin's Claude models are
// now asked on Anthropic's Messages API: each block goes to Devin as a
// ChatMessagePrompt of its own, and a marked one carries
// prompt_cache_options {type: EPHEMERAL} (field 8, 0801), as the devin
// CLI sends its own.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { DevinAuthPlugin } from "./index.mjs"

const { PB, frame, fields, buildMessages, completeMessages, build, configModel, runtimeModel, listed, familiesOf, SNAPSHOT, anthropicEffort } = _internal
const dec = new TextDecoder()
const enc = new TextEncoder()
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// prompts is each ChatMessagePrompt a request sends: its role, text, call
// id, calls and field 8's raw bytes
const prompts = (body) =>
  fields(body)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const p = { role: 0, text: "", cache: null, callID: "", calls: [], images: 0 }
      for (const g of fields(f.data)) {
        if (g.num === 2) p.role = g.n
        else if (g.num === 3) p.text = dec.decode(g.data)
        else if (g.num === 7) p.callID = dec.decode(g.data)
        else if (g.num === 8) p.cache = Buffer.from(g.data).toString("hex")
        else if (g.num === 6) p.calls.push(dec.decode(fields(g.data).find((h) => h.num === 2).data))
        else if (g.num === 10) p.images++
      }
      return p
    })

const EPHEMERAL = "0801"
const mark = { type: "ephemeral" }
const history = (from, n) => Array.from({ length: n }, (_, i) => `step ${from + i}: read src/module_${from + i}.ts`).join("\n")
const system = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.316.e5f; cc_entrypoint=cli; cch=8a1f2;" },
  { type: "text", text: "You are a security monitor for autonomous AI coding agents.", cache_control: mark },
]
// the issue's shape: one user message of <transcript>, the history, the
// current action and the closing note, the mark on the history
const ask = (blocks, action) => ({
  model: "claude-haiku-5-5",
  max_tokens: 64,
  system,
  messages: [{ role: "user", content: [...blocks, { type: "text", text: "Current action: " + action }, { type: "text", text: "</transcript>\nClassify the current action." }] }],
})

test("each user block is a prompt of its own, and only a marked one carries prompt_cache_options (#566)", () => {
  const round1 = prompts(buildMessages(ask([{ type: "text", text: "<transcript>" }, { type: "text", text: history(0, 50), cache_control: mark }], "rm -rf build/"), "claude-haiku-5-5", "k"))
  expect(round1.map((p) => [p.role, p.text.slice(0, 20), p.cache])).toEqual([
    [1, "You are a security m", EPHEMERAL],
    [1, "<transcript>", null],
    [1, history(0, 50).slice(0, 20), EPHEMERAL],
    [1, "Current action: rm -", null],
    [1, "</transcript>\nClassi", null],
  ])
  // the billing line, whose cch changes every turn, isn't sent
  expect(round1.some((p) => p.text.includes("x-anthropic-billing-header"))).toBe(false)
})

test("a grown history keeps every prompt the last mark covered as it was sent (yetone/magpie#3835)", () => {
  const old = [{ type: "text", text: "<transcript>" }, { type: "text", text: history(0, 50) }]
  const round1 = prompts(buildMessages(ask([old[0], { ...old[1], cache_control: mark }], "rm -rf build/"), "claude-haiku-5-5", "k"))
  // the mark moves to the block the history grew by
  const round2 = prompts(buildMessages(ask([...old, { type: "text", text: history(50, 5), cache_control: mark }], "git push --force"), "claude-haiku-5-5", "k"))
  expect(round2.slice(0, 3).map((p) => p.text)).toEqual(round1.slice(0, 3).map((p) => p.text))
  expect(round2[2].cache).toBe(null)
  expect([round2[3].text, round2[3].cache]).toEqual([history(50, 5), EPHEMERAL])
})

test("a system notice after a tool result keeps its position and cache mark", () => {
  const ps = prompts(buildMessages({
    system: [{ type: "text", text: "Stable instructions", cache_control: mark }],
    messages: [
      { role: "user", content: "Read calc.py." },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "calc.py" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "return 42" }] },
      { role: "system", content: [{ type: "text", text: "Run the focused tests next.", cache_control: mark }] },
    ],
  }, "claude-opus-5-5", "k"))
  expect(ps.map((p) => [p.role, p.text, p.callID, p.calls, p.cache])).toEqual([
    [1, "Stable instructions", "", [], EPHEMERAL],
    [1, "Read calc.py.", "", [], null],
    [2, "", "", ["read_file"], null],
    [4, "return 42", "c1", [], null],
    [1, "Run the focused tests next.", "", [], EPHEMERAL],
  ])
})

test("a growing conversation moves its system notice's cache mark without changing the old prefix", () => {
  const first = [
    { role: "user", content: "Inspect calc.py." },
    { role: "system", content: [{ type: "text", text: "Keep changes focused." }, { type: "text", text: "Check the result." }] },
  ]
  const round1 = prompts(buildMessages({ messages: [first[0], { ...first[1], content: [first[1].content[0], { ...first[1].content[1], cache_control: mark }] }] }, "claude-opus-5-5", "k"))
  expect(round1.map((p) => [p.role, p.text, p.cache])).toEqual([
    [1, "Inspect calc.py.", null],
    [1, "Keep changes focused.", null],
    [1, "Check the result.", EPHEMERAL],
  ])
  const round2 = prompts(buildMessages({ messages: [
    ...first,
    { role: "assistant", content: [{ type: "text", text: "The result is correct." }] },
    { role: "user", content: "Continue." },
    { role: "system", content: [{ type: "text", text: "Run tests now.", cache_control: mark }] },
  ] }, "claude-opus-5-5", "k"))
  expect(round2.map((p) => [p.role, p.text, p.cache])).toEqual([
    [1, "Inspect calc.py.", null],
    [1, "Keep changes focused.", null],
    [1, "Check the result.", null],
    [2, "The result is correct.", null],
    [1, "Continue.", null],
    [1, "Run tests now.", EPHEMERAL],
  ])
  expect(round2.slice(0, round1.length).map(({ cache, ...p }) => p)).toEqual(round1.map(({ cache, ...p }) => p))
})

test("system notices before tool results follow the real results without interrupting calls", () => {
  const ps = prompts(buildMessages({ messages: [
    { role: "user", content: "Read calc.py." },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }, { type: "tool_use", id: "c2", name: "read_file", input: {} }] },
    { role: "system", content: "The user asked to stop after this read." },
    { role: "system", content: [{ type: "text", text: "Report both results.", cache_control: mark }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "return 42" }, { type: "tool_result", tool_use_id: "c2", content: "return 43" }] },
  ] }, "claude-opus-5-5", "k"))
  expect(ps.map((p) => [p.role, p.text, p.callID, p.calls, p.cache])).toEqual([
    [1, "Read calc.py.", "", [], null],
    [2, "", "", ["read_file", "read_file"], null],
    [4, "return 42", "c1", [], null],
    [4, "return 43", "c2", [], null],
    [1, "The user asked to stop after this read.", "", [], null],
    [1, "Report both results.", "", [], EPHEMERAL],
  ])
})

test("empty system notices add no prompts or fallback turn", () => {
  const ps = prompts(buildMessages({ messages: [
    { role: "user", content: "Continue." },
    { role: "system", content: "" },
    { role: "system", content: [], output_config: { effort: "low" } },
  ] }, "claude-opus-5-5", "k"))
  expect(ps.map((p) => [p.role, p.text, p.cache])).toEqual([[1, "Continue.", null]])
})

for (const [name, content] of [["empty string", ""], ["empty array", []], ["empty text block", [{ type: "text", text: "" }]]]) {
  test(`a system notice with ${name} does not split an assistant's tool-call turn`, () => {
    const ps = prompts(buildMessages({ messages: [
      { role: "user", content: "Read both files." },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
      { role: "system", content },
      { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "first" }, { type: "tool_result", tool_use_id: "c2", content: "second" }] },
    ] }, "claude-opus-5-5", "k"))
    expect(ps.map((p) => [p.role, p.text, p.callID, p.calls])).toEqual([
      [1, "Read both files.", "", []],
      [2, "", "", ["read_file", "read_file"]],
      [4, "first", "c1", []],
      [4, "second", "c2", []],
    ])
  })
}

test("a notice after an interrupted tool call follows its missing-result placeholder", () => {
  const ps = prompts(buildMessages({ messages: [
    { role: "user", content: "Read calc.py." },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
    { role: "system", content: [{ type: "text", text: "The read was interrupted.", cache_control: mark }] },
  ] }, "claude-opus-5-5", "k"))
  expect(ps.slice(-2).map((p) => [p.role, p.text, p.callID, p.cache])).toEqual([
    [4, "Tool use was interrupted and did not produce a result.", "c1", null],
    [1, "The read was interrupted.", "", EPHEMERAL],
  ])
})

test("tool calls and results keep their own prompts and marks", () => {
  const body = buildMessages(
    {
      model: "claude-opus-5-5",
      max_tokens: 400,
      tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }, { type: "web_search_20250305", name: "web_search" }],
      messages: [
        { role: "user", content: "Read /etc/motd." },
        { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/etc/motd" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "Welcome" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } }], cache_control: mark }] },
      ],
    },
    "claude-opus-5-5",
    "k",
  )
  const ps = prompts(body)
  expect(ps.map((p) => [p.role, p.text.split("\n")[0], p.callID, p.calls, p.cache, p.images])).toEqual([
    [1, "<tool_descriptions>", "", [], null, 0],
    [1, "Read /etc/motd.", "", [], null, 0],
    [2, "Reading it.", "", ["read_file"], null, 0],
    [4, "Welcome", "toolu_01", [], EPHEMERAL, 1],
  ])
  // a server tool isn't offered to Devin
  const offered = fields(body).filter((f) => f.num === 10).map((f) => dec.decode(fields(f.data).find((g) => g.num === 1).data))
  expect(offered).toEqual(["read_file"])
})

test("a failed result says so in its text, as on chat completions", () => {
  const ps = prompts(
    buildMessages(
      {
        model: "claude-haiku-5-5",
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "exit status 1", is_error: true }] },
        ],
      },
      "claude-haiku-5-5",
      "k",
    ),
  )
  expect(ps.find((p) => p.role === 4).text).toBe("Error: exit status 1")
})

test("a Messages request's effort is read as magpie reads it", () => {
  expect(anthropicEffort({ thinking: { type: "adaptive" }, output_config: { effort: "high" } })).toBe("high")
  expect(anthropicEffort({ thinking: { type: "enabled", budget_tokens: 10000 } })).toBe("medium")
  expect(anthropicEffort({ thinking: { type: "disabled" }, output_config: { effort: "high" } })).toBe("")
  expect(anthropicEffort({})).toBe("")
})

test("only Claude models are asked on Anthropic's Messages API; others are unchanged", () => {
  const models = listed(familiesOf(SNAPSHOT), [], {})
  const claude = models.find((m) => m.id === "claude-opus-5-5")
  const other = models.find((m) => !/claude/i.test(m.id) && m.efforts.length)
  expect(claude && other).toBeTruthy()
  expect(configModel(claude).provider).toEqual({ npm: "@ai-sdk/anthropic", api: "https://server.codeium.com/devin/v1" })
  expect(runtimeModel(claude).api.npm).toBe("@ai-sdk/anthropic")
  expect(Object.values(runtimeModel(claude).variants)[0]).toEqual({ effort: claude.efforts[0] })
  expect(configModel(other).provider).toBeUndefined()
  expect(runtimeModel(other).api).toEqual({ id: other.id, url: "https://server.codeium.com/devin/v1", npm: "@ai-sdk/openai-compatible" })
  expect(Object.values(runtimeModel(other).variants)[0]).toEqual({ reasoningEffort: other.efforts[0] })
  expect(Object.values(configModel(other).variants)[0]).toEqual({ reasoningEffort: other.efforts[0] })
  // a chat completion still goes as one prompt per message, with no mark
  const ps = prompts(build({ model: other.id, messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }, other.id, "k"))
  expect(ps.map((p) => [p.text, p.cache])).toEqual([["a\n\nb", null]])
})

// reply is Devin's answer: text, a call and the usage with the cache's
// read (field 5) and write (4)
const reply = () => {
  const usage = new PB().varint(2, 27).varint(3, 12).varint(4, 560).varint(5, 7318).done()
  const call = new PB().str(1, "toolu_02").str(2, "read_file").str(3, '{"path":"/a"}').done()
  const end = enc.encode("{}")
  const tail = new Uint8Array(5 + end.length)
  tail[0] = 2
  new DataView(tail.buffer).setUint32(1, end.length)
  tail.set(end, 5)
  return new Response(new Blob([frame(new PB().str(3, "Let me look.").done()), frame(new PB().bytes(6, call).varint(5, 10).bytes(7, usage).done()), tail]))
}
const ctx = { key: "k", server: "https://devin.test", families: familiesOf(SNAPSHOT) }
const req = (stream) => ({ model: "claude-haiku-5-5", max_tokens: 64, stream, messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: mark }] }] })

test("a whole reply is Anthropic's message, with the cache's read and write", async () => {
  globalThis.fetch = async () => reply()
  const res = await completeMessages(ctx, req(false))
  expect(res.status).toBe(200)
  const j = await res.json()
  expect(j.content).toEqual([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_02", name: "read_file", input: { path: "/a" } }])
  expect(j.stop_reason).toBe("tool_use")
  expect(j.usage).toEqual({ input_tokens: 27, output_tokens: 12, cache_read_input_tokens: 7318, cache_creation_input_tokens: 560 })
})

test("a streamed reply is Anthropic's events", async () => {
  globalThis.fetch = async () => reply()
  const res = await completeMessages(ctx, req(true))
  const ev = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
  expect(ev.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
  expect(ev[4].content_block).toEqual({ type: "tool_use", id: "toolu_02", name: "read_file", input: {} })
  expect(ev[5].delta).toEqual({ type: "input_json_delta", partial_json: '{"path":"/a"}' })
  expect(ev[7].delta.stop_reason).toBe("tool_use")
  expect(ev[7].usage.cache_read_input_tokens).toBe(7318)
})

test("the loader answers count_tokens in Anthropic's words, without asking Devin", async () => {
  globalThis.fetch = async () => {
    throw new Error("no network in tests")
  }
  const auth = { type: "api", key: "k" }
  const { auth: a } = await DevinAuthPlugin({})
  const { fetch: f } = await a.loader(async () => auth)
  const res = await f("https://server.codeium.com/devin/v1/messages/count_tokens", { method: "POST", body: "{}" })
  expect(res.status).toBe(404)
  expect((await res.json()).type).toBe("error")
})
