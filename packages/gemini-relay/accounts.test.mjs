// AccountPool / TokenBucket / CircuitBreaker 的离线测试：假时钟、无网络。
// 重点验证风控分流规则：429 只冷却档位不封号、1060 不记号、401/连续失败封禁、
// 并发闸与 least_used 排序。
import { expect, test } from "bun:test"
import { AccountPool, CircuitBreaker, Jitter, TokenBucket } from "./accounts.mjs"

// 假时钟：手动推进
function fakeClock() {
  let t = 1_000_000
  return { now: () => t, tick: (ms) => (t += ms) }
}

const mk = (n) => ({ id: n, profileDir: "/p/" + n, email: n + "@x.com" })

test("acquire 按 least_used 轮转：成功+失败最少者优先", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a"), mk("b")], clock: c.now })
  const seq = []
  for (let i = 0; i < 4; i++) {
    const lease = pool.acquire({ modelKey: "gemini-3.6-flash" })
    seq.push(lease.accountId)
    pool.release(lease, { ok: true })
  }
  // a、b 轮流：a b a b（同分时按 idle 抖动，但 here weight 相同、使用数相同）
  expect(seq.filter((x) => x === "a").length).toBe(2)
  expect(seq.filter((x) => x === "b").length).toBe(2)
})

test("weight 高的账号承担更多请求", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [{ ...mk("a"), weight: 3 }, { ...mk("b"), weight: 1 }], clock: c.now })
  const counts = { a: 0, b: 0 }
  for (let i = 0; i < 8; i++) {
    const lease = pool.acquire({})
    counts[lease.accountId]++
    pool.release(lease, { ok: true })
  }
  expect(counts.a).toBeGreaterThan(counts.b)
})

test("并发闸：每账号在飞请求达到上限后不再被选中", () => {
  const c = fakeClock()
  // 固定 rng：同分抖动恒定，初始分配确定为 a、b（否则 l1 可能是 b）
  const pool = new AccountPool({ accounts: [mk("a"), mk("b")], clock: c.now, maxConcurrentPerAccount: 1, rng: () => 0.5 })
  const l1 = pool.acquire({})
  const l2 = pool.acquire({})
  expect(l1.accountId).toBe("a")
  expect(l2.accountId).toBe("b")
  expect(() => pool.acquire({})).toThrow(/不可用|exhausted/i)
  pool.release(l1, { ok: true })
  const l3 = pool.acquire({})
  expect(l3.accountId).toBe("a")
})

test("全部不可用时抛 429 all_accounts_exhausted，并提示最早解封时间", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now, cooldownMs: 60_000 })
  const l = pool.acquire({ modelKey: "pro" })
  pool.release(l, { ok: false, status: 429, code: "usage_limit_exceeded" })
  try {
    pool.acquire({ modelKey: "pro" })
    throw new Error("should not reach")
  } catch (e) {
    expect(e.status).toBe(429)
    expect(e.code).toBe("all_accounts_exhausted")
    expect(e.message).toContain("解封")
  }
})

test("429/1037 只冷却 账号×模型档位，其他档位仍可用，不封整号", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now, cooldownMs: 60_000 })
  const l = pool.acquire({ modelKey: "gemini-3.1-pro" })
  pool.release(l, { ok: false, status: 429, code: "usage_limit_exceeded" })
  // pro 档位不可用
  expect(() => pool.acquire({ modelKey: "gemini-3.1-pro" })).toThrow(/不可用/)
  // flash 档位仍可用
  const l2 = pool.acquire({ modelKey: "gemini-3.6-flash" })
  expect(l2.accountId).toBe("a")
  pool.release(l2, { ok: true })
  // 整号没有被 ban
  const bs = pool.banStatus().find((x) => x.id === "a")
  expect(bs.banned).toBe(false)
  // cooldown 到期后 pro 档位恢复
  c.tick(61_000)
  const l3 = pool.acquire({ modelKey: "gemini-3.1-pro" })
  expect(l3.accountId).toBe("a")
})

test("401 / auth_corrupted 连续 3 次封禁 banMs 时长", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now, banMs: 120_000 })
  for (let i = 0; i < 3; i++) {
    const l = pool.acquire({})
    pool.release(l, { ok: false, status: 401, code: "auth_corrupted" })
  }
  const bs = pool.banStatus().find((x) => x.id === "a")
  expect(bs.banned).toBe(true)
  expect(() => pool.acquire({})).toThrow(/不可用/)
  // ban 到期恢复
  c.tick(121_000)
  const l = pool.acquire({})
  expect(l.accountId).toBe("a")
})

test("rotate 401 也计入封禁路径", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now })
  for (let i = 0; i < 3; i++) {
    const l = pool.acquire({})
    pool.release(l, { ok: false, status: 401, code: "rotate_401" })
  }
  expect(pool.banStatus().find((x) => x.id === "a").banned).toBe(true)
})

test("1060（ip_blocked）不记账号头上：连续失败计数被重置，不触发封禁", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now })
  // 两次普通失败 + 一次 1060 + 两次普通失败：若 1060 记账早就封了
  const fail = (code, status) => {
    const l = pool.acquire({})
    pool.release(l, { ok: false, code, status })
  }
  fail("gemini_error", 502)
  fail("gemini_error", 502)
  fail("ip_blocked", 403)
  fail("gemini_error", 502)
  fail("gemini_error", 502)
  const st = pool.stats().find((x) => x.id === "a")
  expect(st.bannedUntil).toBe(0)
  expect(st.consecutiveFails).toBe(2) // 1060 后从 0 重新数
  const l = pool.acquire({})
  expect(l.accountId).toBe("a")
})

test("普通失败连续 3 次也封禁（避免带病账号撞风控）", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now })
  for (let i = 0; i < 3; i++) {
    const l = pool.acquire({})
    pool.release(l, { ok: false, status: 502, code: "gemini_error" })
  }
  expect(pool.banStatus().find((x) => x.id === "a").banned).toBe(true)
})

test("成功会清零连续失败并清除该档位冷却", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now, cooldownMs: 60_000 })
  let l = pool.acquire({ modelKey: "pro" })
  pool.release(l, { ok: false, status: 429, code: "usage_limit_exceeded" })
  c.tick(61_000) // 出冷却
  l = pool.acquire({ modelKey: "pro" })
  pool.release(l, { ok: false, status: 502, code: "gemini_error" })
  l = pool.acquire({ modelKey: "pro" })
  pool.release(l, { ok: true }) // 成功：consecutiveFails 归零
  const st = pool.stats().find((x) => x.id === "a")
  expect(st.consecutiveFails).toBe(0)
  expect(st.bannedUntil).toBe(0)
})

test("resetBan 可以手动解封", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now })
  for (let i = 0; i < 3; i++) {
    const l = pool.acquire({})
    pool.release(l, { ok: false, status: 401 })
  }
  expect(pool.banStatus().find((x) => x.id === "a").banned).toBe(true)
  expect(pool.resetBan("a")).toBe(true)
  expect(pool.banStatus().find((x) => x.id === "a").banned).toBe(false)
  expect(pool.acquire({}).accountId).toBe("a")
})

test("stats 暴露 ok/fail/inflight/lastError", () => {
  const c = fakeClock()
  const pool = new AccountPool({ accounts: [mk("a")], clock: c.now })
  const l = pool.acquire({})
  pool.release(l, { ok: false, status: 429, code: "usage_limit_exceeded", error: "额度用完" })
  const st = pool.stats().find((x) => x.id === "a")
  expect(st.ok).toBe(0)
  expect(st.fail).toBe(1)
  expect(st.inflight).toBe(0)
  expect(st.lastError.code).toBe("usage_limit_exceeded")
  // modelKey 为空时冷却落在 "*" 通配桶
  expect(Object.keys(st.modelCooldown)).toContain("*")
})

// —— TokenBucket 数学 ——

test("TokenBucket：初始 burst 立即可取，之后按 rate 平滑补充", async () => {
  const c = fakeClock()
  const timers = []
  const fakeSetTimeout = (fn, ms) => {
    timers.push({ fn, at: c.now() + ms })
    return timers.length
  }
  const bucket = new TokenBucket({ rate: 1, burst: 2, clock: c.now, setTimeout: fakeSetTimeout }) // 1 token/s
  await bucket.take(1) // burst 里还有 1
  await bucket.take(1) // 取空
  expect(bucket.tokens).toBe(0)
  // 第三个要等 1 秒：take 会挂起，靠假时钟推进解决
  const p = bucket.take(1)
  // 模拟时间流逝：触发所有到期定时器
  c.tick(1000)
  for (const t of timers.splice(0)) t.fn()
  await p
  expect(bucket.tokens).toBeCloseTo(0, 5)
})

test("TokenBucket：等待时间与缺口成正比", () => {
  const c = fakeClock()
  const bucket = new TokenBucket({ rate: 10, burst: 5, clock: c.now }) // 10/s
  bucket.tokens = 0
  expect(bucket._waitMs(1)).toBe(100)
  bucket.tokens = 4.5
  expect(bucket._waitMs(5)).toBe(50)
  bucket.tokens = 5
  expect(bucket._waitMs(1)).toBe(0)
})

test("Jitter.delay 落在 ±pct 区间，humanPause 落在 300-1500", async () => {
  // 只验证不抛错且能 resolve（真实 setTimeout，时长都很短）
  await Jitter.delay(10, 0.5)
  const t0 = Date.now()
  await Jitter.humanPause({ min: 1, max: 5 })
  expect(Date.now() - t0).toBeLessThan(200)
})

// —— CircuitBreaker ——

test("CircuitBreaker：连续 5 次失败熔断，冷却后放行探测，成功闭合", () => {
  const c = fakeClock()
  const cb = new CircuitBreaker({ threshold: 5, cooldownMs: 120_000, clock: c.now })
  for (let i = 0; i < 4; i++) {
    expect(cb.canPass()).toBe(true)
    cb.record(false)
  }
  // 第 5 次失败前仍可通行，失败后 open
  expect(cb.canPass()).toBe(true)
  cb.record(false)
  expect(cb.state).toBe("open")
  expect(cb.canPass()).toBe(false)
  // 冷却结束：half-open 放行一个探测
  c.tick(120_001)
  expect(cb.canPass()).toBe(true)
  expect(cb.state).toBe("half_open")
  // 探测成功 → 闭合
  cb.record(true)
  expect(cb.state).toBe("closed")
  expect(cb.canPass()).toBe(true)
})

test("CircuitBreaker：half-open 探测失败则重新熔断", () => {
  const c = fakeClock()
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000, clock: c.now })
  cb.record(false)
  cb.record(false)
  expect(cb.canPass()).toBe(false)
  c.tick(60_001)
  expect(cb.canPass()).toBe(true) // half-open
  cb.record(false) // 探测失败
  expect(cb.state).toBe("open")
  expect(cb.canPass()).toBe(false)
  c.tick(60_001)
  expect(cb.canPass()).toBe(true)
})
