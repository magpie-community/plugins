// 账号池与风控调度：把“哪个账号现在最不容易被注意”做成可测的纯逻辑。
//
// 风控哲学（对齐用户“封号风险降到最低”的要求）：
//  1. 单账号不要打太狠 —— least_used 轮转 + 每账号并发闸 + 全局/单账号令牌桶限速；
//  2. 请求之间留“人味” —— Jitter 随机停顿，避免机器般均匀的节奏；
//  3. 失败要分级记责 —— 配额类失败（429/1037）只让“账号×模型档位”进冷却，
//     不牵连整号（额度是按模型档位算的）；出口 IP 被封（1060）不记在账号头上；
//     只有鉴权失效（401/auth_corrupted）和连续普通失败才升级为封禁。
//  4. 连续熔断 —— CircuitBreaker 在连续失败时主动停手，避免带着错误身份
//     反复撞墙（反复撞墙正是风控最容易盯上的行为模式）。
//
// 本文件不碰网络、不碰浏览器，全部逻辑可离线测试（支持注入假时钟）。

// GeminiError 优先用 relay.mjs 的正主；但 relay 的依赖链（webchannel/prompt）
// 正在被并行开发，一旦临时断裂，调度逻辑必须仍能离线工作——所以先放一个
// 同形的本地兜底，模块加载后异步换成正主（换不上就一直是兜底，形状一致）。
let GeminiError = class GeminiError extends Error {
  constructor(message, { code = "gemini_error", status = 502, signIn = false } = {}) {
    super(message)
    this.name = "GeminiError"
    this.code = code
    this.status = status
    this.signIn = signIn
  }
}
import("./relay.mjs")
  .then((m) => {
    if (m?.GeminiError) GeminiError = m.GeminiError
  })
  .catch(() => {})

// 连续失败达到该次数即封禁该账号（banMs 时长）
const BAN_AFTER_FAILS = 3

// —— 内部工具 ——

const now = (clock) => (clock ? clock() : Date.now())

function randomInt(max) {
  // crypto 随机，取模偏差可忽略（max 很小）
  const buf = new Uint32Array(1)
  ;(globalThis.crypto || { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 4294967296)) }).getRandomValues(buf)
  return buf[0] % max
}

// 每个账号的运行时状态（不序列化、纯内存）
function newAccountState(def) {
  return {
    id: def.id,
    profileDir: def.profileDir,
    email: def.email ?? "",
    weight: def.weight ?? 1,
    ok: 0, // 成功请求数
    fail: 0, // 失败请求数
    consecutiveFails: 0,
    cooldownUntil: 0, // 配额冷却（账号×模型粒度另有 map，这里是整号级备用）
    bannedUntil: 0,
    inflight: 0,
    lastUsedAt: 0,
    lastSuccessAt: 0,
    lastError: null, // { status, code, error, at }
    // 账号×模型档位 的配额冷却：429/1037 只冷却该档位，不封整号
    modelCooldown: new Map(), // modelKey -> until
  }
}

export class AccountPool {
  constructor({
    accounts = [],
    strategy = "least_used",
    cooldownMs = 15 * 60_000,
    banMs = 2 * 60 * 60_000,
    maxConcurrentPerAccount = 2,
    clock,
    rng,
  } = {}) {
    this.strategy = strategy
    this.cooldownMs = cooldownMs
    this.banMs = banMs
    this.maxConcurrentPerAccount = maxConcurrentPerAccount
    this.clock = clock // 可注入假时钟：() => ms
    this.rng = rng ?? Math.random
    this.accounts = new Map()
    this.leases = new Map() // leaseId -> { account, modelKey, acquiredAt, released }
    this._leaseSeq = 0
    this.events = [] // 风控事件（封禁/冷却），供 stats/排查
    for (const a of accounts) this.accounts.set(a.id, newAccountState(a))
  }

  _t() {
    return now(this.clock)
  }

  _event(type, id, detail) {
    this.events.push({ type, id, at: this._t(), ...detail })
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200)
  }

  // 账号当前是否可用（不考并发闸）
  // 账号对“这次请求的模型档位”是否可用：整号 ban/冷却，或该档位在冷却。
  // 注意：pro 档位的 429 冷却不影响 flash 档位——额度是按模型档位算的。
  _available(st, t, modelKey = "") {
    if (st.bannedUntil > t) return false
    if (st.cooldownUntil > t) return false
    const mc = st.modelCooldown.get(modelKey)
    if (mc > t) return false
    const star = st.modelCooldown.get("*")
    if (star > t) return false
    return true
  }

  // 该账号在该模型档位上最早何时解冻（ Infinity 表示被封看不到头）
  _freeAt(st, modelKey, t) {
    let at = Math.max(st.bannedUntil, st.cooldownUntil)
    for (const key of [modelKey, "*"]) {
      const mc = st.modelCooldown.get(key)
      if (mc > t) at = Math.max(at, mc)
    }
    return at
  }

  // 候选排序：least_used（成功+失败最少）→ weight 高优先 → 最久未用优先；
  // 同分用随机抖动打散，避免每次都精确命中同一账号。
  _rank(candidates, t) {
    const jitter = () => this.rng() * 0.001 // 同分内的微抖动
    const scored = candidates.map((st) => {
      const used = st.ok + st.fail
      // 分数越小越优先；weight 越大除得越多，分数越小
      const score = used / Math.max(0.0001, st.weight) + jitter()
      return { st, score, used, idle: t - (st.lastUsedAt || 0) }
    })
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      if (a.idle !== b.idle) return b.idle - a.idle // 最久未用优先
      return 0
    })
    return scored
  }

  // acquire 租出一个可用账号。全部不可用时抛 429 风格 GeminiError，
  // message 里说明最早解封时间，方便上层提示用户。
  acquire({ modelKey = "" } = {}) {
    const t = this._t()
    const candidates = []
    let earliestFree = Infinity
    let earliestWho = ""
    for (const st of this.accounts.values()) {
      if (st.inflight >= this.maxConcurrentPerAccount) {
        const freeAt = this._freeAt(st, modelKey, t)
        if (freeAt < earliestFree) {
          earliestFree = freeAt
          earliestWho = st.email || st.id
        }
        continue
      }
      if (!this._available(st, t, modelKey)) {
        const freeAt = this._freeAt(st, modelKey, t)
        if (freeAt < earliestFree) {
          earliestFree = freeAt
          earliestWho = st.email || st.id
        }
        continue
      }
      candidates.push(st)
    }
    if (!candidates.length) {
      const who = earliestWho ? `（${earliestWho}）` : ""
      const when = earliestFree === Infinity ? "未知" : new Date(earliestFree).toLocaleString("zh-CN")
      throw new GeminiError(`所有 Gemini 账号当前都不可用${who}，最早解封时间约为 ${when}。请稍后再试或增加账号。`, {
        code: "all_accounts_exhausted",
        status: 429,
      })
    }
    const ranked = this._rank(candidates, t)
    // least_used 策略取分数最优者；将来可按 strategy 扩展 round_robin 等
    const pick = ranked[0].st
    pick.inflight++
    pick.lastUsedAt = t
    const leaseId = "lease-" + ++this._leaseSeq
    const lease = {
      id: leaseId,
      accountId: pick.id,
      profileDir: pick.profileDir,
      email: pick.email,
      modelKey,
      acquiredAt: t,
      released: false,
    }
    this.leases.set(leaseId, { account: pick, modelKey, acquiredAt: t, released: false })
    return lease
  }

  // release 归还租约并上报结果。ok=false 时按错误分流（见文件头注释）。
  release(lease, { ok = true, status, code, error } = {}) {
    if (!lease) return
    const rec = this.leases.get(lease.id)
    const st = rec?.account ?? this.accounts.get(lease.accountId)
    if (rec) {
      rec.released = true
      this.leases.delete(lease.id)
    }
    if (!st) return
    st.inflight = Math.max(0, st.inflight - 1)
    const t = this._t()
    if (ok) {
      st.ok++
      st.consecutiveFails = 0
      st.lastSuccessAt = t
      st.lastError = null
      // 成功时顺手清掉该档位的配额冷却（服务端已经恢复放行了）
      if (lease.modelKey) st.modelCooldown.delete(lease.modelKey)
      return
    }
    st.fail++
    st.lastError = { status, code, error: String(error ?? "").slice(0, 300), at: t }
    const c = String(code ?? "")
    if (c === "usage_limit_exceeded" || status === 429) {
      // 配额类失败：只冷却 账号×模型档位，不封整号（额度按模型档位算）
      const until = t + this.cooldownMs
      const key = lease.modelKey || "*"
      const prev = st.modelCooldown.get(key) ?? 0
      st.modelCooldown.set(key, Math.max(prev, until))
      this._event("cooldown", st.id, { modelKey: key, until })
      return
    }
    if (c === "ip_blocked" || c === "1060") {
      // 出口 IP 被封：不记在账号头上，只透传给上层处理（换代理等）。
      // 但也重置连续失败计数：这不是账号的问题，不该累计到封禁。
      st.consecutiveFails = 0
      this._event("ip_blocked_passthrough", st.id, { status, code })
      return
    }
    if (c === "auth_corrupted" || c === "rotate_401" || status === 401) {
      st.consecutiveFails++
      this._event("auth_fail", st.id, { status, code, consecutiveFails: st.consecutiveFails })
      if (st.consecutiveFails >= BAN_AFTER_FAILS) {
        st.bannedUntil = t + this.banMs
        this._event("ban", st.id, { reason: "auth", until: st.bannedUntil })
      }
      return
    }
    // 其他失败：连续失败达到阈值也封（避免带病账号反复撞风控）
    st.consecutiveFails++
    if (st.consecutiveFails >= BAN_AFTER_FAILS) {
      st.bannedUntil = t + this.banMs
      this._event("ban", st.id, { reason: "consecutive", code, status, until: st.bannedUntil })
    }
  }

  // stats：给管理面/日志看的快照
  stats() {
    const t = this._t()
    return [...this.accounts.values()].map((st) => ({
      id: st.id,
      email: st.email,
      weight: st.weight,
      ok: st.ok,
      fail: st.fail,
      consecutiveFails: st.consecutiveFails,
      cooldownUntil: st.cooldownUntil,
      bannedUntil: st.bannedUntil,
      modelCooldown: Object.fromEntries([...st.modelCooldown.entries()].filter(([, v]) => v > t)),
      inflight: st.inflight,
      lastUsedAt: st.lastUsedAt,
      lastSuccessAt: st.lastSuccessAt,
      lastError: st.lastError,
      available: this._available(st, t, "") && st.inflight < this.maxConcurrentPerAccount,
    }))
  }

  banStatus() {
    const t = this._t()
    return [...this.accounts.values()].map((st) => ({
      id: st.id,
      banned: st.bannedUntil > t,
      bannedUntil: st.bannedUntil,
      cooldown: [...st.modelCooldown.entries()].filter(([, v]) => v > t).map(([k, v]) => ({ modelKey: k, until: v })),
    }))
  }

  resetBan(id) {
    const st = this.accounts.get(id)
    if (!st) return false
    st.bannedUntil = 0
    st.cooldownUntil = 0
    st.consecutiveFails = 0
    st.modelCooldown.clear()
    return true
  }
}

// —— 限速 ——

// TokenBucket：平滑限速。rate 个/秒，burst 桶容量。take(n) 在桶里不够时
// 等待到补足为止。用可注入时钟/定时器便于测试。
export class TokenBucket {
  constructor({ rate, burst, clock, setTimeout: st = setTimeout } = {}) {
    this.rate = rate // tokens per second
    this.burst = burst ?? rate
    this.tokens = this.burst
    this.last = clock ? clock() : Date.now()
    this.clock = clock
    this._setTimeout = st
  }

  _refill() {
    const t = this.clock ? this.clock() : Date.now()
    const elapsed = (t - this.last) / 1000
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate)
      this.last = t
    }
  }

  // 需要等多久才能取出 n 个（毫秒）
  _waitMs(n) {
    this._refill()
    if (this.tokens >= n) return 0
    return Math.ceil(((n - this.tokens) / this.rate) * 1000)
  }

  async take(n = 1) {
    for (;;) {
      const wait = this._waitMs(n)
      if (wait <= 0) {
        this.tokens -= n
        return
      }
      await new Promise((r) => this._setTimeout(r, Math.min(wait, 1000)))
    }
  }
}

// Jitter：拟人化停顿。humanPause 是 300–1500ms 的随机间隔，模拟人打字/
// 思考的节奏；delay(ms, pct) 在给定时长上加 ±pct% 抖动。
export class Jitter {
  static delay(ms, pct = 0.2, { setTimeout: st = setTimeout } = {}) {
    const delta = ms * pct
    const actual = Math.max(0, ms + (Math.random() * 2 - 1) * delta)
    return new Promise((r) => st(r, actual))
  }

  static humanPause({ min = 300, max = 1500, setTimeout: st = setTimeout } = {}) {
    const ms = min + Math.random() * (max - min)
    return new Promise((r) => st(r, ms))
  }
}

// CircuitBreaker：连续 threshold 次失败后熔断 cooldownMs 毫秒，
// 冷却结束后放一个探测请求（half-open），成功则闭合，失败则重新计时。
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 120_000, clock } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.clock = clock
    this.fails = 0
    this.openedAt = 0
    this.state = "closed" // closed | open | half_open
  }

  _t() {
    return this.clock ? this.clock() : Date.now()
  }

  canPass() {
    const t = this._t()
    if (this.state === "open") {
      if (t - this.openedAt >= this.cooldownMs) {
        this.state = "half_open" // 放一个探测请求过去
        return true
      }
      return false
    }
    return true
  }

  record(ok) {
    if (ok) {
      this.fails = 0
      this.state = "closed"
      return
    }
    this.fails++
    if (this.state === "half_open" || this.fails >= this.threshold) {
      this.state = "open"
      this.openedAt = this._t()
      this.fails = 0
    }
  }
}
