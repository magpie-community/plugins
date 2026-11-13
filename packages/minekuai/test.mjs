// 单元测试：只测纯函数，不触网。
// 跑法：node --test（在插件目录下）

import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal } from "./index.mjs"

const {
  root,
  checkURL,
  fmtTokens,
  pct,
  usageFrom,
  webTokenOf,
  label,
  credentialsOf,
  isStale,
  checkinOutcome,
  pointsWindow,
  dailyWindow,
  localDate,
  WEB_TOKEN_TTL,
  CLIENT_ID,
} = _internal

// ---- 地址规整 ----------------------------------------------------------------

test("root 去掉尾部斜杠与误填的 /v1", () => {
  assert.equal(root("https://minekuai.cn"), "https://minekuai.cn")
  assert.equal(root("https://minekuai.cn/"), "https://minekuai.cn")
  assert.equal(root("https://minekuai.cn/v1"), "https://minekuai.cn")
  assert.equal(root("https://minekuai.cn/v1/"), "https://minekuai.cn")
  assert.equal(root("  https://minekuai.cn  "), "https://minekuai.cn")
  // 部署路径前缀要保留，不能被 /v1 规则误伤
  assert.equal(root("https://example.com/relay"), "https://example.com/relay")
})

test("checkURL 接受 http/https，拒绝其它协议与带账号密码的地址", () => {
  assert.equal(checkURL("https://minekuai.cn"), null)
  assert.equal(checkURL("http://127.0.0.1:8080"), null)
  assert.match(checkURL("ftp://minekuai.cn"), /https/)
  assert.match(checkURL("minekuai.cn"), /https/)
  assert.match(checkURL("https://user:pw@minekuai.cn"), /账号密码/)
})

// ---- 展示格式 ----------------------------------------------------------------

test("fmtTokens 按亿 / 万 压缩", () => {
  assert.equal(fmtTokens(1_000_000_000), "10 亿")
  assert.equal(fmtTokens(12_500_000), "1,250 万")
  assert.equal(fmtTokens(1_234), "1,234")
  assert.equal(fmtTokens(0), "0")
  assert.equal(fmtTokens(undefined), "—")
})

test("pct 对 0 总量返回 0，不产生 NaN，也不超过 100", () => {
  assert.equal(pct(50, 100), 50)
  assert.equal(pct(0, 0), 0)
  assert.equal(pct(200, 100), 100)
})

// ---- 额度换算 ----------------------------------------------------------------

// 2026-11-13 在真实账号上读到的结构（数值替换过，形状保持原样）
const REAL_SHAPE = {
  paid: {
    group: "paygo",
    groupName: "按量付费",
    balance: 999_999_865,
    totalIn: 1_000_000_000,
    totalUsed: 135,
  },
  permanent: { balance: 10_000_000, totalIn: 10_000_000, totalUsed: 0 },
  remaining: 10_000_000,
}

test("usageFrom 把付费与免费两个桶都转成窗口", () => {
  const u = usageFrom(REAL_SHAPE, "minekuai.cn …abcd")
  assert.equal(u.user, "minekuai.cn …abcd")
  assert.equal(u.plan, "按量付费")
  assert.equal(u.windows.length, 2)
  assert.equal(u.windows[0].name, "付费按量 token")
  assert.equal(u.windows[1].name, "免费按量额度")
  // 135 / 10 亿：极小但不是 NaN
  assert.ok(u.windows[0].used > 0 && u.windows[0].used < 0.001)
  assert.match(u.windows[0].display, /已用 135/)
  assert.match(u.windows[0].display, /共 10 亿/)
  // 总剩余 = 付费剩余 + 免费剩余 = 999,999,865 + 10,000,000
  assert.equal(u.balance, "10.1 亿 token")
  assert.equal(u.error, undefined)
})

test("usageFrom 在付费额度用完时给出明确错误", () => {
  const u = usageFrom(
    {
      paid: { groupName: "按量付费", balance: 0, totalIn: 1_000_000_000, totalUsed: 1_000_000_000 },
      permanent: { balance: 0, totalIn: 0, totalUsed: 0 },
    },
    "x"
  )
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].used, 100)
  assert.match(u.error, /已用完/)
})

test("usageFrom 在没有任何额度时不假装成功", () => {
  const u = usageFrom({}, "x")
  assert.equal(u.windows.length, 0)
  assert.equal(u.balance, undefined)
  assert.match(u.error, /暂无可用额度/)
})

test("usageFrom 不把预付费包画成周期窗口", () => {
  // 麦块云是预付费 token 包，没有每天/每月重置；
  // 一旦写了 span 或 resetsAt，magpie 会画成「每日重置」，那是错的
  const u = usageFrom(REAL_SHAPE, "x")
  for (const w of u.windows) {
    assert.equal(w.span, undefined)
    assert.equal(w.resetsAt, undefined)
  }
})

// ---- 账号 --------------------------------------------------------------------

test("webTokenOf 容忍空白与缺失", () => {
  assert.equal(webTokenOf({ metadata: { webToken: "  eyJabc  " } }), "eyJabc")
  assert.equal(webTokenOf({ metadata: {} }), "")
  assert.equal(webTokenOf({}), "")
  assert.equal(webTokenOf(undefined), "")
})

test("label 只用密钥后四位，绝不暴露令牌", () => {
  const auth = { key: "sk-ABCDEFGHIJKLMNOP", metadata: { webToken: "eyJhbGciOiJIUzI1NiJ9.secret" } }
  const name = label(auth, "https://minekuai.cn")
  assert.equal(name, "minekuai.cn …MNOP")
  assert.doesNotMatch(name, /eyJ/)
  assert.doesNotMatch(name, /sk-A/)
})

test("clientid 常量与站点前端一致", () => {
  // 取自麦块云前端 bundle 里硬编码的 Lc 常量；
  // 少了它 /app/token 返回 401，站点改版时这里要跟着更新
  assert.equal(CLIENT_ID, "428a8310cd442757ae699df5d894f051")
})

// ---- 令牌续期 ----------------------------------------------------------------

test("credentialsOf 缺手机号或密码都返回 undefined", () => {
  assert.deepEqual(credentialsOf({ metadata: { phone: "13800000000", password: "pw" } }), {
    phone: "13800000000",
    password: "pw",
  })
  assert.equal(credentialsOf({ metadata: { phone: "13800000000" } }), undefined)
  assert.equal(credentialsOf({ metadata: { password: "pw" } }), undefined)
  assert.equal(credentialsOf({ metadata: {} }), undefined)
})

test("isStale 按 1 天提前量判断是否需要续期", () => {
  const now = Date.now()
  // 还剩 12 小时 → 该续了
  assert.equal(isStale({ metadata: { webTokenExpireAt: now + 12 * 3600 * 1000 } }), true)
  // 还剩 6 天 → 不用续
  assert.equal(isStale({ metadata: { webTokenExpireAt: now + 6 * 86400 * 1000 } }), false)
  // 已过期 → 要续
  assert.equal(isStale({ metadata: { webTokenExpireAt: now - 1000 } }), true)
  // 没有记录过期时间的老账号 → 交给 401 触发
  assert.equal(isStale({ metadata: {} }), false)
})

test("WEB_TOKEN_TTL 与站点前端的 7 天一致", () => {
  assert.equal(WEB_TOKEN_TTL, 7 * 24 * 3600 * 1000)
})

// ---- 签到结果映射 ------------------------------------------------------------

test("checkinOutcome 把三种结果映射成 magpie 的 outcome", () => {
  // 刚签成功
  assert.deepEqual(
    checkinOutcome({ state: "done", credit: 10, streak: 3 }),
    { outcome: "claimed", credit: 10, streak: 3, message: "签到成功 +10 鱼币 · 连续 3 天" }
  )
  // 今天已签：不是失败
  const done = checkinOutcome({ state: "already", credit: 10, detail: "今天已签到 +10 鱼币，明天再来" })
  assert.equal(done.outcome, "done")
  assert.equal(done.credit, 10)
  // 真失败
  const failed = checkinOutcome({ state: "failed", detail: "签到服务暂时不可用" })
  assert.equal(failed.outcome, "failed")
  assert.match(failed.message, /不可用/)
})

test("checkinOutcome 在奖励缺失时也不编数字", () => {
  const r = checkinOutcome({ state: "done" })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, undefined)
  assert.equal(r.streak, undefined)
  assert.equal(r.message, "签到成功")
})

test("checkinOutcome 透传登录失效标记", () => {
  const r = checkinOutcome({ state: "failed", detail: "认证失败", signIn: "expired" })
  assert.equal(r.outcome, "failed")
  assert.equal(r.signIn, "expired")
})

test("localDate 用本地时区，不受 UTC 偏移影响", () => {
  assert.equal(localDate(new Date(2026, 10, 13, 0, 5)), "2026-11-13")
  assert.equal(localDate(new Date(2026, 10, 13, 23, 55)), "2026-11-13")
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/)
})

// ---- 鱼币余额 ----------------------------------------------------------------

test("pointsWindow 显示鱼币总数，不把字符串当数字", () => {
  // 站点返回的是字符串 "40.0000"，必须转换后再展示
  const w = pointsWindow({
    giftPoints: "40.0000",
    heldPoints: "0.0000",
    paidPoints: "0.0000",
    totalPoints: "40.0000",
  })
  assert.equal(w.name, "鱼币余额")
  assert.equal(w.display, "40 鱼币")
  assert.equal(w.aside, true, "只展示，不参与路由")
})

test("pointsWindow 在充值与冻结非零时展开细分", () => {
  const w = pointsWindow({
    giftPoints: "40.0000",
    heldPoints: "5.0000",
    paidPoints: "100.0000",
    totalPoints: "145.0000",
  })
  assert.match(w.display, /145 鱼币/)
  assert.match(w.display, /赠送 40/)
  assert.match(w.display, /充值 100/)
  assert.match(w.display, /冻结 5/)
})

test("pointsWindow 在钱包为空时返回 null，不编造 0", () => {
  assert.equal(pointsWindow({}), null)
  assert.equal(pointsWindow(undefined), null)
})

test("pointsWindow 与 token 余额是两套单位，不写进 balance", () => {
  // 鱼币是站内货币，token 是模型用量；混在一起会得到没有意义的数字
  const w = pointsWindow({ totalPoints: "40.0000", giftPoints: "40.0000" })
  assert.equal(w.balance, undefined)
  assert.match(w.display, /鱼币/)
})

// ---- 今日用量 ----------------------------------------------------------------

test("dailyWindow 的 token 口径包含缓存读（与站点一致）", () => {
  // 站点「Token」= 未命中输入 + 缓存读 + 输出
  const w = dailyWindow({
    daily: [
      {
        date: localDate(),
        inputTokens: 1156619,
        cacheReadTokens: 4533632,
        outputTokens: 9462,
        requests: 17,
      },
    ],
  })
  assert.equal(w.name, "今日用量")
  assert.equal(w.display, "569.97 万 token · 17 次调用")
  assert.equal(w.aside, true)
})

test("dailyWindow 在今天没有调用时明确说暂无调用", () => {
  const w = dailyWindow({
    daily: [{ date: localDate(), inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, requests: 0 }],
  })
  assert.equal(w.display, "今日暂无调用")
})

test("dailyWindow 找不到今天那行时退回最后一行", () => {
  const w = dailyWindow({
    daily: [
      { date: "2026-01-01", inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, requests: 1 },
      { date: "2026-01-02", inputTokens: 100, cacheReadTokens: 0, outputTokens: 0, requests: 2 },
    ],
    // 今天不在列表里
  })
  assert.equal(w.display, "100 token · 2 次调用")
})

test("dailyWindow 没有数据时返回 null，不编造 0", () => {
  assert.equal(dailyWindow({}), null)
  assert.equal(dailyWindow({ daily: [] }), null)
  assert.equal(dailyWindow(undefined), null)
})
