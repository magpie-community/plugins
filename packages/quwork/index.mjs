import { createHash } from "node:crypto"

const PROVIDER = "quwork"
const LLM_BASE = "https://llm.quwork.cn/v1"
const ACCOUNT_BASE = "https://llm.rrzu.com"
const FALLBACK_VERSION = "1.7.5"
const BALANCE_TTL_MS = 60_000
const UPSTREAM_TIMEOUT_MS = 15_000

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
  return typeof key === "string" && /^sk-[A-Za-z0-9_-]{1,512}$/.test(key.trim()) ? key.trim() : ""
}

function pointsNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function usageError(error) {
  return { error, signIn: "kept", windows: [] }
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

function createPlugin({ fetchImpl = globalThis.fetch } = {}) {
  const balanceCache = new Map()
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
          type: "api",
          label: "填写已获授权的 QuWork 模型密钥",
          prompts: [{ type: "password", key: "key", message: "QuWork 授权用于第三方接入的模型密钥", placeholder: "sk-…" }],
          async authorize(inputs, { signal } = {}) {
            const key = authKey({ type: "api", key: inputs?.key ?? inputs?.apiKey ?? inputs?.api_key ?? inputs?.value })
            if (!key) return { type: "failed", error: "请填写 QuWork 授权用于第三方接入的模型密钥。" }
            const error = await checkKey(key, fetchImpl, signal)
            if (error) return { type: "failed", error }
            return { type: "success", key, metadata: { source: "pasted" } }
          },
        },
      ],
      async loader(getAuth) {
        if (!authKey(await getAuth())) return {}
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
    },
  }
}

export const QuWorkProvider = async () => createPlugin()
export const _internal = { createPlugin }
