// A reply begun after a tool round and sent back as an assistant prefill:
// magpie's continuation of a reply cut mid-way (prefill.go, continuation.go
// in yetone/magpie) and a client's retry that keeps what it got of the cut
// reply both end `… user(tool_result), assistant(text or thinking)`. It was a
// 400 ("a live tool_result with an assistant prefill tail", plugins#1319);
// it is served as an interrupted tool turn is, the prefill as its carrier.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const USAGE = { inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 5, totalTokens: 105 }
const CARRIER = "part of your own unfinished reply"

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

async function settle(resPromise) {
  const res = await resPromise
  if (res.status !== 200) return { status: res.status, body: await res.text() }
  const parsed = await readSse(res)
  return { status: 200, text: parsed.content.filter((b) => b.type === "text").map((b) => b.text).join(""), error: parsed.error }
}

test("results with a prefill tail for a live call steer the session: the call gets its result, the prompt the carrier", async () => {
  await withKit(async (kit) => {
    let toolReply = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      const reply = await agent.tool("Read", { path: "/a" })
      toolReply = reply?.result?.content?.[0]?.text
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    let prompt = ""
    kit.defaultPrompt = async (agent) => {
      prompt = JSON.stringify(agent.prompt)
      await agent.text(" and the rest")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const next = continueWithToolResults(body, first, () => "REAL_RESULT_42")
    next.messages.push({ role: "assistant", content: "The file says" })
    const res = await settle(kit.request(next))

    assert.equal(res.status, 200, res.body)
    assert.equal(res.text, " and the rest")
    assert.equal(toolReply, "REAL_RESULT_42", "the live call is answered with the client's result")
    assert.equal(kit.acpSpawns.length, 1, "the live session is kept")
    assert.ok(prompt.includes(CARRIER) && prompt.includes("The file says"), prompt)
    assert.equal(prompt.includes("REAL_RESULT_42"), false, "an answered result is not sent again")
  })
})

test("a cut reply asked again after its tool round is replayed with the results, then the carrier", async () => {
  for (const [name, tail, carried] of [
    ["text", { role: "assistant", content: [{ type: "text", text: "The file says" }] }, true],
    ["thinking only", { role: "assistant", content: [{ type: "thinking", thinking: "reading it", signature: "sig" }] }, false],
  ]) {
    await withKit(async (kit) => {
      kit.prompts.push(async (agent) => {
        await agent.tool("Read", { path: "/a" })
        await agent.text("The file says")
        return { stopReason: "end_turn", usage: USAGE }
      })
      let prompt = ""
      kit.defaultPrompt = async (agent) => {
        prompt = JSON.stringify(agent.prompt)
        await agent.text(" hello")
        return { stopReason: "end_turn", usage: USAGE }
      }

      const body = baseBody()
      const first = await readSse(await kit.request(body))
      const second = continueWithToolResults(body, first, () => "REAL_RESULT_42")
      await readSse(await kit.request(second))
      const res = await settle(kit.request({ ...second, messages: [...second.messages, tail] }))

      assert.equal(res.status, 200, `${name}: ${res.body}`)
      assert.equal(res.text, " hello", name)
      assert.ok(prompt.includes("REAL_RESULT_42"), `${name}: the replay carries the tool result`)
      assert.equal(prompt.includes(CARRIER), carried, `${name}: ${prompt}`)
    })
  }
})
