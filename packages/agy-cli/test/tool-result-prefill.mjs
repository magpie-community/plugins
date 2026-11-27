// plugins#1512 (deimos6677): a reply cut after a tool round (agy silent
// past TURN_TIMEOUT_MS, a stream that broke) is asked again by magpie,
// going on from what it had said: the round's tool_result, then the
// reply's text as an assistant prefill. The bridge refused that shape
// with a 400 no client retries, and the agent's turn ended there.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

function promptText(entry) {
  return (entry?.params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

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

function script(kit) {
  kit.defaultPrompt = async (agent) => {
    const text = (agent.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
    if (text.includes("FILE BODY")) {
      await agent.text(" and it says hello.")
      return { stopReason: "end_turn" }
    }
    await agent.tool("Read", { path: "/repo/a.txt" })
    await agent.text("after tool")
    return { stopReason: "end_turn" }
  }
}

const READ_ROUND = [
  { role: "user", content: "read a.txt" },
  { role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_cut1", name: "Read", input: { path: "/repo/a.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cut1", content: "FILE BODY: hello" }] },
  { role: "assistant", content: "I read the file" },
]

test("a tool round whose session is gone, then a prefill tail, is replayed and goes on from the prefill", async () => {
  const kit = await createBridgeKit({})
  try {
    script(kit)
    const response = await kit.request(baseBody({ messages: READ_ROUND }))
    assert.equal(response.status, 200, await response.clone().text())
    const result = await readSse(response)
    assert.ok(!result.error, JSON.stringify(result.error))
    assert.match(result.content.find((block) => block.type === "text")?.text ?? "", /it says hello/)
    const sent = promptText(kit.acpLog.filter((entry) => entry.method === "session/prompt").at(-1))
    assert.match(sent, /FILE BODY: hello/)
    assert.match(sent, /I read the file/)
  } finally {
    await kit.dispose()
  }
})

test("a live tool round answered with a prefill tail drops the live session and replays it", async () => {
  const kit = await createBridgeKit({})
  const err = captureStderr()
  try {
    script(kit)
    const body = baseBody({ messages: [{ role: "user", content: "read a.txt" }] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const next = continueWithToolResults(body, first, () => "FILE BODY: hello")
    next.messages.push({ role: "assistant", content: "I read the file" })
    const response = await kit.request(next)
    assert.equal(response.status, 200, await response.clone().text())
    const result = await readSse(response)
    assert.ok(!result.error, JSON.stringify(result.error))
    assert.match(result.content.find((block) => block.type === "text")?.text ?? "", /it says hello/)
    assert.ok(err.lines.some((line) => line.event === "agy_bridge_tool_state" && line.action === "drop_live" && line.reason === "prefill"),
      JSON.stringify(err.lines.map((line) => [line.event, line.action, line.reason])))
  } finally {
    err.restore()
    await kit.dispose()
  }
})
