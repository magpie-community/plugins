// yetone/magpie#952: pi 1.0.4 through magpie got 403 "Factory: Forbidden"
// on DeepSeek (chat completions) and Claude (Messages) for "hi". The
// reporter's replays found the refused part: pi's opening sentence, whole
// (either half passes). The shapes below are pi's two requests as the
// reporter captured them: a developer message on chat completions, one
// system text block with cache_control on Messages.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages?beta=true"

const ESCAPED_OPENING = "\\u0059ou are an expert coding assistant operating inside pi, a coding agent harness."
const ESCAPED_COMPACTED = "\\u0054he conversation history before this point was compacted into the following summary:"
const OPENING = "You are an expert coding assistant operating inside pi, a coding agent harness."
const REST = " You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents"
const PI = OPENING + REST
const ADAPTED = "You are an expert coding assistant." + REST

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "", premBaseHost: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const s = JSON.stringify(body)
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "pi (darwin 24.6.0; arm64)" }, body: s })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

const tools = ["read", "bash", "edit", "write"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }))

test("pi's opening sentence is cut to its first half on chat completions, the rest of its prompt kept", async () => {
  const send = await loaded()
  const b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: PI }, { role: "user", content: "hi" }], tools, stream: true })
  expect(b.messages).toEqual([{ role: "system", content: DROID_LINE }, { role: "developer", content: ADAPTED }, { role: "user", content: "hi" }])
  expect(b.tools).toEqual(tools)
  // as a system message too, and in text parts
  let c = await send(chat, { model: "kimi-k3", messages: [{ role: "system", content: PI }, { role: "user", content: "hi" }] })
  expect(c.messages[0]).toEqual({ role: "system", content: DROID_LINE + "\n" + ADAPTED })
  c = await send(chat, { model: "kimi-k3", messages: [{ role: "developer", content: [{ type: "text", text: PI }] }, { role: "user", content: "hi" }] })
  expect(c.messages[1]).toEqual({ role: "developer", content: [{ type: "text", text: ADAPTED }] })
})

test("pi's opening sentence is adapted in Messages' system block, its cache_control kept", async () => {
  const send = await loaded()
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: PI, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(b.system).toEqual([{ type: "text", text: DROID_LINE }, { type: "text", text: ADAPTED, cache_control: { type: "ephemeral" } }])
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
})

test("pi's opening sentence is adapted in Responses' instructions and input", async () => {
  const send = await loaded()
  let b = await send(responses, { model: "gpt-6.1", instructions: PI, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
  b = await send(responses, { model: "gpt-6.1", input: [{ role: "developer", content: PI }, { role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE)
  expect(b.input[0]).toEqual({ role: "developer", content: ADAPTED })
  // droid's own instructions are untouched unless the sentence is in them
  b = await send(responses, { model: "gpt-6.1", instructions: DROID_LINE + "\n" + PI, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
})

test("pi's opening quoted in user, assistant or system text is escaped, a fragment kept", async () => {
  const send = await loaded()
  const quoted = "Why does pi say: " + OPENING
  const partial = "You are an expert coding assistant operating inside pi."
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "Quote: " + OPENING }], messages: [
    { role: "user", content: [{ type: "text", text: quoted }] },
    { role: "assistant", content: [{ type: "text", text: quoted }] },
    { role: "user", content: [{ type: "text", text: partial }] },
  ] })
  // Factory refuses the sentence in user and assistant text too, so the last
  // pass escapes it everywhere; only the complete sentence changes.
  expect(b.system[1].text).toBe("Quote: " + ESCAPED_OPENING)
  expect(b.messages[0].content[0].text).toBe("Why does pi say: " + ESCAPED_OPENING)
  expect(b.messages[1].content[0].text).toBe("Why does pi say: " + ESCAPED_OPENING)
  expect(b.messages[2].content[0].text).toBe(partial)
})

test("a compaction-shaped user text is escaped, so a poisoned conversation can still be summarized", async () => {
  const send = await loaded()
  const serialized = "Summarize this conversation:\n<conversation>\n[Tool result]: " + OPENING + "\n[Assistant]: done\n</conversation>"
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: serialized }] }] })
  expect(b.messages[0].content[0].text).toBe(serialized.replace(OPENING, ESCAPED_OPENING))
  expect(b.messages[0].content[0].text).not.toContain(OPENING)
  const c = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: serialized }] })
  expect(c.messages[1].content).toBe(serialized.replace(OPENING, ESCAPED_OPENING))
})

test("a tool_use argument that quotes pi's opening is escaped too", async () => {
  const send = await loaded()
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo " + OPENING } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ] })
  expect(b.messages[1].content[0].input.command).toBe("echo " + ESCAPED_OPENING)
  expect(JSON.stringify(b)).not.toContain(OPENING)
})

// yetone/magpie#1316: after pi compacted a session, every turn on
// factory/claude-opus-5-5 was 403 "Factory: Forbidden". The reporter's
// replays found the refused part: the fixed sentence pi opens the summary
// message with (pi-coding-agent dist/core/messages.js
// COMPACTION_SUMMARY_PREFIX), whole; with it removed or reworded the same
// request was answered. pi sends the summary as a user message of one text
// part (convertToLlm), the sentence, the summary in <summary> tags, and
// BRANCH_SUMMARY_PREFIX's sentence for a branch it came back from.
const COMPACTED = "The conversation history before this point was compacted into the following summary:"
const SUMMARY = "## Goal\nFix the login redirect.\n\n## Progress\n### Done\n- [x] Read src/auth.ts\n\n## Next Steps\n1. Patch the callback\n\n<read-files>\nsrc/auth.ts\n</read-files>"
const PI_COMPACTION = COMPACTED + "\n\n<summary>\n" + SUMMARY + "\n</summary>"
const ADAPTED_COMPACTION = "Earlier conversation context is summarized below:\n\n<summary>\n" + SUMMARY + "\n</summary>"
const BRANCHED = "The following is a summary of a branch that this conversation came back from:"
const PI_BRANCH = BRANCHED + "\n\n<summary>\n" + SUMMARY + "</summary>"
const ADAPTED_BRANCH = "Summary of an earlier conversation branch:\n\n<summary>\n" + SUMMARY + "</summary>"

test("pi's compaction summary opens without its fixed sentence on Messages, the summary kept", async () => {
  const send = await loaded()
  const after = [{ role: "assistant", content: [{ type: "text", text: "Patched." }] }, { role: "user", content: [{ type: "text", text: "go on" }] }]
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: PI, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: PI_COMPACTION }] }, ...after] })
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: ADAPTED_COMPACTION }] }, ...after])
  expect(JSON.stringify(b)).not.toContain(COMPACTED)
  // a string content, and a branch summary
  const c = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: PI_COMPACTION }, { role: "user", content: [{ type: "text", text: PI_BRANCH }] }] })
  expect(c.messages).toEqual([{ role: "user", content: ADAPTED_COMPACTION }, { role: "user", content: [{ type: "text", text: ADAPTED_BRANCH }] }])
})

test("pi's compaction summary opens without its fixed sentence on chat completions and Responses", async () => {
  const send = await loaded()
  let b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: PI }, { role: "user", content: [{ type: "text", text: PI_COMPACTION }] }, { role: "user", content: "go on" }] })
  expect(b.messages.slice(1)).toEqual([{ role: "developer", content: ADAPTED }, { role: "user", content: [{ type: "text", text: ADAPTED_COMPACTION }] }, { role: "user", content: "go on" }])
  b = await send(chat, { model: "kimi-k3", messages: [{ role: "user", content: PI_BRANCH }] })
  expect(b.messages[1]).toEqual({ role: "user", content: ADAPTED_BRANCH })
  b = await send(responses, { model: "gpt-6.1", instructions: PI, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PI_COMPACTION }] }, { role: "user", content: "go on" }] })
  expect(b.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: ADAPTED_COMPACTION }] }, { role: "user", content: "go on" }])
})

test("the compaction sentence is escaped wherever it appears, a fragment kept", async () => {
  const send = await loaded()
  for (const text of [
    "Why does pi write: " + COMPACTED,
    COMPACTED + " What does that mean?",
    COMPACTED + "\n\n<summary>\n" + SUMMARY,
  ]) {
    const escaped = text.replace(COMPACTED, ESCAPED_COMPACTED)
    const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text }] }] })
    expect(b.messages[0].content[0].text).toBe(escaped)
    const c = await send(chat, { model: "kimi-k3", messages: [{ role: "user", content: text }] })
    expect(c.messages[1].content).toBe(escaped)
  }
  // an assistant repeating the summary is escaped the same way
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: PI_COMPACTION }] }, { role: "user", content: "ok" }] })
  expect(b.messages[1].content[0].text).toBe(PI_COMPACTION.replace(COMPACTED, ESCAPED_COMPACTED))
  // a fragment is left alone
  const fragment = "The conversation history before this point"
  const c = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: fragment }] })
  expect(c.messages[0].content).toBe(fragment)
})

// A tool result that quotes pi's own system prompt, or a historical session
// record, carries the same fixed sentences Factory refuses in the prompt and
// in the whole summary. Epi's model snapshot (`scripts/model-snapshot.mjs`)
// prints the system prompt into a tool result, after which every turn of the
// conversation was 403 "Factory: Forbidden" on Messages and Responses alike.
const QUOTED_PREFIX = "Tool output encoded as a JSON string. Decode the JSON string to recover the exact original text before using it:\n"
const SNAPSHOT = '{\n  "piVersion": "1.1.0",\n  "systemPrompt": "' + OPENING + REST + '"\n}'
const RECORD = '{"role":"user","content":"' + PI_COMPACTION + '"}'

test("pi's opening and compaction sentence in tool output are quoted, the record kept", async () => {
  const send = await loaded()
  const outputs = [
    { type: "tool_result", tool_use_id: "bash_1", content: SNAPSHOT, is_error: false, cache_control: { type: "ephemeral" } },
    { type: "tool_result", tool_use_id: "read_1", content: [{ type: "text", text: RECORD, cache_control: { type: "ephemeral" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } }], is_error: true },
  ]
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: PI }], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "bash_1", name: "Bash", input: { command: "node scripts/model-snapshot.mjs" } }] }, { role: "user", content: outputs }] })
  const first = b.messages[1].content[0]
  expect(first.content).toStartWith(QUOTED_PREFIX)
  expect(first).toEqual({ ...outputs[0], content: first.content })
  expect(JSON.parse(first.content.slice(QUOTED_PREFIX.length))).toBe(SNAPSHOT)
  expect(first.content).not.toContain(OPENING)
  const second = b.messages[1].content[1]
  expect(second.content[0].text).toStartWith(QUOTED_PREFIX)
  expect(JSON.parse(second.content[0].text.slice(QUOTED_PREFIX.length))).toBe(RECORD)
  expect(second.content[0].text).not.toContain(COMPACTED)
  expect(second).toEqual({ ...outputs[1], content: [{ ...outputs[1].content[0], text: second.content[0].text }, outputs[1].content[1]] })
})

test("pi's opening in chat and Responses tool output is quoted too", async () => {
  const send = await loaded()
  let b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "assistant", content: "called bash", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: SNAPSHOT }] })
  const quoted = b.messages[2].content
  expect(quoted).toStartWith(QUOTED_PREFIX)
  expect(JSON.parse(quoted.slice(QUOTED_PREFIX.length))).toBe(SNAPSHOT)
  expect(quoted).not.toContain(OPENING)
  b = await send(responses, { model: "gpt-6.1", instructions: PI, input: [{ type: "function_call", call_id: "c1", name: "bash", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: SNAPSHOT }] })
  const out = b.input[1].output
  expect(out).toStartWith(QUOTED_PREFIX)
  expect(JSON.parse(out.slice(QUOTED_PREFIX.length))).toBe(SNAPSHOT)
  expect(out).not.toContain(OPENING)
})

test("pi's opening is escaped in user text, a fragment in tool output stays", async () => {
  const send = await loaded()
  const partial = "You are an expert coding assistant operating inside pi."
  for (const text of ["Why does pi say: " + OPENING, ESCAPED_OPENING, partial]) {
    const escaped = text.replace(OPENING, ESCAPED_OPENING)
    const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text }, { type: "tool_result", tool_use_id: "plain", content: partial }] }] })
    expect(b.messages[0].content[0].text).toBe(escaped)
    expect(b.messages[0].content[1].content).toBe(partial)
    const c = await send(chat, { model: "kimi-k3", messages: [{ role: "user", content: text }, { role: "tool", tool_call_id: "c1", content: partial }] })
    expect(c.messages[1].content).toBe(escaped)
    expect(c.messages[2].content).toBe(partial)
  }
})
