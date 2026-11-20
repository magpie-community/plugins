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
