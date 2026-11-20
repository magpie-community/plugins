// Adversarial regressions for in-session tool steering (`Proc.steerInSession`):
// MCP commit barrier (`waitAcpToolsCommitted`), concurrent request re-entrancy
// (`turn.steering` busy guard), held trailing sibling MCP calls, generation
// chunk wakeup + suppression, natural turn completion / child crash wakeup,
// deferred (`LONGTOOL`) self-poll vs non-polled `withoutAnswered` filtering,
// `AGY_BRIDGE_MCP_COMMIT_WAIT_MS` bounds, and stale MCP socket rejection before
// the next `session/prompt` starts (`turn.promptInFlight`).

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  baseBody, continueWithToolResults, createBridgeKit, readSse, sleep,
} from "./testkit.mjs"

const USAGE = { inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 5, totalTokens: 105 }

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function steerBody(body, prev, text = "Steer to new instruction", resultFn = () => "REAL_RESULT_42") {
  const next = continueWithToolResults(body, prev, resultFn)
  next.messages.at(-1).content.push({ type: "text", text })
  return next
}

function cancelCount(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/cancel").length
}

async function settleResponse(resPromise) {
  const res = await resPromise
  if (res.status !== 200) {
    return { status: res.status, body: await res.text(), retry: res.headers.get("x-should-retry") }
  }
  const parsed = await readSse(res)
  return {
    status: 200,
    stopReason: parsed.stopReason,
    text: parsed.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    tools: parsed.content.filter((b) => b.type === "tool_use").map((b) => b.input),
    error: parsed.error,
  }
}

function unmatchedRetry(body, resultId = "toolu_unmatched_retry") {
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_consumed_not_live0001", name: "Read", input: { path: "/old" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: resultId, content: "already consumed" }] },
    ],
  }
}

function captureBridgeEvents() {
  const rows = []
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...args) {
    const text = typeof chunk === "string" ? chunk : chunk?.toString?.() ?? ""
    for (const line of text.split("\n")) {
      if (!line.startsWith("[agy-bridge] ")) continue
      try { rows.push(JSON.parse(line.slice("[agy-bridge] ".length))) } catch {}
    }
    return write.call(this, chunk, ...args)
  }
  return { rows, restore() { process.stderr.write = write } }
}

async function waitFor(fn, ms = 1000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return
    await sleep(5)
  }
  throw new Error("timed out waiting for bridge state")
}

test("steerInSession: duplicate steer and plain continuation during waitAcpToolsCommitted return 503 without early cancel", async () => {
  // Duplicate steer hitting waitAcpToolsCommitted window
  await withKit({}, async (kit) => {
    let cancelBeforeCommit = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      const reply = await agent.tool("Read", { path: "/a" })
      assert.equal(reply?.result?.content?.[0]?.text, "REAL_RESULT_42")
      await sleep(140)
      cancelBeforeCommit = agent.cancelPending
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text(`steered:${agent.index}`)
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const steered = steerBody(body, first)
    const reqA = kit.request(steered)
    await sleep(30)
    const reqB = kit.request(steered)
    const [resA, resB] = await Promise.all([settleResponse(reqA), settleResponse(reqB)])

    assert.equal(cancelBeforeCommit, false, "duplicate steer must not trigger session/cancel before tool_call_update")
    assert.equal(resA.status, 200)
    assert.equal(resA.stopReason, "end_turn")
    assert.equal(resA.text, "steered:1")
    assert.equal(resB.status, 503)
    assert.match(resB.body, /already steering/)
    assert.equal(kit.acpSpawns.length, 1)
  })

  // Plain non-steer continuation hitting waitAcpToolsCommitted window
  await withKit({}, async (kit) => {
    let cancelBeforeCommit = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(140)
      cancelBeforeCommit = agent.cancelPending
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text(`steered:${agent.index}`)
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const reqA = kit.request(steerBody(body, first))
    await sleep(30)
    const reqB = kit.request(continueWithToolResults(body, first, () => "REAL_RESULT_42"))
    const [resA, resB] = await Promise.all([settleResponse(reqA), settleResponse(reqB)])

    assert.equal(cancelBeforeCommit, false)
    assert.equal(resA.status, 200)
    assert.equal(resA.text, "steered:1")
    assert.equal(resB.status, 503)
    assert.match(resB.body, /already steering/)
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("steerInSession: parallel same-name tool calls wait until every in-flight ACP toolCallId commits", async () => {
  await withKit({}, async (kit) => {
    let cancelAfterSecondOnly = null
    let seenReplies = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c2", status: "in_progress" })
      const replies = await agent.tools([["Read", { path: "/a" }], ["Read", { path: "/b" }]])
      seenReplies = replies.map((r) => r?.result?.content?.[0]?.text)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed" })
      await sleep(80)
      cancelAfterSecondOnly = agent.cancelPending
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("parallel steered")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    assert.equal(first.content.filter((b) => b.type === "tool_use").length, 2)

    const res = await settleResponse(kit.request(steerBody(body, first, "Steer", (_b, i) => `RES_${i}`)))
    assert.deepEqual(seenReplies, ["RES_0", "RES_1"])
    assert.equal(cancelAfterSecondOnly, false, "must wait for c1 even after c2 completed")
    assert.equal(res.status, 200)
    assert.equal(res.text, "parallel steered")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("steerInSession: trailing sibling MCP call during steer is held quiet and its socket destroyed on finalize", async () => {
  await withKit({}, async (kit) => {
    let heldPromise = null
    let heldSettledBeforeCancel = false
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c2", status: "in_progress" })
      heldPromise = agent.tool("Read", { path: "/late-sibling" }).then((reply) => {
        if (!agent.cancelPending) heldSettledBeforeCancel = true
        return reply
      })
      await sleep(40)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("steered cleanly")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const res = await settleResponse(kit.request(steerBody(body, first)))
    assert.equal(res.status, 200)
    assert.equal(res.text, "steered cleanly")
    assert.equal(kit.acpSpawns.length, 1, "held sibling call must not break cancelTurn or force a new session")
    assert.equal(heldSettledBeforeCancel, false, "held sibling socket must stay quiet until cancel/finalize")

    const heldOutcome = await Promise.race([heldPromise, sleep(250).then(() => "hung")])
    assert.equal(heldOutcome, null, "finalizeTurn must destroy held sibling sockets so MCP helpers never hang")
  })
})

test("steerInSession: generation output (text or thought) wakes commit wait early and is suppressed on steered turn", async () => {
  for (const kind of ["text", "thought"]) {
    await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "2500" } }, async (kit) => {
      kit.prompts.push(async (agent) => {
        // Deliberately omit tool_call_update: moving on to generation proves MCP committed.
        agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
        await agent.tool("Read", { path: "/a" })
        if (kind === "text") await agent.text("STALE_POST_TOOL_TEXT")
        else await agent.thought("STALE_POST_TOOL_THOUGHT")
        await agent.waitCancel()
        return { stopReason: "cancelled", usage: USAGE }
      })
      kit.defaultPrompt = async (agent) => {
        await agent.text(`steered-${kind}`)
        return { stopReason: "end_turn", usage: USAGE }
      }

      const body = baseBody()
      const first = await readSse(await kit.request(body))
      const [proc] = [...kit.module.__agyTestAllProcs]
      const turn1 = proc.turn

      const startedAt = Date.now()
      const res = await settleResponse(kit.request(steerBody(body, first)))
      const elapsed = Date.now() - startedAt

      assert.equal(res.status, 200)
      assert.equal(res.text, `steered-${kind}`)
      assert.equal(kit.acpSpawns.length, 1, `${kind} chunk must resolve waitAcpToolsCommitted and keep session`)
      assert.ok(elapsed < 800, `${kind} chunk should wake waitAcpToolsCommitted immediately, took ${elapsed}ms`)
      assert.equal(
        turn1.events.some((ev) => ev.type === "text" || ev.type === "thinking"),
        false,
        `steered turn must suppress ${kind} chunks from the cancelled step`,
      )
    })
  }
})

test("steerInSession: natural end_turn and child crash during commit wait wake immediately and handle session state cleanly", async () => {
  // Natural end_turn without tool_call_update or chunks: wakes immediately, finalizes turn1, reuses session
  await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "2500" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(20)
      return { stopReason: "end_turn", usage: USAGE }
    })
    let prompt2Text = ""
    kit.defaultPrompt = async (agent) => {
      prompt2Text = JSON.stringify(agent.prompt)
      await agent.text("steered after natural end")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const startedAt = Date.now()
    const res = await settleResponse(kit.request(steerBody(body, first)))
    const elapsed = Date.now() - startedAt

    assert.equal(res.status, 200)
    assert.equal(res.text, "steered after natural end")
    assert.equal(kit.acpSpawns.length, 1, "natural completion must finalize turn1 and keep the live session")
    assert.equal(cancelCount(kit), 0)
    assert.ok(elapsed < 800, `Turn.complete() must wake waitAcpToolsCommitted immediately, took ${elapsed}ms`)
    assert.equal(prompt2Text.includes("REAL_RESULT_42"), false)
    assert.equal(prompt2Text.includes("Steer to new instruction"), true)
  })

  // Child SIGKILL during commit wait: wakes immediately and replays in a fresh session
  await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "2500" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(20)
      for (const child of [...kit.children]) child.kill("SIGKILL")
      return new Promise(() => {})
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("replayed after crash")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const startedAt = Date.now()
    const res = await settleResponse(kit.request(steerBody(body, first)))
    const elapsed = Date.now() - startedAt

    assert.equal(res.status, 200)
    assert.equal(res.text, "replayed after crash")
    assert.equal(kit.acpSpawns.length, 2)
    assert.ok(elapsed < 1000, `Turn.fail() must wake waitAcpToolsCommitted immediately, took ${elapsed}ms`)
  })
})

test("steerInSession: deferred LONGTOOL result goes via MCP when self-polled, or in steer prompt when unpolled", async () => {
  // Unpolled deferred call: agy received "still running" and moved on without polling -> steer prompt MUST carry REAL_RESULT
  await withKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "50" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      const firstReply = await agent.tool("Read", { path: "/long" })
      assert.match(firstReply?.result?.content?.[0]?.text || "", /still running/)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    let prompt2 = ""
    kit.defaultPrompt = async (agent) => {
      prompt2 = JSON.stringify(agent.prompt)
      await agent.text("steered unpolled")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    await sleep(90)
    const res = await settleResponse(kit.request(steerBody(body, first, "Steer", () => "LONG_RESULT_77")))

    assert.equal(res.status, 200)
    assert.equal(res.text, "steered unpolled")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal((prompt2.match(/LONG_RESULT_77/g) || []).length, 1, "unpolled deferred result must be sent in steer prompt")
  })

  // Self-polled deferred call: waiter is active when steer arrives -> delivered via MCP poll, NOT duplicated in steer prompt
  await withKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "180" } }, async (kit) => {
    let pollReplyText = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/long" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c2", status: "in_progress" })
      const pollReply = await agent.tool("Read", { path: "/long" })
      pollReplyText = pollReply?.result?.content?.[0]?.text
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    let prompt2 = ""
    kit.defaultPrompt = async (agent) => {
      prompt2 = JSON.stringify(agent.prompt)
      await agent.text("steered polled")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    await sleep(240)
    const res = await settleResponse(kit.request(steerBody(body, first, "Steer", () => "LONG_RESULT_77")))

    assert.equal(res.status, 200)
    assert.equal(res.text, "steered polled")
    assert.equal(pollReplyText, "LONG_RESULT_77")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal((prompt2.match(/LONG_RESULT_77/g) || []).length, 0, "live self-polled result must not be duplicated in steer prompt")
  })
})

test("steerInSession: AGY_BRIDGE_MCP_COMMIT_WAIT_MS clamps int32 overflow and supports 0ms immediate fallback", async () => {
  // > 2^31 - 1 must clamp to 60s instead of overflowing setTimeout to 1ms
  await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "3000000000" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(80)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("clamped ok")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const res = await settleResponse(kit.request(steerBody(body, first)))
    assert.equal(res.status, 200)
    assert.equal(res.text, "clamped ok")
    assert.equal(kit.acpSpawns.length, 1, "clamped timeout must not fire at 1ms before tool_call_update")
  })

  // "0" immediately falls back to replay without waiting 5s when uncommitted
  await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "0" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("zero-wait replay")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const startedAt = Date.now()
    const res = await settleResponse(kit.request(steerBody(body, first)))
    const elapsed = Date.now() - startedAt

    assert.equal(res.status, 200)
    assert.equal(res.text, "zero-wait replay")
    assert.equal(kit.acpSpawns.length, 2)
    assert.ok(elapsed < 800, `0ms commit wait should fall back immediately, took ${elapsed}ms`)
  })
})

test("steerInSession: stale MCP socket arriving before next session/prompt is rejected instead of leaking a phantom tool_use", async () => {
  await withKit({}, async (kit) => {
    let agent1 = null
    kit.prompts.push(async (agent) => {
      agent1 = agent
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await sleep(15)
      await agent.text("clean next turn")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const [proc] = [...kit.module.__agyTestAllProcs]
    const origStartTurn = proc.startTurn
    let staleCall = null
    proc.startTurn = function (...args) {
      const nextTurn = origStartTurn.apply(this, args)
      staleCall = agent1.tool("Read", { path: "/STALE_FROM_CANCELLED_TURN" })
      proc.startTurn = origStartTurn
      return nextTurn
    }

    const res = await settleResponse(kit.request(steerBody(body, first)))
    const staleReply = await staleCall

    assert.equal(res.status, 200)
    assert.equal(res.stopReason, "end_turn")
    assert.equal(res.tools.length, 0, "stale MCP call must never leak into the next turn as tool_use")
    assert.equal(res.text, "clean next turn")
    assert.match(staleReply?.error?.message || "", /no prompt in flight/)
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("steerInSession: pool pressure and repeated unmatched tool results cannot evict or reclaim an active steer", async () => {
  // Pool pressure (evictLRU) while steering
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "1", AGY_BRIDGE_DETACHED_EVICT_MS: "10" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(120)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("survived pool pressure")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body1 = baseBody({ messages: [{ role: "user", content: "conversation one" }] })
    const first = await readSse(await kit.request(body1))
    const steerReq = kit.request(steerBody(body1, first))
    await sleep(25)
    kit.clock.advance(60_000)
    const body2 = baseBody({ messages: [{ role: "user", content: "conversation two" }] })
    const otherRes = await settleResponse(kit.request(body2))
    const steerRes = await settleResponse(steerReq)

    assert.equal(otherRes.status, 503, "pool pressure must reject new conversation rather than evicting steering turn")
    assert.match(otherRes.body, /unfinished responses/)
    assert.equal(steerRes.status, 200)
    assert.equal(steerRes.text, "survived pool pressure")
    assert.equal(kit.acpSpawns.length, 1)
  })

  // 3x unmatched tool results while steering are retryable 503 and never reclaim
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(150)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("survived unmatched repeats")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody({ messages: [{ role: "user", content: "conversation repeat guard" }] })
    const first = await readSse(await kit.request(body))
    const steerReq = kit.request(steerBody(body, first))
    await sleep(25)

    const bogus = continueWithToolResults(body, first, () => "BOGUS")
    for (const block of bogus.messages.at(-1).content) {
      if (block.type === "tool_result") block.tool_use_id = "toolu_unmatched_bogus_id"
    }
    const boguses = []
    for (let i = 0; i < 3; i++) {
      boguses.push(await settleResponse(kit.request(bogus)))
    }
    const steerRes = await settleResponse(steerReq)

    assert.deepEqual(boguses.map((r) => r.status), [503, 503, 503])
    assert.ok(boguses.every((r) => r.retry === null && /already steering this tool turn/.test(r.body)))
    assert.equal(steerRes.status, 200)
    assert.equal(steerRes.text, "survived unmatched repeats")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("steerInSession: deferred self-poll commit wait, foreign ACP tool isolation, failed status commit, and waitLate promptInFlight guard", async () => {
  // 1. Self-polled deferred call must wait for agy's ACP tool_call_update on the poll before session/cancel
  await withKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "180" } }, async (kit) => {
    let cancelBeforeCommit = null
    let pollText = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/long" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c2", status: "in_progress" })
      const poll = await agent.tool("Read", { path: "/long" })
      pollText = poll?.result?.content?.[0]?.text
      await sleep(120)
      cancelBeforeCommit = agent.cancelPending
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("polled deferred ok")
      return { stopReason: "end_turn", usage: USAGE }
    }
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    await sleep(240)
    const res = await settleResponse(kit.request(steerBody(body, first, "Steer", () => "LONG_77")))
    assert.equal(res.status, 200)
    assert.equal(pollText, "LONG_77")
    assert.equal(cancelBeforeCommit, false, "session/cancel went out before the polled call's tool_call_update")
    assert.equal(kit.acpSpawns.length, 1)
  })

  // 2. Unrelated agy-internal ACP tool in flight must not stall a steer that delivers no live MCP socket
  await withKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "50", AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "1500" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/long" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      agent.update({ sessionUpdate: "tool_call", toolCallId: "internal9", status: "in_progress" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("unpolled deferred ok")
      return { stopReason: "end_turn", usage: USAGE }
    }
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    await sleep(90)
    const t0 = Date.now()
    const res = await settleResponse(kit.request(steerBody(body, first, "Steer", () => "LONG_77")))
    const elapsed = Date.now() - t0
    assert.equal(res.status, 200)
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(elapsed < 800, `stalled ${elapsed}ms on a foreign ACP tool`)
  })

  // 3. Stale MCP call arriving during waitLate between two prompts of the same turn is rejected
  await withKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "50" } }, async (kit) => {
    let agent1 = null
    kit.prompts.push(async (agent) => {
      agent1 = agent
      await agent.tool("Read", { path: "/long" })
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("late ok")
      return { stopReason: "end_turn", usage: USAGE }
    }
    const body = baseBody()
    await readSse(await kit.request(body))
    await sleep(120)
    const [proc] = [...kit.module.__agyTestAllProcs]
    assert.ok(proc.turn && !proc.turn.done, "turn should be waiting for the late result")
    const outcome = await Promise.race([
      agent1.tool("Read", { path: "/STALE_BETWEEN_PROMPTS" }),
      sleep(300).then(() => "accepted-and-pending"),
    ])
    assert.match(outcome?.error?.message || String(outcome), /no prompt in flight/)
  })

  // 4. tool_call_update with status "failed" (e.g. client tool_result is_error) counts as committed
  await withKit({ env: { AGY_BRIDGE_MCP_COMMIT_WAIT_MS: "1500" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      await sleep(30)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("failed tool committed")
      return { stopReason: "end_turn", usage: USAGE }
    }
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    const t0 = Date.now()
    const res = await settleResponse(kit.request(steerBody(body, first)))
    const elapsed = Date.now() - t0
    assert.equal(res.status, 200)
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(elapsed < 800, `failed status did not count as commit: ${elapsed}ms`)
  })
})

test("unmatched tool_result while a turn is attached returns 503 BusyError and leaves that stream running", async () => {
  await withKit({}, async (kit) => {
    let release
    const hold = new Promise((resolve) => { release = resolve })
    kit.prompts.push(async (agent) => {
      await agent.text("still streaming")
      await hold
      return { stopReason: "end_turn", usage: USAGE }
    })
    const body = baseBody({ messages: [{ role: "user", content: "attached unmatched retry" }] })
    const liveReq = kit.request(body)
    const liveSettled = liveReq.then(settleResponse, (error) => ({ status: 0, body: String(error?.message ?? error) }))
    try {
      await waitFor(() => [...kit.module.__agyTestAllProcs][0]?.turn?.attached)
      const proc = [...kit.module.__agyTestAllProcs][0]
      const turnId = proc.turn.turnId
      assert.equal(proc.turn.steering, false)
      const events = captureBridgeEvents()
      try {
        const retries = []
        for (let i = 0; i < 3; i++) {
          retries.push(await settleResponse(kit.request(unmatchedRetry(body, `toolu_unmatched_attached_${i}`))))
        }
        assert.deepEqual(retries.map((r) => r.status), [503, 503, 503])
        assert.ok(retries.every((r) => r.retry === null && /already has an active response/.test(r.body)))
        assert.equal(proc.turn.turnId, turnId)
        assert.equal(proc.turn.attached, true)
        assert.equal(proc.turn.steering, false)
        assert.equal(kit.acpSpawns.length, 1)
        const rejected = events.rows.filter((row) => row.action === "reject_active")
        assert.equal(rejected.length, 3)
        assert.ok(rejected.every((row) => row.reason === "attached" && row.attempts == null))
        assert.ok(!events.rows.some((row) => row.action === "reclaim"))
      } finally {
        events.restore()
      }
    } finally {
      release()
    }
    const live = await liveSettled
    assert.equal(live.status, 200)
    assert.equal(live.text, "still streaming")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("unmatched tool_result on a pending turn that is not attached or steering stays 409", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      const reply = await agent.tool("Read", { path: "/a" })
      assert.equal(reply?.result?.content?.[0]?.text, "REAL_RESULT")
      return { stopReason: "end_turn", usage: USAGE }
    })
    const body = baseBody({ messages: [{ role: "user", content: "pending unmatched stays 409" }] })
    const first = await readSse(await kit.request(body))
    const proc = [...kit.module.__agyTestAllProcs][0]
    const turnId = proc.turn.turnId
    assert.equal(proc.turn.attached, false)
    assert.equal(proc.turn.steering, false)

    const events = captureBridgeEvents()
    try {
      const retries = []
      for (let i = 0; i < 2; i++) {
        retries.push(await settleResponse(kit.request(unmatchedRetry(body, `toolu_unmatched_pending_${i}`))))
      }
      assert.deepEqual(retries.map((r) => r.status), [409, 409])
      assert.ok(retries.every((r) => r.retry === null && /no active MCP call matches these tool results/.test(r.body)))
      assert.equal(proc.turn?.turnId, turnId)
      assert.equal(proc.turn.attached, false)
      assert.equal(proc.turn.steering, false)
      assert.equal(kit.acpSpawns.length, 1)
      const rejected = events.rows.filter((row) => row.action === "reject_active")
      assert.deepEqual(rejected.map((row) => row.reason), ["pending_tool", "pending_tool"])
      assert.deepEqual(rejected.map((row) => row.attempts), [1, 2])
      assert.ok(!events.rows.some((row) => row.action === "reclaim"))
    } finally {
      events.restore()
    }

    const done = await settleResponse(kit.request(continueWithToolResults(body, first, () => "REAL_RESULT")))
    assert.equal(done.status, 200)
    assert.equal(done.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("recoverStaleTurn active attached or steering inside the lock is 503 and does not reclaim", async () => {
  for (const reason of ["attached", "steering"]) {
    await withKit({}, async (kit) => {
      kit.prompts.push(async (agent) => {
        agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
        const reply = await agent.tool("Read", { path: "/a" })
        assert.equal(reply?.result?.content?.[0]?.text, "REAL_RESULT")
        return { stopReason: "end_turn", usage: USAGE }
      })
      const body = baseBody({ messages: [{ role: "user", content: `recover ${reason} stays live` }] })
      const first = await readSse(await kit.request(body))
      const proc = [...kit.module.__agyTestAllProcs][0]
      const turnId = proc.turn.turnId
      assert.equal(proc.turn.attached, false)
      assert.equal(proc.turn.steering, false)

      for (let i = 0; i < 2; i++) {
        const prior = await settleResponse(kit.request(unmatchedRetry(body, `toolu_unmatched_prior_${reason}_${i}`)))
        assert.equal(prior.status, 409, prior.body)
      }
      assert.equal(proc.turn.turnId, turnId)
      assert.equal(kit.acpSpawns.length, 1)

      const pool = kit.module.__agyTestPool
      const origGet = pool.get
      let gets = 0
      pool.get = function (key) {
        const found = origGet.call(this, key)
        gets += 1
        if (gets === 2 && found?.turn === proc.turn) found.turn[reason] = true
        return found
      }
      const events = captureBridgeEvents()
      try {
        const retry = await settleResponse(kit.request(unmatchedRetry(body, `toolu_unmatched_race_${reason}`)))
        assert.equal(retry.status, 503, `${reason} race returned ${retry.status}: ${retry.body}`)
        assert.equal(retry.retry, null)
        assert.match(retry.body, reason === "steering" ? /already steering this tool turn/ : /already has an active response/)
        assert.equal(proc.turn?.turnId, turnId)
        assert.equal(kit.acpSpawns.length, 1)
        const rejected = events.rows.filter((row) => row.action === "reject_active")
        assert.equal(rejected.length, 1)
        assert.equal(rejected[0].reason, reason)
        assert.equal(rejected[0].attempts, 3)
        assert.ok(!events.rows.some((row) => row.action === "reclaim" || row.action === "replay_started"))
      } finally {
        events.restore()
        pool.get = origGet
        if (proc.turn) {
          proc.turn.attached = false
          proc.turn.steering = false
        }
      }

      // The in-lock 503 must clear noProgressRepeats so a subsequent quiet unmatched
      // retry starts back at attempt 1 instead of reclaiming the live turn at attempt 4.
      const postEvents = captureBridgeEvents()
      try {
        const afterQuiet = await settleResponse(kit.request(unmatchedRetry(body, `toolu_unmatched_after_${reason}`)))
        assert.equal(afterQuiet.status, 409, `${reason} post-503 quiet retry returned ${afterQuiet.status}: ${afterQuiet.body}`)
        assert.equal(proc.turn?.turnId, turnId)
        assert.equal(kit.acpSpawns.length, 1)
        const postRejected = postEvents.rows.filter((row) => row.action === "reject_active")
        assert.equal(postRejected.length, 1)
        assert.equal(postRejected[0].attempts, 1)
        assert.ok(!postEvents.rows.some((row) => row.action === "reclaim" || row.action === "replay_started"))
      } finally {
        postEvents.restore()
      }

      const done = await settleResponse(kit.request(continueWithToolResults(body, first, () => "REAL_RESULT")))
      assert.equal(done.status, 200)
      assert.equal(done.stopReason, "end_turn")
      assert.equal(kit.acpSpawns.length, 1)
    })
  }
})

test("recoverStaleTurn active for a reason other than attached or steering stays 409", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      const reply = await agent.tool("Read", { path: "/a" })
      assert.equal(reply?.result?.content?.[0]?.text, "REAL_RESULT")
      return { stopReason: "end_turn", usage: USAGE }
    })
    const body = baseBody({ messages: [{ role: "user", content: "recover pending stays 409" }] })
    const first = await readSse(await kit.request(body))
    const proc = [...kit.module.__agyTestAllProcs][0]
    const turnId = proc.turn.turnId
    const savedDeadline = proc.turn.deadlineAt
    assert.ok(savedDeadline > kit.clock.now())
    proc.turn.deadlineAt = kit.clock.now() - 1

    const pool = kit.module.__agyTestPool
    const origGet = pool.get
    let gets = 0
    pool.get = function (key) {
      const found = origGet.call(this, key)
      gets += 1
      if (gets === 2 && found?.turn === proc.turn) found.turn.deadlineAt = savedDeadline
      return found
    }
    const events = captureBridgeEvents()
    let retry
    try {
      retry = await settleResponse(kit.request(unmatchedRetry(body, "toolu_unmatched_expired_race")))
    } finally {
      events.restore()
      pool.get = origGet
      if (proc.turn) proc.turn.deadlineAt = savedDeadline
    }
    assert.equal(retry.status, 409, retry.body)
    assert.equal(retry.retry, null)
    assert.match(retry.body, /no active MCP call matches these tool results/)
    assert.doesNotMatch(retry.body, /already has an active response|already steering/)
    assert.equal(proc.turn?.turnId, turnId)
    assert.equal(proc.turn.attached, false)
    assert.equal(proc.turn.steering, false)
    assert.equal(kit.acpSpawns.length, 1)
    const rejected = events.rows.filter((row) => row.action === "reject_active")
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason, "pending_tool")
    assert.equal(rejected[0].attempts, undefined)
    assert.ok(!events.rows.some((row) => row.action === "reclaim"))

    const done = await settleResponse(kit.request(continueWithToolResults(body, first, () => "REAL_RESULT")))
    assert.equal(done.status, 200)
    assert.equal(done.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
  })
})


