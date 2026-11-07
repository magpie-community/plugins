// magpie-agy 单次窗口 usage 回归（源自 configs 仓 test_agy_bridge_usage.mjs，去掉依赖 OCX 源码的交叉验证）：
// ACP 一次 session/prompt 的多步累计用量不能被当成单条 /v1/messages 的窗口占用（4,775,934 → 4.8m 跳变）。
// 用 OCX 真实预算判据交叉验证「不误报超阈」的用例留在 configs 仓，那里有 OCX 源码。
//
// 运行：node --experimental-vm-modules --test test-usage-settlement.mjs
// 全部经真实仓内 index.mjs 的 fetch → Proc → ACP → 流生成/消费路径，假 agy 见 testkit.mjs。
// 口径（主控已拍板）：单步精确透传；多步为有界估算，原始 ACP 累计对象原样保留，
// 不承诺各响应 usage 求和精确等于上游累计（下面专门有数值反例）。

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  baseBody, continueWithToolResults, createBridgeKit, padBodyToTokens, readJson, readSse, sleep,
  usageTotal,
} from "./testkit.mjs"

const FIXTURE_ESTIMATE = 198_654
const FIXTURE_RAW = Object.freeze({
  inputTokens: 4_775_934, cachedReadTokens: 4_775_934, cachedWriteTokens: 0, outputTokens: 60_000, thoughtTokens: 1_234,
})

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value))

function assertCleanUsage(usage, label) {
  for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]) {
    assert.ok(Number.isSafeInteger(usage?.[key]) && usage[key] >= 0, `${label}: ${key}=${usage?.[key]} 不是非负有限整数`)
  }
  const thinking = usage.output_tokens_details?.thinking_tokens
  if (thinking !== undefined) {
    assert.ok(Number.isSafeInteger(thinking) && thinking >= 0, `${label}: thinking_tokens=${thinking}`)
    assert.ok(thinking <= usage.output_tokens, `${label}: thinking ${thinking} 超过 output ${usage.output_tokens}`)
  }
}

/** 驱动一整轮：遇到 tool_use 就把 tool_result 接回去，直到收尾。返回每次 HTTP 的估算与解析结果。 */
async function runTurn(kit, body, { stream = true, resultFor } = {}) {
  const responses = []
  const estimates = []
  const bodies = []
  let current = stream ? body : { ...body, stream: false }
  for (let guard = 0; guard < 64; guard++) {
    bodies.push(current)
    estimates.push(await kit.countTokens(current))
    const response = await kit.request(current)
    const parsed = stream ? await readSse(response) : await readJson(response)
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    responses.push(parsed)
    if (parsed.stopReason !== "tool_use") return { responses, estimates, bodies }
    current = continueWithToolResults(current, parsed, resultFor)
  }
  throw new Error("工具回合超过 64 次仍未收尾")
}

// ----------------------------------------------------------------------------- 单步

test("单步回合精确透传 ACP usage 并原样保留原始对象", async () => {
  await withKit({}, async (kit) => {
    const raw = { inputTokens: 1000, cachedReadTokens: 400, cachedWriteTokens: 50, outputTokens: 30, thoughtTokens: 5 }
    kit.prompts.push(async (agent) => {
      await agent.thought("considering")
      await agent.text("single step answer")
      return { stopReason: "end_turn", usage: raw }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 1)
    assert.deepEqual(plain(responses[0].usage), {
      input_tokens: 600, output_tokens: 35, cache_read_input_tokens: 400, cache_creation_input_tokens: 50,
      output_tokens_details: { thinking_tokens: 5 },
    })
    const start = responses[0].events.find((item) => item.event === "message_start")
    assert.deepEqual(plain(start.data.message.usage), { input_tokens: 0, output_tokens: 0 })
    const [turn] = kit.turns
    assert.deepEqual(plain(turn.rawUsage), raw)
    assert.equal(turn.rawAcpUsages.length, 1)
  })
})

// ------------------------------------------------------------------ 25 步固定案例

test("25 步/74 工具/累计 4,775,934：各步窗口有界、原始累计保留、求和不守恒反例", async () => {
  await withKit({}, async (kit) => {
    const rounds = Array.from({ length: 24 }, (_unused, index) => (index < 22 ? 3 : 4))
    assert.equal(rounds.reduce((sum, value) => sum + value, 0), 74)
    let agentSawResults = 0
    kit.prompts.push(async (agent) => {
      for (const [round, count] of rounds.entries()) {
        const replies = await agent.tools(Array.from({ length: count }, (_unused, index) => ["Read", { path: `/repo/src/module-${round}-${index}.ts` }]))
        agentSawResults += replies.filter((reply) => reply?.result).length
      }
      await agent.thought("All modules inspected; summarizing.")
      await agent.text("Task complete after inspecting 74 files.")
      return { stopReason: "end_turn", usage: { ...FIXTURE_RAW } }
    })
    const body = await padBodyToTokens(kit, baseBody(), FIXTURE_ESTIMATE)
    const { responses, estimates } = await runTurn(kit, body)

    assert.equal(responses.length, 25, "应为 24 个工具响应 + 1 个收尾响应")
    assert.equal(agentSawResults, 74)
    assert.equal(estimates[0], FIXTURE_ESTIMATE)
    for (const estimate of estimates) {
      assert.ok(estimate >= FIXTURE_ESTIMATE && estimate < FIXTURE_ESTIMATE * 1.05, `估算 ${estimate} 偏离夹具量级`)
    }
    const toolResponses = responses.slice(0, 24)
    const final = responses[24]
    for (const [index, parsed] of toolResponses.entries()) {
      const label = `工具响应 #${index + 1}`
      assert.equal(parsed.stopReason, "tool_use")
      assert.equal(parsed.content.filter((block) => block.type === "tool_use").length, rounds[index], `${label} 并行调用没有合并`)
      assert.equal(parsed.events.filter((item) => item.event === "message_delta").length, 1)
      assertCleanUsage(parsed.usage, label)
      const total = usageTotal(parsed.usage)
      assert.ok(total > 0, `${label} 窗口读数为 0（旧缺陷：中间工具步恒报 0）`)
      assert.ok(total <= Math.round(estimates[index] * 1.5), `${label} ${total} 超过 1.5 倍估算`)
      assert.ok(parsed.usage.output_tokens >= 1, `${label} output_tokens 为 0`)
    }
    assert.equal(final.stopReason, "end_turn")
    assertCleanUsage(final.usage, "收尾响应")
    const finalTotal = usageTotal(final.usage)
    assert.notEqual(finalTotal, FIXTURE_RAW.inputTokens, "收尾响应仍在吐整轮累计（4.8m 跳变）")
    assert.ok(finalTotal <= Math.round(estimates[24] * 1.5), `收尾 ${finalTotal} 超过 1.5 倍估算 ${estimates[24]}`)
    assert.ok(finalTotal > 150_000 && finalTotal < 300_000, `收尾窗口 ${finalTotal} 不在约 198k 的量级`)
    assert.ok(final.usage.cache_read_input_tokens >= finalTotal - 1, "本轮全部命中读缓存，拆分应保持该占比")
    assert.ok(final.usage.output_tokens >= 1)

    // 原始 ACP 累计对象原样保留、只计一次。
    const [turn] = kit.turns
    assert.equal(kit.turns.length, 1)
    assert.deepEqual(plain(turn.rawUsage), { ...FIXTURE_RAW })
    assert.equal(turn.rawAcpUsages.length, 1)

    // 守恒反例：一般多步估算的求和不等于上游累计，也不能把残差塞回末步。
    const fixtureSum24 = 24 * FIXTURE_ESTIMATE
    assert.equal(fixtureSum24, 4_767_696)
    const fixtureLast = Math.round(FIXTURE_RAW.inputTokens / 25)
    assert.equal(fixtureLast, 191_037)
    assert.notEqual(fixtureSum24 + fixtureLast, FIXTURE_RAW.inputTokens)
    const reportedSum = responses.reduce((sum, parsed) => sum + usageTotal(parsed.usage), 0)
    const residual = FIXTURE_RAW.inputTokens - toolResponses.reduce((sum, parsed) => sum + usageTotal(parsed.usage), 0)
    assert.notEqual(reportedSum, FIXTURE_RAW.inputTokens, "估算求和恰好守恒，与口径假设不符，需重新核对夹具")
    assert.notEqual(finalTotal, residual, "末步被用累计残差补平，不是单次窗口")
    const errorRatio = (reportedSum - FIXTURE_RAW.inputTokens) / FIXTURE_RAW.inputTokens
    assert.ok(Math.abs(errorRatio) < 0.1, `估算总误差 ${(errorRatio * 100).toFixed(2)}% 超出量级`)
    console.log(`# 25 步估算求和 ${reportedSum}，上游累计 ${FIXTURE_RAW.inputTokens}，误差 ${(errorRatio * 100).toFixed(2)}%（不承诺守恒）`)

  })
})

// -------------------------------------------------------------------- 写缓存上限

test("末步输入三字段之和（含写缓存）受 1.5 倍估算上限约束", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.tool("Read", { path: "/b" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 900_000, cachedReadTokens: 100_000, cachedWriteTokens: 5_000_000, outputTokens: 10 } }
    })
    const body = await padBodyToTokens(kit, baseBody(), 20_000)
    const { responses, estimates } = await runTurn(kit, body)
    const final = responses.at(-1)
    assertCleanUsage(final.usage, "收尾响应")
    const cap = Math.round(estimates.at(-1) * 1.5)
    assert.ok(usageTotal(final.usage) <= cap, `含写缓存的窗口 ${usageTotal(final.usage)} 超过上限 ${cap}`)
    assert.ok(final.usage.cache_creation_input_tokens > 0, "写缓存被整体丢弃，没有计入窗口")
    assert.ok(final.usage.cache_creation_input_tokens <= cap)
  })
})

// --------------------------------------------------------------- 输出口径与合并

test("输出估算覆盖 text、thinking 与 tool_use JSON", async () => {
  await withKit({}, async (kit) => {
    const longText = "Reasoned answer sentence. ".repeat(40)
    const longThought = "Thinking about which file to read next. ".repeat(40)
    const hugePath = `/repo/${"deep/".repeat(800)}file.ts`
    kit.prompts.push(async (agent) => {
      await agent.thought(longThought)
      await agent.text(longText)
      await agent.tool("Read", { path: "/small" })
      await agent.tool("Read", { path: hugePath })
      await agent.tool("Read", { path: "/small2" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 3000, outputTokens: 20 } }
    })
    const { responses } = await runTurn(kit, baseBody())
    const [withProse, withHugeArgs, bare] = responses
    for (const parsed of responses) assertCleanUsage(parsed.usage, "响应")
    assert.ok(withProse.content.some((block) => block.type === "thinking"))
    assert.ok(withProse.usage.output_tokens_details?.thinking_tokens > 0, "转发的 thinking 没计入输出")
    assert.ok(withProse.usage.output_tokens > bare.usage.output_tokens + 400, "text/thinking 没计入输出估算")
    assert.ok(withHugeArgs.usage.output_tokens > bare.usage.output_tokens + 800, "tool_use JSON 没计入输出估算")
    assert.ok(!(bare.usage.output_tokens_details?.thinking_tokens > 0))
  })
})

test("并行工具调用合并为一次响应，只结算一次", async () => {
  await withKit({}, async (kit) => {
    let replies = null
    kit.prompts.push(async (agent) => {
      replies = await agent.tools([["Read", { path: "/x" }], ["Read", { path: "/y" }], ["Read", { path: "/z" }]])
      await agent.text("merged")
      return { stopReason: "end_turn", usage: { inputTokens: 5000, cachedReadTokens: 1000, outputTokens: 40 } }
    })
    const { responses } = await runTurn(kit, baseBody(), { resultFor: (block) => `content of ${block.input.path}` })
    assert.equal(responses.length, 2)
    const [merged] = responses
    assert.deepEqual(merged.content.filter((block) => block.type === "tool_use").map((block) => block.input.path), ["/x", "/y", "/z"])
    assert.equal(merged.events.filter((item) => item.event === "message_delta").length, 1)
    assert.deepEqual(replies.map((reply) => reply.result.content?.[0]?.text ?? JSON.stringify(reply.result)),
      ["content of /x", "content of /y", "content of /z"])
    const [turn] = kit.turns
    assert.equal(turn.responseSteps.length, 2)
    assert.equal(turn.emittedOutputTokens, merged.usage.output_tokens + responses[1].usage.output_tokens)
  })
})

test("跨事件循环的 13 个并行 MCP 调用合并：旧版 14 次 HTTP，新版 2 次", async () => {
  const observe = async (legacy, stream) => withKit({
    ...(legacy ? { indexTransform: (source) => {
      const pattern = /            const emittedIds = new Set\(\[event.call.id\]\)[\s\S]*?(?=            stopMessage\("tool_use")/
      assert.match(source, pattern, "旧版对照必须只恢复原来的即时队列排空逻辑")
      return source.replace(pattern, '            while (turn.events[0]?.type === "tool") emitToolUse(turn.events.shift().call)\n')
    } } : {}),
  }, async (kit) => {
    let replies
    kit.prompts.push(async (agent) => {
      replies = await agent.toolsAcrossTicks(Array.from({ length: 13 }, (_, i) => ["Read", { path: `/parallel-${i}` }]))
      await agent.text("all thirteen finished")
      return { stopReason: "end_turn", usage: { inputTokens: 900_000, cachedReadTokens: 600_000, outputTokens: 90 } }
    })
    const { responses, estimates } = await runTurn(kit, baseBody(), { stream })
    assert.equal(replies.length, 13)
    for (const [i, response] of responses.entries()) {
      assertCleanUsage(response.usage, `batch step ${i}`)
      assert.ok(usageTotal(response.usage) <= Math.round(estimates[i] * 1.5), "累计用量不能作为本次窗口")
    }
    return { requests: responses.length, tools: responses.map((response) => response.content.filter((b) => b.type === "tool_use").length) }
  })
  const before = await observe(true, true)
  assert.equal(before.requests, 14)
  assert.deepEqual(before.tools.slice(0, 13), Array(13).fill(1))
  for (const stream of [true, false]) {
    const after = await observe(false, stream)
    assert.equal(after.requests, 2)
    assert.deepEqual(after.tools, [13, 0])
    console.log(`# cross-tick stream=${stream}: HTTP ${before.requests} -> ${after.requests}; tool_use ${before.tools.slice(0, 13).join('+')} -> 13`)
  }
})

test("晚到工具超过微批上限后单独响应，同参数的独立调用不去重", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      const first = agent.tool("Read", { path: "/same" })
      await sleep(70)
      const second = agent.tool("Read", { path: "/same" })
      await Promise.all([first, second])
      return { stopReason: "end_turn", usage: { inputTokens: 5000, outputTokens: 10 } }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 3)
    const calls = responses.flatMap((r) => r.content.filter((b) => b.type === "tool_use"))
    assert.equal(calls.length, 2)
    assert.notEqual(calls[0].id, calls[1].id)
    assert.equal(kit.turns[0].waiters.length, 0)
  })
})

test("文本插入立即截断微批并保留文本及后续工具的顺序", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      const first = agent.tool("Read", { path: "/first" })
      await agent.text("between calls")
      const second = agent.tool("Read", { path: "/second" })
      await Promise.all([first, second])
      return { stopReason: "end_turn", usage: { inputTokens: 4000, outputTokens: 10 } }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 3)
    assert.deepEqual(responses[0].content.map((b) => b.type), ["tool_use"])
    assert.deepEqual(responses[1].content.map((b) => b.type), ["text", "tool_use"])
    assert.equal(responses[1].content[0].text, "between calls")
  })
})

test("微批等待可取消，不遗留等待者或计时器", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/cancel-batch" })
      return { stopReason: "end_turn" }
    })
    const controller = new AbortController()
    const response = await kit.request(baseBody(), { signal: controller.signal })
    const reader = response.body.getReader()
    let text = ""
    while (!text.includes('"type":"tool_use"')) {
      const part = await reader.read()
      assert.equal(part.done, false)
      text += new TextDecoder().decode(part.value)
    }
    const turn = kit.turns[0]
    controller.abort()
    await assert.rejects(reader.read())
    assert.equal(turn.waiters.length, 0)
    assert.equal(turn.responseSteps[0].settled, false)
  })
})

test("turn 完成事件截断微批，收尾事件仍由下一响应消费", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      // ACP can end a prompt before a client returns its outstanding result.
      agent.tool("Read", { path: "/last" })
      return { stopReason: "end_turn", usage: { inputTokens: 8000, outputTokens: 10 } }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 2)
    assert.equal(responses[0].stopReason, "tool_use")
    assert.equal(responses[1].stopReason, "end_turn")
    assert.equal(kit.turns[0].waiters.length, 0)
    assert.equal(kit.turns[0].finalized, true)
  })
})

test("同一工具事件重复送达只发一个 tool_use，MCP 仍接收一次结果", async () => {
  await withKit({}, async (kit) => {
    const prototype = kit.module.__agyTestTurn.prototype
    const push = prototype.push
    prototype.push = function (event) {
      push.call(this, event)
      if (event.type === "tool") push.call(this, event)
    }
    try {
      let reply
      kit.prompts.push(async (agent) => {
        reply = await agent.tool("Read", { path: "/duplicate-event" })
        return { stopReason: "end_turn", usage: { inputTokens: 8000, outputTokens: 10 } }
      })
      const { responses } = await runTurn(kit, baseBody())
      assert.equal(responses.length, 2)
      assert.equal(responses[0].content.filter((block) => block.type === "tool_use").length, 1)
      assert.ok(reply.result)
      assert.equal(kit.turns[0].calls.length, 1)
    } finally {
      prototype.push = push
    }
  })
})

// --------------------------------------------------------------------- late 续发

test("late 工具结果触发同一响应内第二次 prompt：两次 ACP usage 各计一次，窗口有界", async () => {
  await withKit({ env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "40" } }, async (kit) => {
    const u1 = { inputTokens: 50_000, cachedReadTokens: 10_000, cachedWriteTokens: 300, outputTokens: 100 }
    const u2 = { inputTokens: 60_000, cachedReadTokens: 30_000, cachedWriteTokens: 200, outputTokens: 50, thoughtTokens: 7 }
    let firstPromptDone = false
    let deferredReply = null
    let latePromptText = ""
    kit.prompts.push(async (agent) => {
      deferredReply = await agent.tool("Read", { path: "/slow" })
      firstPromptDone = true
      return { stopReason: "end_turn", usage: u1 }
    })
    kit.prompts.push(async (agent) => {
      latePromptText = JSON.stringify(agent.prompt)
      await agent.text("final answer after the late result")
      return { stopReason: "end_turn", usage: u2 }
    })
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    for (let i = 0; i < 200 && !firstPromptDone; i++) await sleep(5)
    assert.ok(firstPromptDone, "工具调用没有被延期，late 路径未触发")
    assert.match(JSON.stringify(deferredReply), /still running|running/i)
    await sleep(20)
    const next = continueWithToolResults(body, first, () => "LATE-RESULT-PAYLOAD")
    const final = await readSse(await kit.request(next))
    assert.equal(final.stopReason, "end_turn")
    assert.match(latePromptText, /LATE-RESULT-PAYLOAD/)
    const sessionPrompts = kit.acpLog.filter((item) => item.method === "session/prompt")
    assert.equal(sessionPrompts.length, 2)
    assert.equal(new Set(sessionPrompts.map((item) => item.params.sessionId)).size, 1)

    const [turn] = kit.turns
    assert.equal(turn.promptCount, 2)
    assert.equal(turn.rawAcpUsages.length, 2)
    assert.deepEqual(plain(turn.rawUsage), {
      inputTokens: 110_000, cachedReadTokens: 40_000, cachedWriteTokens: 500, outputTokens: 150, thoughtTokens: 7,
    })
    for (const parsed of [first, final]) assertCleanUsage(parsed.usage, "late 回合响应")
    assert.ok(usageTotal(first.usage) > 0)
    const step = turn.responseSteps.at(-1)
    const estimate = turn.stepInputEstimates[step.estimateIndex]
    assert.ok(usageTotal(final.usage) <= Math.round(estimate * 1.5), `late 收尾 ${usageTotal(final.usage)} 超过 1.5 倍估算 ${estimate}`)
    assert.ok(usageTotal(final.usage) < 110_000, "late 收尾吐了两次 prompt 的累计")
  })
})

// --------------------------------------------------------------- 异常与缺失字段

test("缺失、非数值、无穷、负数 usage 字段被清理成非负有限整数", async () => {
  const garbage = [
    undefined,
    null,
    { inputTokens: "abc", cachedReadTokens: -5, cachedWriteTokens: "Infinity", outputTokens: "NaN", thoughtTokens: -1 },
    { inputTokens: -100, cachedReadTokens: 999, cachedWriteTokens: null, outputTokens: {}, thoughtTokens: [] },
    { inputTokens: "1e400", cachedReadTokens: "-Infinity", outputTokens: 12.7 },
  ]
  for (const usage of garbage) {
    for (const multiStep of [false, true]) {
      await withKit({}, async (kit) => {
        kit.prompts.push(async (agent) => {
          if (multiStep) await agent.tool("Read", { path: "/f" })
          await agent.text("answer")
          return usage === undefined ? { stopReason: "end_turn" } : { stopReason: "end_turn", usage }
        })
        const { responses } = await runTurn(kit, baseBody())
        assert.equal(responses.length, multiStep ? 2 : 1)
        for (const parsed of responses) assertCleanUsage(parsed.usage, `usage=${JSON.stringify(usage)} multi=${multiStep}`)
        if (multiStep) assert.ok(usageTotal(responses[0].usage) > 0, "工具步读数为 0")
      })
    }
  }
})

// ------------------------------------------------------------------ 取消与重试

test("取消后重试：被取消回合的 usage 不并入重试响应", async () => {
  await withKit({}, async (kit) => {
    const cancelled = { inputTokens: 777_777, cachedReadTokens: 0, outputTokens: 3 }
    const retry = { inputTokens: 1200, cachedReadTokens: 200, outputTokens: 7 }
    kit.prompts.push(async (agent) => {
      await agent.text("partial answer")
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: cancelled }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("complete answer")
      return { stopReason: "end_turn", usage: retry }
    })
    const body = baseBody({ tools: [] })
    const controller = new AbortController()
    const response = await kit.request(body, { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("text_delta")) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    controller.abort()
    await reader.read().then(() => {}, () => {})
    for (let i = 0; i < 200 && !kit.turns[0]?.finalized; i++) await sleep(5)
    assert.ok(kit.acpLog.some((item) => item.method === "session/cancel"), "取消没有通知 agy")
    assert.ok(kit.turns[0].finalized)

    const { responses } = await runTurn(kit, body)
    assert.deepEqual(plain(responses[0].usage), {
      input_tokens: 1000, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 0,
    })
    assert.equal(kit.turns.length, 2)
    assert.deepEqual(plain(kit.turns[0].rawUsage), cancelled)
    assert.deepEqual(plain(kit.turns[1].rawUsage), retry)
    assert.equal(kit.turns[1].rawAcpUsages.length, 1)
  })
})

test("同一 HTTP 步骤不会被重复结算", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/once" })
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 4000, outputTokens: 9 } }
    })
    const { responses } = await runTurn(kit, baseBody())
    const [turn] = kit.turns
    const emitted = responses.reduce((sum, parsed) => sum + parsed.usage.output_tokens, 0)
    assert.equal(turn.emittedOutputTokens, emitted)
    const step = turn.responseSteps[0]
    const before = plain(step.usage)
    turn.recordResponseUsage(step, { input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9, output_tokens: 999 }, false)
    assert.deepEqual(plain(step.usage), before)
    assert.equal(turn.emittedOutputTokens, emitted)
  })
})

// --------------------------------------------------------------- 校准与 Proc 隔离

test("单步校准系数与缓存占比只在同一 Proc 内沿用，不同 Proc 互不影响", async () => {
  await withKit({}, async (kit) => {
    const base = await padBodyToTokens(kit, baseBody({ messages: [{ role: "user", content: "conversation A" }] }), 4000)
    const estimateA1 = await kit.countTokens(base)
    const calibrated = Math.round(estimateA1 * 1.2)
    const cachedA = Math.round(calibrated * 0.25)
    kit.prompts.push(async (agent) => {
      await agent.text("A first answer")
      return { stopReason: "end_turn", usage: { inputTokens: calibrated, cachedReadTokens: cachedA, outputTokens: 5 } }
    })
    const first = await runTurn(kit, base)
    assert.equal(usageTotal(first.responses[0].usage), calibrated)

    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.text("A second answer")
      return { stopReason: "end_turn", usage: { inputTokens: 9000, outputTokens: 5 } }
    })
    const followUp = {
      ...base,
      messages: [...base.messages, { role: "assistant", content: plain(first.responses[0].content) }, { role: "user", content: "next question" }],
    }
    const second = await runTurn(kit, followUp)
    assert.equal(kit.acpSpawns.length, 1, "同一会话没有复用 Proc，校准沿用无从验证")
    const toolStep = second.responses[0].usage
    const expectedTotal = second.estimates[0] * 1.2
    assert.ok(Math.abs(usageTotal(toolStep) - expectedTotal) <= 2, `同 Proc 工具步 ${usageTotal(toolStep)}，期望约 ${expectedTotal}`)
    assert.ok(Math.abs(toolStep.cache_read_input_tokens - usageTotal(toolStep) * 0.25) <= 2, "缓存占比没有沿用")

    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/b" })
      await agent.text("B answer")
      return { stopReason: "end_turn", usage: { inputTokens: 9000, outputTokens: 5 } }
    })
    const other = await padBodyToTokens(kit, baseBody({ messages: [{ role: "user", content: "conversation B" }] }), 4000)
    const third = await runTurn(kit, other)
    assert.equal(kit.acpSpawns.length, 2, "不同会话应使用不同 Proc")
    const isolated = third.responses[0].usage
    assert.ok(Math.abs(usageTotal(isolated) - third.estimates[0]) <= 1, `跨 Proc 工具步 ${usageTotal(isolated)} 带上了别的会话的系数`)
    assert.equal(isolated.cache_read_input_tokens, 0)
  })
})

test("校准系数被夹在 [0.5, 1.5]", async () => {
  for (const [factor, clamped] of [[3, 1.5], [0.1, 0.5]]) {
    await withKit({}, async (kit) => {
      const base = await padBodyToTokens(kit, baseBody({ messages: [{ role: "user", content: `clamp ${factor}` }] }), 4000)
      kit.prompts.push(async (agent) => {
        await agent.text("first")
        return { stopReason: "end_turn", usage: { inputTokens: Math.round(4000 * factor), outputTokens: 1 } }
      })
      const first = await runTurn(kit, base)
      kit.prompts.push(async (agent) => {
        await agent.tool("Read", { path: "/c" })
        await agent.text("second")
        return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 1 } }
      })
      const followUp = {
        ...base,
        messages: [...base.messages, { role: "assistant", content: plain(first.responses[0].content) }, { role: "user", content: "again" }],
      }
      const second = await runTurn(kit, followUp)
      const total = usageTotal(second.responses[0].usage)
      assert.ok(Math.abs(total - second.estimates[0] * clamped) <= 2, `系数 ${factor} 应夹到 ${clamped}，实际 ${total / second.estimates[0]}`)
    })
  }
})

// ------------------------------------------------------------ SSE 与 JSON 一致性

test("SSE 与 stream:false 经同一流生成/消费路径得到相同内容与 usage", async () => {
  const scenario = (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.thought("plan the read")
      await agent.text("Reading the file now.")
      await agent.tools([["Read", { path: "/p1" }], ["Read", { path: "/p2" }]])
      await agent.thought("summarize")
      await agent.text("Both files read.")
      return { stopReason: "end_turn", usage: { inputTokens: 40_000, cachedReadTokens: 30_000, cachedWriteTokens: 1000, outputTokens: 300, thoughtTokens: 20 } }
    })
  }
  const normalize = (responses) => responses.map((parsed) => {
    const ids = new Map()
    return {
      stopReason: parsed.stopReason,
      model: parsed.model,
      usage: plain(parsed.usage),
      content: parsed.content.map((block) => {
        if (block.type === "tool_use") {
          if (!ids.has(block.id)) ids.set(block.id, `tool-${ids.size}`)
          return { type: "tool_use", id: ids.get(block.id), name: block.name, input: plain(block.input) }
        }
        if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, signed: /^agyb1\./.test(block.signature) }
        return { type: block.type, text: block.text }
      }),
    }
  })
  const results = []
  for (const stream of [true, false]) {
    await withKit({}, async (kit) => {
      scenario(kit)
      const { responses } = await runTurn(kit, baseBody(), { stream })
      for (const parsed of responses) assertCleanUsage(parsed.usage, `stream=${stream}`)
      results.push(normalize(responses))
    })
  }
  assert.equal(results[0].length, 2)
  assert.deepEqual(results[1], results[0])
})
