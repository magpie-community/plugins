// inspectToolTurn appends protocol notices (such as <system-reminder>) to a
// tool result's content before continueWith stores call.result. When the same
// raw tool_result is replayed while the turn is still open (a multi-step tool
// turn, a retry, or Claude Code auto-compaction), duplicate validation must
// compare the canonical raw tool_result rather than the notice-enriched copy
// (#1475).

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse, sleep } from "./testkit.mjs"

function promptText(params) {
  return (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

test("replaying an unchanged tool_result after system notices were appended passes validation and delivers once", async () => {
  const kit = await createBridgeKit({})
  try {
    const delivered = []
    kit.defaultPrompt = async (agent) => {
      const r1 = await agent.tool("Read", { path: "/one" })
      delivered.push(r1)
      const r2 = await agent.tool("Read", { path: "/two" })
      delivered.push(r2)
      await agent.text(`done:${r2?.result?.content?.map((p) => p.text).join("|") || ""}`)
      return { stopReason: "end_turn" }
    }

    const firstBody = baseBody({ messages: [{ role: "user", content: "two steps" }] })
    const first = await readSse(await kit.request(firstBody))
    assert.equal(first.stopReason, "tool_use")
    const call1 = first.content.find((b) => b.type === "tool_use")

    const secondBody = continueWithToolResults(firstBody, first, () => "step-one")
    secondBody.messages.at(-1).content.push({
      type: "text",
      text: "<system-reminder>\nFirst notice\n</system-reminder>",
    })
    const second = await readSse(await kit.request(secondBody))
    assert.equal(second.stopReason, "tool_use")
    const call2 = second.content.find((b) => b.type === "tool_use")
    assert.equal(delivered.length, 1)
    const firstTexts = delivered[0]?.result?.content?.map((p) => p.text) || []
    assert.deepEqual(firstTexts, ["step-one", "<system-reminder>\nFirst notice\n</system-reminder>"])

    const changedContent = continueWithToolResults(firstBody, first, () => "changed-result")
    const conflict1 = await kit.request(changedContent)
    assert.equal(conflict1.status, 409)
    assert.match((await conflict1.json())?.error?.message || "", /conflicting duplicate result/)

    const changedError = continueWithToolResults(firstBody, first, () => "step-one")
    changedError.messages.at(-1).content[0].is_error = true
    const conflict2 = await kit.request(changedError)
    assert.equal(conflict2.status, 409)

    const thirdBody = {
      ...secondBody,
      messages: [
        ...secondBody.messages,
        { role: "assistant", content: second.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call1.id, content: "step-one" },
            { type: "tool_result", tool_use_id: call2.id, content: "step-two" },
            { type: "text", text: "<system-reminder>\nSecond notice\n</system-reminder>" },
          ],
        },
      ],
    }
    const thirdRes = await kit.request(thirdBody)
    assert.equal(thirdRes.status, 200, thirdRes.status !== 200 ? await thirdRes.text() : "")
    const third = await readSse(thirdRes)
    assert.equal(third.stopReason, "end_turn")
    assert.equal(delivered.length, 2, "first MCP call is not delivered a second time")
    assert.equal(kit.acpSpawns.length, 1)
    const secondTexts = delivered[1]?.result?.content?.map((p) => p.text) || []
    assert.deepEqual(secondTexts, ["step-two", "<system-reminder>\nSecond notice\n</system-reminder>"])
  } finally {
    await kit.dispose()
  }
})

test("auto-compaction replaying an unchanged tool_result with system notices does not return 409", async () => {
  const kit = await createBridgeKit({})
  try {
    kit.defaultPrompt = async (agent) => {
      const text = promptText({ prompt: agent.prompt })
      if (text.includes("SUMMARIZE_COMPACT")) {
        await agent.text("compact summary")
        return { stopReason: "end_turn" }
      }
      await agent.tool("Read", { path: "/one" })
      await agent.tool("Read", { path: "/two" })
      await agent.text("done")
      return { stopReason: "end_turn" }
    }

    const headers = { "x-magpie-session": "compact-session-1475" }
    const firstBody = baseBody({ messages: [{ role: "user", content: "start work" }] })
    const first = await readSse(await kit.request(firstBody, { headers }))
    const call1 = first.content.find((b) => b.type === "tool_use")

    const secondBody = continueWithToolResults(firstBody, first, () => "step-one")
    secondBody.messages.at(-1).content.push({
      type: "text",
      text: "<system-reminder>\nHook context\n</system-reminder>",
    })
    const second = await readSse(await kit.request(secondBody, { headers }))
    assert.equal(second.stopReason, "tool_use")

    const compactBody = baseBody({
      system: "You are summarizing the conversation.",
      messages: [
        ...firstBody.messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call1.id, content: "step-one" },
            { type: "text", text: "<system-reminder>\nHook context\n</system-reminder>" },
            { type: "text", text: "SUMMARIZE_COMPACT now" },
          ],
        },
      ],
    })
    const compactRes = await kit.request(compactBody, { headers })
    assert.equal(compactRes.status, 200, compactRes.status !== 200 ? await compactRes.text() : "")
    const compact = await readSse(compactRes)
    assert.equal(compact.stopReason, "end_turn")
    assert.ok(compact.content.some((b) => b.text?.includes("compact summary")))
  } finally {
    await kit.dispose()
  }
})

test("same-batch equal tool_result blocks followed by a notice deliver once and retain the notice", async () => {
  const kit = await createBridgeKit({})
  try {
    const delivered = []
    kit.defaultPrompt = async (agent) => {
      delivered.push(await agent.tool("Read", { path: "/dup" }))
      await agent.text("finished")
      return { stopReason: "end_turn" }
    }

    const firstBody = baseBody({ messages: [{ role: "user", content: "same batch dup" }] })
    const first = await readSse(await kit.request(firstBody))
    const call = first.content.find((b) => b.type === "tool_use")

    const next = {
      ...firstBody,
      messages: [
        ...firstBody.messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call.id, content: "same-value" },
            { type: "tool_result", tool_use_id: call.id, content: "same-value" },
            { type: "text", text: "<system-reminder>\nRetained notice\n</system-reminder>" },
          ],
        },
      ],
    }
    const res = await kit.request(next)
    assert.equal(res.status, 200)
    const done = await readSse(res)
    assert.equal(done.stopReason, "end_turn")
    assert.equal(delivered.length, 1)
    assert.deepEqual(
      delivered[0]?.result?.content?.map((p) => p.text),
      ["same-value", "<system-reminder>\nRetained notice\n</system-reminder>"],
    )
  } finally {
    await kit.dispose()
  }
})

test("deferred tool_result enriched with a notice compares by raw key on replay", async () => {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "40" } })
  try {
    let firstPromptDone = false
    let latePromptText = ""
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/slow" })
      firstPromptDone = true
      return { stopReason: "end_turn" }
    })
    kit.prompts.push(async (agent) => {
      latePromptText = promptText({ prompt: agent.prompt })
      await agent.tool("Read", { path: "/after-late" })
      await agent.text("after late done")
      return { stopReason: "end_turn" }
    })

    const firstBody = baseBody({ messages: [{ role: "user", content: "deferred notice" }] })
    const first = await readSse(await kit.request(firstBody))
    const call1 = first.content.find((b) => b.type === "tool_use")
    for (let i = 0; i < 200 && !firstPromptDone; i++) await sleep(5)
    assert.ok(firstPromptDone)
    await sleep(20)

    const secondBody = continueWithToolResults(firstBody, first, () => "late-one")
    secondBody.messages.at(-1).content.push({
      type: "text",
      text: "<system-reminder>\nDeferred notice\n</system-reminder>",
    })
    const second = await readSse(await kit.request(secondBody))
    assert.equal(second.stopReason, "tool_use")
    assert.match(latePromptText, /late-one/)
    assert.match(latePromptText, /Deferred notice/)
    const call2 = second.content.find((b) => b.type === "tool_use")

    const conflict = await kit.request(continueWithToolResults(firstBody, first, () => "late-changed"))
    assert.equal(conflict.status, 409)

    const thirdBody = {
      ...secondBody,
      messages: [
        ...secondBody.messages,
        { role: "assistant", content: second.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call1.id, content: "late-one" },
            { type: "tool_result", tool_use_id: call2.id, content: "step-two" },
          ],
        },
      ],
    }
    const thirdRes = await kit.request(thirdBody)
    assert.equal(thirdRes.status, 200, thirdRes.status !== 200 ? await thirdRes.text() : "")
    const third = await readSse(thirdRes)
    assert.equal(third.stopReason, "end_turn")
  } finally {
    await kit.dispose()
  }
})
