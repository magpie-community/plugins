// AStudio（科大讯飞 Astron Studio 桌面端）for OpenCode and magpie.
//
// AStudio 桌面端登录后，把账号的模型凭据与会话写进它的数据目录（Windows 下
// 注册表 HKCU\Software\AStudioStorage 登记 DataRoot）：
//   <DataRoot>/userdata/astron-session.json        — modelBearerToken / token / uid
//   <DataRoot>/runtime/acode-home/config.toml      — [model_providers.astron-spark]
//       experimental_bearer_token = "…"（与 session 的 modelBearerToken 同源）
// 两套云端接口：
//   模型调用  POST https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses
//             （OpenAI Responses 协议，Authorization: Bearer <modelBearerToken>，
//              与桌面端写进 acode 内核的 base_url/wire_api 完全一致）
//   模型目录  GET  https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models
//   账号面    https://agent.xfyun.cn/xingchen-studio/…（Cookie 会话鉴权）：
//             points/balance、membership/me、membership/plan-config、points/summary
//
// 本插件复用这份登录态：第一种登录方式直接从磁盘读取桌面端会话（Raccoon
// 「复用桌面端登录态」同款），第二种让用户手动粘贴 modelBearerToken。目录与
// 思考档位按账号实时拉取（目录读取不计费）。AStudio 有「每日登录积分」
// （服务端在当天账号会话首次活跃时发放，客户端弹窗只做通知，无领取接口），
// auth.checkin 用「发放前后余额差」观测：涨了记 claimed，没涨不谎称已签——
// 记 inactive 并说明未观测到（宿主把 done 渲染成「今日已签到」，是没发生的断言）。

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir as osHomedir } from "node:os"

const ID = "astudio"

// 云端地址（来自桌面端 resolveAstronRuntimeProfile 的 production 分支）。
const MODEL_GATEWAY_BASE = "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1"
const MODEL_MANAGER_URL = "https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models"
const STUDIO_API_BASE = "https://agent.xfyun.cn/xingchen-studio/"

const REGISTRY_KEY = "HKCU\\Software\\AStudioStorage"
const REGISTRY_PREFIXES = ["Production", "Canary", "Development"]

// 未登录/拿不到桌面端数据时的兜底目录（桌面端未在注册表登记时也可能落在这些位置）。
// 函数吃 homedir 参数（readDesktopCredential 注入，缺省回落真实家目录），测试可重定向。
const SESSION_FALLBACKS = [
  (home = osHomedir()) => join(home, ".acode", "acode", "userdata", "astron-session.json"),
]

const ACODE_CONFIG_FALLBACKS = [
  (home = osHomedir()) => join(home, ".acode", "acode", "config.toml"),
]

// 模型目录读不到时的启动表（2026-11-01 实测目录快照；models 钩子会用实时目录覆盖）。
const BOOTSTRAP = [
  { id: "astronclaw-auto", name: "Auto", context: 262144, output: 32768 },
  { id: "spark-x2.6", name: "Spark-X2.6", context: 262144, output: 32768, badge: "Preview" },
  { id: "spark-x2.6-4b", name: "Spark-X2.6-Lite", context: 1048576, output: 110000, free: true },
  { id: "spark-x2.5", name: "Spark-X2.5", context: 262144, output: 32768 },
  { id: "xopglm52", name: "GLM-5.2", context: 1048576, output: 32768 },
  { id: "xopdeepseekv4pro0813", name: "DeepSeek-V4-Pro", context: 1048576, output: 32768 },
  { id: "xopdsv4flash0731in", name: "DeepSeek-V4-Flash", context: 1048576, output: 32768 },
]

function join(...parts) {
  return parts.join("/")
}

// rowFromCatalogEntry 把 model-manager 的一个模型变成 OpenCode 的 Model。
// 套餐不按 token 计费，无 cost；倍率上游未给出，不标。
function rowFromCatalogEntry(m) {
  const image = Array.isArray(m?.input_modalities) && m.input_modalities.includes("image")
  const efforts = Array.isArray(m?.supported_reasoning_levels)
    ? m.supported_reasoning_levels.filter((l) => typeof l?.effort === "string" && l.effort)
    : []
  const reasoning = efforts.some((l) => l.effort !== "none")
  const variants = reasoning
    ? Object.fromEntries(efforts.map((l) => [l.effort, { reasoningEffort: l.effort }]))
    : undefined
  const free = m?.badge?.text?.en === "Free"
  return {
    id: m.slug,
    name: m.display_name ?? m.slug,
    limit: {
      context: typeof m?.context_window === "number" && m.context_window > 0 ? m.context_window : 0,
      output: typeof m?.max_output_tokens === "number" && m.max_output_tokens > 0 ? m.max_output_tokens : 32768,
    },
    reasoning,
    tool_call: true,
    ...(variants ? { variants } : {}),
    ...(free ? { free: true } : {}),
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning,
      toolcall: true,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
  }
}

function bootstrapRows() {
  return Object.fromEntries(
    BOOTSTRAP.map((m) => [
      m.id,
      {
        id: m.id,
        name: m.name,
        limit: { context: m.context, output: m.output },
        reasoning: true,
        tool_call: true,
        ...(m.free ? { free: true } : {}),
        modalities: { input: ["text"], output: ["text"] },
        capabilities: {
          reasoning: true,
          toolcall: true,
          attachment: false,
          input: { text: true, image: false },
          output: { text: true },
        },
      },
    ]),
  )
}

// registryDataRoots 读注册表里登记的各 profile 数据根目录（Windows）。
function registryDataRoots(registryQuery = defaultRegistryQuery) {
  const roots = []
  for (const prefix of REGISTRY_PREFIXES) {
    const value = registryQuery(REGISTRY_KEY, `${prefix}DataRoot`)
    if (value) roots.push(value)
  }
  return roots
}

function defaultRegistryQuery(key, valueName) {
  if (process.platform !== "win32") return null
  try {
    const r = spawnSync("reg", ["query", key, "/v", valueName, "/reg:64"], { timeout: 5000, windowsHide: true })
    const out = `${r.stdout ?? ""}`
    const m = out.match(/REG_SZ\s+(\S[^\r\n]*)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

// readAcodeConfigToken 兜底：从 acode 内核的 config.toml 取凭据。
function readAcodeConfigToken(content) {
  const section = content.match(/^\s*\[\s*model_providers\s*\.\s*astron-spark\s*\]\s*$/m)
  if (!section) return null
  const after = content.slice(section.index + section[0].length)
  const nextSection = after.search(/^\s*\[/m)
  const body = nextSection >= 0 ? after.slice(0, nextSection) : after
  const token = body.match(/^\s*experimental_bearer_token\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const uid = body.match(/^\s*uid\s*=\s*"([^"]+)"\s*$/m)?.[1]
  return token ? { key: token, uid: uid ?? undefined } : null
}

// readDesktopCredential 找到桌面端登录态并返回 { key, uid, session, source }。
// session 是账号面的 Cookie 材料（token/ssoSessionId/accountId），积分与签到用。
// 找不到抛错，error message 面向用户。
function readDesktopCredential({ env = process.env, homedir = osHomedir(), readFileImpl, registryQuery } = {}) {
  const readFile = readFileImpl ?? ((path) => readFileSync(path, "utf8"))
  const sessionPaths = []
  const configPaths = []
  const configured = env.ASTUDIO_HOME?.trim() || env.SYNARA_HOME?.trim()
  if (configured) {
    sessionPaths.push(join(configured, "userdata", "astron-session.json"))
    configPaths.push(join(configured, "runtime", "acode-home", "config.toml"))
  }
  for (const root of registryDataRoots(registryQuery)) {
    sessionPaths.push(join(root, "userdata", "astron-session.json"))
    configPaths.push(join(root, "runtime", "acode-home", "config.toml"))
  }
  for (const p of SESSION_FALLBACKS) sessionPaths.push(p(homedir))
  for (const p of ACODE_CONFIG_FALLBACKS) configPaths.push(p(homedir))

  const problems = []
  for (const path of sessionPaths) {
    let raw
    try {
      raw = readFile(path)
    } catch {
      continue
    }
    let session
    try {
      session = JSON.parse(raw)
    } catch {
      problems.push(`${path} 不是有效 JSON`)
      continue
    }
    if (session.banned === true) throw new Error(`AStudio 账号已被封禁（${path}）`)
    const key = typeof session.modelBearerToken === "string" && session.modelBearerToken.trim()
      ? session.modelBearerToken.trim()
      : typeof session.token === "string" && session.token.trim()
        ? session.token.trim()
        : null
    if (!key) {
      problems.push(`${path} 里没有 modelBearerToken/token`)
      continue
    }
    if (key.length > 4096) {
      problems.push(`${path} 的凭据异常地长`)
      continue
    }
    const uid = typeof session.uid === "string" && session.uid.trim() ? session.uid.trim() : undefined
    const cookieSession = typeof session.token === "string" && session.token.trim() && typeof session.accountId === "string" && session.accountId.trim()
      ? { token: session.token.trim(), ssoSessionId: typeof session.ssoSessionId === "string" ? session.ssoSessionId.trim() : undefined, accountId: session.accountId.trim() }
      : undefined
    return { key, uid, session: cookieSession, source: path }
  }

  for (const path of configPaths) {
    let raw
    try {
      raw = readFile(path)
    } catch {
      continue
    }
    const parsed = readAcodeConfigToken(raw)
    if (parsed) return { ...parsed, session: undefined, source: path }
    problems.push(`${path} 里没有 astron-spark 凭据`)
  }

  const detail = problems.length ? `：${problems.join("；")}` : ""
  throw new Error(`未找到 AStudio 桌面端登录态${detail}。请先启动 AStudio 并登录，或改用「粘贴 modelBearerToken」方式。`)
}

// 桌面端 buildAstronCookieHeader 的等价实现（agent.xfyun.cn 的 Cookie 会话）。
function buildCookieHeader(session) {
  const parts = []
  if (session?.ssoSessionId) parts.push(`ssoSessionId=${session.ssoSessionId}`, `sso_sessionid=${session.ssoSessionId}`)
  if (session?.accountId) parts.push(`account_id=${session.accountId}`)
  if (session?.token) parts.push(`token=${session.token}`)
  return parts.join("; ")
}

// studioJson 调账号面接口；信封 flag:true&&code:0 视为成功并返回 data，
// 401/403（含 code 80000 登录异常）抛带 signIn:"expired" 的错。
async function studioJson(path, { session, fetchImpl, method = "GET", body, operation = path }) {
  let res
  try {
    res = await fetchImpl(new URL(path, STUDIO_API_BASE), {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: buildCookieHeader(session),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  } catch (error) {
    throw new Error(`${operation} 网络失败：${error?.cause?.code || error?.message || "未知错误"}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`AStudio 会话已失效（HTTP ${res.status}），请重新登录 AStudio`), { signIn: "expired" })
  }
  let payload
  try {
    payload = await res.json()
  } catch {
    throw new Error(`${operation} 返回的不是 JSON（HTTP ${res.status}）`)
  }
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}
  if (!res.ok || (envelope.flag === false || (envelope.code !== undefined && envelope.code !== 0))) {
    if (envelope.code === 80000 || /重新登录/.test(String(envelope.desc ?? ""))) {
      throw Object.assign(new Error(`AStudio 会话已失效，请重新登录 AStudio`), { signIn: "expired" })
    }
    throw new Error(`${operation} 失败（HTTP ${res.status}${envelope.desc ? `：${envelope.desc}` : ""}）`)
  }
  return envelope.data
}

async function fetchCatalog(key, fetchImpl) {
  return await fetchImpl(MODEL_MANAGER_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

function createPlugin({ fetchImpl = globalThis.fetch, env = process.env, homedir = osHomedir(), registryQuery, readFileImpl, sleepImpl } = {}) {
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function readBalance(session) {
    return await studioJson("points/balance", { session, fetchImpl, operation: "积分余额" })
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // ??= 保留用户在 plugins.json 里自己配置的同名供应商。
      cfg.provider[ID] ??= {
        name: "AStudio",
        npm: "@ai-sdk/openai", // OpenAI Responses；网关在 baseURL 后拼 /responses
        api: MODEL_GATEWAY_BASE,
        models: bootstrapRows(),
      }
    },

    auth: {
      provider: ID,
      methods: [
        {
          type: "api",
          label: "读取 AStudio 桌面端登录态",
          // 不用输入框：authorize 自己从磁盘读桌面端会话。
          async authorize() {
            let cred
            try {
              cred = readDesktopCredential({ env, homedir, registryQuery, readFileImpl })
            } catch (error) {
              return { type: "failed", error: error?.message ?? "读取 AStudio 桌面端登录态失败" }
            }
            return {
              type: "success",
              key: cred.key,
              accountId: cred.uid,
              metadata: {
                uid: cred.uid,
                source: cred.source,
                method: "desktop",
                // Cookie 会话材料：积分余额、会员信息与每日签到用。
                session: cred.session,
              },
            }
          },
        },
        {
          type: "api",
          label: "粘贴 modelBearerToken",
          prompts: [
            {
              type: "password",
              key: "modelBearerToken",
              message: "modelBearerToken（astron-session.json 或 acode config.toml 里的值）",
              validate: (v) => (v && v.trim() ? undefined : "必填"),
            },
            {
              type: "text",
              key: "uid",
              message: "账号 uid（可选，用于显示，如 18800000000）",
            },
            {
              type: "password",
              key: "sessionToken",
              message: "网页会话 token（astron-session.json 的 token 字段；用于积分余额与每日签到）",
            },
            {
              type: "text",
              key: "accountId",
              message: "账号面 accountId（与 sessionToken 一起填，积分余额与签到才可用）",
            },
            {
              type: "password",
              key: "ssoSessionId",
              message: "ssoSessionId（可选，Cookie 会话补充材料）",
            },
          ],
          // 粘贴路径此前只问不存（没有 authorize，输入全部丢弃）。现在按桌面端
          // 成功返回的同一形状落库；token+accountId 齐才组得出 Cookie 会话。
          async authorize(inputs) {
            const key = String(inputs?.modelBearerToken ?? "").trim()
            if (!key) return { type: "failed", error: "modelBearerToken 必填" }
            if (key.length > 4096) return { type: "failed", error: "凭据异常地长" }
            const token = String(inputs?.sessionToken ?? "").trim()
            const accountId = String(inputs?.accountId ?? "").trim()
            const ssoSessionId = String(inputs?.ssoSessionId ?? "").trim()
            const uid = String(inputs?.uid ?? "").trim() || undefined
            const session = token && accountId
              ? { token, accountId, ...(ssoSessionId ? { ssoSessionId } : {}) }
              : undefined
            return {
              type: "success",
              key,
              accountId: accountId || uid,
              metadata: {
                uid,
                source: "paste",
                method: "paste",
                ...(session ? { session } : {}),
              },
            }
          },
        },
      ],
      // @ai-sdk/openai 把 apiKey 发成 Authorization: Bearer <key>，与桌面端内核
      // 对 model-gateway 的调用完全一致，无需自定义头。
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: MODEL_GATEWAY_BASE, apiKey: auth.key }
      },
      // 有 Cookie 会话时显示真实积分余额与会员档；只有模型凭据时退回目录
      // 连通性检查。读取均不计费。
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const session = auth.metadata?.session
        if (!session?.token) {
          let res
          try {
            res = await fetchCatalog(auth.key, fetchImpl)
          } catch (error) {
            return { error: `AStudio 不可达：${error?.cause?.code || error?.message || "网络错误"}`, windows: [] }
          }
          if (res.status === 401 || res.status === 403) {
            return { error: `AStudio 拒绝了这份凭据（HTTP ${res.status}），请重新登录`, signIn: "expired", windows: [] }
          }
          if (!res.ok) return { error: `AStudio 返回 HTTP ${res.status}`, windows: [] }
          return { plan: "AStudio", windows: [] }
        }
        // 单项失败不塌方（一边挂了另一边还能显示），但登录态过期必须透传，
        // 不能折叠成「账号信息读取失败」。
        const tolerate = (promise) =>
          promise.catch((error) => {
            if (error?.signIn === "expired") throw error
            return null
          })
        let balance, membership
        try {
          ;[balance, membership] = await Promise.all([
            tolerate(readBalance(session)),
            tolerate(studioJson("membership/me", { session, fetchImpl, operation: "会员信息" })),
          ])
        } catch (error) {
          return { error: error?.message ?? "AStudio 账号信息读取失败", signIn: "expired", windows: [] }
        }
        if (!balance && !membership) {
          return { error: "AStudio 账号信息读取失败", windows: [] }
        }
        const windows = []
        if (balance && typeof balance.totalBalance === "number") {
          windows.push({
            name: "通用积分",
            balance: balance.totalBalance,
            aside: false,
            ...(balance.activityNextExpireTime && balance.activityBalance > 0
              ? { runsOutAt: balance.activityNextExpireTime, runsOut: balance.activityBalance }
              : {}),
          })
        }
        if (balance && typeof balance.sparkTotalBalance === "number") {
          windows.push({ name: "星火积分", balance: balance.sparkTotalBalance, aside: false })
        }
        return {
          ...(membership?.planName ? { plan: membership.planName } : { plan: "AStudio" }),
          ...(membership?.uid != null ? { user: String(membership.uid) } : {}),
          ...(membership?.endTime ? { until: membership.endTime } : {}),
          windows,
        }
      },
      // 「每日登录积分」：服务端在当天账号会话首次活跃时发放，客户端没有领取
      // 接口（弹窗只做通知）。这里以一组账号面请求代表当天的会话活跃，并用
      // 发放前后的余额差观测结果：涨了是 claimed，没涨是 done。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const session = auth.metadata?.session
        if (!session?.token) {
          return { outcome: "ineligible", message: "该账号只有模型凭据（无网页会话），无法执行每日登录签到" }
        }
        let config
        try {
          config = await studioJson("membership/plan-config", { session, fetchImpl, operation: "签到配置" })
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "签到配置读取失败" }
        }
        if (config?.dailyLoginEnabled === false) {
          return { outcome: "inactive", message: "当前没有每日登录积分活动" }
        }
        let before
        try {
          before = await readBalance(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "积分余额读取失败" }
        }
        // 会话活跃 touch：与桌面端启动时同类只读请求。
        await studioJson("membership/me", { session, fetchImpl, operation: "会员信息" }).catch(() => null)
        await studioJson("points/summary", { session, fetchImpl, operation: "积分汇总" }).catch(() => null)
        await sleep(2500)
        let after
        try {
          after = await readBalance(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "积分余额读取失败" }
        }
        if (typeof before?.totalBalance !== "number" || typeof after?.totalBalance !== "number") {
          return { outcome: "failed", message: "积分余额读数不完整" }
        }
        const delta = after.totalBalance - before.totalBalance
        if (delta > 0) return { outcome: "claimed", credit: delta, message: `每日登录积分 +${delta}` }
        // 余额没涨 ≠ 已发放：无领取接口，发放可能挂靠桌面端登录，本次未观测到。
        // 不能报 done（宿主渲染成「今日已签到」，是没发生的断言）；inactive 是
        // 静默结算态，message 仍会把实情带给用户。
        return { outcome: "inactive", message: "未观测到新发放：余额无变化（发放可能挂靠桌面端登录）" }
      },
    },

    provider: {
      id: ID,
      // 按账号实时拉目录（模型、思考档位、限免标记都可能随账号/时间变）。
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res
        try {
          res = await fetchCatalog(auth.key, fetchImpl)
        } catch {
          // 网络失败保留原列表，与目录接口非 2xx 同待遇。
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`AStudio 拒绝了这份凭据（HTTP ${res.status}），请重新登录`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("AStudio 模型目录不是有效 JSON")
        }
        const list = body?.data?.models
        if (!Array.isArray(list) || list.some((m) => typeof m?.slug !== "string" || !m.slug)) {
          throw new Error("AStudio 模型目录格式异常")
        }
        const rows = Object.fromEntries(
          list
            .filter((m) => m.visibility !== "hidden" && m.supported_in_api !== false)
            .map((m) => [m.slug, rowFromCatalogEntry(m)]),
        )
        if (!Object.keys(rows).length) throw new Error("AStudio 模型目录为空")
        return rows
      },
    },
  }
}

// 插件是唯一的导出函数；magpie 会把入口导出的每个函数都当插件调用，测试需要的
// 内部函数按社区约定放在 _internal 对象上。
export const AStudioPlugin = async () => createPlugin()
export const _internal = {
  createPlugin,
  rowFromCatalogEntry,
  bootstrapRows,
  readDesktopCredential,
  readAcodeConfigToken,
  registryDataRoots,
  buildCookieHeader,
  studioJson,
  MODEL_GATEWAY_BASE,
  MODEL_MANAGER_URL,
  STUDIO_API_BASE,
  BOOTSTRAP,
  ID,
}
