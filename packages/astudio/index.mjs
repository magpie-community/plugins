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
// 三种登录方式：①浏览器登录（推荐，可多账号）——弹出全新 profile 的专用浏览器，
// 用户在里面登录后收割网页会话 Cookie（ssoSessionId + account_id 必需，token 有
// 则带上），再用桌面端启动时的同款 POST auth/bearer-token 换发模型凭据（JWT，
// 实测 3 年有效；换发后旧 token 仍可用），accountId 用账号 uid，同一账号的桌面端
// 与网页登录因此归到同一格；②读取桌面端登录态——直接从磁盘读桌面端会话
// （magpie 的 oauth 方式，读不到时给出官网链接并轮询，等用户装好登录）；
// ③粘贴 modelBearerToken。目录与思考档位按账号实时拉取（目录读取不计费）。
//
// AStudio 有「每日登录积分」：服务端在当天账号会话首次活跃时发放，客户端弹窗
// 只做通知、没有领取接口。auth.checkin 先读当日获得流水（points/details
// direction=CREDIT，与网页后台「获得明细」同源）：已有「每日登录赠送」GRANT 行
// 即 done，此时一个写请求都不发；流水为空才补一次会话活跃（POST
// tenant-app/v2/init-app，复刻桌面端启动），再读一次流水。流水读失败退回余额差 +
// 弹窗观测。流水通畅、余额没涨、也无当日弹窗则记 inactive——宿主把 done 渲染成
// 「今日已签到」，没发生的不能断言。

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir as osHomedir } from "node:os"
import * as browserDefault from "./browser.mjs"

const ID = "astudio"

// 云端地址（来自桌面端 resolveAstronRuntimeProfile 的 production 分支）。
const MODEL_GATEWAY_BASE = "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1"
const MODEL_MANAGER_URL = "https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models"
const STUDIO_API_BASE = "https://agent.xfyun.cn/xingchen-studio/"
// agent.xfyun.cn 的账号面接口要求桌面端身份：只带 Cookie 会被拒（code 11001001）。
// clientType 是必需头且校验合法枚举（21/22 通过、99/缺失被拒）；studioVersion 桌面端也带，实测值不参与校验。
const CLIENT_TYPE = process.platform === "darwin" ? "22" : "21"
const STUDIO_VERSION = "3.5.5"

// 读取桌面端登录态失败时展示的跳转页：AStudio 官网（含桌面端下载）。
const OFFICIAL_SITE = "https://agent.xfyun.cn/"
// 网页登录的落地页：登录后 web bundle 把 ssoSessionId/account_id/token 写进 Cookie。
const STUDIO_WEB_URL = "https://agent.xfyun.cn/studio-credits"
// 浏览器登录窗口的等待上限（宿主取消时也会提前 abort）。
const WEB_SIGNIN_WAIT_MS = 10 * 60 * 1000
// 等待「用户去装桌面端并登录」的窗口与轮询间隔。
const DESKTOP_POLL_MS = 2000
const DESKTOP_WAIT_MS = 5 * 60 * 1000

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
    const raw = readFileOrNull(path, readFile, problems)
    if (raw === null) continue
    let session
    try {
      session = JSON.parse(raw)
    } catch {
      problems.push(`${path} 不是有效 JSON`)
      continue
    }
    if (session.banned === true) throw Object.assign(new Error(`AStudio 账号已被封禁（${path}）`), { code: "banned" })
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
    const raw = readFileOrNull(path, readFile, problems)
    if (raw === null) continue
    const parsed = readAcodeConfigToken(raw)
    if (parsed) return { ...parsed, session: undefined, source: path }
    problems.push(`${path} 里没有 astron-spark 凭据`)
  }

  const detail = problems.length ? `：${problems.join("；")}` : ""
  // 「什么都没找到」与「有数据但读不出来」分开说：后者的用户多半已经装好了。
  const message = problems.length
    ? `AStudio 桌面端登录态读不出来${detail}。请先启动 AStudio 并登录，或改用「粘贴 modelBearerToken」方式。`
    : "未找到 AStudio 桌面端登录态。请先启动 AStudio 并登录，或改用「粘贴 modelBearerToken」方式。"
  throw Object.assign(
    new Error(message),
    // problems 为空 = 这些路径上什么都没有（新机器）；非空 = 有 AStudio 的数据但用不了。
    { code: problems.length ? "unreadable" : "missing" },
  )
}

// readFileOrNull 读一个候选文件：不存在（ENOENT）算「这台机器上没有」，别的读盘
// 错误（权限、I/O）要留进 problems，否则用户只会看到「没装」而看不出是读不了。
function readFileOrNull(path, readFile, problems) {
  try {
    return readFile(path)
  } catch (error) {
    if (error?.code !== "ENOENT") problems.push(`${path} 读取失败（${error?.message ?? "未知错误"}）`)
    return null
  }
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
        clientType: CLIENT_TYPE,
        studioVersion: STUDIO_VERSION,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: buildCookieHeader(session),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  } catch (error) {
    throw Object.assign(new Error(`${operation} 网络失败：${error?.cause?.code || error?.message || "未知错误"}`), { transient: true })
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
    throw Object.assign(new Error(`${operation} 失败（HTTP ${res.status}${envelope.desc ? `：${envelope.desc}` : ""}）`), {
      transient: res.status >= 500,
    })
  }
  return envelope.data
}

// 网页登录换发模型凭据：桌面端启动时的同款 POST（Cookie 鉴权），返回
// modelBearerToken（JWT，实测 3 年有效期；换发后旧 token 仍可用）。
// 请求装配与错误分类都走 studioJson，别再抄一份（抄本必然与正本漂移）。
async function exchangeModelToken(session, fetchImpl) {
  const data = await studioJson("auth/bearer-token", {
    session,
    fetchImpl,
    method: "POST",
    operation: "换发模型凭据",
  })
  const token = data?.modelBearerToken
  if (typeof token !== "string" || !token) throw new Error("换发模型凭据失败：返回里没有 modelBearerToken")
  return token
}

// 登录回调里的两次网络读：只有网络/5xx 这类瞬时失败重试，会话失效与确定性
// 4xx 不重试——用户刚在浏览器里登完，一次抖动不该把整次登录作废。
async function retryTransient(fn, sleep, attempts = 3, delayMs = 2000) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (!error?.transient || i + 1 >= attempts) throw error
      await sleep(delayMs)
    }
  }
}

async function fetchCatalog(key, fetchImpl) {
  return await fetchImpl(MODEL_MANAGER_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

// authResult 把读到的桌面端凭据变成 magpie 的登录结果：带 key 会被存成 API key，
// metadata 整份留给 loader / usage / checkin（session 是账号面的 Cookie 材料）。
function authResult(cred) {
  return {
    type: "success",
    key: cred.key,
    // 实测 uid === account_id；session 里缺 uid 的旧登录态退回 account_id，
    // 否则 accountId 为空会让宿主把多个账号塌进同一格。
    accountId: cred.uid || cred.session?.accountId,
    metadata: {
      uid: cred.uid,
      source: cred.source,
      method: "desktop",
      session: cred.session,
    },
  }
}

// probeDesktopCredential 读一次桌面端登录态，把「没找到」变成返回值而不是异常。
function probeDesktopCredential(deps = {}) {
  try {
    return { cred: readDesktopCredential(deps) }
  } catch (error) {
    return { error }
  }
}

// waitForDesktopCredential 轮询磁盘，等用户在本机装好并登录桌面端。返回
// {status:"ready", result} / {status:"timeout", error} / {status:"aborted"}。
async function waitForDesktopCredential({ read, sleep, now, signal, waitMs = DESKTOP_WAIT_MS, stepMs = DESKTOP_POLL_MS }) {
  const deadline = now() + waitMs
  for (;;) {
    // magpie 取消登录时会 abort 这个 signal，别再空转剩下的几分钟。
    if (signal?.aborted) return { status: "aborted" }
    const trial = read()
    if (trial.cred) return { status: "ready", result: authResult(trial.cred) }
    if (now() >= deadline) return { status: "timeout", error: trial.error }
    await sleep(stepMs)
  }
}

// reasonOf 把读盘失败压成一句给用户看的话（超时失败时带上最后一次的原因）。
function reasonOf(error) {
  return error?.code === "unreadable" || error?.code === "banned"
    ? error.message
    : "本机没有 AStudio 桌面端登录态"
}

function createPlugin({ fetchImpl = globalThis.fetch, env = process.env, homedir = osHomedir(), registryQuery, readFileImpl, sleepImpl, nowMsImpl = () => Date.now(), browserModule = browserDefault } = {}) {
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function readBalance(session) {
    return await studioJson("points/balance", { session, fetchImpl, operation: "积分余额" })
  }

  // points/details 的时间参数格式（网页端同款）：`YYYY-MM-DD HH:mm:ss`，服务端
  // 按北京时间解释。窗口必须用 +08:00 的墙上时间算：本地时区（TZ=America/
  // Los_Angeles）或 UTC 机器会把当天的 GRANT 行算到窗口外，签到误报 inactive。
  // 时间只从 nowMsImpl 取，测试才能把时钟钉住。
  const CST_OFFSET_MS = 8 * 3600 * 1000
  function cstStamp(ms) {
    const d = new Date(ms + CST_OFFSET_MS)
    const p2 = (n) => String(n).padStart(2, "0")
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  }
  const cstDayStart = (ms) => Math.floor((ms + CST_OFFSET_MS) / 86400000) * 86400000 - CST_OFFSET_MS
  const cstDayOf = (ms) => Math.floor((ms + CST_OFFSET_MS) / 86400000)

  // 当日「每日登录赠送」入账流水。网页后台的获得明细（points/details
  // direction=CREDIT）是权威数据源：发放一旦发生就有 GRANT 行，不管由哪个
  // 端触发（桌面端 init-app、服务端午夜批量），都比「余额差+弹窗」可靠。
  async function readDailyGrantLedger(session) {
    const now = nowMsImpl()
    const query = `pageNum=1&pageSize=50&direction=CREDIT&startTime=${encodeURIComponent(cstStamp(cstDayStart(now)))}&endTime=${encodeURIComponent(cstStamp(now))}`
    const data = await studioJson(`points/details?${query}`, { session, fetchImpl, operation: "获得明细" })
    const items = Array.isArray(data?.items) ? data.items : []
    return items.find((item) => item?.direction === "CREDIT" && item?.operation === "GRANT" && item?.reason === "每日登录赠送") ?? null
  }

  // 星火积分最近到期批次（raccoon 同款算法）：流水按 expireTime 聚合，
  // 取最近的未过期批次金额，供 usage 窗口挂 runsOutAt/runsOut。
  // 服务端时间戳是北京时间的裸串（无时区标记），显式钉 +08:00：
  // 不同运行时对无时区 ISO 串的解释不同（node=本地时区、bun=UTC）。
  const parseCST = (s) => Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+08:00`)
  async function readSparkExpiry(session, cap) {
    const now = nowMsImpl()
    const startTime = encodeURIComponent(cstStamp(now - 60 * 86400000))
    const endTime = encodeURIComponent(cstStamp(now))
    // 60 天窗口里每天一笔 GRANT，一页 50 行装不下——逐页读，最多 10 页，
    // 用整行去重防服务端忽略 pageNum 时重复累加。
    const seen = new Set()
    const rows = []
    for (let page = 1; page <= 10; page++) {
      const data = await studioJson(
        `points/details?pageNum=${page}&pageSize=50&direction=CREDIT&startTime=${startTime}&endTime=${endTime}`,
        { session, fetchImpl, operation: "获得明细" },
      )
      const batch = Array.isArray(data?.items) ? data.items : []
      for (const item of batch) {
        const key = JSON.stringify(item)
        if (seen.has(key)) continue
        seen.add(key)
        rows.push(item)
      }
      if (batch.length < 50) break
    }
    let soonestMs = 0
    let expiring = 0
    for (const item of rows) {
      if (item?.assetCode !== "SPARK_POINTS") continue
      const amount = Number(item?.amount)
      const expMs = item?.expireTime ? parseCST(item.expireTime) : NaN
      if (!Number.isFinite(amount) || amount <= 0) continue
      if (!Number.isFinite(expMs) || expMs <= now) continue
      if (!soonestMs || expMs < soonestMs) {
        soonestMs = expMs
        expiring = amount
      } else if (expMs === soonestMs) {
        expiring += amount
      }
    }
    if (!soonestMs) return null
    // 流水记的是发放额，余额才是还没花掉的量：到期提示不能超过余额。
    const limit = Number(cap)
    const runsOut = Number.isFinite(limit) && limit >= 0 ? Math.min(expiring, limit) : expiring
    return { runsOutAt: new Date(soonestMs).toISOString(), runsOut }
  }

  async function readPopups(session) {
    return await studioJson("client-popups/pending", { session, fetchImpl, operation: "每日奖励弹窗" })
  }

  // 桌面端启动时的两个 POST 里，签到只复刻 init-app（租户初始化）。另一个
  // auth/bearer-token 会换发 modelBearerToken；2026-11-06 实测新旧 token 并存
  // （换发后旧 token 仍可用），但签到没有换发需求，多换一次只是白白轮换，
  // 故仍不调用——浏览器登录自己需要 key 时才换。失败不塌方，但原因要收集
  // 起来交给上层，否则用户分不清「POST 失败」和「今天确实没发」。
  async function desktopLogin(session) {
    const warnings = []
    try {
      await studioJson("tenant-app/v2/init-app", { session, fetchImpl, method: "POST", operation: "租户初始化" })
    } catch (error) {
      if (error?.signIn === "expired") throw error
      warnings.push(`init-app ${error?.message ?? "失败"}`)
    }
    return { warnings }
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
          // 网页登录：浏览器里登一次，插件收割 Cookie（ssoSessionId/account_id/
          // token）后换发模型凭据。每次登录用全新 profile，不串票；登录收尾后
          // 连 profile 一起删掉——会话已存进 metadata.session，浏览器目录只是
          // 第二份凭据副本，留着只会随每次重登无限堆积。accountId 用 uid——
          // 同一账号用桌面端登录时也是 uid，宿主因此把两路登录归到同一格。
          type: "oauth",
          label: "浏览器登录（推荐，可多账号）",
          async authorize(_inputs, { signal } = {}) {
            // 先确认本机有 Chrome/Edge：没有就当场报错，别先说「已弹出」再失败。
            await browserModule.browserExecutable?.()
            const harvesting = browserModule.startBrowserHarvest({ deadlineMs: WEB_SIGNIN_WAIT_MS, startUrl: STUDIO_WEB_URL })
            harvesting.promise.catch(() => {})
            const cleanup = setTimeout(() => { harvesting.abort().catch(() => {}) }, WEB_SIGNIN_WAIT_MS)
            // 别让这个兜底定时器拖住宿主的事件循环（测试里变成 5 分钟不退出）。
            cleanup.unref?.()
            const onAbort = () => { harvesting.abort().catch(() => {}) }
            if (signal?.aborted) onAbort()
            else if (typeof signal?.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true })
            return {
              url: "",
              opened: true, // 浏览器已由本插件弹出，宿主不要再开 url
              instructions: "已弹出专用浏览器窗口：请在里面登录讯飞账号（手机验证码或扫码均可），登录成功后本流程自动继续。",
              method: "auto",
              async callback(_code, { signal: callbackSignal } = {}) {
                if (callbackSignal?.aborted) onAbort()
                else if (typeof callbackSignal?.addEventListener === "function") callbackSignal.addEventListener("abort", onAbort, { once: true })
                let harvested
                try {
                  harvested = await harvesting.promise
                  const membership = await retryTransient(
                    () => studioJson("membership/me", { session: harvested.session, fetchImpl, operation: "会员信息" }),
                    sleep,
                  )
                  const uid = String(membership?.uid ?? "").trim()
                  if (!uid) throw new Error("AStudio 账号信息里没有 uid，无法确定账号")
                  const key = await retryTransient(() => exchangeModelToken(harvested.session, fetchImpl), sleep)
                  return {
                    type: "success",
                    key,
                    accountId: uid,
                    metadata: {
                      uid,
                      method: "web",
                      source: STUDIO_WEB_URL,
                      session: harvested.session,
                    },
                  }
                } catch (error) {
                  return { type: "failed", error: error?.message ?? String(error) }
                } finally {
                  clearTimeout(cleanup)
                  signal?.removeEventListener?.("abort", onAbort)
                  callbackSignal?.removeEventListener?.("abort", onAbort)
                  if (harvested) {
                    await harvested.close().catch(() => {})
                    await harvested.release()
                    // 会话已收进 metadata.session；浏览器目录是第二份凭据副本，
                    // 成功失败都不留（否则每次重登都在盘上堆一份）。
                    await browserModule.removeProfile(harvested.profilePath)
                  }
                }
              },
            }
          },
        },
        {
          // oauth 方式：magpie 不显示 key 输入框，authorize 必须立刻返回
          // { url, instructions, method, callback }，结果由 callback 交回。
          // 读得到就立刻完成（url 留空）；读不到就给出官网链接，边等边让用户去装。
          type: "oauth",
          label: "读取 AStudio 桌面端登录态",
          async authorize(_inputs, { signal } = {}) {
            const read = () => probeDesktopCredential({ env, homedir, registryQuery, readFileImpl })
            const probe = read()
            if (probe.cred) {
              return {
                url: "",
                instructions: `已读取本机 AStudio 登录态（${probe.cred.uid}），正在完成登录…`,
                method: "auto",
                callback: async () => authResult(probe.cred),
              }
            }
            // 硬失败：抛错让宿主把原因原样当登录失败显示（0.1.2810 也认 {type:"failed"}，
            // 但抛错在任何宿主版本上都成立），不能落到下面那条「装上吧」的说明里。
            if (probe.error?.code === "banned") throw new Error(probe.error.message)
            return {
              url: OFFICIAL_SITE,
              instructions:
                probe.error?.code === "unreadable"
                  ? `${probe.error.message}（上方链接是官网；在 AStudio 里登录或修好后，这一步会自动完成。）`
                  : "本机没有找到 AStudio 桌面端登录态。装上并登录 AStudio 桌面端就好——上方链接是官网，可下载；登录后这一步会自动完成。已有 token 的话，也可以改用「粘贴 modelBearerToken」。",
              method: "auto",
              callback: async (_code, { signal: callbackSignal } = {}) => {
                const waited = await waitForDesktopCredential({ read, sleep, now: nowMsImpl, signal: callbackSignal ?? signal })
                if (waited.status === "ready") return waited.result
                if (waited.status === "aborted") return { type: "failed", error: "登录已取消" }
                return {
                  type: "failed",
                  error: `仍未检测到 AStudio 桌面端登录态（最后一次：${reasonOf(waited.error)}）。装上或登录 AStudio 后，重新点一次「读取 AStudio 桌面端登录态」即可。`,
                }
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
        // 账号面鉴权只需 ssoSessionId + account_id（2026-11-06 实测，token 可缺）；
        // account_id 是三种登录方式都有的最小标识。
        if (!session?.accountId) {
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
          // 星火积分的到期时间 balance 接口不给，从入账流水推（失败不塌方）；
          // 流水是发放额，到期提示按余额封顶。
          const sparkExpiry = await readSparkExpiry(session, balance.sparkTotalBalance).catch(() => null)
          windows.push({
            name: "星火积分",
            balance: balance.sparkTotalBalance,
            aside: false,
            ...(sparkExpiry && balance.sparkTotalBalance > 0 ? sparkExpiry : {}),
          })
        }
        return {
          ...(membership?.planName ? { plan: membership.planName } : { plan: "AStudio" }),
          ...(membership?.uid != null ? { user: String(membership.uid) } : {}),
          ...(membership?.endTime ? { until: membership.endTime } : {}),
          windows,
        }
      },
      // 「每日登录积分」：服务端在当天账号会话首次活跃时发放，客户端没有领取
      // 接口（DAILY_REWARD_DIALOG 弹窗只做通知）。先读当日获得流水：已有当日
      // GRANT 行就 done、一个写请求都不发；流水为空才复刻桌面端启动的 init-app，
      // 再读一次流水（流水读不到才退回余额差 + 弹窗观测）。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const session = auth.metadata?.session
        if (!session?.accountId) {
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
        const warnings = []
        // 星火 7 天内到期时给签到消息加一句提醒（按北京时间算日历天，不是
        // 「剩不到 24 小时」）。余额是还没花掉的量，提示金额不能超过它。
        const expiryNote = async (cap) => {
          let limit = cap
          if (limit === undefined) {
            const balance = await readBalance(session).catch(() => null)
            limit = balance?.sparkTotalBalance
          }
          const sparkExpiry = await readSparkExpiry(session, limit).catch(() => null)
          if (!sparkExpiry) return ""
          const daysLeft = cstDayOf(Date.parse(sparkExpiry.runsOutAt)) - cstDayOf(nowMsImpl())
          if (daysLeft > 7) return ""
          return `；注意 ${sparkExpiry.runsOut} 星火积分${daysLeft <= 0 ? "今天" : ` ${daysLeft} 天内`}到期`
        }

        // 1) 流水优先：当日已有「每日登录赠送」GRANT 行 = 已发放。只读，
        //    不写 init-app、不碰弹窗（11-06 实测服务端午夜批量先于签到）。
        let grant = null
        let ledgerError = null
        try {
          grant = await readDailyGrantLedger(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          ledgerError = error
        }
        if (grant) {
          const rawPoints = Number(grant.amount)
          const credit = Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : 0
          return {
            outcome: "done",
            ...(credit > 0 ? { credit } : {}),
            message: `每日登录积分 +${credit || 0} 已发放（流水实证，先于签到发生）${await expiryNote()}`,
          }
        }

        // 2) 未发放：复刻桌面端启动的 init-app（签到唯一的写请求），再读一次
        //    流水。余额只用于「流水滞后」归因与旧判据兜底。
        let before = null
        try {
          before = await readBalance(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
        }
        // 旧判据（流水不可用）才需要基线弹窗：签到前就挂着的旧弹窗不能算今天。
        let hadDailyBefore = null
        let baselineError = null
        if (ledgerError) {
          try {
            const baseline = await readPopups(session)
            hadDailyBefore = Array.isArray(baseline) && baseline.some((item) => item?.componentType === "DAILY_REWARD_DIALOG")
          } catch (error) {
            if (error?.signIn === "expired") throw error
            baselineError = error
          }
        }
        const login = await desktopLogin(session)
        warnings.push(...login.warnings)
        // 会话活跃 touch：与桌面端启动时同类只读请求。
        await studioJson("membership/me", { session, fetchImpl, operation: "会员信息" }).catch(() => null)
        await studioJson("points/summary", { session, fetchImpl, operation: "积分汇总" }).catch(() => null)
        await sleep(2500)
        let after = null
        try {
          after = await readBalance(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
        }
        let grantAfter = null
        try {
          grantAfter = await readDailyGrantLedger(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          if (!ledgerError) ledgerError = error
        }
        if (grantAfter) {
          const rawPoints = Number(grantAfter.amount)
          const credit = Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : 0
          return {
            outcome: "claimed",
            ...(credit > 0 ? { credit } : {}),
            message: `每日登录积分 +${credit || "?"}（流水实证，本次签到触发）${await expiryNote(after?.sparkTotalBalance)}`,
          }
        }
        const delta =
          typeof before?.totalBalance === "number" && typeof after?.totalBalance === "number"
            ? after.totalBalance - before.totalBalance
            : null
        const warnSuffix = warnings.length ? `（${warnings.join(" / ")}）` : ""
        if (!ledgerError) {
          // 流水通畅但无 GRANT 行：余额涨了说明发放已到账、流水只是滞后；
          // 余额没涨才是真的没发。不谎称已签。
          if (delta > 0) {
            return {
              outcome: "claimed",
              credit: delta,
              message: `每日登录积分 +${delta}（余额上涨，流水尚未入账）${await expiryNote(after?.sparkTotalBalance)}`,
            }
          }
          return { outcome: "inactive", message: `未观测到新发放：当日获得流水无「每日登录赠送」记录${warnSuffix}` }
        }
        // ---- 流水读失败：退回旧判据（余额差+弹窗，只读）----
        if (typeof before?.totalBalance !== "number" || typeof after?.totalBalance !== "number") {
          return { outcome: "failed", message: `积分余额读数不完整${warnSuffix}` }
        }
        let popups = null
        let popupError = null
        try {
          popups = await readPopups(session)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          popupError = error
        }
        if (delta > 0) {
          return {
            outcome: "claimed",
            credit: delta,
            message: `每日登录积分 +${delta}${await expiryNote(after?.sparkTotalBalance)}`,
          }
        }
        // 基线读失败 ⇒ 不知道签到前是否已有弹窗，任何 done 结论都是猜的。
        if (hadDailyBefore === null) {
          return {
            outcome: "failed",
            message: `签到前无法读取每日奖励弹窗，不能判定今日是否发放${baselineError?.message ? `：${baselineError.message}` : ""}${warnSuffix}`,
          }
        }
        if (popupError) {
          return { outcome: "failed", message: `${popupError?.message ?? "每日奖励弹窗读取失败"}${warnSuffix}` }
        }
        const daily = Array.isArray(popups) && popups.find((item) => item?.componentType === "DAILY_REWARD_DIALOG")
        if (daily) {
          const rawPoints = Number(daily.payload?.points)
          const credit = Number.isFinite(rawPoints) && rawPoints >= 0 ? rawPoints : 0
          // payload 没有日期字段，签到前就挂着的那份无法断定是今天的。
          if (hadDailyBefore === true) {
            return { outcome: "inactive", message: "余额无变化，且签到前已有未确认的每日奖励弹窗，无法判定今日是否发放" }
          }
          return { outcome: "done", ...(credit > 0 ? { credit } : {}), message: "每日登录积分已发放（服务端待通知弹窗）" }
        }
        // 余额没涨、也没有待通知弹窗：这套请求序列没触发发放，不谎称已签。
        return { outcome: "inactive", message: `未观测到新发放：余额无变化，也没有今日的每日奖励弹窗${warnSuffix}` }
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
  probeDesktopCredential,
  waitForDesktopCredential,
  readFileOrNull,
  reasonOf,
  authResult,
  readAcodeConfigToken,
  registryDataRoots,
  buildCookieHeader,
  studioJson,
  exchangeModelToken,
  MODEL_GATEWAY_BASE,
  MODEL_MANAGER_URL,
  STUDIO_API_BASE,
  STUDIO_VERSION,
  STUDIO_WEB_URL,
  OFFICIAL_SITE,
  DESKTOP_WAIT_MS,
  WEB_SIGNIN_WAIT_MS,
  BOOTSTRAP,
  ID,
}
