// magpie-scnet —— 把「超算互联网」(SCNet) 接入 magpie 的 provider 插件。
//
// 这个插件存在的理由：SCNet 的模型服务有两个**互相独立**的档位，各用各的
// API Key，混用会扣错账：
//
//   1. Token Plan（套餐）
//      - 专属 Key，前缀 sk-t…
//      - 控制台路径：模型服务 → Token Plan → API Key
//      - 只覆盖套餐内模型（目前 DeepSeek-V4.1-Flash-1017-Event）
//      - 消耗套餐 Credits，50,000 Credits/月，按模型倍率抵扣
//
//   2. 免费额度（Free Quota）
//      - 通用 Key，前缀 sk-N…（API Key 页「按量付费」下的模型服务 Key）
//      - 控制台路径：模型服务 → API Key → 创建/查看
//      - 免费额度是账号下的一条资源（目前 GLM-5.3-Flash，1 亿 tokens，30 天）
//      - 用通用 Key 调 GLM-5.3-Flash 时先扣免费额度；额度用完/调用其他模型
//        就会走按量付费，**不会**扣 Token Plan 的 Credits
//
// 两档共用同一个 API 域名和协议：
//   OpenAI 兼容：https://api.scnet.cn/api/llm/v1
//   Anthropic 兼容：https://api.scnet.cn/api/llm/anthropic
// 但 Key 和可用模型不同，所以本插件把它们做成两个明确的登录档位，
// 登录时按前缀 + /v1/models 双重校验，避免把 sk-t 填进免费档或反过来。
//
// 额度查询：SCNet 的模型 API 没有 /v1/usage 之类的接口（实测 401），
// 额度只存在于控制台的 /acx/charge/... 接口，需要网页登录 Cookie。
// 因此额度是「可选」的：填了 Cookie 就显示，不填只做模型调用。

const ID = "scnet"
const CHAT = "@ai-sdk/openai-compatible"

// 两档的 API 根地址相同；插件内统一用 OpenAI 兼容协议。
const API_BASE = "https://api.scnet.cn/api/llm/v1"
const CONSOLE_BASE = "https://www.scnet.cn"

// 免费额度目前只覆盖这个模型。即使通用 Key 能列出更多模型，
// 免费档也只暴露这一个，避免用户误用其他模型走按量付费。
const FREE_MODEL = "GLM-5.3-Flash"

// Token Plan 专属 Key 的前缀。用于登录时防止两档混填。
const TOKEN_PLAN_PREFIX = "sk-t"

const TIMEOUT = 20_000
const PLACEHOLDER = "scnet-placeholder"

// =============================================================================
// 基础工具
// =============================================================================

/** hostOf 取域名，仅用于账号显示名。 */
function hostOf(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

/** num 只接受有限数字；"49,999.85" 这类字符串要先去掉逗号再转。 */
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** pct 算百分比，总量为 0 时返回 0，避免 NaN。 */
const pct = (used, total) => (total > 0 ? Math.min(100, Math.max(0, (100 * used) / total)) : 0)

/** fmt 给 Credits / tokens 加千分位，去掉无意义的尾零。 */
function fmt(v) {
  const n = num(v)
  if (n === undefined) return "—"
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
}

// =============================================================================
// 模型 API
// =============================================================================

/**
 * fetchModels 用 API Key 拉 GET /v1/models。
 *
 * 实测返回：
 *   Token Plan Key → 只有套餐内模型
 *   通用 Key       → 账号可访问的全部模型
 *
 * 这个差异正好可以用来校验档位：Token Plan 不该看到免费模型，
 * 通用 Key 必须能看到 GLM-5.3-Flash。
 */
async function fetchModels(key) {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`/v1/models: 返回的不是 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    const why = body?.error?.message ?? body?.msg ?? text.slice(0, 200)
    const err = new Error(`${res.status} ${why}`)
    if (res.status === 401) err.signIn = "expired"
    throw err
  }

  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null
  if (!list) throw new Error("/v1/models: 返回结构无法识别")

  return list
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((id) => typeof id === "string" && id)
}

/**
 * runtimeModel 生成 magpie 的模型对象。
 * SCNet 是纯文本对话网关，保守声明能力，价格留 0（由 magpie 自己统计）。
 */
function runtimeModel(id) {
  return {
    id,
    providerID: ID,
    name: id,
    api: { id, url: API_BASE, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

function placeholderModel() {
  return {
    id: PLACEHOLDER,
    name: PLACEHOLDER,
    api: { npm: CHAT, url: API_BASE },
  }
}

// =============================================================================
// 控制台额度 API（需要网页 Cookie）
// =============================================================================

/**
 * consoleJson 请求控制台接口。
 *
 * 控制台的响应外壳是 {code,msg,data}，成功码是**字符串** "0"；
 * 未登录时 code 可能是 401/1004 等，需要区分「会话失效」和普通错误。
 *
 * @param {string} path 以 /acx/ 开头的路径
 * @param {object} opts { cookie, method, body }
 */
async function consoleJson(path, { cookie, method = "GET", body } = {}) {
  const headers = {
    Accept: "application/json",
    Cookie: cookie,
    // 控制台是 Vue SPA，后端对 UA/版本没有强校验，但带上更贴近真实请求
    "User-Agent": "magpie-scnet",
    version: "2.12.2",
  }
  let payload
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }

  const res = await fetch(CONSOLE_BASE + path, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${path}: 返回的不是 JSON（HTTP ${res.status}）`)
  }

  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 160)}`)
  }
  // 成功码是字符串 "0"；其余都按错误处理
  if (String(data?.code) !== "0") {
    const err = new Error(`${path}: ${data?.msg ?? "请求失败"}`)
    if (String(data?.code) === "401" || /登录|未登录/.test(String(data?.msg))) {
      err.signIn = "expired"
    }
    throw err
  }
  return data?.data
}

/** 当前用户的账号 id：免费额度统计接口必须带它。 */
async function currentAccountId(cookie) {
  const data = await consoleJson("/acx/user/customer/group/curuser-group-list?start=0&limit=9999", {
    cookie,
  })
  const first = Array.isArray(data) ? data[0] : null
  const accountId = first?.accountId
  if (!accountId) throw new Error("控制台未返回 accountId，Cookie 可能不完整")
  return accountId
}

/**
 * Token Plan 套餐列表。
 *
 * 实测返回：
 *   [{ resourceAccountId, orderId, resourceId, name, status,
 *      totalDays, usedAmount, totalAmount, unit:"CREDITS",
 *      minValidTime, maxExpireTime, currentTime }]
 */
async function tokenPlanPlans(cookie) {
  const data = await consoleJson("/acx/charge/account/currentuser/tokenplan/list", { cookie })
  return Array.isArray(data) ? data : []
}

/**
 * 免费额度资源列表。
 *
 * 实测返回：
 *   { list:[{ resourceId:"GLM-5.3-Flash", purchaseCount:"100000000",
 *             balance:"99999642", unit:"MTOKENS", validTime, expireTime, status }],
 *     totalBalance, totalPurchaseCount, totalUsed }
 */
async function freeQuotaResources(cookie) {
  const accountId = await currentAccountId(cookie)
  return consoleJson("/acx/charge/account/llmapi/resource/list/statistics", {
    cookie,
    method: "POST",
    body: { accountId },
  })
}

// =============================================================================
// 额度展示
// =============================================================================

/**
 * usageFromTokenPlan 把套餐列表转成 magpie usage。
 * 只取 status = enable 的那条；多条时取最早到期的（最该被关注的）。
 */
function usageFromTokenPlan(plans, user) {
  const live = (Array.isArray(plans) ? plans : []).filter((p) => p?.status === "enable")
  const plan = live.sort((a, b) => String(a.maxExpireTime).localeCompare(String(b.maxExpireTime)))[0]
  if (!plan) {
    return { user, plan: "Token Plan", windows: [], error: "没有生效中的 Token Plan 套餐" }
  }

  const total = num(plan.totalAmount) ?? 0
  const used = num(plan.usedAmount) ?? 0
  const out = {
    user,
    plan: plan.name || "Token Plan",
    windows: [
      {
        name: "Token Plan Credits",
        used: pct(used, total),
        display: `已用 ${fmt(used)} / 共 ${fmt(total)} Credits`,
      },
    ],
  }
  if (total > used) out.balance = `${fmt(total - used)} Credits`
  if (plan.maxExpireTime) out.until = plan.maxExpireTime
  if (total > 0 && used >= total) out.error = "Token Plan Credits 已用完"
  return out
}

/**
 * usageFromFree 把免费额度资源转成 magpie usage。
 * 优先找 GLM-5.3-Flash；没有就取第一条 MTOKENS 资源。
 */
function usageFromFree(data, user) {
  const list = Array.isArray(data?.list) ? data.list : []
  const item =
    list.find((r) => r?.resourceId === FREE_MODEL) ??
    list.find((r) => String(r?.unit).toUpperCase() === "MTOKENS")

  if (!item) {
    return { user, plan: "免费额度", windows: [], error: "账号下没有可用的免费额度" }
  }

  const total = num(item.purchaseCount) ?? 0
  const left = num(item.balance) ?? 0
  const used = Math.max(0, total - left)
  const out = {
    user,
    plan: `${item.resourceId} 免费额度`,
    windows: [
      {
        name: `免费额度 ${item.resourceId}`,
        used: pct(used, total),
        display: `已用 ${fmt(used)} / 共 ${fmt(total)} ${item.unit || "tokens"}`,
      },
    ],
    balance: `${fmt(left)} ${item.unit || "tokens"}`,
  }
  if (item.expireTime) out.until = item.expireTime
  if (left <= 0) out.error = "免费额度已用完"
  return out
}

/** 读额度；没有 Cookie 时给出明确说明，而不是静默空白。 */
async function readUsage(auth, tier) {
  const user = label(auth)
  const cookie = cookieOf(auth)
  if (!cookie) {
    return {
      user,
      windows: [],
      error: "未提供控制台 Cookie，无法读取额度；模型调用不受影响",
    }
  }
  try {
    if (tier === "tokenplan") {
      return usageFromTokenPlan(await tokenPlanPlans(cookie), user)
    }
    return usageFromFree(await freeQuotaResources(cookie), user)
  } catch (e) {
    return {
      user,
      windows: [],
      error: String(e?.message ?? e),
      ...(e?.signIn ? { signIn: e.signIn } : {}),
    }
  }
}

// =============================================================================
// 账号
// =============================================================================

/** tierOf 读账号的档位，默认 tokenplan。 */
function tierOf(auth) {
  return auth?.metadata?.tier === "free" ? "free" : "tokenplan"
}

/** cookieOf 取控制台 Cookie（整段 Cookie 请求头的值）。 */
function cookieOf(auth) {
  const c = auth?.metadata?.consoleCookie
  return typeof c === "string" ? c.trim() : ""
}

/** label 生成账号显示名：档位 + Key 后四位，绝不暴露完整 Key。 */
function label(auth) {
  const tier = tierOf(auth)
  const name = tier === "free" ? "免费额度" : "Token Plan"
  const key = typeof auth?.key === "string" ? auth.key : ""
  return `${name} · ${hostOf(API_BASE)}${key.length >= 8 ? " …" + key.slice(-4) : ""}`
}

// =============================================================================
// 登录校验
// =============================================================================

/**
 * checkTier 双重校验，防止两档 Key 混用：
 *
 *   1. 前缀：
 *      - Token Plan 必须是 sk-t…
 *      - 免费额度必须是 sk-… 但不能是 sk-t…
 *   2. /v1/models：
 *      - Token Plan 不能把免费模型当成套餐模型（至少要有模型）
 *      - 免费额度必须能看到 GLM-5.3-Flash
 *
 * 前缀只作为第一道提示；真正的能力判断以 /v1/models 为准，
 * 这样站点以后换前缀也不会把用户挡在门外。
 */
function checkTier(tier, key, models) {
  const ids = new Set(models)
  const isTokenPlanKey = key.startsWith(TOKEN_PLAN_PREFIX)

  if (tier === "tokenplan") {
    if (!isTokenPlanKey) {
      return `这看起来不是 Token Plan 专属 Key（应以 ${TOKEN_PLAN_PREFIX} 开头）。Token Plan Key 在「Token Plan」页面获取；当前 Key 可能是 API Key 页的通用 Key。`
    }
    if (!models.length) return "Token Plan Key 没有返回任何可用模型"
    return null
  }

  // free
  if (isTokenPlanKey) {
    return "这是 Token Plan 专属 Key，不能用于免费额度。免费额度请使用「API Key」页的通用模型服务 Key（sk-N…）。"
  }
  if (!key.startsWith("sk-")) return "API Key 应以 sk- 开头"
  if (!ids.has(FREE_MODEL)) {
    return `这个 Key 看不到免费模型 ${FREE_MODEL}，无法用于免费额度档；请确认使用的是「API Key」页的通用 Key，且免费额度仍在有效期内。`
  }
  return null
}

// =============================================================================
// 插件主体
// =============================================================================

function hooks() {
  return {
    /** config：provider 静态信息 */
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      const kept = Object.fromEntries(
        Object.entries(was.models ?? {}).filter(([k]) => k !== PLACEHOLDER)
      )
      config.provider[ID] = {
        ...was,
        name: "超算互联网",
        npm: was.npm || CHAT,
        models: Object.keys(kept).length ? kept : { [PLACEHOLDER]: placeholderModel() },
      }
    },

    auth: {
      provider: ID,

      /** loader：模型请求用的 baseURL + Key */
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: API_BASE, apiKey: auth.key }
      },

      methods: [
        {
          type: "oauth",
          label: "超算互联网 API Key",
          prompts: [
            {
              type: "select",
              key: "tier",
              message: "档位（两档 Key 不通用）",
              options: [
                { label: "Token Plan（sk-t…，扣套餐 Credits）", value: "tokenplan" },
                { label: "免费额度（sk-N…，GLM-5.3-Flash）", value: "free" },
              ],
            },
            {
              type: "password",
              key: "apiKey",
              message: "API Key",
              placeholder: "Token Plan 填 sk-t…；免费额度填 API Key 页的 sk-N…",
            },
            {
              type: "password",
              key: "consoleCookie",
              message: "控制台 Cookie（可选，仅用于查额度）",
              placeholder: "整段 Cookie 值；留空则只做模型调用",
            },
          ],

          async authorize(inputs) {
            return {
              url: "",
              instructions: "",
              method: "auto",
              async callback() {
                const tier = inputs?.tier === "free" ? "free" : "tokenplan"
                const key = String(inputs?.apiKey ?? "").trim()
                const cookie = String(inputs?.consoleCookie ?? "").trim()
                if (!key) return { type: "failed", error: "没有填写 API Key" }

                // 1) 拉模型列表，既是校验也是档位能力判断
                let models
                try {
                  models = await fetchModels(key)
                } catch (e) {
                  return {
                    type: "failed",
                    error: `API Key 不可用：${String(e?.message ?? e).slice(0, 300)}`,
                  }
                }

                // 2) 档位与 Key 是否匹配
                const bad = checkTier(tier, key, models)
                if (bad) return { type: "failed", error: bad }

                // 3) 填了 Cookie 就验证一次额度接口，提前暴露过期 Cookie
                if (cookie) {
                  try {
                    if (tier === "tokenplan") await tokenPlanPlans(cookie)
                    else await freeQuotaResources(cookie)
                  } catch (e) {
                    return {
                      type: "failed",
                      error: `控制台 Cookie 不可用：${String(e?.message ?? e).slice(0, 300)}`,
                    }
                  }
                }

                return {
                  type: "success",
                  key,
                  metadata: {
                    tier,
                    baseURL: API_BASE,
                    consoleCookie: cookie || undefined,
                  },
                  accountId: label({ key, metadata: { tier } }),
                }
              },
            }
          },
        },
      ],

      /** usage：按档位查各自的额度 */
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return { error: "未登录" }
        return readUsage(auth, tierOf(auth))
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models

        try {
          let ids = await fetchModels(auth.key)
          // 免费档只暴露免费模型，避免误用其他模型走按量付费
          if (tierOf(auth) === "free") ids = ids.filter((id) => id === FREE_MODEL)
          if (!ids.length) return provider.models

          const out = {}
          for (const id of ids) out[id] = runtimeModel(id)
          return out
        } catch (e) {
          if (e?.signIn) throw e
          return provider.models
        }
      },
    },
  }
}

export async function ScnetPlugin() {
  return hooks()
}

// _internal 只给测试用。
export const _internal = {
  ID,
  API_BASE,
  FREE_MODEL,
  TOKEN_PLAN_PREFIX,
  fetchModels,
  runtimeModel,
  placeholderModel,
  consoleJson,
  currentAccountId,
  tokenPlanPlans,
  freeQuotaResources,
  usageFromTokenPlan,
  usageFromFree,
  readUsage,
  checkTier,
  tierOf,
  cookieOf,
  label,
  fmt,
  pct,
}
