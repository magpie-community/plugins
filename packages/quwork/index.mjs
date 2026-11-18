import { createHash } from "node:crypto"
import { findBrowser, openChromeSession } from "./browser.mjs"

const PROVIDER = "quwork"
const LLM_BASE = "https://llm.quwork.cn/v1"
const ACCOUNT_BASE = "https://llm.rrzu.com"
const ACCOUNT_BASES = [ACCOUNT_BASE, "https://qurwork-llm.rrzu.com"]
const CHECKIN_PATH = "/api/user/checkin"
const FALLBACK_VERSION = "1.7.5"
const BALANCE_TTL_MS = 60_000
const UPSTREAM_TIMEOUT_MS = 15_000
const OFFICIAL_LOGIN = "https://quwork.cn/"

const CLIENT_HEADERS = { "x-qurwork-env": "prod", "x-qurwork-version": FALLBACK_VERSION }

const MODELS = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    variants: { off: {}, low: {}, high: {}, max: {} },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    tool_call: true,
    variants: { off: {}, low: {}, high: {}, max: {} },
  },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", limit: { context: 1000000, output: 128000 }, tool_call: true },
  { id: "qwen3.8-flash", name: "Qwen3.8-Flash", limit: { context: 1000000, output: 128000 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "qwen3.7-plus", name: "Qwen3.7-Plus", limit: { context: 1000000, output: 128000 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", limit: { context: 1000000, output: 128000 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "glm-5.2", name: "GLM-5.2", limit: { context: 1000000, output: 128000 }, tool_call: true },
  { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code", limit: { context: 1000000, output: 128000 }, tool_call: true },
  { id: "kimi-k2.6", name: "Kimi-K2.6", limit: { context: 1000000, output: 262144 }, tool_call: true, modalities: { input: ["text", "image"] } },
  { id: "MiniMax-M2.5", name: "MiniMax-M2.5", limit: { context: 1000000, output: 32768 }, tool_call: true },
]

function authKey(auth) {
  const key = auth?.type === "api" ? auth.key : auth?.access
  return typeof key === "string" && key.trim().length >= 4 && key.trim().length <= 4096 ? key.trim() : ""
}

function pointsNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function usageError(error) {
  return { error, signIn: "kept", windows: [] }
}

function accountAccessToken(auth) {
  const token = auth?.metadata?.accessToken
  if (typeof token === "string" && token.trim()) return token.trim()
  if (auth?.metadata?.source === "browser" && typeof auth?.access === "string" && auth.access.trim()) {
    return auth.access.trim()
  }
  return ""
}

function booleanValue(value) {
  if (typeof value === "boolean") return value
  if (value === 1 || value === "1" || value === "true") return true
  if (value === 0 || value === "0" || value === "false") return false
  return null
}

function checkinData(payload) {
  const data = payload && typeof payload === "object" && payload.data !== undefined ? payload.data : payload
  return data && typeof data === "object" && !Array.isArray(data) ? data : {}
}

function checkinMessage(payload, data) {
  const value = payload?.message ?? data?.message ?? data?.msg
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : ""
}

function beijingDate(now = Date.now()) {
  const stamp = now instanceof Date ? now.getTime() : Number(now)
  return new Date((Number.isFinite(stamp) ? stamp : Date.now()) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function dateOnly(value) {
  const match = String(value ?? "").match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : ""
}

function checkinRecords(data) {
  for (const candidate of [data?.records, data?.stats?.records, data?.history, data?.stats?.history]) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function todayRecord(data, now = Date.now()) {
  const today = beijingDate(now)
  return checkinRecords(data).find((record) => dateOnly(record?.checkin_date ?? record?.date) === today) ?? null
}

function checkedToday(data, now = Date.now()) {
  const stats = data?.stats ?? {}
  const flags = [
    data?.checked_in_today,
    data?.checkedInToday,
    data?.today_checked,
    data?.is_checked_in,
    data?.checked_in,
    stats?.checked_in_today,
    stats?.checkedInToday,
    stats?.today_checked,
    stats?.is_checked_in,
  ]
  let sawFalse = false
  for (const value of flags) {
    const answer = booleanValue(value)
    if (answer === true) return true
    if (answer === false) sawFalse = true
  }
  if (todayRecord(data, now)) return true
  const dates = [
    data?.checkin_date,
    data?.last_checkin_date,
    data?.lastCheckinDate,
    stats?.checkin_date,
    stats?.last_checkin_date,
    stats?.lastCheckinDate,
  ]
  if (dates.some((value) => dateOnly(value) === beijingDate(now))) return true
  if (sawFalse) return false
  return null
}

function creditOf(data) {
  for (const value of [
    data?.quota_awarded,
    data?.reward_points,
    data?.points_awarded,
    data?.awarded_points,
    data?.credit,
    data?.reward,
    data?.points,
    data?.stats?.today_quota,
    data?.stats?.today_points,
  ]) {
    const amount = pointsNumber(value)
    if (amount !== null) return amount
  }
  return null
}

function todayCreditOf(data, now = Date.now()) {
  const record = todayRecord(data, now)
  if (record) {
    const amount = creditOf(record)
    if (amount !== null) return amount
  }
  for (const value of [data?.today_quota, data?.today_points, data?.stats?.today_quota, data?.stats?.today_points]) {
    const amount = pointsNumber(value)
    if (amount !== null) return amount
  }
  return null
}

function streakOf(data) {
  for (const value of [
    data?.streak,
    data?.continuous_days,
    data?.checkin_streak,
    data?.consecutive_days,
    data?.stats?.streak,
    data?.stats?.continuous_days,
    data?.stats?.checkin_streak,
  ]) {
    const amount = pointsNumber(value)
    if (amount !== null) return Math.round(amount)
  }
  return null
}

function outcomeFromMessage(message) {
  if (/已签到|已经签到|今日已签|重复签到|already\s*(?:checked|signed)/i.test(message)) return "done"
  if (/未启用|未开启|未开放|disabled|not\s*enabled/i.test(message)) return "inactive"
  if (/captcha|验证码|人机|turnstile|challenge/i.test(message)) return "captcha"
  return ""
}

async function checkinHttp(method, accessToken, fetchImpl) {
  let last = null
  for (const base of ACCOUNT_BASES) {
    try {
      const response = await fetchImpl(`${base}${CHECKIN_PATH}`, {
        method,
        headers: {
          ...CLIENT_HEADERS,
          authorization: `Bearer ${accessToken}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      const text = await response.text().catch(() => "")
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {}
      const result = { status: response.status, ok: response.ok, payload, text }
      if (response.status === 401 || response.status === 403) return { ...result, kind: "auth" }
      if (response.ok) return { ...result, kind: "ok" }
      if (response.status >= 500 && payload && typeof payload === "object" && payload.success === false) {
        if (outcomeFromMessage(checkinMessage(payload, checkinData(payload)))) {
          return { ...result, kind: "http" }
        }
      }
      if (response.status === 404 || response.status === 405 || response.status === 501 || response.status >= 500) {
        last = result
        continue
      }
      return { ...result, kind: "http" }
    } catch (error) {
      last = { status: 0, ok: false, payload: null, text: "", error }
    }
  }
  return last ? { ...last, kind: last.status ? "http" : "network" } : { status: 0, ok: false, payload: null, text: "", kind: "network" }
}

function interpretCheckinStatus(result, now = Date.now()) {
  if (result.kind === "auth") {
    return { outcome: "failed", message: "QuWork 登录已过期，请重新在官网登录。" }
  }
  if (result.kind === "network") {
    return { outcome: "failed", message: "暂时无法连接 QuWork 签到服务，请稍后再试。" }
  }
  const payload = result.payload
  const data = checkinData(payload)
  const message = checkinMessage(payload, data)
  if (payload && typeof payload === "object" && payload.success === false) {
    const outcome = outcomeFromMessage(message)
    if (outcome) return { outcome, message: message || (outcome === "done" ? "今日已签到。" : "当前无法签到。") }
    return { outcome: "failed", message: message || `QuWork 未确认签到状态（HTTP ${result.status}）。` }
  }
  if (booleanValue(data.enabled) === false) {
    return { outcome: "inactive", message: message || "QuWork 当前未开放每日签到。" }
  }
  const checked = checkedToday(data, now)
  if (checked === true) {
    const answer = { outcome: "done", message: message || "今日已签到。" }
    const credit = todayCreditOf(data, now)
    if (credit !== null) answer.credit = credit
    return answer
  }
  if (checked === false) return { claim: true }
  if (result.kind === "http") {
    if (result.status === 429) return { outcome: "failed", message: "QuWork 限制了签到请求，请稍后再试。" }
    return { outcome: "failed", message: message || `暂时无法读取 QuWork 签到状态（HTTP ${result.status}）。` }
  }
  if (result.kind === "ok") return { claim: true }
  return { outcome: "failed", message: "QuWork 未返回可识别的签到状态。" }
}

async function interpretCheckinClaim(result, accessToken, fetchImpl, now = Date.now()) {
  if (result.kind === "auth") {
    return { outcome: "failed", message: "QuWork 登录已过期，请重新在官网登录。" }
  }
  if (result.kind === "network") {
    return { outcome: "failed", message: "暂时无法连接 QuWork 签到服务，请稍后再试。" }
  }
  const payload = result.payload
  const data = checkinData(payload)
  const message = checkinMessage(payload, data)
  if (payload && typeof payload === "object" && payload.success === false) {
    const outcome = outcomeFromMessage(message)
    if (outcome === "done") return { outcome, message: message || "今日已签到。" }
    if (outcome === "inactive" || outcome === "captcha") {
      return { outcome, message: message || (outcome === "captcha" ? "QuWork 要求人工验证，请在官网完成签到。" : "QuWork 当前未开放每日签到。") }
    }
    return { outcome: "failed", message: message || `QuWork 未确认签到结果（HTTP ${result.status}）。` }
  }
  if (result.kind === "ok") {
    const credit = creditOf(data)
    const streak = streakOf(data)
    const answer = {
      outcome: "claimed",
      message: message || (credit !== null ? `已签到 +${credit}` : "签到成功。"),
    }
    if (credit !== null) answer.credit = credit
    if (streak !== null) answer.streak = streak
    return answer
  }
  if (result.status === 429) return { outcome: "failed", message: "QuWork 限制了签到请求，请稍后再试。" }
  const after = interpretCheckinStatus(await checkinHttp("GET", accessToken, fetchImpl), now)
  if (after.outcome === "done") {
    const answer = { outcome: "claimed", message: after.message || message || "签到成功。" }
    if (after.credit !== undefined) answer.credit = after.credit
    if (after.streak !== undefined) answer.streak = after.streak
    return answer
  }
  if (after.outcome === "inactive" || after.outcome === "captcha") return after
  return { outcome: "failed", message: message || "QuWork 未明确确认签到结果，请在官网核对。" }
}

async function runCheckin(accessToken, fetchImpl) {
  const now = Date.now()
  const status = interpretCheckinStatus(await checkinHttp("GET", accessToken, fetchImpl), now)
  if (status.outcome) return status
  if (!status.claim) return { outcome: "failed", message: "QuWork 未返回可识别的签到状态。" }
  return interpretCheckinClaim(await checkinHttp("POST", accessToken, fetchImpl), accessToken, fetchImpl, now)
}

async function fetchUsage(accessToken, fetchImpl) {
  try {
    const response = await fetchImpl(`${ACCOUNT_BASE}/api/user/self`, {
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401) return usageError("旧版积分凭据已失效。请在 QuWork 官方入口查看积分。")
      if (response.status === 403) return usageError("QuWork 拒绝查询积分，请在官方入口核对账号状态。")
      if (response.status === 429) return usageError("QuWork 限制了积分查询，请稍后查看。")
      return usageError(`暂时无法查询 QuWork 积分（HTTP ${response.status}）。`)
    }
    const payload = await response.json()
    const entitlement = payload?.data?.points_entitlement
    const total = pointsNumber(entitlement?.total_points)
    if (payload?.success !== true || total === null) return usageError("QuWork 未返回有效的积分余额。")
    const limited = pointsNumber(entitlement.limited_points)
    const permanent = pointsNumber(entitlement.permanent_points)
    const plan = entitlement.active_subscription?.plan_name
    const parts = []
    if (limited !== null) parts.push(`限时 ${limited}`)
    if (permanent !== null) parts.push(`永久 ${permanent}`)
    const detail = parts.length ? `（${parts.join(" · ")}）` : ""
    return { plan: typeof plan === "string" && plan.trim() ? plan.trim() : "积分", balance: `${total} 积分${detail}`, windows: [] }
  } catch {
    return usageError("暂时无法读取 QuWork 积分，请稍后查看。")
  }
}

async function checkKey(key, fetchImpl, signal) {
  try {
    const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    const response = await fetchImpl(`${LLM_BASE}/models`, {
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${key}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    await response.body?.cancel().catch(() => {})
    return response.ok ? null : `QuWork 未接受模型密钥（HTTP ${response.status}）。`
  } catch {
    return signal?.aborted ? "QuWork 登录已取消。" : "连接 QuWork 模型服务失败，请稍后查看。"
  }
}

function createPlugin({ fetchImpl = globalThis.fetch, browser = { find: findBrowser, open: openChromeSession } } = {}) {
  const balanceCache = new Map()
  const checkinInFlight = new Map()

  async function browserAuthorize(_inputs, { signal } = {}) {
    if (!browser.find()) {
      return { type: "failed", error: "没有找到 Chrome 或 Edge；请安装浏览器，或改用模型密钥登录。" }
    }
    let session
    try {
      session = await browser.open(OFFICIAL_LOGIN)
    } catch (error) {
      return { type: "failed", error: error?.message ?? String(error) }
    }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      return session.close()
    }
    if (signal?.aborted) {
      await close()
      return { type: "failed", error: "QuWork 登录已取消。" }
    }
    return {
      url: "",
      opened: true,
      instructions: "已打开专用浏览器窗口：请在 QuWork 官网完成登录。登录成功后，Magpie 会自动继续。",
      method: "auto",
      close,
      async callback(_code, { signal } = {}) {
        const abort = () => close()
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
        try {
          const found = await session.credentials(5 * 60 * 1000)
          if (!found?.webToken && !found?.llmToken) {
            return { type: "failed", error: "QuWork 官网登录超时，请重试。" }
          }
          const accessToken = found.webToken || ""
          const candidates = [found.llmToken, accessToken].filter(Boolean)
          let key = ""
          for (const candidate of candidates) {
            if (!(await checkKey(candidate, fetchImpl, signal))) {
              key = candidate
              break
            }
          }
          if (!key && accessToken) {
            const points = await fetchUsage(accessToken, fetchImpl)
            if (points.balance) {
              return {
                type: "success",
                key: accessToken,
                metadata: { source: "browser", accessToken, modelKey: false },
              }
            }
          }
          if (!key) {
            return {
              type: "failed",
              error: "官网登录成功，但 QuWork 没有返回可用于第三方模型的凭据。请在官网控制台创建模型密钥后重试。",
            }
          }
          return {
            type: "success",
            key,
            metadata: { source: "browser", accessToken, modelKey: true },
          }
        } catch (error) {
          return { type: "failed", error: error?.message ?? String(error) }
        } finally {
          signal?.removeEventListener("abort", abort)
          await close()
        }
      },
    }
  }

  return {
    async config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {
        name: "QuWork",
        npm: "@ai-sdk/openai-compatible",
        api: LLM_BASE,
        models: Object.fromEntries(MODELS.map((model) => [model.id, model])),
      }
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "官网浏览器登录（自动读取登录态）",
          authorize: browserAuthorize,
        },
        {
          type: "api",
          label: "填写已获授权的 QuWork 模型密钥",
          prompts: [{ type: "password", key: "key", message: "QuWork 授权用于第三方接入的模型密钥", placeholder: "sk-…" }],
          async authorize(inputs, { signal } = {}) {
            const raw = inputs?.key ?? inputs?.apiKey ?? inputs?.api_key ?? inputs?.value
            const key = typeof raw === "string" ? raw.trim() : ""
            if (!/^sk-[A-Za-z0-9_-]{1,512}$/.test(key)) {
              return { type: "failed", error: "请填写 sk- 开头的 QuWork 授权模型密钥。" }
            }
            const error = await checkKey(key, fetchImpl, signal)
            if (error) return { type: "failed", error }
            return { type: "success", key, metadata: { source: "pasted" } }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!authKey(auth)) return {}
        if (auth.metadata?.modelKey === false) {
          return {
            baseURL: LLM_BASE,
            async fetch() {
              throw new Error("官网登录成功，但 QuWork 没有返回模型密钥。请在 QuWork 官网创建模型密钥后重新登录。")
            },
          }
        }
        return {
          baseURL: LLM_BASE,
          apiKey: PROVIDER,
          async fetch(input, init) {
            const isRequest = input instanceof Request
            const target = new URL(isRequest ? input.url : String(input))
            if (!target.href.startsWith(`${LLM_BASE}/`)) {
              throw new Error("QuWork 模型密钥仅用于 QuWork 模型网关。")
            }
            const key = authKey(await getAuth())
            if (!key) throw new Error("请在 Magpie 中配置 QuWork 模型密钥。")
            const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined))
            headers.set("authorization", `Bearer ${key}`)
            for (const [name, value] of Object.entries(CLIENT_HEADERS)) headers.set(name, value)
            return fetchImpl(isRequest ? input : target.href, { ...init, headers, redirect: "error" })
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (!authKey(auth)) return usageError("请先在 Magpie 中配置 QuWork 模型密钥。")
        const accessToken = auth.metadata?.source === "browser" ? auth.metadata.accessToken : null
        if (typeof accessToken !== "string" || !accessToken.trim()) {
          return usageError("当前为模型密钥接入。请在 QuWork 官方入口查看账号积分。")
        }
        const now = Date.now()
        for (const [cacheKey, entry] of balanceCache) {
          if (entry.until <= now) balanceCache.delete(cacheKey)
        }
        const cacheKey = createHash("sha256").update(accessToken).digest("hex")
        const cached = balanceCache.get(cacheKey)
        if (cached) return cached.result
        const entry = { until: Infinity, result: null }
        entry.result = fetchUsage(accessToken, fetchImpl).finally(() => {
          entry.until = Date.now() + BALANCE_TTL_MS
        })
        balanceCache.set(cacheKey, entry)
        return entry.result
      },
      async checkin(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          return { outcome: "failed", message: "无法读取 QuWork 登录信息，请重新登录。" }
        }
        const accessToken = accountAccessToken(auth)
        if (!accessToken) {
          return {
            outcome: "ineligible",
            message: "签到需要官网浏览器登录的账号凭据；仅 sk- 模型密钥不能签到。",
          }
        }
        const cacheKey = createHash("sha256").update(accessToken).digest("hex")
        const running = checkinInFlight.get(cacheKey)
        if (running) return running
        const task = runCheckin(accessToken, fetchImpl)
          .catch(() => ({ outcome: "failed", message: "签到失败，请稍后再试。" }))
          .finally(() => checkinInFlight.delete(cacheKey))
        checkinInFlight.set(cacheKey, task)
        return task
      },
    },
  }
}

export const QuWorkProvider = async () => createPlugin()
export const _internal = { createPlugin }
