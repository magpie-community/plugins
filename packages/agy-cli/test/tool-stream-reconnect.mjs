import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse, sleep } from "./testkit.mjs"

const USAGE = { inputTokens: 100, outputTokens: 5, totalTokens: 105 }
const textOf = (response) => response.content.map((block) => block.text ?? "").join("")

async function withToolStream(options, run) {
  const kit = await createBridgeKit(options)
  const release = Promise.withResolvers()
  const delivered = Promise.withResolvers()
  let deliveries = 0
  let cancelledBeforeCommit = null
  const calls = (method) => kit.acpLog.filter((entry) => entry.method === method)
  kit.prompts.push(async (agent) => {
    if (options.steer) agent.update({ sessionUpdate: "tool_call", toolCallId: "fixture", status: "in_progress" })
    const result = await agent.tool("Read", { path: "/fixture" })
    deliveries++
    delivered.resolve(result?.result?.content?.[0]?.text)
    if (options.output) await agent.text("partial output before disconnect")
    await release.promise
    if (options.steer) {
      cancelledBeforeCommit = agent.cancelPending
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "fixture", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    }
    await agent.text("ORIGINAL")
    return { stopReason: "end_turn", usage: USAGE }
  })
  kit.defaultPrompt = async (agent) => {
    await agent.text("NEXT_PROMPT")
    return { stopReason: "end_turn", usage: USAGE }
  }

  try {
    const opening = baseBody()
    const first = await readSse(await kit.request(opening))
    assert.equal(first.stopReason, "tool_use")
    const next = continueWithToolResults(opening, first, () => "FIXTURE_RESULT")
    const abort = new AbortController()
    const stream = await kit.request(next, { signal: abort.signal })
    assert.equal(stream.status, 200)
    assert.equal(await delivered.promise, "FIXTURE_RESULT")
    if (options.output) {
      const reader = stream.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        assert.equal(done, false, "expected visible output before disconnecting")
        if (new TextDecoder().decode(value).includes("content_block_delta")) break
      }
      reader.releaseLock()
    }
    abort.abort()
    await run({
      kit, next, calls, release: release.resolve,
      deliveries: () => deliveries, cancelledBeforeCommit: () => cancelledBeforeCommit,
    })
  } finally {
    release.resolve()
    await kit.dispose()
  }
}

async function finish(response) {
  const parsed = await readSse(await response)
  assert.equal(parsed.stopReason, "end_turn")
  assert.equal(parsed.content.some((block) => block.type === "tool_use"), false)
  return textOf(parsed)
}

test("identical retry reattaches to the original response without delivering the result again", async () => {
  await withToolStream({}, async ({ kit, next, release, calls, deliveries }) => {
    const conflict = structuredClone(next)
    conflict.messages.at(-1).content[0].content = "WRONG_RESULT"
    assert.equal((await kit.request(conflict)).status, 409)

    const retry = kit.request(next)
    release()
    assert.equal(await finish(retry), "ORIGINAL")
    assert.equal(deliveries(), 1)
    assert.equal(calls("session/new").length, 1)
    assert.equal(calls("session/prompt").length, 1)
    assert.equal(calls("session/cancel").length, 0)
    assert.equal(kit.turns[0].responseSteps.length, 2)
  })
})

for (const placement of ["inline", "separate"]) {
  test(`a steer (${placement}) waits for the result commit and keeps the session`, async () => {
    await withToolStream({ steer: true }, async ({ kit, next, calls, release, deliveries, cancelledBeforeCommit }) => {
      const instruction = { type: "text", text: "Follow the new instruction." }
      const steered = structuredClone(next)
      if (placement === "inline") steered.messages.at(-1).content.push(instruction)
      else steered.messages.push({ role: "user", content: [instruction] })
      const response = kit.request(steered)
      await sleep(25)
      assert.equal(kit.turns[0].steering, true)
      assert.equal(calls("session/cancel").length, 0)
      release()
      assert.equal(await finish(response), "NEXT_PROMPT")
      assert.equal(cancelledBeforeCommit(), false)
      assert.equal(deliveries(), 1)
      assert.equal(calls("session/new").length, 1)
      assert.equal(calls("session/cancel").length, 1)
      const prompts = calls("session/prompt")
      assert.equal(prompts.length, 2)
      assert.match(JSON.stringify(prompts[1]), /Follow the new instruction/)
      assert.doesNotMatch(JSON.stringify(prompts[1]), /FIXTURE_RESULT/)
    })
  })
}

test("an expired reconnect window cancels the detached prompt", async () => {
  const indexTransform = (source) => source.replace(
    /const TOOL_STREAM_RECONNECT_MS = \d[\d_]*/, "const TOOL_STREAM_RECONNECT_MS = 15",
  )
  await withToolStream({ indexTransform }, async ({ kit, next, calls, release }) => {
    assert.equal(calls("session/cancel").length, 0)
    await sleep(60)
    assert.equal(calls("session/cancel").length, 1)
    release()
    assert.equal(await finish(kit.request(next)), "NEXT_PROMPT")
    assert.equal(calls("session/new").length, 2)
  })
})

test("a changed request uses ordinary history recovery", async () => {
  await withToolStream({}, async ({ kit, next, calls }) => {
    const changed = structuredClone(next)
    changed.tools[0].description = "Changed definition"
    assert.equal(await finish(kit.request(changed)), "NEXT_PROMPT")
    assert.equal(calls("session/new").length, 2)
  })
})

test("a response that already emitted output is cancelled immediately", async () => {
  await withToolStream({ output: true }, async ({ kit, next, calls, release }) => {
    assert.equal(calls("session/cancel").length, 1)
    release()
    assert.equal(await finish(kit.request(next)), "NEXT_PROMPT")
    assert.equal(calls("session/new").length, 2)
  })
})

test("an exited agy is recovered through the existing path", async () => {
  await withToolStream({}, async ({ kit, next, calls }) => {
    await kit.finishChildren()
    assert.equal(await finish(kit.request(next)), "NEXT_PROMPT")
    assert.equal(calls("session/new").length, 2)
  })
})
