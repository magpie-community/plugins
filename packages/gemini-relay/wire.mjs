// 可选的高级入口：多账号风控反代。把 AccountPool（选号/限流/熔断）、
// 每账号一个常驻 RelayBrowser、UsageTracker（额度可见）接到一起。
//
// index.mjs 的默认单账号路径不变（避免与其他改动冲突）；要启用多账号
// 调度时用这里：
//
//   import { createAccountAwareRelay } from "./wire.mjs"
//   const relay = createAccountAwareRelay({
//     accounts: [
//       { id: "a1", profileDir: "C:/.../gemini-relay-browser/xxxx", weight: 1 },
//       { id: "a2", profileDir: "C:/.../gemini-relay-browser/yyyy", weight: 2, email: "me@gmail.com" },
//     ],
//     options: { headless: true },
//   })
//   const r = await relay.ask("你好", { model: "gemini-3.1-pro" })
//   const usage = await relay.usage("a1")
//
// 风控行为：least_used 选号 + 每账号 6 rpm / 全局 20 rpm 令牌桶 +
// 请求间随机人味停顿 + 429 只冷却“账号×模型档位” + 401/连续失败封禁 +
// IP 被封不记账号头上。
import { GeminiError, MODELS, RelaySession, thinkingByte } from "./relay.mjs"
import { RelayBrowser } from "./browser.mjs"
import { AccountPool, CircuitBreaker, Jitter, TokenBucket } from "./accounts.mjs"
import { UsageTracker } from "./usage.mjs"

export function createAccountAwareRelay({ accounts = [], options = {} } = {}) {
  const headless = options.headless ?? true
  // 每账号 6 rpm、全局 20 rpm（可被 options 覆盖）
  const perAccountRpm = options.perAccountRpm ?? 6
  const globalRpm = options.globalRpm ?? 20
  const humanPause = options.humanPause ?? true

  const pool = new AccountPool({
    accounts,
    cooldownMs: options.cooldownMs,
    banMs: options.banMs,
    maxConcurrentPerAccount: options.maxConcurrentPerAccount ?? 2,
  })
  const globalBucket = new TokenBucket({ rate: globalRpm / 60, burst: Math.max(1, Math.ceil(globalRpm / 60)) })
  const accountBuckets = new Map() // accountId -> TokenBucket
  const breakers = new Map() // accountId -> CircuitBreaker
  const browsers = new Map() // accountId -> RelayBrowser
  const trackers = new Map() // accountId -> UsageTracker
  const sessions = new Map() // accountId -> RelaySession

  const bucketFor = (id) => {
    let b = accountBuckets.get(id)
    if (!b) {
      b = new TokenBucket({ rate: perAccountRpm / 60, burst: Math.max(1, Math.ceil(perAccountRpm / 60)) })
      accountBuckets.set(id, b)
    }
    return b
  }
  const breakerFor = (id) => {
    let c = breakers.get(id)
    if (!c) {
      c = new CircuitBreaker({ threshold: options.breakerThreshold ?? 5, cooldownMs: options.breakerCooldownMs ?? 120_000 })
      breakers.set(id, c)
    }
    return c
  }
  const browserFor = (lease) => {
    let b = browsers.get(lease.accountId)
    if (!b) {
      b = new RelayBrowser({ profileDir: lease.profileDir, headless })
      browsers.set(lease.accountId, b)
    }
    return b
  }
  const sessionFor = (lease) => {
    let s = sessions.get(lease.accountId)
    if (!s) {
      s = new RelaySession({ browser: browserFor(lease) })
      sessions.set(lease.accountId, s)
    }
    return s
  }
  const trackerFor = (lease) => {
    let t = trackers.get(lease.accountId)
    if (!t) {
      t = new UsageTracker({ page: browserFor(lease).ensure, account: lease.accountId })
      // UsageTracker 需要一个有 eval 的 page；这里惰性拿当前 page
      trackers.set(lease.accountId, t)
    }
    return t
  }

  // model 解析：名字 → MODELS 条目 + reasoning_effort → b15
  function resolveModel(model, reasoningEffort) {
    const key = String(model ?? "gemini-auto").replace(/^gemini-relay\//, "")
    const m = MODELS[key]
    if (!m) throw new GeminiError(`没有模型 ${key}。可用：${Object.keys(MODELS).join("、")}。`, { code: "model_not_found", status: 404 })
    if (reasoningEffort) {
      const b15 = thinkingByte(reasoningEffort)
      if (m.b14 !== 3) throw new GeminiError(`模型 ${m.name} 没有思考深度选择，reasoning_effort 仅 gemini-3.1-pro 支持。`, { code: "invalid_request_error", status: 400 })
      return { ...m, b15 }
    }
    return m
  }

  async function ask(prompt, { model, messages, signal, strictModel = true, reasoningEffort } = {}) {
    if (messages?.length && !prompt) prompt = messages.map((m) => `[${m.role}]\n${m.content ?? ""}`).join("\n\n")
    const m = resolveModel(model, reasoningEffort)
    const modelKey = String(model ?? "gemini-auto")
    // 熔断是出口/代理粒度的兜底：任何一个账号连续失败都先停一停
    const globalBreaker = breakerFor("__global__")
    if (!globalBreaker.canPass())
      throw new GeminiError("连续失败触发了全局熔断，稍等两分钟再试（避免带病请求反复撞风控）。", { code: "circuit_open", status: 503 })
    const lease = pool.acquire({ modelKey })
    const acctBreaker = breakerFor(lease.accountId)
    if (!acctBreaker.canPass()) {
      pool.release(lease, { ok: false, code: "circuit_open", status: 503, error: "账号熔断中" })
      throw new GeminiError(`账号 ${lease.email || lease.accountId} 触发熔断，正在冷却。`, { code: "circuit_open", status: 503 })
    }
    try {
      await globalBucket.take(1)
      await bucketFor(lease.accountId).take(1)
      if (humanPause) await Jitter.humanPause()
      if (signal?.aborted) throw new GeminiError("已取消", { code: "aborted", status: 499 })
      const session = sessionFor(lease)
      const final = await session.ask(prompt, { model: m, signal, strictModel })
      pool.release(lease, { ok: true })
      acctBreaker.record(true)
      globalBreaker.record(true)
      return { ...final, accountId: lease.accountId }
    } catch (e) {
      acctBreaker.record(false)
      globalBreaker.record(false)
      // 分流规则在 AccountPool.release 里：429/1037 冷却档位、401/连续失败封禁、1060 不记号
      pool.release(lease, { ok: false, status: e?.status, code: e?.code, error: e?.message })
      throw e
    }
  }

  // usage(accountId)：该账号的额度快照（60s 缓存，尽力而为不抛错）
  async function usage(accountId) {
    const lease = { accountId, profileDir: accounts.find((a) => a.id === accountId)?.profileDir }
    if (!lease.profileDir) throw new GeminiError(`没有账号 ${accountId}。`, { code: "account_not_found", status: 404 })
    const b = browserFor(lease)
    const page = await b.ensure()
    let t = trackers.get(accountId)
    if (!t) {
      t = new UsageTracker({ page, account: accountId })
      trackers.set(accountId, t)
    } else {
      t.page = page // 浏览器可能重开过，page 要跟最新的走
    }
    return t.snapshot()
  }

  function stats() {
    return {
      accounts: pool.stats(),
      bans: pool.banStatus(),
      browsers: [...browsers.entries()].map(([id, b]) => ({ id, started: b.started() })),
      config: { perAccountRpm, globalRpm, humanPause, headless },
    }
  }

  async function dispose() {
    for (const b of browsers.values()) await b.stop().catch(() => {})
  }

  return { ask, usage, stats, dispose, pool }
}
