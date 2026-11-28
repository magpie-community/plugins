// #1644 (Sor85): a client that merges a new message into a running step drops
// the tool call agy had just emitted (B) without storing or running it, and
// sends A's result again with the new message after it. The live session
// answers B as cancelled and takes the new message as its next prompt, as
// #1231 does for a dropped call, instead of replaying the conversation into a
// new session (72K and 81K tokens with no cache in the report).

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

globalThis.fetch = () => { throw new Error("offline fixture") }

const sessions = (kit) => kit.acpLog.filter((entry) => entry.method === "session/new").length

// The reporter's fixture: A, its result, then B emitted and its response ended.
async function atB(kit, { textBeforeB = "" } = {}) {
  const seen = { prompts: [] }
  kit.prompts.push(async (agent) => {
    await agent.tool("Read", { path: "/fixture/a" })
    if (textBeforeB) await agent.text(textBeforeB)
    seen.b = await agent.tool("Read", { path: "/fixture/b" })
    return { stopReason: "end_turn" }
  })
  kit.defaultPrompt = async (agent) => {
    seen.prompts.push(JSON.stringify(agent.prompt))
    await agent.text("fixture answer")
    return { stopReason: "end_turn" }
  }
  const opening = baseBody()
  const a = await readSse(await kit.request(opening))
  assert.equal(a.stopReason, "tool_use")
  const original = continueWithToolResults(opening, a, () => "result A")
  const b = await readSse(await kit.request(original))
  assert.equal(b.stopReason, "tool_use")
  return { seen, a, b, original }
}

async function withKit(fn) {
  const kit = await createBridgeKit({ agentVersion: "1.5.19", sessionResume: true })
  try { return await fn(kit) } finally { await kit.dispose() }
}

function goesOn(kit, seen, response, b) {
  assert.equal(response.stopReason, "end_turn")
  assert.equal(sessions(kit), 1, "the live session takes the new message, no replay")
  assert.equal(kit.acpSpawns.length, 1)
  // B was never run: agy hears it was cancelled, not A's result
  assert.equal(seen.b?.result?.isError, true)
  assert.match(seen.b.result.content[0].text, /not executed/)
  assert.doesNotMatch(seen.b.result.content[0].text, /result A/)
  // only the new message is prompted, not the history and not A's result again
  assert.equal(seen.prompts.length, 1)
  assert.ok(seen.prompts[0].includes("Use this new instruction."))
  assert.ok(!seen.prompts[0].includes("start the task"), "no replay of the history")
  assert.ok(!seen.prompts[0].includes("result A"), "A's result went to agy once")
  // B is not sent to the client again
  assert.ok(!response.content.some((block) => block.type === "tool_use" && block.id === b.content.find((x) => x.type === "tool_use").id))
}

test("#1644 the reporter's identical retry still answers with the emitted B in one session", async () => {
  await withKit(async (kit) => {
    const { b, original } = await atB(kit)
    const response = await readSse(await kit.request(structuredClone(original)))
    assert.equal(sessions(kit), 1)
    assert.deepEqual(response.content, b.content)
  })
})

test("#1644 A's result again with a new user message: B is cancelled and the session goes on", async () => {
  await withKit(async (kit) => {
    const { seen, b, original } = await atB(kit)
    const retry = structuredClone(original)
    retry.messages.push({ role: "user", content: "Use this new instruction." })
    const response = await readSse(await kit.request(retry))
    goesOn(kit, seen, response, b)

    // the session's history is now the client's: the next turn goes on in it
    const next = structuredClone(retry)
    next.messages.push({ role: "assistant", content: response.content.map((x) => ({ type: "text", text: x.text })) }, { role: "user", content: "and again" })
    const again = await readSse(await kit.request(next))
    assert.equal(again.stopReason, "end_turn")
    assert.equal(sessions(kit), 1)
  })
})

test("#1644 the new instruction merged into the tool result's own message goes on the same way", async () => {
  await withKit(async (kit) => {
    const { seen, b, original } = await atB(kit)
    const retry = structuredClone(original)
    retry.messages.at(-1).content.push({ type: "text", text: "Use this new instruction." })
    const response = await readSse(await kit.request(retry))
    goesOn(kit, seen, response, b)
  })
})

test("#1644 with ids the client renamed (a Gemini client), the session goes on too", async () => {
  await withKit(async (kit) => {
    const { seen, b, original } = await atB(kit)
    const retry = structuredClone(original)
    const assistantA = retry.messages.at(-2)
    const use = assistantA.content.find((x) => x.type === "tool_use")
    const result = retry.messages.at(-1).content.find((x) => x.type === "tool_result")
    use.id = "toolu_renamed_by_client"
    result.tool_use_id = use.id
    retry.messages.push({ role: "user", content: "Use this new instruction." })
    const response = await readSse(await kit.request(retry))
    goesOn(kit, seen, response, b)
  })
})

test("#1644 A's result changed beside the new message is still a conflict, never handed to B", async () => {
  await withKit(async (kit) => {
    const { seen, original } = await atB(kit)
    const retry = structuredClone(original)
    retry.messages.at(-1).content[0].content = "a different result A"
    retry.messages.push({ role: "user", content: "Use this new instruction." })
    const res = await kit.request(retry)
    assert.equal(res.status, 409)
    await res.text()
    assert.equal(seen.b, undefined, "B got no answer")
  })
})

test("#1644 a B step that said something first is a fork the client never had: the same session is resumed at the shared rows", async () => {
  await withKit(async (kit) => {
    const { seen, original } = await atB(kit, { textBeforeB: "Now the second file." })
    const retry = structuredClone(original)
    retry.messages.push({ role: "user", content: "Use this new instruction." })
    const response = await readSse(await kit.request(retry))
    assert.equal(response.stopReason, "end_turn")
    // no new session (its system prompt would start a cold cache): the old one is resumed
    assert.equal(sessions(kit), 1)
    const resumes = kit.acpLog.filter((entry) => entry.method === "session/resume")
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].params.sessionId, kit.acpLog.find((entry) => entry.method === "session/prompt").sessionId)
    // the shared rows run to A's result, which the session has: only the new
    // message goes in, after a note that the step past A's result is not the client's
    assert.equal(seen.prompts.length, 1)
    assert.match(seen.prompts[0], /after the results of your Read \{\\"path\\":\\"\/fixture\/a\\"\} call is not in the client's conversation/)
    assert.ok(seen.prompts[0].includes("Use this new instruction."))
    assert.ok(!seen.prompts[0].includes("result A"), "A's result went to agy once")
    assert.ok(!seen.prompts[0].includes("start the task"), "the shared opening is not replayed")
    // B was never answered over MCP, so agy's session stays at the parked rows
    // (the call's socket only closes with the stopped agy: no payload)
    assert.equal(seen.b ?? null, null, "B got no MCP response")
  })
})

test("#1644 a client that kept B and answers it with text after goes on as a steer, not a drop", async () => {
  await withKit(async (kit) => {
    const { seen, b, original } = await atB(kit)
    const next = continueWithToolResults(original, b, () => "result B")
    next.messages.at(-1).content.push({ type: "text", text: "Use this new instruction." })
    const response = await readSse(await kit.request(next))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(sessions(kit), 1)
    assert.equal(seen.b?.result?.content?.[0]?.text, "result B")
  })
})

test("#1644 renamed ids with A's result changed are not taken as the dropped step", async () => {
  await withKit(async (kit) => {
    const { seen, original } = await atB(kit)
    const retry = structuredClone(original)
    const use = retry.messages.at(-2).content.find((x) => x.type === "tool_use")
    const result = retry.messages.at(-1).content.find((x) => x.type === "tool_result")
    use.id = "toolu_renamed_by_client"
    result.tool_use_id = use.id
    result.content = "a different result A"
    retry.messages.push({ role: "user", content: "Use this new instruction." })
    const response = await readSse(await kit.request(retry))
    assert.equal(response.stopReason, "end_turn")
    assert.equal(sessions(kit), 2, "replayed with the client's own result")
    assert.doesNotMatch(seen.b?.result?.content?.[0]?.text ?? "", /not executed|result A/)
  })
})
