// UsageTracker 的离线测试：不碰网络，喂固定的 batchexecute 响应文本。
// 解析函数（parseBatchExecute/parseUsageInfo/parseQuota）是纯函数，直接测；
// UsageTracker 用假 page（eval 返回固定文本）驱动 snapshot/缓存/失败保留。
import { expect, test } from "bun:test"
import { parseBatchExecute, parseQuota, parseUsageInfo, UsageTracker, USAGE_RPC, QUOTA_RPC } from "./usage.mjs"

// —— 构造固定响应 ——

// GET_USAGE_INFO：tier=2(PRO)，5h 窗口剩 12、周窗口剩 80%、AI credits 剩 3
const usageInfoBody = JSON.stringify([
  2,
  [
    [12, 0.4, 1, [1766400000]], // metricType 1 = 5h 窗口，usageLevel 0.4 = 40%
    [80, 0.8, 2, [1767000000]], // metricType 2 = 周窗口
    [3, 0.3, 3, [1769000000]], // metricType 3 = AI credits
  ],
])

// CHECK_GEMINI_QUOTA（Pro payload）：Pro(actionId 4) total 100 剩 37，
// FlashThinking(15) total 50 剩 50
const quotaProBody = JSON.stringify([
  [
    [
      [1, 4], // id
      4, // actionId = Pro
      0.63, // usageLevel
      [1766400000], // reset
      100, // total
      37, // remaining
    ],
    [[6, 6], 15, 0.0, [1766400000], 50, 50],
  ],
])

// CHECK_GEMINI_QUOTA（Flash payload）：Flash(11) total 200 剩 5
const quotaFlashBody = JSON.stringify([[[[[1, 11], 11, 0.975, [1766400000], 200, 5]]]])

// batchexecute 的响应形状：)]}' 前缀 + 长度行 + 行 JSON
function batchExecute(rows) {
  let out = ")]}'\n"
  for (const [rpcid, body] of rows) {
    const line = JSON.stringify([["wrb.fr", rpcid, body, null, null, null, "generic"]])
    out += String(line.length) + "\n" + line + "\n"
  }
  return out
}

const GOOD_RESPONSE = batchExecute([
  [USAGE_RPC, usageInfoBody],
  [QUOTA_RPC, quotaProBody],
  [QUOTA_RPC, quotaFlashBody],
])

// —— 纯解析函数 ——

test("parseBatchExecute 剥掉 )]} ' 前缀与长度行，抽出 wrb.fr 行", () => {
  const rows = parseBatchExecute(GOOD_RESPONSE)
  expect(rows.length).toBe(3)
  expect(rows[0].rpcid).toBe("jSf9Qc")
  expect(rows[0].data).toBe(usageInfoBody)
  expect(rows[1].rpcid).toBe("qpEbW")
  expect(rows[2].rpcid).toBe("qpEbW")
})

test("parseBatchExecute 容忍垃圾输入", () => {
  expect(parseBatchExecute("")).toEqual([])
  expect(parseBatchExecute(null)).toEqual([])
  expect(parseBatchExecute(")]}'\ngarbage\n")).toEqual([])
  expect(parseBatchExecute(")]}'\n12\n[broken")).toEqual([])
})

test("parseUsageInfo 解出 tier 与 5h/周/credits 三窗口", () => {
  const info = parseUsageInfo(usageInfoBody)
  expect(info.error).toBeUndefined()
  expect(info.tier).toBe(2)
  expect(info.items.length).toBe(3)
  const [five, week, credits] = info.items
  expect(five.metricType).toBe(1)
  expect(five.remaining).toBe(12)
  expect(five.usageLevel).toBe(0.4)
  expect(five.resetAt).toBe(1766400000000) // 秒 → 毫秒
  expect(week.metricType).toBe(2)
  expect(credits.metricType).toBe(3)
})

test("parseUsageInfo 对异常结构返回 {error} 而不抛", () => {
  expect(parseUsageInfo("not json").error).toBeTruthy()
  expect(parseUsageInfo("42").error).toBeTruthy()
  expect(parseUsageInfo("{}").error).toBeTruthy()
})

test("parseQuota 解出 actionId/total/remaining/resetAt", () => {
  const q = parseQuota(quotaProBody)
  expect(q.error).toBeUndefined()
  expect(q.items.length).toBe(2)
  const [pro, thinking] = q.items
  expect(pro.actionId).toBe(4)
  expect(pro.total).toBe(100)
  expect(pro.remaining).toBe(37)
  expect(pro.resetAt).toBe(1766400000000)
  expect(thinking.actionId).toBe(15)
  expect(thinking.remaining).toBe(50)
  // flash payload
  const qf = parseQuota(quotaFlashBody)
  expect(qf.items[0].actionId).toBe(11)
  expect(qf.items[0].remaining).toBe(5)
})

test("parseQuota 对异常结构返回 {error} 而不抛", () => {
  expect(parseQuota("nope").error).toBeTruthy()
  // "[]" 是合法 JSON：空 items，不算解析失败
  expect(parseQuota("[]").items).toEqual([])
})

// —— UsageTracker（假 page） ——

function fakePage(text, { fail = false } = {}) {
  const state = { fail }
  return {
    state,
    evalCalls: 0,
    async eval() {
      this.evalCalls++
      if (state.fail) throw new Error("page eval failed: /sorry")
      return { status: 200, text }
    },
  }
}

test("snapshot 解析完整响应：tier/windows/quotas/aiCredits", async () => {
  const tracker = new UsageTracker({ page: fakePage(GOOD_RESPONSE), account: "a1" })
  const snap = await tracker.snapshot()
  expect(snap.error).toBeNull()
  expect(snap.account).toBe("a1")
  expect(snap.tier).toBe(2)
  expect(snap.tierName).toBe("PRO")
  // 5h 窗口：remaining 12，usagePct 40%
  expect(snap.windows.current_5h).toEqual({ remaining: 12, usagePct: 40, resetAt: 1766400000000 })
  expect(snap.windows.weekly).toEqual({ remaining: 80, usagePct: 80, resetAt: 1767000000000 })
  expect(snap.aiCredits).toEqual({ remaining: 3, resetAt: 1769000000000 })
  // quotas：pro 37/100=63% used，flash 5/200=97.5% used，flash_thinking 50/50=0%
  expect(snap.quotas.pro).toEqual({ remaining: 37, total: 100, usagePct: 63, resetAt: 1766400000000 })
  expect(snap.quotas.flash).toEqual({ remaining: 5, total: 200, usagePct: 97.5, resetAt: 1766400000000 })
  expect(snap.quotas.flash_thinking).toEqual({ remaining: 50, total: 50, usagePct: 0, resetAt: 1766400000000 })
})

test("snapshot 缓存 60s：第二次直接用缓存不重新 eval", async () => {
  const page = fakePage(GOOD_RESPONSE)
  const tracker = new UsageTracker({ page, account: "a1" })
  await tracker.snapshot()
  const snap2 = await tracker.snapshot()
  expect(page.evalCalls).toBe(1)
  expect(snap2.fetchedAt).toBeTruthy()
  // force 才会再查
  await tracker.snapshot({ force: true })
  expect(page.evalCalls).toBe(2)
})

test("页内失败不抛：返回 {error}，并保留上一次好快照标 stale", async () => {
  const page = fakePage(GOOD_RESPONSE)
  const tracker = new UsageTracker({ page, account: "a1", cacheMs: 0 })
  const good = await tracker.snapshot()
  expect(good.error).toBeNull()
  // 之后页开始报错
  page.state.fail = true
  const bad = await tracker.snapshot({ force: true })
  expect(bad.error).toContain("/sorry")
  expect(bad.stale).toBe(true)
  expect(bad.tier).toBe(2) // 旧快照仍在
  expect(bad.quotas.pro.remaining).toBe(37)
})

test("从未成功过时失败返回 {error} 且不抛", async () => {
  const tracker = new UsageTracker({ page: fakePage("", { fail: true }), account: "a2" })
  const snap = await tracker.snapshot()
  expect(snap.error).toBeTruthy()
  expect(snap.tier).toBeUndefined()
  expect(snap.fetchedAt).toBe(0)
})

test("HTTP 非 200（如 /sorry 429）按失败处理不抛", async () => {
  const page = {
    async eval() {
      return { status: 429, text: "rate limited" }
    },
  }
  const tracker = new UsageTracker({ page, account: "a3" })
  const snap = await tracker.snapshot()
  expect(snap.error).toContain("429")
  expect(snap.code).toBe("usage_limit_exceeded")
})

test("响应里没有可识别 RPC 时按改版处理", async () => {
  const page = fakePage(")]}'\n5\n[[]]\n")
  const tracker = new UsageTracker({ page, account: "a4" })
  const snap = await tracker.snapshot()
  expect(snap.error).toContain("没有可识别")
})
