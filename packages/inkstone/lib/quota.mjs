// pool/credits → magpie 账户卡的窗口与明细。
//
// 控制台的数字可能是字符串也可能是数字；时间既有 ISO 字符串也有秒级时间戳。
// 这里统一归一化，映射成 magpie 的 usage 形状：
//   - 前两个窗口（5h / 7d）画成进度条：used 是**已用占比**，display 是已用/总量
//     （与 Cursor / factory 等插件一致；官方卡片显示"剩余/总量"，这里换算成已用）；
//   - 其余信息放 aside 行，tooltip 里可见：每个墨点包、限速。
//
// 读不到的字段绝不伪造：余额为 0 是"没额度"，读失败是"不知道"，两者不能混。

/** 容错正数："600000" / 591300.25 / null 都能读；负数与垃圾归 0。 */
export function flexNum(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 可缺的数：空串/undefined → undefined，供"字段缺失"与"0"区分。 */
export function optionalNum(value) {
  if (value === null || value === undefined) return undefined
  const s = String(value).trim()
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** 最多两位小数、无千分位（卡片自己加）。 */
export function compact(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return "0"
  const s = v.toFixed(2).replace(/\.?0+$/, "")
  return s === "" ? "0" : s
}

/** 整数千分位（限速这类大数字读起来省事）：2000000 → "2,000,000"。 */
export function group(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) return ""
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** 控制台的时间：ISO 字符串或秒/毫秒时间戳 → ISO，读不出就 undefined。 */
export function isoOf(value) {
  if (value === null || value === undefined || value === "") return undefined
  // 控制台的数字可能是字符串："1700000000" 这类纯数字按时间戳读，
  // "0" 不是时间，字符串垃圾也不是。
  if (/^\d+$/.test(String(value).trim())) {
    const n = Number(String(value).trim())
    if (!(n > 0)) return undefined
    const ms = n > 1e12 ? n : n * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  if (typeof value === "number") {
    if (!(value > 0)) return undefined
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  const s = String(value).trim()
  const d = new Date(s.includes("T") || s.includes(" ") ? s.replace(" ", "T") : s)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

const dayOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** 控制台的本地日历日：时刻按本机时区取日期，避免 UTC 偏移把日期退一天。 */
export function localDay(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return dayOf(d)
}

/**
 * credits/balance → 头部与两个进度条。
 * `balance` 是控制台的 data 字段。窗口缺 limit、或 used/remaining 都没有时
 * 跳过（不显示成 0% 假象）；`enabled` 为 false 的窗口也跳过。
 */
export function windowsOf(balance) {
  const out = []
  const usage = balance?.usage_windows ?? {}
  for (const [key, name, span] of [
    ["5h", "5 hours", 5 * 3600],
    ["7d", "7 days", 7 * 24 * 3600],
  ]) {
    const w = usage[key]
    if (!w || w.enabled === false) continue
    const limit = flexNum(w.limit_credits)
    if (limit <= 0) continue
    const remaining = optionalNum(w.remaining_credits)
    const usedGiven = optionalNum(w.used_credits)
    const spent =
      usedGiven !== undefined
        ? Math.max(0, usedGiven)
        : remaining !== undefined
          ? Math.max(0, limit - remaining)
          : undefined
    if (spent === undefined) continue
    const round = (n) => Math.round(n * 100) / 100
    const pct = Math.max(0, Math.min(100, (spent / limit) * 100))
    out.push({
      name,
      used: pct,
      display: `${compact(spent)} / ${compact(limit)}`,
      amount: round(spent),
      limit: round(limit),
      unit: "墨点",
      span,
      ...(isoOf(w.next_recover_at) ? { resetsAt: isoOf(w.next_recover_at) } : {}),
    })
  }
  return out
}

/**
 * credits/packages → 每个可用墨点包一行，直接用控制台自己的包名；
 * 没名字时回退“墨点包N”。只列还剩墨点、且状态可用的包。
 */
export function packageRows(packages) {
  const items = Array.isArray(packages?.packages)
    ? packages.packages
    : Array.isArray(packages?.items)
      ? packages.items
      : Array.isArray(packages)
        ? packages
        : []
  const ok = new Set(["available", "unused"])
  const rows = []
  for (const p of items) {
    const remaining = flexNum(p.remaining_credits)
    // total 缺失不是 0：没有总量就只显示剩余，不伪造 "剩 1 / 0"。
    const total = optionalNum(p.total_credits)
    const status = String(p.status ?? "").toLowerCase()
    if (remaining <= 0) continue
    if (status && !ok.has(status)) continue
    const expiry = isoOf(p.current_cycle?.end_at)
    const day = localDay(expiry)
    // 控制台对每个包都给了一个名字：优先展示它，免得“墨点包1”只有内部人知道是什么。
    const vendorName = typeof p?.remark === "string" && p.remark.trim() ? p.remark.trim() : typeof p?.remark_en === "string" && p.remark_en.trim() ? p.remark_en.trim() : ""
    const round = (n) => Math.round(n * 100) / 100
    // 面板的约定（plugin-host 的 usage 文档）：amount 是**已用**、limit 是总量，
    // 面板显示"剩余 = limit - amount"。amount 填剩余会被再减一次，整行数字对不上。
    const spent = total > 0 ? Math.max(0, total - remaining) : undefined
    const pct = spent !== undefined ? Math.max(0, Math.min(100, (spent / total) * 100)) : undefined
    rows.push({
      name: vendorName || `墨点包${rows.length + 1}`,
      ...(pct !== undefined ? { used: pct } : {}),
      display: `剩 ${compact(remaining)}${total > 0 ? ` / ${compact(total)}` : ""}${day ? ` · ${day} 到期` : ""}`,
      ...(spent !== undefined ? { amount: round(spent), limit: round(total) } : {}),
      unit: "墨点",
      // 包到期不是重置：交给宿主的 runsOutAt/runsOut（hover 行），不占 resetsAt。
      ...(expiry ? { runsOutAt: expiry, runsOut: round(remaining) } : {}),
      aside: true,
    })
  }
  return rows
}

/**
 * 组装整张卡。读失败的段单独说明，不拖垮整卡：
 * 余额/窗口是主数据，包是明细，失败只留一句说明。
 */
export function cardOf({ balance, packages, user, errors = [] } = {}) {
  const available = optionalNum(balance?.available_credits)
  const packs = flexNum(balance?.active_package_count)
  const windows = windowsOf(balance)
  const packRows = packageRows(packages)

  const rows = [
    ...packRows,
    ...(flexNum(balance?.rpm_limit) || flexNum(balance?.tpm_limit)
      ? [
          {
            name: "限速",
            used: 0,
            display: `${group(flexNum(balance.rpm_limit)) || "—"} RPM · ${group(flexNum(balance.tpm_limit)) || "—"} TPM`,
            aside: true,
          },
        ]
      : []),
  ]

  return {
    plan: "墨点计划 (Token Plan)",
    ...(user ? { user } : {}),
    ...(available !== undefined
      ? { balance: `${compact(available)} 墨点${packs > 0 ? ` · ${packs} 个可用包` : ""}` }
      : packs > 0
        ? { balance: `${packs} 个可用包` }
        : {}),
    windows: [...windows, ...rows],
    ...(errors.length ? { error: errors.join("; ") } : {}),
    signIn: "kept",
  }
}
