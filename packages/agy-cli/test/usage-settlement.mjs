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
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
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


function editTool() {
  return [{
    name: "Edit",
    description: "edit a file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
    },
  }]
}

function followUpAfter(first, userText, { fillDefaults = false, rewriteIds = false } = {}) {
  const completed = first.bodies.at(-1)
  const followMessages = [
    ...JSON.parse(JSON.stringify(completed.messages)),
    { role: "assistant", content: plain(first.responses.at(-1).content) },
    { role: "user", content: userText },
  ]
  const idMap = new Map()
  let mutated = 0
  for (const message of followMessages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === "tool_use" && block.input) {
        if (fillDefaults && block.input.replace_all === undefined) {
          block.input = { ...block.input, replace_all: false }
          mutated++
        }
        if (rewriteIds && block.id) {
          const next = `${block.id}_rewritten`
          idMap.set(block.id, next)
          block.id = next
          mutated++
        }
      }
    }
  }
  if (rewriteIds) {
    for (const message of followMessages) {
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block?.type === "tool_result" && idMap.has(block.tool_use_id)) {
          block.tool_use_id = idMap.get(block.tool_use_id)
        }
      }
    }
  }
  return { followMessages, mutated }
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
      input_tokens: 600, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50,
      output_tokens_details: { thinking_tokens: 5 },
    })
    const start = responses[0].events.find((item) => item.event === "message_start")
    assert.deepEqual(plain(start.data.message.usage), { input_tokens: 0, output_tokens: 0 })
    const [turn] = kit.turns
    assert.deepEqual(plain(turn.rawUsage), raw)
    assert.equal(turn.rawAcpUsages.length, 1)
  })
})

test("ACP outputTokens 已含 thoughtTokens：单步不把思考记两次（flash 实测形状）", async () => {
  await withKit({}, async (kit) => {
    // Shape seen live: one visible token, 139 thinking. candidatesTokenCount
    // = thoughtsTokenCount + 1 for a 1-byte visible reply.
    const raw = { inputTokens: 12007, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 140, thoughtTokens: 139 }
    kit.prompts.push(async (agent) => {
      await agent.thought("long hidden reasoning")
      await agent.text("4")
      return { stopReason: "end_turn", usage: raw }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 1)
    assert.equal(responses[0].usage.output_tokens, 140)
    assert.equal(responses[0].usage.output_tokens_details.thinking_tokens, 139)
  })
})

test("小读缓存 + 重思考：totalTokens 形状判断不把思考加在两边（12007/100/140/139）", async () => {
  // Exclusive input, inclusive output: totalTokens = input + cache read + output.
  // With thinking added to both sides of the shape check, a cache read below
  // 2x thinking picked the cache-inclusive branch and billed input 11907.
  for (const cachedReadTokens of [100, 3000]) {
    await withKit({}, async (kit) => {
      const raw = {
        inputTokens: 12_007, cachedReadTokens, cachedWriteTokens: 0,
        outputTokens: 140, thoughtTokens: 139, totalTokens: 12_007 + cachedReadTokens + 140,
      }
      kit.prompts.push(async (agent) => {
        await agent.thought("long hidden reasoning")
        await agent.text("4")
        return { stopReason: "end_turn", usage: raw }
      })
      const { responses } = await runTurn(kit, baseBody({ tools: [] }))
      assert.equal(responses.length, 1)
      const usage = plain(responses[0].usage)
      assert.deepEqual(usage, {
        input_tokens: 12_007,
        cache_read_input_tokens: cachedReadTokens,
        cache_creation_input_tokens: 0,
        output_tokens: 140,
        output_tokens_details: { thinking_tokens: 139 },
      }, `cachedReadTokens ${cachedReadTokens}`)
      assert.equal(usage.input_tokens + usage.cache_read_input_tokens, 12_007 + cachedReadTokens)
    })
  }
})

test("thoughtTokens 大于 outputTokens 时至少计思考数，thinking 不超过 output", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.text("x")
      return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 3, thoughtTokens: 9 } }
    })
    const { responses } = await runTurn(kit, baseBody())
    assertCleanUsage(responses[0].usage, "thinking>output")
    assert.equal(responses[0].usage.output_tokens, 9)
  })
})

test("多步工具回合：各步 output 之和不超过 ACP 累计 outputTokens（含思考）", async () => {
  await withKit({}, async (kit) => {
    const raw = { inputTokens: 40_000, cachedReadTokens: 30_000, cachedWriteTokens: 0, outputTokens: 5_000, thoughtTokens: 4_800 }
    kit.prompts.push(async (agent) => {
      await agent.thought("plan")
      await agent.text("Reading.")
      await agent.tools([["Read", { path: "/a" }]])
      await agent.thought("more")
      await agent.tools([["Read", { path: "/b" }]])
      await agent.text("Done.")
      return { stopReason: "end_turn", usage: raw }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.ok(responses.length >= 3)
    for (const parsed of responses) assertCleanUsage(parsed.usage, "multi-step")
    const total = responses.reduce((sum, parsed) => sum + parsed.usage.output_tokens, 0)
    assert.ok(total <= raw.outputTokens, `各步 output 之和 ${total} 超过 ACP 累计 ${raw.outputTokens}`)
    assert.ok(total >= raw.outputTokens - 50, `各步 output 之和 ${total} 明显少于 ACP 累计`)
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
      const pattern = /            const emittedIds = new Set\(\[event.call.id\]\)[\s\S]*?(?=            const usage = await settleUsage)/
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

test("取消的 prompt 也教会缓存占比：下一回合的工具步沿用 agy 报告的读缓存比例", async () => {
  await withKit({}, async (kit) => {
    // 形状取自 agy 的 session/prompt 结果：inputTokens 含缓存读，一次取消后无校准。
    const cancelled = { inputTokens: 520_000, cachedReadTokens: 390_000, cachedWriteTokens: 0, outputTokens: 900, thoughtTokens: 40 }
    kit.prompts.push(async (agent) => {
      await agent.text("partial answer")
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: cancelled }
    })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 9000, cachedReadTokens: 6000, outputTokens: 5 } }
    })
    const body = baseBody({ tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }] })
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
    assert.ok(kit.turns[0].finalized)

    const next = {
      ...body,
      messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "partial answer" }] }, { role: "user", content: "go on" }],
    }
    const { responses } = await runTurn(kit, next)
    assert.equal(kit.acpSpawns.length, 1, "同一会话没有复用 Proc")
    const toolStep = responses[0].usage
    assert.equal(responses[0].stopReason, "tool_use")
    const ratio = toolStep.cache_read_input_tokens / usageTotal(toolStep)
    assert.ok(Math.abs(ratio - 0.75) < 0.02, `工具步缓存占比 ${ratio}，期望沿用取消 prompt 的 0.75`)
  })
})


test("同一会话未校准 Proc 上，工具环第二步起把上一步窗口计为读缓存、新增部分计为 input（估算，非 ACP 回传）", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/one" })
      await agent.tool("Read", { path: "/two" })
      await agent.tool("Read", { path: "/three" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 8000, outputTokens: 5 } }
    })
    const body = await padBodyToTokens(kit, baseBody({ messages: [{ role: "user", content: "start tool loop" }] }), 4000)
    const { responses } = await runTurn(kit, body)
    assert.equal(responses.length, 4, "应为三次 tool_use + 一次收尾")
    const first = responses[0].usage
    const second = responses[1].usage
    const third = responses[2].usage
    assert.equal(first.cache_read_input_tokens, 0, "第一步尚无前缀缓存可沿用")
    const firstTotal = usageTotal(first)
    const secondTotal = usageTotal(second)
    const thirdTotal = usageTotal(third)
    assert.ok(firstTotal > 0 && secondTotal > 0 && thirdTotal > 0)
    assert.ok(second.cache_read_input_tokens >= firstTotal - 2,
      `第二步读缓存 ${second.cache_read_input_tokens} 应覆盖第一步窗口 ${firstTotal}`)
    assert.ok(second.input_tokens <= Math.max(1, secondTotal - firstTotal + 2),
      `第二步未缓存 input ${second.input_tokens} 不应再包含全部前缀`)
    // Step 3 reads step 2's window from the cache and bills what was added
    // since (the second tool result) as input, never its whole window.
    assert.ok(third.cache_read_input_tokens >= secondTotal - 2,
      `第三步读缓存 ${third.cache_read_input_tokens} 应至少覆盖第二步窗口 ${secondTotal}`)
    assert.ok(thirdTotal > secondTotal, "第三步窗口应比第二步大")
    assert.ok(third.input_tokens >= thirdTotal - secondTotal - 2,
      `第三步未缓存 input ${third.input_tokens} 应覆盖第二步之后新增的 ${thirdTotal - secondTotal}`)
    assert.ok(third.cache_read_input_tokens <= secondTotal + 2,
      `第三步读缓存 ${third.cache_read_input_tokens} 不应超过第二步窗口 ${secondTotal}`)
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("回合结束后，客户端补上的历史 tool_use.input 默认字段仍复用同一 Proc", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Edit", { path: "/f", old_string: "a", new_string: "b" })
      await agent.text("edited")
      return { stopReason: "end_turn", usage: { inputTokens: 4000, outputTokens: 5 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 4100, cachedReadTokens: 3000, outputTokens: 3 } }
    })
    const body = baseBody({ messages: [{ role: "user", content: "please edit" }], tools: editTool() })
    const first = await runTurn(kit, body)
    assert.equal(first.responses[0].stopReason, "tool_use")
    assert.equal(first.responses.at(-1).stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)

    // Mid-turn tool_result kept the model-issued input. Only the next user
    // turn fills a default, which is how some clients persist history.
    const { followMessages, mutated } = followUpAfter(first, "thanks, continue", { fillDefaults: true })
    assert.ok(mutated >= 1, "没有改到历史 tool_use.input")
    const second = await runTurn(kit, { ...body, messages: followMessages })
    assert.equal(kit.acpSpawns.length, 1, "补默认字段后应复用会话，而不是 retire 后新开进程")
    assert.equal(second.responses[0].stopReason, "end_turn")
  })
})

test("回合结束后改写历史 tool_use id 时不得因忽略 input 而复用会话", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Edit", { path: "/f", old_string: "a", new_string: "b" })
      await agent.text("edited")
      return { stopReason: "end_turn", usage: { inputTokens: 4000, outputTokens: 5 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 4100, outputTokens: 3 } }
    })
    const body = baseBody({ messages: [{ role: "user", content: "please edit" }], tools: editTool() })
    const first = await runTurn(kit, body)
    assert.equal(kit.acpSpawns.length, 1)
    const { followMessages, mutated } = followUpAfter(first, "thanks, continue", { fillDefaults: true, rewriteIds: true })
    assert.ok(mutated >= 2, "没有同时改到 input 与 id")
    const second = await runTurn(kit, { ...body, messages: followMessages })
    assert.equal(kit.acpSpawns.length, 2, "改写 tool_use id 后应新开进程，不能只靠去 input 的 historyKey 复用")
    assert.equal(second.responses[0].stopReason, "end_turn")
  })
})

test("上一 prompt 已把缓存比例校准为 0 时，下一回合工具步不再把前缀估成读缓存", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.text("no cache this turn")
      return { stopReason: "end_turn", usage: { inputTokens: 5000, cachedReadTokens: 0, outputTokens: 5 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.tool("Read", { path: "/b" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 8000, cachedReadTokens: 0, outputTokens: 5 } }
    })
    const tools = [{ name: "Read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }]
    const firstBody = await padBodyToTokens(kit, baseBody({ messages: [{ role: "user", content: "first prompt" }], tools }), 4000)
    const first = await runTurn(kit, firstBody)
    assert.equal(first.responses.length, 1)
    assert.equal(first.responses[0].usage.cache_read_input_tokens, 0)
    const next = {
      ...firstBody,
      messages: [
        ...firstBody.messages,
        { role: "assistant", content: plain(first.responses[0].content) },
        { role: "user", content: "now use tools" },
      ],
    }
    const { responses } = await runTurn(kit, next)
    assert.equal(kit.acpSpawns.length, 1, "同一会话应复用 Proc")
    assert.equal(responses[0].stopReason, "tool_use")
    assert.equal(responses[1].stopReason, "tool_use")
    // c27ba5f already taught lastCacheRatio = 0 from the first prompt.
    // The in-turn prefix estimate must not override that calibrated miss.
    assert.equal(responses[0].usage.cache_read_input_tokens, 0)
    assert.equal(responses[1].usage.cache_read_input_tokens, 0,
      "已校准为零后，第二步也不应再把已结算前缀估成读缓存")
  })
})

test("LRU 淘汰后，补默认字段的 follow-up 仍能 resume 原 session", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" }, sessionResume: true }, async (kit) => {
    let sessionA
    kit.prompts.push(async (agent) => {
      sessionA = agent.sessionId
      await agent.tool("Edit", { path: "/f", old_string: "a", new_string: "b" })
      await agent.text("edited")
      return { stopReason: "end_turn", usage: { inputTokens: 4000, outputTokens: 5 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("filler")
      return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 1 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("resumed")
      return { stopReason: "end_turn", usage: { inputTokens: 4100, cachedReadTokens: 3000, outputTokens: 3 } }
    })
    const bodyA = baseBody({ messages: [{ role: "user", content: "please edit conversation A" }], tools: editTool() })
    const first = await runTurn(kit, bodyA)
    assert.ok(sessionA, "未记下会话 A 的 sessionId")
    assert.equal(kit.acpSpawns.length, 1)

    const bodyB = baseBody({ messages: [{ role: "user", content: "unrelated filler conversation B" }] })
    const filler = await runTurn(kit, bodyB)
    assert.equal(filler.responses[0].stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "第二会话应挤掉会话 A")

    const { followMessages, mutated } = followUpAfter(first, "thanks, continue", { fillDefaults: true })
    assert.ok(mutated >= 1)
    const second = await runTurn(kit, { ...bodyA, messages: followMessages })
    assert.equal(second.responses[0].stopReason, "end_turn")
    const resumes = kit.acpLog.filter((item) => item.method === "session/resume")
    assert.equal(resumes.length, 1, "补默认字段后应 session/resume，而不是新开 session")
    assert.equal(resumes[0].params.sessionId, sessionA)
    const news = kit.acpLog.filter((item) => item.method === "session/new")
    assert.equal(news.length, 2, "只有 A 的首回合与 filler B 应 session/new")
  })
})

test("取消 prompt 把缓存比例校准为 0 后，下一回合工具步也不再把前缀估成读缓存", async () => {
  await withKit({}, async (kit) => {
    const cancelled = { inputTokens: 5000, cachedReadTokens: 0, outputTokens: 3 }
    kit.prompts.push(async (agent) => {
      await agent.text("partial")
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: cancelled }
    })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.tool("Read", { path: "/b" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 8000, cachedReadTokens: 0, outputTokens: 5 } }
    })
    const tools = [{ name: "Read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }]
    const body = await padBodyToTokens(kit, baseBody({ messages: [{ role: "user", content: "first prompt" }], tools }), 4000)
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
    assert.ok(kit.turns[0].finalized)

    const next = {
      ...body,
      messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "partial" }] }, { role: "user", content: "now use tools" }],
    }
    const { responses } = await runTurn(kit, next)
    assert.equal(kit.acpSpawns.length, 1, "同一会话应复用 Proc")
    assert.equal(responses[0].stopReason, "tool_use")
    assert.equal(responses[1].stopReason, "tool_use")
    assert.equal(responses[0].usage.cache_read_input_tokens, 0)
    assert.equal(responses[1].usage.cache_read_input_tokens, 0,
      "取消 prompt 已校准为零后，第二步也不应再把已结算前缀估成读缓存")
  })
})

test("LRU 淘汰后，改写历史 tool_use id 的 follow-up 不得 session/resume", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" }, sessionResume: true }, async (kit) => {
    let sessionA
    kit.prompts.push(async (agent) => {
      sessionA = agent.sessionId
      await agent.tool("Edit", { path: "/f", old_string: "a", new_string: "b" })
      await agent.text("edited")
      return { stopReason: "end_turn", usage: { inputTokens: 4000, outputTokens: 5 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("filler")
      return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 1 } }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("fresh")
      return { stopReason: "end_turn", usage: { inputTokens: 4100, outputTokens: 3 } }
    })
    const bodyA = baseBody({ messages: [{ role: "user", content: "please edit conversation A" }], tools: editTool() })
    const first = await runTurn(kit, bodyA)
    assert.ok(sessionA)
    const bodyB = baseBody({ messages: [{ role: "user", content: "unrelated filler conversation B" }] })
    await runTurn(kit, bodyB)
    assert.equal(kit.acpSpawns.length, 2)

    const { followMessages, mutated } = followUpAfter(first, "thanks, continue", { fillDefaults: true, rewriteIds: true })
    assert.ok(mutated >= 2)
    const second = await runTurn(kit, { ...bodyA, messages: followMessages })
    assert.equal(second.responses[0].stopReason, "end_turn")
    const resumes = kit.acpLog.filter((item) => item.method === "session/resume")
    assert.equal(resumes.length, 0, "改写 tool_use id 后不应 resume 已淘汰会话")
    const news = kit.acpLog.filter((item) => item.method === "session/new")
    assert.equal(news.length, 3, "应新开 session，而不是 resume 会话 A")
  })
})

// ------------------------------------------------ agy 1.5.1+ 独立字段与 SQLite 步级真实计费

test("agy 1.5.1+ 独立 inputTokens（未含读缓存）按 totalTokens 完整保留 cachedReadTokens 并校准真实缓存占比", async () => {
  await withKit({}, async (kit) => {
    const cancelled = {
      inputTokens: 2133,
      cachedReadTokens: 6399,
      cachedWriteTokens: 0,
      outputTokens: 30,
      thoughtTokens: 10,
      totalTokens: 2133 + 6399 + 30 + 10,
    }
    kit.prompts.push(async (agent) => {
      await agent.text("partial answer")
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: cancelled }
    })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/after-cancel" })
      await agent.text("done")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 2133,
          cachedReadTokens: 28_610,
          cachedWriteTokens: 120,
          outputTokens: 45,
          thoughtTokens: 15,
          totalTokens: 2133 + 28_610 + 120 + 45 + 15,
        },
      }
    })
    const body = baseBody()
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

    // 取消的 agy 1.5.1+ prompt 应教会 6399 / (2133 + 6399) = 0.75，而不是把 6399 / 2133 截断成 1.0
    const next = {
      ...body,
      messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "partial answer" }] }, { role: "user", content: "continue" }],
    }
    const second = await runTurn(kit, next)
    const toolRatio = second.responses[0].usage.cache_read_input_tokens / usageTotal(second.responses[0].usage)
    assert.ok(Math.abs(toolRatio - 0.75) < 0.03, `agy 1.5.1+ 取消后工具步缓存率 ${toolRatio}，期望约 0.75（不应误算为 1.0）`)
  })

  await withKit({}, async (kit) => {
    const raw = {
      inputTokens: 2133,
      cachedReadTokens: 28_610,
      cachedWriteTokens: 120,
      // outputTokens already includes thoughtTokens, same as a live ACP report.
      outputTokens: 60,
      thoughtTokens: 15,
      totalTokens: 2133 + 28_610 + 120 + 60,
    }
    kit.prompts.push(async (agent) => {
      await agent.text("answer with high cache hit")
      return { stopReason: "end_turn", usage: raw }
    })
    const { responses } = await runTurn(kit, baseBody({ tools: [] }))
    assert.deepEqual(plain(responses[0].usage), {
      input_tokens: 2133,
      cache_read_input_tokens: 28_610,
      cache_creation_input_tokens: 120,
      output_tokens: 60,
      output_tokens_details: { thinking_tokens: 15 },
    })
  })

  // Same 1.5.1+ shape with a cache read well below 2x thinking, so the shape
  // check cannot lean on a large cache read to pick the right branch.
  await withKit({}, async (kit) => {
    const raw = {
      inputTokens: 2133,
      cachedReadTokens: 300,
      cachedWriteTokens: 0,
      outputTokens: 2060,
      thoughtTokens: 2000,
      totalTokens: 2133 + 300 + 2060,
    }
    kit.prompts.push(async (agent) => {
      await agent.thought("heavy reasoning")
      await agent.text("answer with small cache hit")
      return { stopReason: "end_turn", usage: raw }
    })
    const { responses } = await runTurn(kit, baseBody({ tools: [] }))
    assert.deepEqual(plain(responses[0].usage), {
      input_tokens: 2133,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 0,
      output_tokens: 2060,
      output_tokens_details: { thinking_tokens: 2000 },
    })
  })
})

const localRequire = createRequire(import.meta.url)
let openSqlite = null
try {
  const { Database } = localRequire("bun:sqlite")
  openSqlite = (file) => {
    const db = new Database(file)
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, ...args) => {
        const stmt = db.prepare(sql)
        try {
          return stmt.run(...args)
        } finally {
          stmt.finalize()
        }
      },
      close: () => db.close(),
    }
  }
} catch {
  try {
    const { DatabaseSync } = localRequire("node:sqlite")
    openSqlite = (file) => {
      const db = new DatabaseSync(file)
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...args) => db.prepare(sql).run(...args),
        close: () => db.close(),
      }
    }
  } catch {}
}

test("SQLite gen_metadata 步级落盘：tool_use 中间步直接读取真实缓存命中并即时校准缓存率", { skip: !openSqlite }, async () => {
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
  const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
  const genBlob = ({ input, output, write = 0, read = 0, thinking = 0 }) => new Uint8Array(field(1, field(4, [
    0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []),
    ...(read ? [0x28, ...varint(read)] : []),
    ...(thinking ? [0x48, ...varint(thinking)] : []),
  ])))

  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const db = openSqlite(dbFile)
      try {
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        db.run("INSERT INTO gen_metadata VALUES (1, ?)", genBlob({ input: 1800, read: 18_200, write: 0, output: 32, thinking: 8 }))
      } finally {
        db.close()
      }
      await agent.tool("Read", { path: "/step1.ts" })
      const db2 = openSqlite(dbFile)
      try {
        db2.run("INSERT INTO gen_metadata VALUES (2, ?)", genBlob({ input: 2100, read: 19_900, write: 0, output: 50, thinking: 10 }))
      } finally {
        db2.close()
      }
      await agent.text("done reading")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 3900,
          cachedReadTokens: 38_100,
          cachedWriteTokens: 0,
          outputTokens: 82,
          thoughtTokens: 18,
          totalTokens: 3900 + 38_100 + 82,
        },
      }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 2)
    assert.deepEqual(plain(responses[0].usage), {
      input_tokens: 1800,
      cache_read_input_tokens: 18_200,
      cache_creation_input_tokens: 0,
      output_tokens: 32,
      output_tokens_details: { thinking_tokens: 8 },
    })
    assert.deepEqual(plain(responses[1].usage), {
      input_tokens: 2100,
      cache_read_input_tokens: 19_900,
      cache_creation_input_tokens: 0,
      output_tokens: 50,
      output_tokens_details: { thinking_tokens: 10 },
    })
  })
})

test("单次生成串行派发多工具 + WAL 关库：续接工具不虚增账单、不清空游标，后续步完整读取真实高命中率", { skip: !openSqlite }, async () => {
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
  const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
  const genBlob = ({ input, output, write = 0, read = 0, thinking = 0 }) => new Uint8Array(field(1, field(4, [
    0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []),
    ...(read ? [0x28, ...varint(read)] : []),
    ...(thinking ? [0x48, ...varint(thinking)] : []),
  ])))

  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let secondToolElapsedMs = 0
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const writeGen = (idx, stats) => {
        const db = openSqlite(dbFile)
        try {
          db.run("PRAGMA journal_mode = WAL")
          db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
          db.run("INSERT INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
        } finally {
          db.close()
        }
      }
      // Generation 0 一次生成 3 个工具，但 agy 串行逐个调用 MCP tools/call
      writeGen(0, { input: 31_609, read: 22_528, output: 1255, thinking: 850 })
      await agent.tool("Read", { path: "/a.ts" })
      const t0 = performance.now()
      await agent.tool("Read", { path: "/b.ts" })
      secondToolElapsedMs = performance.now() - t0
      await agent.tool("Read", { path: "/c.ts" })

      // Generation 1 高缓存命中
      writeGen(1, { input: 12_852, read: 54_133, output: 509, thinking: 171 })
      await agent.tool("Read", { path: "/d.ts" })

      // Generation 2 收尾高缓存命中
      writeGen(2, { input: 2243, read: 66_986, output: 640, thinking: 283 })
      await agent.text("all done")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 31_609 + 12_852 + 2243,
          cachedReadTokens: 22_528 + 54_133 + 66_986,
          cachedWriteTokens: 0,
          outputTokens: 1255 + 509 + 640,
          thoughtTokens: 850 + 171 + 283,
          totalTokens: 31_609 + 12_852 + 2243 + 22_528 + 54_133 + 66_986 + 1255 + 509 + 640,
        },
      }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 5)
    assert.ok(secondToolElapsedMs < 500, `同次生成续接工具耗时 ${secondToolElapsedMs.toFixed(0)}ms，不应空转等待 1000ms`)
    assert.deepEqual(plain(responses.map((r) => r.usage)), [
      { input_tokens: 31_609, cache_read_input_tokens: 22_528, cache_creation_input_tokens: 0, output_tokens: 1255, output_tokens_details: { thinking_tokens: 850 } },
      { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      { input_tokens: 12_852, cache_read_input_tokens: 54_133, cache_creation_input_tokens: 0, output_tokens: 509, output_tokens_details: { thinking_tokens: 171 } },
      { input_tokens: 2243, cache_read_input_tokens: 66_986, cache_creation_input_tokens: 0, output_tokens: 640, output_tokens_details: { thinking_tokens: 283 } },
    ])
  })
})

test("SQLite 空表回退（.pb 冷启动）+ maxInitialPromptBytes（112KiB）历史裁剪：窗口按送达裁剪值封顶，且次轮记住空库不再空等 1s", { skip: !openSqlite }, async () => {
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    kit.prompts.push(async (agent) => {
      // 模拟 agy 冷启动偶发创建空 SQLite 表并将轨迹写入 .pb
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const db = openSqlite(dbFile)
      try {
        db.run("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
      } finally {
        db.close()
      }
      for (let i = 0; i < 6; i++) {
        await agent.tool("Read", { path: `/repo/chunk-${i}.ts` })
      }
      await agent.text("done after replay clip")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 75_000,
          cachedReadTokens: 380_000,
          cachedWriteTokens: 0,
          outputTokens: 400,
          totalTokens: 455_400,
        },
      }
    })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/repo/turn2.ts" })
      await agent.text("turn 2 done")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 12_000,
          cachedReadTokens: 88_000,
          cachedWriteTokens: 0,
          outputTokens: 40,
          totalTokens: 100_040,
        },
      }
    })

    // 构造约 1.5MB 未裁剪历史（~360k tokens），但经 maxInitialPromptBytes()（112KiB）与单块 12KiB 裁剪后送入 agy 的窗口仅 ~100k tokens
    const historyTurn = "historical context line for replay trimming verification. ".repeat(900)
    const messages = []
    for (let i = 0; i < 11; i++) {
      messages.push({ role: "user", content: `turn ${i}: ${historyTurn}` })
      messages.push({ role: "assistant", content: `ack ${i}: ${historyTurn}` })
    }
    messages.push({ role: "user", content: "continue investigating the current module" })
    const body = await padBodyToTokens(kit, baseBody({ messages }), 360_000)
    const rawEstimate = await kit.countTokens(body)
    assert.equal(rawEstimate, 360_000)

    const firstTurn = await runTurn(kit, body, {
      resultFor: (_block, index) => "tool output line ".repeat(200) + `#${index}`,
    })
    const { responses } = firstTurn
    assert.equal(responses.length, 7)
    const toolSteps = responses.slice(0, 6)

    // 第 1 步按实际送入 agy 的裁剪后窗口结算，绝不报未裁剪的 ~360k
    const firstWindow = usageTotal(toolSteps[0].usage)
    assert.ok(firstWindow < 120_000, `裁剪后首步窗口 ${firstWindow} 仍按未裁剪全量估算`)
    assert.equal(toolSteps[0].usage.cache_read_input_tokens, 0)

    // 第 2..6 步：前序已发送前缀转入 cache_read，uncached input 只计本步新增增量
    for (let i = 1; i < toolSteps.length; i++) {
      const prevWindow = usageTotal(toolSteps[i - 1].usage)
      const curr = toolSteps[i].usage
      assertCleanUsage(curr, `裁剪回退工具步 #${i + 1}`)
      assert.ok(curr.cache_read_input_tokens >= prevWindow - 1, `工具步 #${i + 1} 未命中前序前缀缓存`)
      assert.ok(curr.input_tokens < 5_000, `工具步 #${i + 1} uncached input=${curr.input_tokens} 重复计入全量窗口`)
    }

    const sumIn = toolSteps.reduce((s, r) => s + r.usage.input_tokens, 0)
    const sumRead = toolSteps.reduce((s, r) => s + r.usage.cache_read_input_tokens, 0)
    const hitRate = sumRead / (sumIn + sumRead)
    assert.ok(sumIn < 130_000, `6 步累计 uncached input=${sumIn} 远超单次裁剪窗口（旧缺陷：6 × 360k = 2.16M）`)
    assert.ok(hitRate > 0.75, `回退多步命中率 ${(hitRate * 100).toFixed(1)}% 过低`)

    // 第 2 回合复用同一 Proc：已记住该会话 SQLite 无可用行，首步 tool_use 不再白等 1000ms
    const turn2Messages = [
      ...firstTurn.bodies.at(-1).messages,
      { role: "assistant", content: plain(responses.at(-1).content) },
      { role: "user", content: "follow up on the same cold-started session" },
    ]
    const t0 = performance.now()
    const firstToolResp = await readSse(await kit.request({ ...body, messages: turn2Messages }))
    const turn2FirstStepMs = performance.now() - t0
    assert.equal(kit.acpSpawns.length, 1, "第 2 回合应复用同一 Proc")
    assert.equal(firstToolResp.stopReason, "tool_use")
    assert.ok(turn2FirstStepMs < 500, `第 2 回合首步耗时 ${turn2FirstStepMs.toFixed(0)}ms，不应再次轮询等待 1000ms`)
    const finishBody = continueWithToolResults({ ...body, messages: turn2Messages }, firstToolResp, () => "ok")
    const finalResp = await readSse(await kit.request(finishBody))
    assert.equal(finalResp.stopReason, "end_turn")
  })
})

test("跨回合隔离：上一回合被取消或超时回退后延迟落盘的 SQLite 行绝不串入下一回合", { skip: !openSqlite }, async () => {
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
  const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
  const genBlob = ({ input, output, write = 0, read = 0, thinking = 0 }) => new Uint8Array(field(1, field(4, [
    0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []),
    ...(read ? [0x28, ...varint(read)] : []),
    ...(thinking ? [0x48, ...varint(thinking)] : []),
  ])))

  // 场景 1：第 1 回合取消，150ms 后延迟落盘 {input: 50000, output: 900}；第 2 回合首步绝不能把这 900 output 算进来
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    const writeGen = (sessionId, idx, stats) => {
      const db = openSqlite(path.join(convDir, `${sessionId}.db`))
      try {
        db.exec("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
      } finally {
        db.close()
      }
    }

    let lateTimer = null
    kit.prompts.push(async (agent) => {
      const db = openSqlite(path.join(convDir, `${agent.sessionId}.db`))
      try {
        db.exec("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
      } finally {
        db.close()
      }
      await agent.text("partial")
      await agent.waitCancel()
      lateTimer = setTimeout(() => {
        try { writeGen(agent.sessionId, 1, { input: 50_000, read: 0, output: 900 }) } catch {}
      }, 150)
      return { stopReason: "cancelled", usage: { inputTokens: 50_000, cachedReadTokens: 0, outputTokens: 900, totalTokens: 50_900 } }
    })
    kit.prompts.push(async (agent) => {
      await sleep(220)
      writeGen(agent.sessionId, 2, { input: 1000, read: 49_000, output: 20 })
      await agent.tool("Read", { path: "/after-cancel.ts" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 1000, cachedReadTokens: 49_000, outputTokens: 25, totalTokens: 50_025 } }
    })

    try {
      const body = baseBody()
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

      const next = {
        ...body,
        messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "partial" }] }, { role: "user", content: "next turn" }],
      }
      const { responses } = await runTurn(kit, next)
      assert.equal(kit.acpSpawns.length, 1, "同一会话复用 Proc")
      assert.ok(responses[0].usage.output_tokens < 200,
        `第 2 回合首步 output_tokens=${responses[0].usage.output_tokens} 误吞入了上一取消回合延迟写入的 900 token`)
    } finally {
      clearTimeout(lateTimer)
    }
  })

  // 场景 2：第 1 回合超时回退（SQLite 行在第 1 回合结束后才落盘），第 2 回合同样不得误计该晚到行
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let sessionId
    const writeGen = (id, idx, stats) => {
      const db = openSqlite(path.join(convDir, `${id}.db`))
      try {
        db.exec("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
      } finally {
        db.close()
      }
    }

    kit.prompts.push(async (agent) => {
      sessionId = agent.sessionId
      const db = openSqlite(path.join(convDir, `${sessionId}.db`))
      try {
        db.exec("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
      } finally {
        db.close()
      }
      await agent.text("short reply")
      return { stopReason: "end_turn", usage: { inputTokens: 3000, cachedReadTokens: 0, outputTokens: 10, totalTokens: 3010 } }
    })
    kit.prompts.push(async (agent) => {
      writeGen(agent.sessionId, 2, { input: 1000, read: 2000, output: 15 })
      await agent.tool("Read", { path: "/turn2.ts" })
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 1000, cachedReadTokens: 2000, outputTokens: 20, totalTokens: 3020 } }
    })

    const body = baseBody()
    const turn1 = await runTurn(kit, body)
    // 第 1 回合已回退结算后，其延迟行（output: 900）才写入 SQLite
    writeGen(sessionId, 1, { input: 3000, read: 0, output: 900 })
    const next = {
      ...body,
      messages: [...body.messages, { role: "assistant", content: plain(turn1.responses[0].content) }, { role: "user", content: "turn 2" }],
    }
    const turn2 = await runTurn(kit, next)
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(turn2.responses[0].usage.output_tokens < 200,
      `第 2 回合首步 output_tokens=${turn2.responses[0].usage.output_tokens} 误计入了回退回合的晚到行`)
  })
})

test("异步延迟 >75ms 落盘：pending 预写行等待真实落盘；无预写慢行在后续步合并 output 且单步窗口只取最新一笔", { skip: !openSqlite }, async () => {
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
  const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
  const genBlob = ({ input, output, write = 0, read = 0, thinking = 0 }, context = 24_000) => {
    const stats = [
      0x10, ...varint(input), 0x18, ...varint(output),
      ...(write ? [0x20, ...varint(write)] : []),
      ...(read ? [0x28, ...varint(read)] : []),
      ...(thinking ? [0x48, ...varint(thinking)] : []),
    ]
    return new Uint8Array(field(1, [...field(4, stats), ...field(9, field(10, [8, ...varint(context)]))]))
  }

  // 子场景 1：gen_metadata 先有 pre-send 估算行（pending: true），真实计费 150ms（>75ms）后才写入 -> 当步必须等齐并精确上报
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let lateTimer = null
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const upsertGen = (idx, stats) => {
        const db = openSqlite(dbFile)
        try {
          db.exec("PRAGMA journal_mode = WAL")
          db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
          db.run("INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
        } finally {
          db.close()
        }
      }
      upsertGen(1, { input: 1800, read: 18_200, output: 32, thinking: 8 })
      await agent.tool("Read", { path: "/step1.ts" })

      // 第 2 步先写入 0 计费的 pre-send 行（触发 pending: true），150ms 后才落盘真实计费
      upsertGen(2, { input: 0, read: 0, output: 0, thinking: 0 })
      lateTimer = setTimeout(() => {
        try { upsertGen(2, { input: 2100, read: 19_900, output: 50, thinking: 10 }) } catch {}
      }, 150)
      await agent.tool("Read", { path: "/step2.ts" })

      upsertGen(3, { input: 2400, read: 22_000, output: 40, thinking: 5 })
      await agent.text("done")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 1800 + 2100 + 2400,
          cachedReadTokens: 18_200 + 19_900 + 22_000,
          cachedWriteTokens: 0,
          outputTokens: 32 + 50 + 40,
          thoughtTokens: 8 + 10 + 5,
          totalTokens: 1800 + 2100 + 2400 + 18_200 + 19_900 + 22_000 + 32 + 50 + 40,
        },
      }
    })
    try {
      const { responses } = await runTurn(kit, baseBody())
      assert.equal(responses.length, 3)
      assert.deepEqual(plain(responses[1].usage), {
        input_tokens: 2100,
        cache_read_input_tokens: 19_900,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        output_tokens_details: { thinking_tokens: 10 },
      })
    } finally {
      clearTimeout(lateTimer)
    }
  })

  // 子场景 2：无 pre-send 行且无文本块，第 2 步的整行在 150ms（>75ms）后才首次落盘：
  // 钉死行为：第 2 步按 75ms 超时先结 0；第 3 步看到 [Gen 2, Gen 3] 两笔调用时，
  // 必须只报最新一笔调用的上下文窗口（严禁累加翻倍），并合并两笔的 output_tokens。
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let lateTimer = null
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const writeGen = (idx, stats) => {
        const db = openSqlite(dbFile)
        try {
          db.exec("PRAGMA journal_mode = WAL")
          db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
          db.run("INSERT INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
        } finally {
          db.close()
        }
      }
      writeGen(1, { input: 1800, read: 18_200, output: 32, thinking: 8 })
      await agent.tool("Read", { path: "/s1.ts" })

      lateTimer = setTimeout(() => {
        try { writeGen(2, { input: 2582, read: 83_270, output: 453, thinking: 0 }) } catch {}
      }, 150)
      await agent.tool("Read", { path: "/s2.ts" })

      await sleep(120)
      writeGen(3, { input: 2355, read: 83_803, output: 100, thinking: 15 })
      await agent.text("completed")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 1800 + 2582 + 2355,
          cachedReadTokens: 18_200 + 83_270 + 83_803,
          cachedWriteTokens: 0,
          outputTokens: 32 + 453 + 100,
          thoughtTokens: 8 + 15,
          totalTokens: 1800 + 2582 + 2355 + 18_200 + 83_270 + 83_803 + 32 + 453 + 100,
        },
      }
    })
    try {
      const { responses } = await runTurn(kit, baseBody())
      assert.equal(responses.length, 3)
      assert.deepEqual(plain(responses.map((r) => r.usage)), [
        { input_tokens: 1800, cache_read_input_tokens: 18_200, cache_creation_input_tokens: 0, output_tokens: 32, output_tokens_details: { thinking_tokens: 8 } },
        { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        { input_tokens: 2355, cache_read_input_tokens: 83_803, cache_creation_input_tokens: 0, output_tokens: 553, output_tokens_details: { thinking_tokens: 15 } },
      ])
    } finally {
      clearTimeout(lateTimer)
    }
  })

  // 子场景 3：无 pre-send 行，但第 2 步在 tool_use 前已流出文本块（必为新生成，不可共享上一生成）：
  // 即使整行在 150ms（>75ms）后才首次落盘，也必须按 1000ms 等待并在第 2 步当步精确上报。
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let lateTimer = null
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const writeGen = (idx, stats) => {
        const db = openSqlite(dbFile)
        try {
          db.exec("PRAGMA journal_mode = WAL")
          db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
          db.run("INSERT INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
        } finally {
          db.close()
        }
      }
      writeGen(1, { input: 1800, read: 18_200, output: 32, thinking: 8 })
      await agent.tool("Read", { path: "/t1.ts" })

      lateTimer = setTimeout(() => {
        try { writeGen(2, { input: 2100, read: 19_900, write: 0, output: 50, thinking: 10 }) } catch {}
      }, 150)
      await agent.text("inspecting next file ")
      await agent.tool("Read", { path: "/t2.ts" })

      writeGen(3, { input: 2400, read: 22_000, output: 40, thinking: 5 })
      await agent.text("done")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 1800 + 2100 + 2400,
          cachedReadTokens: 18_200 + 19_900 + 22_000,
          cachedWriteTokens: 0,
          outputTokens: 32 + 50 + 40,
          thoughtTokens: 8 + 10 + 5,
          totalTokens: 1800 + 2100 + 2400 + 18_200 + 19_900 + 22_000 + 32 + 50 + 40,
        },
      }
    })
    try {
      const { responses } = await runTurn(kit, baseBody())
      assert.equal(responses.length, 3)
      assert.deepEqual(plain(responses[1].usage), {
        input_tokens: 2100,
        cache_read_input_tokens: 19_900,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        output_tokens_details: { thinking_tokens: 10 },
      })
    } finally {
      clearTimeout(lateTimer)
    }
  })
})

test("SQLite 异常保护：超额失真行触发回退，EXCLUSIVE 锁库立即停止轮询不阻塞", { skip: !openSqlite }, async () => {
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
  const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
  const genBlob = ({ input, output, write = 0, read = 0 }) => new Uint8Array(field(1, field(4, [
    0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []),
    ...(read ? [0x28, ...varint(read)] : []),
  ])))

  // 子场景 1：SQLite 记录的累计 prompt 远超 ACP 终态上报（> expected + max(16, 1%)），必须拒信并回退到有界估算
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    kit.prompts.push(async (agent) => {
      const db = openSqlite(path.join(convDir, `${agent.sessionId}.db`))
      try {
        db.exec("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        db.run("INSERT INTO gen_metadata VALUES (1, ?)", genBlob({ input: 45_000, read: 45_000, output: 30 }))
      } finally {
        db.close()
      }
      await agent.text("short answer")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 1500, cachedReadTokens: 4500, cachedWriteTokens: 0, outputTokens: 30, totalTokens: 6030 },
      }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.ok(usageTotal(responses[0].usage) <= 6000,
      `超额失真的 SQLite 行（90000）未被拦截，实际返回窗口=${usageTotal(responses[0].usage)}`)
  })

  // 子场景 2：数据库被 EXCLUSIVE 锁住（SQLITE_BUSY）时立即放弃轮询，不耗满 1000ms
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let locker = null
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      locker = openSqlite(dbFile)
      locker.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
      locker.exec("BEGIN EXCLUSIVE")
      locker.run("INSERT INTO gen_metadata VALUES (1, ?)", genBlob({ input: 2000, read: 4000, output: 20 }))
      await agent.text("checking ")
      await agent.tool("Read", { path: "/locked.ts" })
      locker.exec("ROLLBACK")
      locker.close()
      locker = null
      await agent.text("unlocked done")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 2000, cachedReadTokens: 4000, cachedWriteTokens: 0, outputTokens: 25, totalTokens: 6025 },
      }
    })
    try {
      const body = baseBody()
      const t0 = performance.now()
      const toolResp = await readSse(await kit.request(body))
      const toolElapsedMs = performance.now() - t0
      assert.equal(toolResp.stopReason, "tool_use")
      assert.ok(toolElapsedMs < 500, `SQLITE_BUSY 时首步耗时 ${toolElapsedMs.toFixed(0)}ms，不应重复轮询阻塞至 1000ms`)
      const finalResp = await readSse(await kit.request(continueWithToolResults(body, toolResp, () => "ok")))
      assert.equal(finalResp.stopReason, "end_turn")
    } finally {
      try { locker?.exec("ROLLBACK") } catch {}
      try { locker?.close() } catch {}
    }
  })
})

test("SQLite field 3 已含 field 9（thinking）：单步/多步落盘、steps 旧表与中途回退均不重复计思考", { skip: !openSqlite }, async () => {
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
  const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
  const usageBytes = ({ input, output, write = 0, read = 0, thinking = 0 }) => [
    0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []),
    ...(read ? [0x28, ...varint(read)] : []),
    ...(thinking ? [0x48, ...varint(thinking)] : []),
  ]
  const genBlob = (stats) => new Uint8Array(field(1, field(4, usageBytes(stats))))
  const stepBlob = (stats) => new Uint8Array(field(9, usageBytes(stats)))

  // 子场景 1：Carbon 实测单步重思考形状（2316 / 9390 / 9322 / 11706）：
  // 真机存在 <sessionId>.db 时单步也会优先走 measuredUsage()，必须报 9390 而非 18712，且与无库兜底完全一致。
  let withDbUsage = null
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    kit.prompts.push(async (agent) => {
      const db = openSqlite(path.join(convDir, `${agent.sessionId}.db`))
      try {
        db.exec("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        db.run("INSERT INTO gen_metadata VALUES (0, ?)", genBlob({ input: 2316, output: 9390, thinking: 9322 }))
      } finally {
        db.close()
      }
      await agent.thought("deep reasoning")
      await agent.text("short visible answer")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 2316, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 9390, thoughtTokens: 9322, totalTokens: 11_706 },
      }
    })
    const { responses } = await runTurn(kit, baseBody({ tools: [] }))
    assert.equal(responses.length, 1)
    withDbUsage = plain(responses[0].usage)
    assert.deepEqual(withDbUsage, {
      input_tokens: 2316,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 9390,
      output_tokens_details: { thinking_tokens: 9322 },
    })
  })

  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.thought("deep reasoning")
      await agent.text("short visible answer")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 2316, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 9390, thoughtTokens: 9322, totalTokens: 11_706 },
      }
    })
    const { responses } = await runTurn(kit, baseBody({ tools: [] }))
    assert.deepEqual(plain(responses[0].usage), withDbUsage)
  })

  // 子场景 2：旧版 steps 表（Flash 实测形状 2322 / 4728 / 4661）与单笔 thinking > output 防御下限。
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const db = openSqlite(dbFile)
      try {
        db.run("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
        db.run("INSERT INTO steps VALUES (1, 15, 3, ?)", stepBlob({ input: 2322, output: 4728, thinking: 4661 }))
      } finally {
        db.close()
      }
      await agent.tool("Read", { path: "/legacy.ts" })
      const db2 = openSqlite(dbFile)
      try {
        db2.run("INSERT INTO steps VALUES (2, 15, 3, ?)", stepBlob({ input: 500, output: 3, thinking: 9 }))
        db2.run("INSERT INTO steps VALUES (3, 15, 3, ?)", stepBlob({ input: 600, output: 10, thinking: 2 }))
      } finally {
        db2.close()
      }
      await agent.text("done")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 3422, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 4747, thoughtTokens: 4672, totalTokens: 8169 },
      }
    })
    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 2)
    assertCleanUsage(responses[0].usage, "legacy-steps-flash")
    assertCleanUsage(responses[1].usage, "legacy-steps-guard")
    assert.equal(responses[0].usage.output_tokens, 4728)
    assert.equal(responses[0].usage.output_tokens_details.thinking_tokens, 4661)
    assert.equal(responses[1].usage.output_tokens, 19)
    assert.equal(responses[1].usage.output_tokens_details.thinking_tokens, 11)
  })

  // 子场景 3：首步走 SQLite 结算后尾步锁库回退 responseUsage()：
  // turn.emittedOutputTokens 记录不翻倍的 4700，尾步才能拿足剩余 ACP output 预算（5000 - 4700 = 300）。
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let locker = null
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      const db = openSqlite(dbFile)
      try {
        db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        db.run("INSERT INTO gen_metadata VALUES (1, ?)", genBlob({ input: 20_000, read: 10_000, output: 4700, thinking: 4650 }))
      } finally {
        db.close()
      }
      await agent.tool("Read", { path: "/step1.ts" })
      locker = openSqlite(dbFile)
      locker.exec("BEGIN EXCLUSIVE")
      locker.run("INSERT INTO gen_metadata VALUES (2, ?)", genBlob({ input: 20_000, read: 20_000, output: 300, thinking: 150 }))
      await agent.text("ok")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 40_000, cachedReadTokens: 30_000, cachedWriteTokens: 0, outputTokens: 5000, thoughtTokens: 4800, totalTokens: 75_000 },
      }
    })
    try {
      const { responses } = await runTurn(kit, baseBody())
      assert.equal(responses.length, 2)
      assert.equal(responses[0].usage.output_tokens, 4700)
      assert.equal(responses[1].usage.output_tokens, 300)
      assert.equal(responses[0].usage.output_tokens + responses[1].usage.output_tokens, 5000)
    } finally {
      try { locker?.exec("ROLLBACK") } catch {}
      try { locker?.close() } catch {}
    }
  })
})
