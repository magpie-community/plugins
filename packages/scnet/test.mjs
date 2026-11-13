// 单元测试：纯函数，不触网。
import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal } from "./index.mjs"

const {
  checkTier,
  usageFromTokenPlan,
  usageFromFree,
  label,
  cookieOf,
  tierOf,
  fmt,
  pct,
  FREE_MODEL,
} = _internal

// ---- 档位校验：两套 Key 不能混用 --------------------------------------------

test("Token Plan 档接受 sk-t 密钥", () => {
  assert.equal(checkTier("tokenplan", "sk-t-abc123", ["DeepSeek-V4.1-Flash-1017-Event"]), null)
})

test("Token Plan 档拒绝通用 Key", () => {
  const err = checkTier("tokenplan", "sk-N-abc123", ["DeepSeek-V4.1-Flash-1017-Event"])
  assert.match(err, /不是 Token Plan 专属 Key/)
  assert.match(err, /sk-t/)
})

test("免费额度档接受能看到 GLM-5.3-Flash 的通用 Key", () => {
  assert.equal(checkTier("free", "sk-N-abc123", ["GLM-5.3-Flash", "Other-Model"]), null)
})

test("免费额度档拒绝 Token Plan 专属 Key", () => {
  const err = checkTier("free", "sk-t-abc123", ["GLM-5.3-Flash"])
  assert.match(err, /不能用于免费额度/)
  assert.match(err, /sk-N/)
})

test("免费额度档拒绝看不到 GLM-5.3-Flash 的 Key", () => {
  const err = checkTier("free", "sk-N-abc123", ["DeepSeek-V4.1-Flash-1017-Event"])
  assert.match(err, new RegExp(FREE_MODEL))
})

test("免费额度档拒绝非 sk- 前缀", () => {
  assert.match(checkTier("free", "abc", ["GLM-5.3-Flash"]), /sk-/)
})

// ---- Token Plan 额度 --------------------------------------------------------

const PLANS = [
  {
    resourceAccountId: "111",
    orderId: "222",
    resourceId: "TP-Event-022",
    name: "DeepSeek-V4.1-Flash-1017首单5千万",
    status: "enable",
    totalDays: 31,
    usedAmount: "0.152",
    totalAmount: "50000.0000000000",
    unit: "CREDITS",
    minValidTime: "2026-11-13 14:29:17",
    maxExpireTime: "2026-12-13 23:59:59",
  },
]

test("Token Plan 额度：已用 / 总量 / 剩余 / 到期时间", () => {
  const u = usageFromTokenPlan(PLANS, "x")
  assert.equal(u.plan, PLANS[0].name)
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].name, "Token Plan Credits")
  assert.match(u.windows[0].display, /已用 0\.15 \/ 共 50,000 Credits/)
  assert.equal(u.balance, "49,999.85 Credits")
  assert.equal(u.until, "2026-12-13 23:59:59")
  assert.equal(u.error, undefined)
})

test("Token Plan 同时有多条时取最早到期的生效套餐", () => {
  const u = usageFromTokenPlan(
    [
      { ...PLANS[0], name: "late", maxExpireTime: "2027-01-01 00:00:00" },
      { ...PLANS[0], name: "early", maxExpireTime: "2026-12-01 00:00:00" },
      { ...PLANS[0], name: "off", status: "disable" },
    ],
    "x"
  )
  assert.equal(u.plan, "early")
})

test("没有生效中的套餐时明确说明", () => {
  const u = usageFromTokenPlan([{ ...PLANS[0], status: "disable" }], "x")
  assert.match(u.error, /没有生效中的 Token Plan/)
})

test("Token Plan 用完时给出提示", () => {
  const u = usageFromTokenPlan(
    [{ ...PLANS[0], usedAmount: "50000", totalAmount: "50000" }],
    "x"
  )
  assert.equal(u.windows[0].used, 100)
  assert.match(u.error, /已用完/)
})

// ---- 免费额度 --------------------------------------------------------------

const FREE_DATA = {
  list: [
    {
      resourceId: "GLM-5.3-Flash",
      purchaseCount: "100000000",
      balance: "99999642",
      unit: "MTOKENS",
      validTime: "2026-11-13T14:33:22",
      expireTime: "2026-12-13T23:59:59",
      status: "enable",
    },
  ],
  totalBalance: "99999642",
  totalPurchaseCount: "100000000",
  totalUsed: "358",
}

test("免费额度：用 purchase - balance 算已用", () => {
  const u = usageFromFree(FREE_DATA, "x")
  assert.match(u.plan, /GLM-5\.3-Flash/)
  assert.equal(u.windows.length, 1)
  assert.match(u.windows[0].display, /已用 358 \/ 共 100,000,000 MTOKENS/)
  assert.equal(u.balance, "99,999,642 MTOKENS")
  assert.equal(u.until, "2026-12-13T23:59:59")
})

test("免费额度有多条资源时优先 GLM-5.3-Flash", () => {
  const u = usageFromFree(
    {
      list: [
        { resourceId: "Other", purchaseCount: "100", balance: "50", unit: "MTOKENS" },
        { resourceId: "GLM-5.3-Flash", purchaseCount: "1000", balance: "900", unit: "MTOKENS" },
      ],
    },
    "x"
  )
  assert.match(u.plan, /GLM-5\.3-Flash/)
  assert.match(u.balance, /900/)
})

test("没有免费额度时明确说明", () => {
  const u = usageFromFree({ list: [] }, "x")
  assert.match(u.error, /没有可用的免费额度/)
})

test("免费额度用完时给出提示", () => {
  const u = usageFromFree(
    { list: [{ resourceId: "GLM-5.3-Flash", purchaseCount: "100", balance: "0", unit: "MTOKENS" }] },
    "x"
  )
  assert.equal(u.windows[0].used, 100)
  assert.match(u.error, /已用完/)
})

// ---- 账号 ------------------------------------------------------------------

test("账号名显示档位和 Key 后四位，不泄露完整 Key", () => {
  const a = { key: "sk-t-1234567890", metadata: { tier: "tokenplan" } }
  assert.equal(label(a), "Token Plan · api.scnet.cn …7890")
  assert.doesNotMatch(label(a), /sk-t-1234/)
})

test("tierOf 默认 tokenplan，只有显式 free 才是免费档", () => {
  assert.equal(tierOf({}), "tokenplan")
  assert.equal(tierOf({ metadata: { tier: "free" } }), "free")
  assert.equal(tierOf({ metadata: { tier: "other" } }), "tokenplan")
})

test("cookieOf 去空白并容忍缺失", () => {
  assert.equal(cookieOf({ metadata: { consoleCookie: "  a=b  " } }), "a=b")
  assert.equal(cookieOf({}), "")
})

test("fmt 与 pct 不产生 NaN", () => {
  assert.equal(fmt("49,999.85"), "49,999.85")
  assert.equal(fmt(undefined), "—")
  assert.equal(pct(0, 0), 0)
  assert.equal(pct(200, 100), 100)
})
