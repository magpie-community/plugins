// #1231: Codex delivers a sub-agent message at a sampling boundary by keeping
// the interrupted reply's text, dropping its tool call, and sending on. The
// live session answers the dropped call as cancelled and takes the new message
// as its next prompt instead of replaying the conversation in a new session.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse, sleep } from "./testkit.mjs"

const USAGE = { inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 5, totalTokens: 105 }

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try { return await fn(kit) } finally { await kit.dispose() }
}

function interruptedTurn(kit, seen) {
  kit.prompts.push(async (agent) => {
    await agent.text("Let me read the file.")
    agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
    seen.reply = await agent.tool("Read", { path: "/a" })
    agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" })
    await agent.waitCancel()
    return { stopReason: "cancelled", usage: USAGE }
  })
  kit.defaultPrompt = async (agent) => {
    seen.prompts.push(JSON.stringify(agent.prompt))
    await agent.text("went on")
    return { stopReason: "end_turn", usage: USAGE }
  }
}

function sentOn(body, assistant, text) {
  return { ...body, messages: [...body.messages, { role: "assistant", content: assistant }, { role: "user", content: text }] }
}

test("#1231 a dropped pending call is answered as cancelled and the live session goes on", async () => {
  await withKit(async (kit) => {
    const seen = { prompts: [] }
    interruptedTurn(kit, seen)
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    await sleep(20)
    const next = sentOn(body, [{ type: "text", text: "Let me read the file." }], "SUBAGENT_MESSAGE arrived")
    const res = await kit.request(next)
    assert.equal(res.status, 200, await (res.status === 200 ? "" : res.text()))
    const parsed = await readSse(res)
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1, "the live session is kept, no replay")
    assert.equal(seen.reply?.result?.isError, true)
    assert.match(seen.reply.result.content[0].text, /not executed/)
    assert.equal(seen.prompts.length, 1)
    assert.ok(seen.prompts[0].includes("SUBAGENT_MESSAGE"))
    assert.ok(!seen.prompts[0].includes("start the task"), "only the new message is sent, not a replay")

    // The session's history is the client's: its next message continues it.
    const third = sentOn(next, parsed.content.map((b) => ({ type: "text", text: b.text })), "and again")
    const again = await readSse(await kit.request(third))
    assert.equal(again.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("#1231 a reply whose text changed too is a fork and replays", async () => {
  await withKit(async (kit) => {
    const seen = { prompts: [] }
    interruptedTurn(kit, seen)
    const body = baseBody()
    await readSse(await kit.request(body))
    await sleep(20)
    const res = await kit.request(sentOn(body, [{ type: "text", text: "Something else entirely." }], "SUBAGENT_MESSAGE arrived"))
    assert.equal(res.status, 200)
    await readSse(res)
    assert.equal(kit.acpSpawns.length, 2, "a different branch is replayed in a new session")
    assert.match(seen.reply?.result?.content?.[0]?.text ?? "", /superseded/)
  })
})

test("#1231 a reply that was only the tool call is a fork and replays", async () => {
  await withKit(async (kit) => {
    const seen = { prompts: [] }
    kit.prompts.push(async (agent) => {
      seen.reply = await agent.tool("Read", { path: "/a" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("went on")
      return { stopReason: "end_turn", usage: USAGE }
    }
    const body = baseBody()
    await readSse(await kit.request(body))
    await sleep(20)
    const res = await kit.request({ ...body, messages: [...body.messages, { role: "user", content: "SUBAGENT_MESSAGE arrived" }] })
    assert.equal(res.status, 200)
    await readSse(res)
    assert.equal(kit.acpSpawns.length, 2)
  })
})
