// Claude Code's /compact asks for the summary on a copy of the conversation:
// the last exchange's reply left out, the summary instructions appended to
// that exchange's user message. Its history then matched no live session,
// so a new one got a replay cut to the 112 KiB prompt budget, and most of
// what was to be summarized never reached the model.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

const COMPACT = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n" +
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests."
const NOTICE = { role: "system", content: "<total_tokens>15000000 tokens left</total_tokens>" }

async function run(lastTurn) {
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  const prompts = []
  try {
    kit.defaultPrompt = async (agent) => {
      const text = (agent.prompt || []).map((p) => p.text || "").join("")
      prompts.push({ session: agent.sessionId, text })
      await agent.text(text.includes("Your task is to create") ? "<summary>s</summary>" : "noted")
      return { stopReason: "end_turn" }
    }
    let messages = []
    for (const part of ["part 1 code A", "part 2 code B", "part 3 code C"]) {
      messages = [...messages, { role: "user", content: part }, NOTICE]
      const parsed = await readSse(await kit.request(baseBody({ messages })))
      messages = [...messages, { role: "assistant", content: parsed.content.filter((block) => block.type === "text") }]
    }
    // the last exchange without its reply, its user message carrying lastTurn
    const userAt = messages.length - 3
    const forked = [...messages.slice(0, userAt),
      { role: "user", content: [{ type: "text", text: messages[userAt].content + "\n" }, { type: "text", text: lastTurn }] }, NOTICE]
    const parsed = await readSse(await kit.request(baseBody({ messages: forked })))
    return { parsed, prompts, opened: stderr.lines.filter((row) => row.action === "session_new"), events: stderr.lines }
  } finally {
    await kit.dispose()
    stderr.restore()
  }
}

test("Claude Code's compaction stays in the live session, which has the whole conversation", async () => {
  const { parsed, prompts, opened, events } = await run(COMPACT)
  assert.equal(parsed.stopReason, "end_turn")
  assert.equal(opened.length, 1, JSON.stringify(opened))
  const last = prompts.at(-1)
  assert.equal(last.session, prompts[0].session)
  // only the new turn goes: the session already has parts 1 and 2
  assert.ok(last.text.includes("Your task is to create") && last.text.includes("part 3 code C"), last.text)
  assert.ok(!last.text.includes("part 1 code A"), last.text)
  assert.ok(events.some((row) => row.action === "kept" && row.reason === "compaction_fork"), JSON.stringify(events))
})

test("the same shape without the compaction prompt (an edited last message) still starts a new session", async () => {
  const { prompts, opened } = await run("actually, do something else")
  assert.equal(opened.length, 2, JSON.stringify(opened))
  assert.notEqual(prompts.at(-1).session, prompts[0].session)
  assert.ok(prompts.at(-1).text.includes("part 1 code A"))
})

// After the compaction Claude Code goes on with the summary alone, as the first
// message of a conversation of its own key. It used to get a new session, and
// agy's own context of the whole conversation gave way to the summary.
const SUMMARY = "1. Primary Request and Intent: the user is writing code in three parts, part 1 code A, part 2 code B " +
  "and part 3 code C, and asked for each to be noted.\n\n2. Key Technical Concepts: none beyond the three parts.\n\n" +
  "3. Pending Tasks: wait for part 4."
const OPENING = "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation."

function compactedOpening(summary) {
  // Claude Code drops <analysis>, unwraps <summary> and squeezes blank lines
  return `${OPENING}\n\nSummary:\n${summary.replace(/\n\n+/g, "\n")}\n\nIf you need specific details from before compaction, read the full transcript.`
}

async function compactThenContinue(kit, prompts, opening, rounds = 1) {
  kit.defaultPrompt = async (agent) => {
    const text = (agent.prompt || []).map((p) => p.text || "").join("")
    prompts.push({ session: agent.sessionId, text })
    await agent.text(text.includes("Your task is to create") ? `<analysis>notes</analysis>\n<summary>\n${SUMMARY}\n</summary>` : "noted")
    return { stopReason: "end_turn" }
  }
  let messages = []
  for (const part of ["part 1 code A", "part 2 code B", "part 3 code C"]) {
    messages = [...messages, { role: "user", content: part }, NOTICE]
    const parsed = await readSse(await kit.request(baseBody({ messages })))
    messages = [...messages, { role: "assistant", content: parsed.content.filter((block) => block.type === "text") }]
  }
  for (let round = 0; round < rounds; round++) {
    const userAt = messages.length - 3
    const forked = [...messages.slice(0, userAt),
      { role: "user", content: [{ type: "text", text: contentOf(messages[userAt]) + "\n" }, { type: "text", text: COMPACT }] }, NOTICE]
    await readSse(await kit.request(baseBody({ messages: forked })))
    messages = [{ role: "user", content: [{ type: "text", text: opening }, { type: "text", text: `part ${4 + round} code D` }] }, NOTICE]
    const parsed = await readSse(await kit.request(baseBody({ messages })))
    messages = [...messages, { role: "assistant", content: parsed.content.filter((block) => block.type === "text") },
      { role: "user", content: `part ${5 + round} code E` }, NOTICE]
    const next = await readSse(await kit.request(baseBody({ messages })))
    messages = [...messages, { role: "assistant", content: next.content.filter((block) => block.type === "text") }]
  }
}

function contentOf(message) {
  return typeof message.content === "string" ? message.content : message.content.map((block) => block.text || "").join("")
}

async function withCompaction(opening, rounds) {
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  const prompts = []
  try {
    await compactThenContinue(kit, prompts, opening, rounds)
    return { prompts, opened: stderr.lines.filter((row) => row.action === "session_new"), events: stderr.lines }
  } finally {
    await kit.dispose()
    stderr.restore()
  }
}

test("the compacted conversation goes on in the session that wrote its summary", async () => {
  const { prompts, opened, events } = await withCompaction(compactedOpening(SUMMARY))
  assert.equal(opened.length, 1, JSON.stringify(opened))
  assert.ok(prompts.every((prompt) => prompt.session === prompts[0].session))
  assert.ok(events.some((row) => row.action === "kept" && row.reason === "compacted_opening"), JSON.stringify(events))
  const [opening, next] = prompts.slice(-2)
  assert.ok(opening.text.includes("part 4 code D"), opening.text)
  // the session went on: the next turn sends only what is new
  assert.ok(next.text.includes("part 5 code E") && !next.text.includes("part 4 code D"), next.text)
})

test("a compacted opening with another conversation's summary starts a new session", async () => {
  const { opened, events } = await withCompaction(compactedOpening(SUMMARY.replace(/code/g, "kode")))
  assert.equal(opened.length, 2, JSON.stringify(opened))
  assert.ok(!events.some((row) => row.reason === "compacted_opening"))
})

test("a second compaction before agy compacted its own window starts a new session, not a compaction every turn", async () => {
  const { opened, events } = await withCompaction(compactedOpening(SUMMARY), 2)
  assert.equal(events.filter((row) => row.reason === "compacted_opening").length, 1, JSON.stringify(events))
  assert.equal(opened.length, 2, JSON.stringify(opened))
})
