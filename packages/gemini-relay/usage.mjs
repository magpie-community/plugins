// 用量与配额可见性（尽力而为）：在 Gemini 网页版自己的页面里发
// batchexecute，问它“这个账号还剩多少额度”。页面内 fetch 带着账号自己的
// Cookie 与 TLS，和聊天请求同一个身份，不会多出可疑的第三方客户端指纹。
//
// 两个 RPC（协议来自 HanaokaYuzu/Gemini-API 的逆向，实测 2026-11）：
//  - jSf9Qc  GET_USAGE_INFO     → 订阅档位 + 5h/周窗口 + AI credits
//  - qpEbW   CHECK_GEMINI_QUOTA → 各模型档位的配额（Pro=actionId 4，
//                                 Flash=11，FlashThinking=15）
//
// 失败绝不致命：页内 fetch 可能被 /sorry 或改版打断，这里只记录错误并
// 保留上一次快照，让上层“看不到额度”也能继续聊天。
import { GeminiError } from "./relay.mjs"

export const APP = "https://gemini.google.com"
export const USAGE_RPC = "jSf9Qc" // GET_USAGE_INFO
export const QUOTA_RPC = "qpEbW" // CHECK_GEMINI_QUOTA
// quota payload：Pro 档与 Flash 档的 actionId 集合（应用自己查询用的组合）
export const QUOTA_PAYLOAD_PRO = "[[[1,4],[6,6],[1,15]]]"
export const QUOTA_PAYLOAD_FLASH = "[[[1,11],[2,11],[6,11]]]"

export const TIER_NAMES = { 1: "FREE", 2: "PRO", 3: "ULTRA", 4: "PLUS" }
export const ACTION_NAMES = { 4: "pro", 11: "flash", 15: "flash_thinking" }

// —— 纯解析函数（离线可测） ——

// parseBatchExecute：batchexecute 响应是
//   )]}'        ← 安全前缀
//   12345       ← 下一行的字符数
//   [["wrb.fr", ...]]   ← 一行 JSON
// 逐段读取，返回 [{ rpcid, data }]，data 是未解析的 JSON 字符串。
export function parseBatchExecute(text) {
  if (typeof text !== "string") return []
  // 去掉 )]}' 前缀（有的实现带换行，有的紧跟正文）
  let body = text
  const idx = body.indexOf("[")
  if (body.startsWith(")]}'")) body = body.slice(4)
  else if (idx > 0 && idx <= 10) body = body.slice(idx)
  const rows = []
  const lines = body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith("[")) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(row)) continue
    for (const r of row) {
      if (Array.isArray(r) && r[0] === "wrb.fr" && typeof r[1] === "string") {
        rows.push({ rpcid: r[1], data: typeof r[2] === "string" ? r[2] : "" })
      }
    }
  }
  return rows
}

// parseUsageInfo：GET_USAGE_INFO 的 body。
//   body[0] = tier（1=FREE 2=PRO 3=ULTRA 4=PLUS）
//   body[1] = items[]，每项 [remaining, usageLevel, metricType, [resetTs]]
//     metricType: 1=5h 窗口 2=周窗口 3=AI credits
export function parseUsageInfo(data) {
  let body
  try {
    body = JSON.parse(data)
  } catch {
    return { error: "usage info 不是 JSON" }
  }
  if (!Array.isArray(body)) return { error: "usage info 结构异常" }
  const tier = body[0]
  const items = []
  for (const it of Array.isArray(body[1]) ? body[1] : []) {
    if (!Array.isArray(it) || it.length < 3) continue
    items.push({
      remaining: it[0],
      usageLevel: it[1],
      metricType: it[2],
      resetAt: tsToMs(Array.isArray(it[3]) ? it[3][0] : undefined),
    })
  }
  return { tier, items }
}

// parseQuota：CHECK_GEMINI_QUOTA 的 body。
//   items[] 每项 [ [id...], actionId, usageLevel, [resetTs], total, remaining ]
//     actionId: 4=Pro 11=Flash 15=FlashThinking
//   外层可能是 [ items ]（Pro payload）或 [ [ items ] ]（Flash payload），
//   所以先找到“元素是 6 元组”的那一层。
export function parseQuota(data) {
  let body
  try {
    body = JSON.parse(data)
  } catch {
    return { error: "quota 不是 JSON" }
  }
  if (!Array.isArray(body)) return { error: "quota 结构异常" }
  const isItem = (x) => Array.isArray(x) && x.length >= 6 && Number.isFinite(x[1])
  // 外层包裹层数不固定（Pro 是 [items]，Flash 是 [[items]]），一路下钻到
  // “元素本身是 6 元组”的那一层为止
  let layer = body
  while (Array.isArray(layer) && layer.length && Array.isArray(layer[0]) && !isItem(layer[0])) layer = layer[0]
  const out = []
  for (const it of Array.isArray(layer) ? layer : []) {
    if (!isItem(it)) continue
    out.push({
      actionId: it[1],
      usageLevel: it[2],
      resetAt: tsToMs(Array.isArray(it[3]) ? it[3][0] : undefined),
      total: it[4],
      remaining: it[5],
    })
  }
  return { items: out }
}

// reset 时间戳兼容秒/毫秒
function tsToMs(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

// usagePct：窗口没有 total，只能从 usageLevel 估——0~1 当作比例，
// >1 当作已经是百分数。尽力而为，不精确没关系，能看见趋势就赢。
function levelToPct(level) {
  const n = Number(level)
  if (!Number.isFinite(n)) return null
  if (n <= 1) return Math.round(n * 1000) / 10
  return Math.min(100, Math.round(n * 10) / 10)
}

function pctUsed(total, remaining) {
  const t = Number(total)
  const r = Number(remaining)
  if (!Number.isFinite(t) || !Number.isFinite(r) || t <= 0) return null
  return Math.max(0, Math.min(100, Math.round(((t - r) / t) * 1000) / 10))
}

// —— 页内执行：发 batchexecute，返回原始文本 ——

// 与 relay.mjs 的 PAGE_ASK 同一套路：从页面 HTML 里取 cfb2h（bl）与
// SNlM0e（at），页内 fetch 带 credentials。prompt 不内插，全部参数化。
const PAGE_USAGE = `(async () => {
  const html = document.documentElement.innerHTML;
  const g = (k) => (html.match(new RegExp('"' + k + '":"([^"]*)"')) || [])[1] || "";
  const at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] || "";
  const bl = g("cfb2h");
  if (!bl) return { err: "页面里没有 cfb2h，Gemini 网页版可能改版了" };
  const freq = JSON.stringify([[
    ["${USAGE_RPC}", "[]", null, "generic"],
    ["${QUOTA_RPC}", ${JSON.stringify(QUOTA_PAYLOAD_PRO)}, null, "generic"],
    ["${QUOTA_RPC}", ${JSON.stringify(QUOTA_PAYLOAD_FLASH)}, null, "generic"]
  ]]);
  const q = new URLSearchParams({ bl, hl: "en", _reqid: String(100000 + Math.floor(Math.random() * 899999)), rt: "c" });
  const form = new URLSearchParams({ "f.req": freq });
  if (at) form.set("at", at);
  const r = await fetch("https://gemini.google.com/_/BardChatUi/data/batchexecute?" + q, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
    body: form, credentials: "include",
  });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 500000) };
})()`

export class UsageTracker {
  // page: RelayPage（有 send/eval）；account: 账号标识（仅用于日志/快照）
  constructor({ page, account = "", cacheMs = 60_000 } = {}) {
    this.page = page
    this.account = account
    this.cacheMs = cacheMs
    this.snapshot_ = null
    this.fetchedAt = 0
    this.lastError = null
    this.refreshing = null
  }

  // snapshot 返回缓存（60s 内直接用，防打爆）；force=true 强制刷新。
  // 失败不抛：返回 { error } 并尽量保留上一次快照。
  async snapshot({ force = false } = {}) {
    const now = Date.now()
    if (!force && this.snapshot_ && now - this.fetchedAt < this.cacheMs) return this.snapshot_
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async refresh() {
    try {
      const r = await this.page.eval(PAGE_USAGE)
      if (!r || r.err) throw new GeminiError(r?.err || "页内用量查询没有返回", { code: "usage_page_error", status: 502 })
      if (r.status !== 200) {
        // /sorry、限流、改版都落到这里
        throw new GeminiError(`用量查询 HTTP ${r.status}`, { code: r.status === 429 ? "usage_limit_exceeded" : "usage_http_error", status: r.status })
      }
      const rows = parseBatchExecute(r.text)
      const snap = {
        account: this.account,
        tier: null,
        tierName: null,
        windows: {},
        quotas: {},
        aiCredits: null,
        fetchedAt: Date.now(),
        error: null,
      }
      let sawAny = false
      for (const row of rows) {
        if (row.rpcid === USAGE_RPC && row.data) {
          const info = parseUsageInfo(row.data)
          if (!info.error) {
            sawAny = true
            snap.tier = info.tier
            snap.tierName = TIER_NAMES[info.tier] ?? String(info.tier ?? "")
            for (const it of info.items) {
              if (it.metricType === 1) snap.windows.current_5h = { remaining: it.remaining, usagePct: levelToPct(it.usageLevel), resetAt: it.resetAt }
              else if (it.metricType === 2) snap.windows.weekly = { remaining: it.remaining, usagePct: levelToPct(it.usageLevel), resetAt: it.resetAt }
              else if (it.metricType === 3) snap.aiCredits = { remaining: it.remaining, resetAt: it.resetAt }
            }
          }
        } else if (row.rpcid === QUOTA_RPC && row.data) {
          const q = parseQuota(row.data)
          if (!q.error) {
            for (const it of q.items) {
              const name = ACTION_NAMES[it.actionId]
              if (!name) continue
              sawAny = true
              snap.quotas[name] = {
                remaining: it.remaining,
                total: it.total,
                usagePct: pctUsed(it.total, it.remaining),
                resetAt: it.resetAt,
              }
            }
          }
        }
      }
      if (!sawAny) throw new GeminiError("用量响应里没有可识别的 RPC 数据（可能改版）", { code: "usage_parse_error", status: 502 })
      this.snapshot_ = snap
      this.fetchedAt = snap.fetchedAt
      this.lastError = null
      return snap
    } catch (e) {
      // 尽力而为：失败保留旧快照，附上 error 说明
      this.lastError = { message: String(e?.message ?? e), code: e?.code, status: e?.status, at: Date.now() }
      if (this.snapshot_) {
        return { ...this.snapshot_, error: this.lastError.message, stale: true }
      }
      return { account: this.account, error: this.lastError.message, code: e?.code, status: e?.status, fetchedAt: 0 }
    }
  }
}
