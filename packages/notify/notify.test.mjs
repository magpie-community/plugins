// Runs the hooks the way magpie's gateway calls them — onRequest as a
// request comes in, onResponse with the finished reply — against channels
// faked with fetch: no network, no account.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { onRequest, onResponse, reset, settled, options, duration, message } from "./notify.hooks.mjs"
import { opensTurn, ending, hasTools, firstWords, compacting, continued, notificationOnly, background } from "./turn.mjs"
import { send, usable } from "./channels.mjs"

const realFetch = globalThis.fetch
let calls = []
let answer = () => Response.json({ ok: true })
let clock = 1_000_000
let timers = [] // failure pushes held back: { at, fn }
const fakeTimers = {
  later: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t },
  cancel: (t) => { timers = timers.filter((x) => x !== t) },
}
// move the clock on, firing the held pushes that come due
async function wait(ms) {
  clock += ms
  for (const t of timers.filter((x) => x.at <= clock)) { timers = timers.filter((x) => x !== t); t.fn() }
  await settled()
}

beforeEach(() => {
  calls = []
  answer = () => Response.json({ ok: true })
  clock = 1_000_000
  timers = []
  reset(() => clock, fakeTimers)
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body })
    return answer(String(url), init)
  }
})
afterEach(() => { globalThis.fetch = realFetch })

const ntfy = { type: "ntfy", topic: "t-123" }
const ctx = (protocol, extra = {}) => ({
  protocol, agent: "claude", session: "sess-1", cwd: "/home/ted/code/magpie-plugins", origin: "local",
  model: "claude-opus", state: {}, ...extra,
  options: { channels: [ntfy], ...(extra.options ?? {}) },
})
const minutes = (n) => { clock += n * 60_000 }

// one request/reply pair, each with a context of its own as the gateway gives
async function exchange(protocol, body, reply, extra = {}) {
  const c = ctx(protocol, extra)
  onRequest(body, c)
  onResponse(reply, c)
  await settled()
  return c
}

// ---- Anthropic Messages (Claude Code) ----
const tools = [{ name: "Bash", input_schema: { type: "object" } }]
const aUser = { model: "m", tools, messages: [{ role: "user", content: "fix the test" }] }
const aToolUse = { type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }
const aResult = { model: "m", tools, messages: [...aUser.messages, { role: "assistant", content: aToolUse.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }
const aFinal = { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "All tests pass now." }] }

test("a long Claude Code turn is pushed once, when the model stops asking for tools", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(4)
  await exchange("anthropic", aResult, aToolUse)
  expect(calls).toHaveLength(0)
  minutes(2)
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://ntfy.sh")
  const sent = JSON.parse(calls[0].body)
  expect(sent.topic).toBe("t-123")
  expect(sent.title).toBe("✅ Claude Code done · magpie-plugins")
  expect(sent.message).toContain("took 6 min")
  expect(sent.message).toContain("Model: claude-opus")
  expect(sent.message).not.toContain("All tests pass") // text is opt-in
})

test("a short turn sends nothing", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(1)
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(0)
})

test("a new user message restarts the turn's clock", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(10)
  await exchange("anthropic", aUser, aToolUse) // the user interrupted and asked again
  minutes(1)
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(0)
})

test("side calls without tools neither open nor close a turn", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(5)
  const title = { model: "haiku", messages: [{ role: "user", content: "title this" }] }
  const c = await exchange("anthropic", title, aFinal)
  expect(c.state.notify).toBeUndefined()
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(1)
})

test("a failed request ends the turn with a failure push after the hold, unless errors is off", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(5)
  await exchange("anthropic", aResult, null, { success: false })
  expect(calls).toHaveLength(0) // held back
  await wait(59_000)
  expect(calls).toHaveLength(0)
  await wait(1_000)
  expect(calls).toHaveLength(1)
  const sent = JSON.parse(calls[0].body)
  expect(sent.title).toStartWith("❌ Claude Code failed")
  expect(sent.message).toContain("took 5 min") // timed to the failure, not the hold
  calls = []
  await exchange("anthropic", aUser, aToolUse, { options: { errors: false } })
  minutes(5)
  await exchange("anthropic", aResult, null, { success: false, options: { errors: false } })
  expect(calls).toHaveLength(0)
})

test("a failure the agent retries sends no ❌, and the turn's clock keeps running", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(4)
  await exchange("anthropic", aResult, null, { success: false }) // 529
  await wait(10_000)
  await exchange("anthropic", aResult, aFinal) // the agent's retry
  await wait(120_000)
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).title).toStartWith("✅")
})

test("Esc (a failure) then a new message continues the same turn", async () => {
  await exchange("anthropic", aUser, aToolUse)
  minutes(5)
  await exchange("anthropic", aResult, null, { success: false })
  await wait(20_000)
  await exchange("anthropic", aUser, aToolUse)
  await wait(120_000)
  expect(calls).toHaveLength(0)
})

// ---- Claude Code subagents share their parent's session ----
const subUser = { model: "m", tools, messages: [{ role: "user", content: "Search the repo for TODOs and list them" }] }
const subToolUse = { ...aToolUse, content: [{ type: "tool_use", id: "s1", name: "Grep", input: {} }] }
const subResult = { model: "m", tools, messages: [...subUser.messages, { role: "assistant", content: subToolUse.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "x" }] }] }
const subFinal = { ...aFinal, content: [{ type: "text", text: "Found 3 TODOs." }] }
const taskUse = { ...aToolUse, content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }] }

test("a subagent's end sends no push and leaves the main turn's clock alone", async () => {
  await exchange("anthropic", aUser, taskUse) // the main agent starts a subagent
  minutes(2)
  await exchange("anthropic", subUser, subToolUse) // the subagent, same session
  minutes(4)
  await exchange("anthropic", subResult, subFinal) // it ends after 4 min: no push
  expect(calls).toHaveLength(0)
  minutes(1)
  await exchange("anthropic", aResult, aFinal) // the main turn ends, 7 min in
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 7 min")
})

test("parallel subagents are all nested; a later conversation in the session is not", async () => {
  await exchange("anthropic", aUser, taskUse)
  await exchange("anthropic", subUser, subToolUse)
  await exchange("anthropic", { ...subUser, messages: [{ role: "user", content: "Read the docs folder" }] }, subFinal)
  minutes(5)
  await exchange("anthropic", subResult, subFinal)
  expect(calls).toHaveLength(0)
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(1)
  // the main turn is over; a new conversation (/clear) in the same session pushes as usual
  calls = []
  minutes(1)
  await exchange("anthropic", subUser, subToolUse)
  minutes(4)
  await exchange("anthropic", subResult, subFinal)
  expect(calls).toHaveLength(1)
})

test("a subagent whose first request beats the parent reply's onResponse is still nested", async () => {
  // Claude Code runs Task tool_use blocks while the reply still streams, and
  // magpie calls onResponse only after the last byte: the subagent's request
  // reaches onRequest first
  const main = ctx("anthropic")
  onRequest(aUser, main)
  minutes(1)
  await exchange("anthropic", subUser, subToolUse) // while the parent is mid-request
  onResponse(taskUse, main) // the parent's two-Task reply finishes
  await exchange("anthropic", { ...subUser, messages: [{ role: "user", content: "Read the docs folder" }] }, subToolUse)
  minutes(4)
  await exchange("anthropic", subResult, subFinal)
  expect(calls).toHaveLength(0)
  await exchange("anthropic", aResult, aFinal)
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 5 min")
})

test("a conversation left waiting stops making new ones nested", async () => {
  // no session: agent and folder are the base, and nesting is never inferred
  const noSession = { session: undefined, agent: "crush" }
  await exchange("chat", { tools: [{}], messages: [{ role: "user", content: "a" }] }, { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }] }, noSession)
  minutes(5) // quit during the tool run; a new conversation in the same folder
  const b = { tools: [{}], messages: [{ role: "user", content: "b" }] }
  await exchange("chat", b, { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }] }, noSession)
  minutes(5)
  await exchange("chat", { ...b, messages: [...b.messages, { role: "tool", content: "x" }] }, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] }, noSession)
  expect(calls).toHaveLength(1)
  // a real session: a parent unseen for 15 minutes no longer counts
  calls = []
  await exchange("anthropic", aUser, taskUse, { session: "s9" })
  minutes(16)
  await exchange("anthropic", subUser, subToolUse, { session: "s9" })
  minutes(4)
  await exchange("anthropic", subResult, subFinal, { session: "s9" })
  expect(calls).toHaveLength(1)
})

// ---- compaction and background agents, from captured Claude Code bodies ----
// fixtures/claude-2.1.316 holds request bodies recorded from the real
// `claude` 2.1.316 (`claude -p` with a sandbox HOME / CLAUDE_CONFIG_DIR and
// ANTHROPIC_BASE_URL at a recording endpoint), with each long
// <system-reminder>, the system prompt and the tool schemas cut short; the
// order and shape of the content blocks are as sent. `reply` is what the
// endpoint answered.
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/claude-2.1.316/${name}.json`, import.meta.url), "utf8"))
const send1 = async (name, extra = {}) => { const f = fx(name); return exchange("anthropic", f.body, f.reply, { session: f.session, ...extra }) }

test("captured auto-compaction during a tool loop neither ends nor restarts the turn", async () => {
  expect(compacting(fx("autocompact-1-start").body, "anthropic")).toBe(false)
  expect(compacting(fx("autocompact-2-compact").body, "anthropic")).toBe(true) // the prompt follows "CRITICAL: …", after the tool_result
  expect(continued(fx("autocompact-3-continued").body, "anthropic")).toBe(true) // after the <system-reminder> blocks
  await send1("autocompact-1-start")
  minutes(16)
  await send1("autocompact-2-compact") // plain text and end_turn
  expect(calls).toHaveLength(0)
  await send1("autocompact-3-continued") // new first words
  minutes(4)
  await send1("autocompact-4-tool")
  await send1("autocompact-5-done")
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 20 min")
})

test("captured /compact after a turn, then a new message: one push per turn, each timed from its own message", async () => {
  await send1("compact-1-start")
  minutes(5)
  await send1("compact-2-done")
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 5 min")
  minutes(1)
  expect(compacting(fx("compact-3-compact").body, "anthropic")).toBe(true)
  await send1("compact-3-compact")
  expect(calls).toHaveLength(1)
  const f = fx("compact-4-continued") // the summary as a string, then "/compact" caveats and the user's text
  expect(continued(f.body, "anthropic")).toBe(true)
  const c = ctx("anthropic", { session: f.session })
  onRequest(f.body, c)
  minutes(4)
  onResponse(f.reply, c)
  await settled()
  expect(calls).toHaveLength(2)
  expect(JSON.parse(calls[1].body).message).toContain("took 4 min")
})

test("every compaction wording in the binary is found anywhere in the last user message", () => {
  const f = fx("autocompact-2-compact").body
  const part = f.messages.at(-1).content.findIndex((p) => p.type === "text" && p.text.startsWith("CRITICAL"))
  for (const w of [
    "Your task is to create a detailed summary of the conversation so far, paying close attention",
    "Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow",
    "Your task is to create a detailed summary of this conversation.",
    "Summarize the transcript inside <summary></summary> tags. Include relevant information",
  ]) {
    const content = f.messages.at(-1).content.map((p, i) => i === part ? { ...p, text: `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n${w}` } : p)
    expect(compacting({ ...f, messages: [...f.messages.slice(0, -1), { role: "user", content }] }, "anthropic")).toBe(true)
  }
  expect(compacting(fx("compact-2-done").body, "anthropic")).toBe(false)
})

test("a subagent that compacts and continues stays nested, and never takes over the main turn", async () => {
  const main = fx("agent-1-main"), sub = fx("agent-2-subagent")
  const session = main.session
  const subTool = { ...aToolUse }
  await send1("agent-1-main") // main asks for the Agent tool and waits
  await exchange("anthropic", sub.body, subTool, { session })
  minutes(10)
  const compact = fx("autocompact-2-compact").body.messages.at(-1).content.find((p) => p.type === "text" && p.text.startsWith("CRITICAL"))
  const subCompact = { ...sub.body, messages: [...sub.body.messages, { role: "assistant", content: subTool.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, compact] }] }
  await exchange("anthropic", subCompact, fx("autocompact-2-compact").reply, { session })
  const cont = fx("autocompact-3-continued").body
  await exchange("anthropic", cont, aToolUse, { session })
  minutes(1)
  await exchange("anthropic", { ...cont, messages: [...cont.messages, { role: "assistant", content: aToolUse.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }, aFinal, { session })
  expect(calls).toHaveLength(0) // the subagent's end
  // with no compaction seen, a continued conversation in a busy session is a new, nested one
  await exchange("anthropic", { ...cont, messages: [{ role: "user", content: [...cont.messages[0].content, { type: "text", text: "other" }] }] }, aFinal, { session })
  expect(calls).toHaveLength(0)
  minutes(2)
  const launched = { ...main.body, messages: [...main.body.messages, { role: "assistant", content: main.reply.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "done" }] }] }
  await exchange("anthropic", launched, aFinal, { session })
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 13 min")
})

test("captured background Agent: the turn ends when the agent has reported back, not when the main conversation pauses", async () => {
  expect(notificationOnly(fx("agent-4-notified").body, "anthropic")).toBe(true)
  expect(opensTurn(fx("agent-4-notified").body, "anthropic")).toBe(false)
  expect(background(fx("agent-3-launched").body, "anthropic")).toEqual({ launched: ["toolu_agent"], stopped: [] })
  expect(background(fx("agent-4-notified").body, "anthropic")).toEqual({ launched: [], stopped: ["toolu_agent"] })
  await send1("agent-1-main")
  minutes(1)
  await send1("agent-3-launched") // "Agent launched, waiting." and end_turn
  expect(calls).toHaveLength(0)
  const sub = fx("agent-2-subagent"), c = ctx("anthropic", { session: sub.session })
  onRequest(sub.body, c) // the agent's first request comes after its parent paused
  minutes(6)
  onResponse(sub.reply, c)
  await settled()
  expect(calls).toHaveLength(0) // the agent's end
  await send1("agent-4-notified")
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 7 min")
})

test("captured notification that carries another reminder (the agent ran Bash) still ends the turn once, timed from the user's message", async () => {
  const n = fx("agent-bash-5-notified").body
  expect(n.messages.at(-1).content).toHaveLength(2) // <tools-used-before-summary>, then the notification
  expect(notificationOnly(n, "anthropic")).toBe(true)
  expect(opensTurn(n, "anthropic")).toBe(false)
  // a reminder alone, or a reminder beside words the user typed, is not a notification
  const typed = { ...n, messages: [...n.messages.slice(0, -1), { role: "user", content: [n.messages.at(-1).content[0], { type: "text", text: "and also fix the docs" }] }] }
  expect(notificationOnly(typed, "anthropic")).toBe(false)
  await send1("agent-bash-1-main")
  minutes(1)
  await send1("agent-bash-3-launched") // the main conversation stops for now
  const sub = fx("agent-bash-2-subagent"), c = ctx("anthropic", { session: sub.session })
  onRequest(sub.body, c)
  minutes(5)
  onResponse(sub.reply, c)
  minutes(5)
  await send1("agent-bash-4-subagent-done")
  expect(calls).toHaveLength(0)
  await send1("agent-bash-5-notified")
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 11 min")
})

test("a retried request carries the same launch twice; the agent is still counted once", async () => {
  await send1("agent-1-main")
  minutes(1)
  const l = fx("agent-3-launched")
  await exchange("anthropic", l.body, null, { session: l.session, success: false }) // 529: Claude Code sends the same body again
  await send1("agent-3-launched")
  minutes(10)
  await wait(0)
  expect(calls).toHaveLength(0)
  await send1("agent-4-notified")
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 11 min")
})

test("the same agent notifying twice does not end the turn while another is still running", async () => {
  const l = fx("agent-3-launched"), nt = fx("agent-4-notified")
  const r = l.body.messages.at(-1).content[0]
  const launched = { ...l.body, messages: [...l.body.messages.slice(0, -1), { role: "user", content: [{ ...r, tool_use_id: "toolu_a" }, { ...r, tool_use_id: "toolu_b" }] }] }
  expect(background(launched, "anthropic").launched).toEqual(["toolu_a", "toolu_b"])
  const note = (id) => {
    const p = nt.body.messages.at(-1).content[0]
    return { ...nt.body, messages: [...nt.body.messages.slice(0, -1), { role: "user", content: [{ ...p, text: p.text.replace("<tool-use-id>toolu_agent</tool-use-id>", `<tool-use-id>${id}</tool-use-id>`) }] }] }
  }
  const session = l.session
  await send1("agent-1-main")
  minutes(1)
  await exchange("anthropic", launched, l.reply, { session })
  minutes(3)
  await exchange("anthropic", note("toolu_a"), nt.reply, { session })
  await exchange("anthropic", note("toolu_a"), nt.reply, { session }) // "the same task-id may notify more than once"
  expect(calls).toHaveLength(0)
  minutes(5)
  await exchange("anthropic", note("toolu_b"), nt.reply, { session })
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 9 min")
})

test("Codex remote compaction neither ends nor restarts the turn", async () => {
  const rTools = [{ type: "function", name: "shell" }]
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "refactor the parser" }] }
  const call = { status: "completed", output: [{ type: "function_call", name: "shell" }] }
  const done = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }
  const x = { agent: "codex" }
  await exchange("responses", { tools: rTools, input: [user] }, call, x)
  minutes(10)
  await exchange("responses", { tools: rTools, input: [user, { type: "function_call_output", output: "x" }, { type: "compaction_trigger" }] }, { status: "completed", output: [{ type: "compaction", encrypted_content: "…" }] }, x)
  expect(calls).toHaveLength(0)
  const after = [{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] }, { type: "compaction", encrypted_content: "…" }]
  await exchange("responses", { tools: rTools, input: after }, call, x)
  minutes(5)
  await exchange("responses", { tools: rTools, input: [...after, { type: "function_call_output", output: "y" }] }, done, x)
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).message).toContain("took 15 min")
})

test("Codex local compaction sends no tools, and its summary carries the turn on", async () => {
  expect(hasTools({ input: [{ role: "user", content: "You are performing a CONTEXT CHECKPOINT COMPACTION." }] }, "responses")).toBe(false)
  expect(continued({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Another language model started to solve this problem and produced a summary…" }] }] }, "responses")).toBe(true)
  expect(compacting({ input: [{ type: "message", role: "user", content: "fix it" }] }, "responses")).toBe(false)
  expect(continued(aUser, "anthropic")).toBe(false)
})

test("a conversation is told apart by its first words' text, not cache markers", () => {
  const a = { messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] }
  const b = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: "x" }, { role: "user", content: [{ type: "tool_result", content: "r" }] }] }
  expect(firstWords(a, "anthropic")).toBe(firstWords(b, "anthropic"))
  expect(firstWords({ input: [{ type: "function_call_output" }] }, "responses")).toBe("")
  expect(firstWords({ input: [{ type: "message", role: "developer", content: "d" }, { role: "user", content: [{ type: "input_text", text: "go" }] }] }, "responses")).toBe("go")
  expect(firstWords({ contents: [{ role: "user", parts: [{ text: "g" }] }] }, "gemini")).toBe("g")
})

test("a Responses request with no user message stays in the conversation it continues", async () => {
  const rTools = [{ type: "function", name: "shell" }]
  const open = { tools: rTools, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] }
  const cont = { tools: rTools, previous_response_id: "r1", input: [{ type: "function_call_output", call_id: "c", output: "x" }] }
  const call = { status: "completed", output: [{ type: "function_call", name: "shell" }] }
  const done = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }
  await exchange("responses", open, call, { agent: "codex" })
  minutes(4)
  await exchange("responses", cont, done, { agent: "codex" })
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body).title).toBe("✅ Codex done · magpie-plugins")
})

test("includeText adds the reply, cut to maxTextLength; lang zh", async () => {
  const o = { includeText: true, maxTextLength: 10, lang: "zh" }
  await exchange("anthropic", aUser, aToolUse, { options: o })
  minutes(3)
  await exchange("anthropic", aResult, aFinal, { options: o })
  const sent = JSON.parse(calls[0].body)
  expect(sent.title).toBe("✅ Claude Code 完成 · magpie-plugins")
  expect(sent.message).toContain("用时 3 分钟")
  expect(sent.message).toContain("All tests …")
})

test("cooldown: two turns closing within it send one push", async () => {
  await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0, cooldownSeconds: 60 } })
  await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0, cooldownSeconds: 60 } })
  expect(calls).toHaveLength(1)
})

test("only local requests count unless allOrigins; agents off the list are left alone", async () => {
  await exchange("anthropic", aUser, aFinal, { origin: "gateway-key", options: { minMinutes: 0 } })
  await exchange("anthropic", aUser, aFinal, { session: "s1b", origin: "remote", options: { minMinutes: 0 } })
  await exchange("anthropic", aUser, aFinal, { session: "s2", options: { minMinutes: 0, agents: ["codex"] } })
  expect(calls).toHaveLength(0)
  await exchange("anthropic", aUser, aFinal, { session: "s3", origin: "gateway-key", options: { minMinutes: 0, allOrigins: true } })
  await exchange("anthropic", aUser, aFinal, { session: "s4", origin: "remote", options: { minMinutes: 0, allOrigins: true } })
  expect(calls).toHaveLength(2)
})

test("no channel, no work", async () => {
  const c = ctx("anthropic", { options: { channels: [] } })
  onRequest(aUser, c)
  expect(c.state.notify).toBeUndefined()
})

test("a channel that answers an error code is not ok", async () => {
  answer = () => Response.json({ errcode: 310000, errmsg: "sign not match" })
  expect((await send({ type: "dingtalk", webhook: "https://oapi.dingtalk.com/robot/send?access_token=x" }, m)).ok).toBe(false)
})

test("a thrown fetch never reaches the request", async () => {
  answer = () => { throw new Error("offline") }
  expect(await exchange("anthropic", aUser, aFinal, { options: { minMinutes: 0 } })).toBeDefined()
  expect(calls).toHaveLength(1)
  expect((await send(ntfy, m)).ok).toBe(false)
})

test("the suggested options send nowhere until a topic is filled in", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(options(pkg.magpie.options).channels).toEqual([])
})

test("durations and agent names read well", () => {
  const w = { s: "s", min: "min", h: "h" }
  expect(duration(45_000, w)).toBe("45 s")
  expect(duration(12 * 60_000, w)).toBe("12 min")
  expect(duration(125 * 60_000, w)).toBe("2 h 5 min")
  expect(duration(120 * 60_000, w)).toBe("2 h")
  expect(message({ agent: "other", cwd: "" }, 60_000, true, "", options({})).title).toBe("✅ Other done")
})

// ---- the other APIs ----
test("Responses (Codex): function calls keep the turn open, a message closes it", () => {
  const body = { tools: [{ type: "function", name: "shell" }], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] }
  expect(opensTurn(body, "responses")).toBe(true)
  expect(opensTurn({ ...body, input: [...body.input, { type: "function_call_output", call_id: "c", output: "x" }] }, "responses")).toBe(false)
  expect(opensTurn({ input: "hi" }, "responses")).toBe(true)
  expect(ending({ status: "completed", output: [{ type: "function_call", name: "shell" }] }, "responses").done).toBe(false)
  expect(ending({ status: "completed", output: [{ type: "local_shell_call" }] }, "responses").done).toBe(false)
  expect(ending({ status: "incomplete", output: [] }, "responses").done).toBe(false)
  expect(ending({ status: "completed", output: [{ type: "reasoning" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] }, "responses")).toEqual({ done: true, text: "done" })
})

test("Chat completions", () => {
  expect(opensTurn({ messages: [{ role: "user", content: "x" }] }, "chat")).toBe(true)
  expect(opensTurn({ messages: [{ role: "tool", content: "x" }] }, "chat")).toBe(false)
  expect(ending({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }] }, "chat").done).toBe(false)
  expect(ending({ choices: [{ finish_reason: "length", message: { content: "x" } }] }, "chat").done).toBe(false)
  expect(ending({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }, "chat")).toEqual({ done: true, text: "ok" })
  expect(ending({ error: { message: "x" } }, "chat").done).toBe(false)
})

test("Gemini", () => {
  expect(hasTools({ tools: [{ functionDeclarations: [{ name: "a" }] }] }, "gemini")).toBe(true)
  expect(hasTools({ tools: [{}] }, "gemini")).toBe(false)
  expect(opensTurn({ contents: [{ role: "user", parts: [{ text: "x" }] }] }, "gemini")).toBe(true)
  expect(opensTurn({ contents: [{ role: "user", parts: [{ functionResponse: { name: "a" } }] }] }, "gemini")).toBe(false)
  expect(ending({ candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "a" } }] } }] }, "gemini").done).toBe(false)
  expect(ending({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hm", thought: true }, { text: "ok" }] } }] }, "gemini")).toEqual({ done: true, text: "ok" })
})

test("Anthropic: max_tokens and server tools keep the turn open", () => {
  expect(ending({ stop_reason: "max_tokens", content: [{ type: "text", text: "x" }] }, "anthropic").done).toBe(false)
  expect(ending({ stop_reason: "end_turn", content: [{ type: "server_tool_use" }] }, "anthropic").done).toBe(false)
  expect(opensTurn({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, "anthropic")).toBe(true)
})

// ---- channels ----
const m = { title: "T", body: "B", ok: true, event: { kind: "done" } }

test("each channel posts where and what its service documents", async () => {
  await send({ type: "ntfy", topic: "x", server: "https://ntfy.example.com/", token: "tk" }, m)
  expect(calls.at(-1).url).toBe("https://ntfy.example.com")
  expect(calls.at(-1).init.headers.authorization).toBe("Bearer tk")

  await send({ type: "bark", key: "K" }, m)
  expect(calls.at(-1).url).toBe("https://api.day.app/push")
  expect(JSON.parse(calls.at(-1).body)).toMatchObject({ device_key: "K", title: "T", body: "B", group: "magpie" })

  await send({ type: "serverchan", key: "SCT123abc" }, m)
  expect(calls.at(-1).url).toBe("https://sctapi.ftqq.com/SCT123abc.send")
  expect(calls.at(-1).body).toBe("title=T&desp=B")
  await send({ type: "serverchan", key: "sctp42tXYZ" }, m)
  expect(calls.at(-1).url).toBe("https://42.push.ft07.com/send/sctp42tXYZ.send")

  await send({ type: "wecom", webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k" }, m)
  expect(JSON.parse(calls.at(-1).body)).toEqual({ msgtype: "text", text: { content: "T\nB" } })

  await send({ type: "telegram", token: "123:abc", chatId: 42 }, m)
  expect(calls.at(-1).url).toBe("https://api.telegram.org/bot123:abc/sendMessage")
  expect(JSON.parse(calls.at(-1).body)).toMatchObject({ chat_id: 42, text: "T\nB" })

  await send({ type: "webhook", url: "https://hooks.example.com/x", headers: { "x-k": "v" } }, m)
  expect(calls.at(-1).init.headers["x-k"]).toBe("v")
  expect(JSON.parse(calls.at(-1).body)).toEqual({ title: "T", body: "B", event: { kind: "done" } })
})

test("Feishu and DingTalk sign with the robot's secret", async () => {
  await send({ type: "feishu", webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x", secret: "s3" }, m)
  const f = JSON.parse(calls.at(-1).body)
  expect(f.msg_type).toBe("text")
  expect(f.sign).toBe(createHmac("sha256", `${f.timestamp}\ns3`).update("").digest("base64"))

  await send({ type: "dingtalk", webhook: "https://oapi.dingtalk.com/robot/send?access_token=x", secret: "SEC" }, m)
  const u = new URL(calls.at(-1).url)
  const ts = u.searchParams.get("timestamp")
  expect(u.searchParams.get("sign")).toBe(createHmac("sha256", "SEC").update(`${ts}\nSEC`).digest("base64"))
})

test("a channel missing what it needs is dropped from the options", () => {
  expect(usable({ type: "ntfy" })).toBe(false)
  expect(usable({ type: "telegram", token: "x" })).toBe(false)
  expect(usable({ type: "nope", url: "x" })).toBe(false)
  expect(usable({ type: "bark", key: "k", off: true })).toBe(false)
  expect(options({ channels: [{ type: "ntfy" }, ntfy] }).channels).toEqual([ntfy])
  expect(options({ channels: ntfy, agents: "claude, codex" }).agents).toEqual(["claude", "codex"])
})

test("Bark's success answer (code 200) is a success", async () => {
  answer = () => Response.json({ code: 200, message: "success" })
  expect((await send({ type: "bark", key: "K" }, m)).ok).toBe(true)
})
