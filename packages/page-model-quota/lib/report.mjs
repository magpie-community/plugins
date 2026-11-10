// 估算每个模型在所有额度池里还剩多少 token。
//
// 口径：token 指一次请求实际处理的全部 token，即 in + out + cache_read + cache_write + reasoning。
// 某个窗口“1% 额度值多少 token”由历史推得：取该窗口当前这一轮的读数区间，
// 用区间内该账号消耗的 token 除以掉掉的百分比。
//
// 一个窗口的剩余 token = 剩余百分比 × 每百分比 token。
// 再把窗口的剩余 token 按该账号在窗口内的模型占比摊到各模型，最后跨账号、跨供应商按模型相加。

const DAY = 24 * 60 * 60 * 1000

export function tokensOf(row) {
  return Number(row.in || 0) + Number(row.out || 0) + Number(row.cache_read || 0) +
    Number(row.cache_write || 0) + Number(row.reasoning || 0)
}

// 去掉模型名后面的上下文容量后缀，让同一个模型的 500k、256k 之类归到一起：
//   grok-4.7@500k / grok-4.7@256k  ->  grok-4.7
//   claude-fable-5-1[1m]           ->  claude-fable-5-1
//   grok-4.7-500k                  ->  grok-4.7
export function cleanModelName(name) {
  let s = String(name ?? "").trim()
  s = s.replace(/\s*@\S*$/, "")
  s = s.replace(/\s*\[[^\]]*\]\s*$/, "")
  s = s.replace(/[-_ ]\d+k$/i, "")
  return s.trim()
}

// 模型名归一：跨供应商、跨大小写、跨分隔符归到同一个键。
export function canonModel(name) {
  return cleanModelName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

// 把逐条 usage 记录按账号建索引，并附上按时间排序的前缀和，便于任意区间求和。
export function indexUsage(rows, { now = Date.now(), shareWindowMs = 7 * DAY } = {}) {
  const accounts = new Map()
  const modelDaily = new Map() // canon -> {tokens}
  const displayCount = new Map() // canon -> Map<raw, count>（全量统计，名字更全）

  for (const row of rows) {
    const key = `${row.provider || ""}|${row.providerAccount || ""}`
    if (!accounts.has(key)) accounts.set(key, { rows: [] })
    accounts.get(key).rows.push(row)

    const c = canonModel(row.model || row.served || "?")
    if (!displayCount.has(c)) displayCount.set(c, new Map())
    const dc = displayCount.get(c)
    const raw = cleanModelName(row.model || row.served || "?")
    dc.set(raw, (dc.get(raw) || 0) + 1)

    const t = Date.parse(row.t)
    const tk = tokensOf(row)
    if (Number.isFinite(t) && now - t <= shareWindowMs) {
      if (!modelDaily.has(c)) modelDaily.set(c, { tokens: 0 })
      modelDaily.get(c).tokens += tk
    }
  }

  for (const acc of accounts.values()) {
    acc.rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    acc.times = acc.rows.map((r) => Date.parse(r.t))
    acc.cum = new Array(acc.rows.length)
    let sum = 0
    for (let i = 0; i < acc.rows.length; i++) {
      sum += tokensOf(acc.rows[i])
      acc.cum[i] = sum
    }
    acc.total = sum
  }

  const bestDisplay = (canon) => {
    const m = displayCount.get(canon)
    if (!m) return canon
    let best = canon, bestN = -1
    for (const [raw, n] of m) if (n > bestN) { best = raw; bestN = n }
    return best
  }

  // 前缀和在 [t0, t1) 区间内的增量，以及该区间内按模型的 token 数。
  const sliceStats = (acc, t0, t1) => {
    const lo = lowerBound(acc.times, t0)
    const hi = lowerBound(acc.times, t1)
    const tokens = (hi > 0 ? acc.cum[hi - 1] : 0) - (lo > 0 ? acc.cum[lo - 1] : 0)
    const byModel = new Map()
    let calls = 0
    for (let i = lo; i < hi; i++) {
      const r = acc.rows[i]
      const c = canonModel(r.model || r.served || "?")
      byModel.set(c, (byModel.get(c) || 0) + tokensOf(r))
      calls++
    }
    return { tokens, byModel, calls }
  }

  return { accounts, modelDaily, bestDisplay, sliceStats }
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

// 从历史读数里求“每 1% 额度约合多少 token”。
// 优先用当前这一轮：首点（应为 100 附近）到末点的 token 增量 ÷ 掉掉的百分比。
// 首点不是满额时，退到该轮内各相邻点区间比值的中位数。
export function tokensPerPercent(points, acc, sliceStats) {
  if (!Array.isArray(points) || points.length < 2 || !acc) return null
  // 按轮次分组。历史里有的点没有 start 字段，所以除了 start 变化，
  // 还要在“剩余百分比突然回升”（重置）处切一刀。
  const sorted = points
    .filter((p) => p && p.at)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const groups = []
  let cur = null
  let curStart = null
  for (const p of sorted) {
    const st = p.start ? Date.parse(p.start) : null
    const prev = cur && cur.length ? cur[cur.length - 1] : null
    const reset = prev && Number(p.left) > Number(prev.left) + 2
    const newStart = st != null && curStart != null && st !== curStart
    if (!cur || reset || newStart) {
      cur = []
      groups.push(cur)
      curStart = st
    } else if (st != null) {
      curStart = st
    }
    cur.push(p)
  }
  if (!groups.length) return null
  // 每一轮就是一次独立测量：这一轮掉了多少百分比、同期记录到多少 token、多少条请求。
  const rounds = []
  for (const arr of groups) {
    if (arr.length < 2) continue
    const first = arr[0]
    const last = arr[arr.length - 1]
    const drop = Number(first.left) - Number(last.left)
    const t0 = Date.parse(first.at)
    const t1 = Date.parse(last.at)
    if (!(drop >= 3) || !(t1 > t0)) continue
    const s = sliceStats(acc, t0, t1)
    if (!(s.tokens > 0)) continue
    rounds.push({
      start: t0,
      end: t1,
      drop,
      tokens: s.tokens,
      calls: s.calls,
      cpp: s.calls > 0 ? s.calls / drop : 0,
      ratio: s.tokens / drop,
      byModel: s.byModel,
    })
  }
  if (!rounds.length) return null

  // 每一轮都是一次测量。记录很少的轮次（每条请求对应的百分比过大）不参与，
  // 用剩下这些完整轮次的中位数作为这个窗口的「每 1% 多少 token」。
  const cpps = rounds.map((r) => r.cpp).filter((x) => x > 0).sort((a, b) => a - b)
  const medCpp = cpps.length ? cpps[Math.floor(cpps.length / 2)] : 0
  const usable = rounds.filter((r) => r.calls >= 5 && (medCpp === 0 || r.cpp >= medCpp * 0.2))
  const pool = usable.length ? usable : rounds
  const ratios = pool.map((r) => r.ratio).sort((a, b) => a - b)
  const med = ratios[Math.floor(ratios.length / 2)]
  const byModel = new Map()
  for (const r of pool) for (const [m, v] of r.byModel) byModel.set(m, (byModel.get(m) || 0) + v)
  const p20 = ratios[Math.floor(ratios.length * 0.2)]
  const p80 = ratios[Math.floor(ratios.length * 0.8)]
  const dispersion = med > 0 ? (p80 - p20) / med : 99
  const last = rounds[rounds.length - 1]

  return {
    tpp: med,
    // 语言无关的取值，页面自己翻译：median 用多轮中位数，single 只有一轮，sparse 记录不足。
    method: usable.length > 1 ? "median" : usable.length === 1 ? "single" : "sparse",
    usableRounds: usable.length,
    start: pool[0].start,
    end: pool[pool.length - 1].end,
    drop: pool[pool.length - 1].drop,
    byModel,
    totalTokens: pool.reduce((s, r) => s + r.tokens, 0),
    points: sorted.length,
    rounds: rounds.length,
    dispersion,
    medianCallsPerPercent: medCpp,
    lowConfidence: usable.length === 0,
    latest: { drop: last.drop, tokens: last.tokens, calls: last.calls, cpp: last.cpp, ratio: last.ratio },
  }
}

// 判断一个窗口属于哪一类：
//   token     令牌型窗口（名字带 tokens）
//   aggregate 汇总窗口（Total credits、总积分），它等于下面各分包的合计
//   credit    积分类窗口（Credits、Extra credits、各种积分包、试用包）
//   rate      时间型速率窗口（5 hours、7 days、Month、Weekly、每日、本轮）
// 时间型窗口是嵌套的：5 小时限制的是瞬时速度，7 天 / Month 才是总的额度上限，
// 所以剩余 token 以周期最长的那个窗口为准。
export function classifyWindow(name) {
  const n = String(name || "")
  if (/tokens?\s*(\(|（)?\s*est/i.test(n) || /tokens?\s*$/i.test(n)) return "token"
  if (/total|总|合计|全部/i.test(n)) return "aggregate"
  if (/积分|credit|bonus|包|签到|福利|赠送|余额|领取|trial|试用/i.test(n)) return "credit"
  if (/^\s*(\d+\s*(hours?|days?|weeks?|months?|minutes?)|weekly|monthly|daily|month|day|hour|每日|本轮)/i.test(n)) return "rate"
  return "credit"
}

// 窗口对应的周期长度（小时），用来判断哪个是总的额度上限。
export function periodHours(name) {
  const n = String(name || "").trim().toLowerCase()
  const m = /^\s*(\d+(?:\.\d+)?)\s*(minute|hour|day|week|month)/.exec(n)
  if (m) {
    const v = Number(m[1])
    return m[2] === "minute" ? v / 60 : m[2] === "hour" ? v : m[2] === "day" ? v * 24 : m[2] === "week" ? v * 168 : v * 720
  }
  if (/month|月/.test(n)) return 720
  if (/week|周/.test(n)) return 168
  if (/day|天|每日/.test(n)) return 24
  if (/hour|小时|本轮/.test(n)) return 1
  return 0
}

// 主入口：把网关给当前额度、历史读数、逐条用量合成按模型的剩余 token 报表。
export function buildReport({ quotaRecords, history, usage, now = Date.now() }) {
  const idx = usage
  const models = new Map() // canon -> {tokens, pools: Map<poolKey, tokens>, display}
  const modelPoolDetail = new Map() // canon -> [{pool, tokens, share, ...}]
  const pools = [] // 每个有效池一行，便于展开
  const blockedAccounts = [] // 因为某个窗口已用完而不计入的账号
  const skipped = { noHistory: 0, noUsage: 0, noPercent: 0, unsupportedUnit: 0, blockedWindows: 0 }

  // 同一账号的多个窗口要先合在一起看：时间型嵌套取最紧，汇总窗口只算它自己。
  const accounts = new Map()
  for (const rec of quotaRecords || []) {
    const key = `${rec.provider || ""}|${rec.user || ""}`
    if (!accounts.has(key)) accounts.set(key, { provider: rec.provider, user: rec.user || "", recs: [] })
    accounts.get(key).recs.push(rec)
  }

  for (const [key, group] of accounts) {
    const acc = idx.accounts.get(key) || findAccountLoose(idx.accounts, group.provider, group.user)
    const hist = findHistory(history, group.provider, group.user) || {}
    const wins = []
    for (const rec of group.recs) {
      for (const w of rec.windows || []) {
        if (typeof w.used !== "number") { skipped.noPercent++; continue }
        // 单位是「次」「问题」这类非 token 额度的窗口，不参与 token 估算
        if (w.unit && !/credit|积分|token/i.test(String(w.unit))) { skipped.unsupportedUnit++; continue }
        const remaining = typeof w.remaining === "number" ? w.remaining : Math.max(0, 100 - w.used)
        const pts = hist[w.name]
        const est = pts && acc ? tokensPerPercent(pts, acc, idx.sliceStats) : null
        if (!pts) skipped.noHistory++
        else if (!est) skipped.noUsage++
        wins.push({
          name: w.name,
          remaining,
          used: w.used,
          resetsAt: w.resetsAt || null,
          tpp: est ? est.tpp : null,
          method: est ? est.method : null,
          points: est ? est.points : 0,
          rounds: est ? est.rounds : 0,
          dispersion: est ? est.dispersion : 0,
          medianCallsPerPercent: est ? est.medianCallsPerPercent : 0,
          latest: est ? est.latest : null,
          lowConfidence: est ? !!est.lowConfidence : false,
          byModel: est ? est.byModel : null,
          remainTokens: est ? Math.max(0, remaining) * est.tpp : null,
          kind: classifyWindow(w.name),
          periodH: periodHours(w.name),
        })
      }
    }
    if (!wins.length) continue

    const rate = wins.filter((x) => x.kind === "rate")
    const aggregate = wins.filter((x) => x.kind === "aggregate")
    const credit = wins.filter((x) => x.kind === "credit")
    const token = wins.filter((x) => x.kind === "token")

    // 组合成「池」：时间型一组取最紧；有汇总窗口就只算汇总；其余各算各的。
    const plan = []
    if (rate.length) plan.push({ label: rate.map((x) => x.name).join(" · "), wins: rate, mode: "longest", kind: "rate" })
    if (aggregate.length) plan.push({ label: aggregate.map((x) => x.name).join(" · "), wins: aggregate, mode: "single", kind: "aggregate" })
    else for (const c of credit) plan.push({ label: c.name, wins: [c], mode: "single", kind: "credit" })
    for (const t of token) plan.push({ label: t.name, wins: [t], mode: "single", kind: "token" })

    for (const p of plan) {
      let binding
      let blockedWin = null
      if (p.mode === "longest") {
        // 周期最长的窗口是总的额度上限；5 小时这类只限制瞬时速度，不单独当成总剩余
        binding = p.wins.reduce((a, b) => {
          const pa = a.periodH || 0
          const pb = b.periodH || 0
          if (pb !== pa) return pb > pa ? b : a
          return Number(b.remaining) < Number(a.remaining) ? b : a
        })
        if (binding.remaining <= 1) blockedWin = binding
      } else {
        binding = p.wins[0]
        const hit = p.wins.find((x) => x.remaining <= 1)
        if (hit) blockedWin = hit
      }
      const shown = binding
      const latest = binding?.latest || null
      // 最新一轮记录很少、远低于历史轮次时，标成记录不足
      const lowConfidence = !!binding && (binding.lowConfidence ||
        (!!latest && binding.medianCallsPerPercent > 0 && latest.cpp > 0 &&
          latest.cpp < binding.medianCallsPerPercent * 0.2))
      const shortExhausted = p.mode === "longest"
        ? p.wins.filter((x) => x !== binding && x.remaining <= 1).map((x) => x.name)
        : []
      const poolKey = group.user ? `${group.provider}/${group.user}·${p.label}` : `${group.provider}·${p.label}`
      const row = {
        pool: poolKey,
        provider: group.provider,
        user: group.user,
        window: p.label,
        used: shown.used,
        remaining: blockedWin ? 0 : shown.remaining,
        resetsAt: shown.resetsAt,
        tpp: binding ? binding.tpp : null,
        method: binding ? binding.method : null,
        points: binding ? binding.points : 0,
        rounds: binding ? binding.rounds : 0,
        roundDrop: latest ? latest.drop : null,
        roundTokens: latest ? latest.tokens : null,
        roundCalls: latest ? latest.calls : null,
        dispersion: binding ? binding.dispersion : 0,
        lowConfidence,
        shortExhausted,
        tokens: 0,
        blocked: !!blockedWin,
        blockedBy: blockedWin ? blockedWin.name : "",
        models: [],
      }
      if (blockedWin) {
        skipped.blockedWindows++
        if (!blockedAccounts.find((a) => a.account === key)) {
          blockedAccounts.push({ account: key, window: blockedWin.name })
        }
        pools.push(row)
        continue
      }
      const tokens = !binding
        ? 0
        : p.mode === "longest"
          ? binding.remainTokens
          : p.wins.reduce((s, x) => s + Math.max(0, x.remainTokens || 0), 0)
      if (!(tokens > 0)) { pools.push(row); continue }
      row.tokens = tokens

      // 摊到模型：用该池里最紧那个窗口的模型占比
      const byModel = (binding && binding.byModel) || new Map()
      let denom = 0
      for (const v of byModel.values()) denom += v
      if (denom > 0) {
        for (const [canon, v] of byModel) {
          const share = v / denom
          if (share <= 0) continue
          const part = tokens * share
          addModel(models, canon, part, poolKey, idx.bestDisplay(canon))
          row.models.push({ id: canon, name: idx.bestDisplay(canon), share, tokens: part })
          pushDetail(modelPoolDetail, canon, {
            pool: poolKey, provider: group.provider, user: group.user, window: p.label,
            remaining: binding.remaining, resetsAt: binding.resetsAt, poolTokens: tokens, tokens: part, share,
          })
        }
      } else {
        addModel(models, "", tokens, poolKey, "")
        row.models.push({ id: "", name: "", share: 1, tokens })
        pushDetail(modelPoolDetail, "", {
          pool: poolKey, provider: group.provider, user: group.user, window: p.label,
          remaining: binding ? binding.remaining : 0, resetsAt: shown.resetsAt, poolTokens: tokens, tokens, share: 1,
        })
      }
      pools.push(row)
    }
  }

  // 各模型的近期日均消耗，用来折算“还能用多久”
  const out = []
  for (const [canon, m] of models) {
    const daily = idx.modelDaily.get(canon)?.tokens || 0
    const perDay = daily / 7
    const detail = (modelPoolDetail.get(canon) || []).sort((a, b) => b.tokens - a.tokens)
    out.push({
      id: canon,
      name: m.display,
      tokens: m.tokens,
      pools: detail,
      dailyTokens: perDay,
      days: perDay > 0 ? m.tokens / perDay : null,
    })
  }
  out.sort((a, b) => b.tokens - a.tokens)

  const totalTokens = out.reduce((s, m) => s + m.tokens, 0)
  return { generatedAt: now, totalTokens, models: out, pools, blockedAccounts, skipped }
}


function pushDetail(map, canon, entry) {
  if (!map.has(canon)) map.set(canon, [])
  map.get(canon).push(entry)
}

function addModel(models, canon, tokens, poolKey, display) {
  if (!models.has(canon)) models.set(canon, { tokens: 0, pools: new Map(), display })
  const m = models.get(canon)
  m.tokens += tokens
  m.pools.set(poolKey, (m.pools.get(poolKey) || 0) + tokens)
}

function findHistory(history, provider, user) {
  const exact = history[`${provider}|${user}`]
  if (exact) return exact
  const target = `${provider}|${String(user || "").toLowerCase()}`
  for (const [k, v] of Object.entries(history)) {
    if (k.toLowerCase() === target) return v
  }
  // 别名差异：同供应商下，用户串互相包含
  const u = String(user || "").toLowerCase()
  if (u) {
    for (const [k, v] of Object.entries(history)) {
      const [p, name] = k.split("|")
      if (p !== provider) continue
      const n = String(name || "").toLowerCase()
      if (n && (u.includes(n) || n.includes(u))) return v
    }
  }
  return null
}

function findAccountLoose(accounts, provider, user) {
  const u = String(user || "").toLowerCase()
  for (const [k, v] of accounts) {
    const [p, a] = k.split("|")
    if (p !== provider) continue
    const n = String(a || "").toLowerCase()
    if (n && u && (n === u || u.includes(n) || n.includes(u))) return v
  }
  return null
}
