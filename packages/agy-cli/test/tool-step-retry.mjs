// Identical tool_result retry after the bridge already emitted the next
// tool_use step (e.g. response lost in flight and client timed out at 300s):
// replay the emitted tool_use step instead of dropping the live session on
// history_mismatch (expected_history = history + 2, first_diff = missing_actual).

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

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

function messageIdOf(parsed) {
  return parsed.events.find((entry) => entry.event === "message_start")?.data?.message?.id
}

function toolText(res) {
  return (res?.result?.content || res?.content || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

function twoStepScript(kit) {
  kit.defaultPrompt = async (agent) => {
    const first = await agent.tool("Read", { path: "/repo/a.txt" })
    const second = await agent.tool("Read", { path: "/repo/b.txt" })
    await agent.text(`done:${toolText(first)}:${toolText(second)}`)
    return { stopReason: "end_turn" }
  }
}

test("identical tool_result retry replays the emitted next tool_use step without dropping the live session", async () => {
  const kit = await createBridgeKit({})
  const err = captureStderr()
  try {
    twoStepScript(kit)
    const opening = baseBody({ messages: [{ role: "user", content: "read a and b" }] })
    const step1 = await readSse(await kit.request(opening))
    assert.equal(step1.stopReason, "tool_use")

    const req1 = continueWithToolResults(opening, step1, () => "AAA")
    const step2 = await readSse(await kit.request(req1))
    assert.equal(step2.stopReason, "tool_use")
    const call2 = step2.content.find((block) => block.type === "tool_use")
    assert.ok(call2)

    // Client never received step2 (e.g. timed out after 300s) and resends req1 identically.
    const retryRes = await kit.request(structuredClone(req1))
    assert.equal(retryRes.status, 200, await retryRes.clone().text())
    const replayed = await readSse(retryRes)
    assert.equal(replayed.stopReason, "tool_use")
    assert.deepEqual(replayed.content, step2.content)
    assert.equal(messageIdOf(replayed), messageIdOf(step2))

    assert.ok(
      err.lines.some((line) => line.event === "agy_bridge_tool_state" && line.action === "replay_tool_step" && line.reason === "idempotent_retry"),
      JSON.stringify(err.lines.map((line) => [line.event, line.action, line.reason])),
    )
    assert.ok(
      !err.lines.some((line) => line.action === "drop_live"),
      JSON.stringify(err.lines.filter((line) => line.action === "drop_live")),
    )
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/new").length, 1)

    // Answering the replayed call finishes on the same live session.
    const req2 = continueWithToolResults(req1, replayed, () => "BBB")
    const done = await readSse(await kit.request(req2))
    assert.equal(done.stopReason, "end_turn")
    assert.match(done.content.find((block) => block.type === "text")?.text ?? "", /done:AAA:BBB/)
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/new").length, 1)
  } finally {
    err.restore()
    await kit.dispose()
  }
})

test("identical retry with companion text spliced by inspectToolTurn replays instead of 409", async () => {
  const kit = await createBridgeKit({})
  try {
    twoStepScript(kit)
    const opening = baseBody({ messages: [{ role: "user", content: "read a and b" }] })
    const step1 = await readSse(await kit.request(opening))
    assert.equal(step1.stopReason, "tool_use")

    const req1 = continueWithToolResults(opening, step1, () => "AAA")
    req1.messages.at(-1).content.push({ type: "text", text: "<system-reminder>keep going</system-reminder>" })
    const step2 = await readSse(await kit.request(req1))
    assert.equal(step2.stopReason, "tool_use")

    const retryRes = await kit.request(structuredClone(req1))
    assert.equal(retryRes.status, 200, await retryRes.clone().text())
    const replayed = await readSse(retryRes)
    assert.deepEqual(replayed.content, step2.content)
  } finally {
    await kit.dispose()
  }
})

test("non-streaming identical retry returns the replayed JSON response", async () => {
  const kit = await createBridgeKit({})
  try {
    twoStepScript(kit)
    const opening = baseBody({ messages: [{ role: "user", content: "read a and b" }] })
    const step1 = await readSse(await kit.request(opening))
    const req1 = continueWithToolResults(opening, step1, () => "AAA")
    const step2 = await readSse(await kit.request(req1))

    const retryReq = structuredClone(req1)
    retryReq.stream = false
    const retryRes = await kit.request(retryReq)
    assert.equal(retryRes.status, 200, await retryRes.clone().text())
    const json = await retryRes.json()
    assert.equal(json.id, messageIdOf(step2))
    assert.equal(json.stop_reason, "tool_use")
    assert.deepEqual(json.content, step2.content)
  } finally {
    await kit.dispose()
  }
})

test("changed request or prefill tail does not replay the cached step", async () => {
  const kit = await createBridgeKit({})
  const err = captureStderr()
  try {
    twoStepScript(kit)
    const opening = baseBody({ messages: [{ role: "user", content: "read a and b" }] })
    const step1 = await readSse(await kit.request(opening))
    const req1 = continueWithToolResults(opening, step1, () => "AAA")
    const step2 = await readSse(await kit.request(req1))
    assert.equal(step2.stopReason, "tool_use")

    // Conflicting duplicate tool_result still returns 409.
    const conflict = structuredClone(req1)
    conflict.messages.at(-1).content[0].content = "CHANGED"
    const conflictRes = await kit.request(conflict)
    assert.equal(conflictRes.status, 409)

    // Changing the tool catalog invalidates the digest and drops the live session.
    const grown = structuredClone(req1)
    grown.tools = [...grown.tools, { name: "Write", description: "write", input_schema: { type: "object", properties: {} } }]
    const grownRes = await kit.request(grown)
    assert.equal(grownRes.status, 200, await grownRes.clone().text())
    await readSse(grownRes)
    assert.ok(
      err.lines.some((line) => line.event === "agy_bridge_tool_state" && line.action === "drop_live" && line.reason === "history_mismatch"),
      JSON.stringify(err.lines.map((line) => [line.event, line.action, line.reason])),
    )
  } finally {
    err.restore()
    await kit.dispose()
  }
})

test("prefill tail after tool_result keeps 0.1.120 drop_live/prefill behavior", async () => {
  const kit = await createBridgeKit({})
  const err = captureStderr()
  try {
    twoStepScript(kit)
    const opening = baseBody({ messages: [{ role: "user", content: "read a and b" }] })
    const step1 = await readSse(await kit.request(opening))
    const req1 = continueWithToolResults(opening, step1, () => "AAA")
    const step2 = await readSse(await kit.request(req1))
    assert.equal(step2.stopReason, "tool_use")

    const prefill = structuredClone(req1)
    prefill.messages.push({ role: "assistant", content: "partial reply" })
    const prefillRes = await kit.request(prefill)
    assert.equal(prefillRes.status, 200, await prefillRes.clone().text())
    await readSse(prefillRes)
    assert.ok(
      err.lines.some((line) => line.event === "agy_bridge_tool_state" && line.action === "drop_live" && line.reason === "prefill"),
      JSON.stringify(err.lines.map((line) => [line.event, line.action, line.reason])),
    )
  } finally {
    err.restore()
    await kit.dispose()
  }
})
