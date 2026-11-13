// magpie-minekuai —— 把「麦块云」(https://minekuai.cn) 接入 magpie 的 provider 插件。
//
// 背景（这是本插件存在的唯一理由）：
//   麦块云的 /v1 网关只实现了 OpenAI / Anthropic 三种对话协议，**没有** sub2api 的
//   GET /v1/usage（实测返回 404 "No endpoint GET /v1/usage."）。因此现成的
//   sub2api 插件接进去能看到模型，却永远读不到额度。
//   麦块云自己的额度数据放在控制台私有接口 /app/token 上，用网页登录令牌（JWT）鉴权，
//   而且必须额外带一个前端硬编码的 clientid 请求头。本插件正是补上这一段。
//
// 一个账号由两套凭证组成，互相不通用：
//   1. API Key（sk-…）      → 走 /v1/*，列模型、发对话请求；
//   2. 网页登录令牌（eyJ…）  → 走 /app/*，读余额与已用 token。
//   API Key 调 /app/token 只会 401，网页令牌调 /v1/models 也只会 401，二者不能互换。
//
// magpie 侧需要的三件事：
//   - config：声明 provider（名称、图标、npm 包、模型占位）；
//   - auth：一次登录 = 一个实例；provider 的 loader 把 sk- 密钥交给 magpie 发请求；
//   - usage：用网页登录令牌读 /app/token，换算成 magpie 的额度结构。
//
// 读到的真实字段（2026-11 实测）：
//   GET /app/token
//     {
//       paid:      { group, groupName, balance, totalIn, totalUsed },   // 付费按量 token
//       permanent: { balance, totalIn, totalUsed },                     // 免费按量额度
//       remaining, today: {...}, keys: [{ keyId, name, keyPrefix }]
//     }
//   单位是 token 数，不是货币；ben 插件的 money() 在这里不适用。

const ID = "minekuai"
const CHAT = "@ai-sdk/openai-compatible"

// 麦块云前端硬编码的客户端标识。所有普通用户相同，不是每人一个；
// 少了它 /app/token 会返回 {"code":401,"msg":"认证失败，无法访问系统资源"}。
const CLIENT_ID = "428a8310cd442757ae699df5d894f051"

// 默认站点。登录时若用户不在 prompts 里改，就用它。
const DEFAULT_BASE = "https://minekuai.cn"

// 单个 HTTP 请求的超时。控制台接口偶发 1.5 秒以上的延迟，15 秒足够。
const TIMEOUT = 15_000

// 模型占位 id：config 阶段还没有任何账号列出模型时用它顶上，
// magpie 的社区检查要求 config 里有非空 models。真实模型列表由 provider.models 覆盖。
const PLACEHOLDER = "minekuai-placeholder"

// =============================================================================
// 站点地址处理
// =============================================================================

/**
 * root 把用户填的地址规整成站点根地址：
 * 去掉尾部斜杠，去掉误填的 /v1（OpenAI 客户端的 base URL 习惯带 /v1）。
 * 例：https://minekuai.cn/v1/ → https://minekuai.cn
 */
function root(url) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
}

/**
 * checkURL 校验地址格式，返回 null 表示通过，否则返回给用户看的错误文案。
 * magpie 的 prompt 校验函数就吃这种「null = 通过」的约定。
 */
function checkURL(value) {
  try {
    const u = new URL(root(value))
    if (u.protocol !== "https:" && u.protocol !== "http:") return "地址需以 https:// 开头"
    if (u.username || u.password) return "地址里不要带账号密码"
    return null
  } catch {
    return "地址形如 https://minekuai.cn"
  }
}

/** hostOf 取域名，仅用于给账号起默认名字与打日志，失败时原样返回。 */
function hostOf(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// =============================================================================
// HTTP
// =============================================================================

/**
 * httpJson 发一个 JSON 请求并把站点自己的错误信息抛出来。
 *
 * 麦块云控制台接口的响应外壳是 { code, msg, data }：
 *   - HTTP 一直是 200，鉴权失败靠 body 里的 code:401 表达；
 *   - 所以既要看 res.ok，也要看 data.code。
 * 命中「登录失效」时给 Error 挂 signIn = "expired"，magpie 会把它显示成需要重登。
 *
 * @param {string} base   站点根地址
 * @param {string} path   以 / 开头的路径，如 /app/token
 * @param {object} opts   { token, headers, method, body, accept }
 *   - body：有值时按 JSON 发送
 *   - accept：允许「业务码不是 200 但不算失败」的码，如签到重复时的 409。
 *     命中时照常返回 data，由调用方自己看 code。
 */
async function httpJson(
  base,
  path,
  { token, headers = {}, method = "GET", body, accept = [] } = {}
) {
  const h = { Accept: "application/json", ...headers }
  if (token) h.Authorization = `Bearer ${token}`
  let payload
  if (body !== undefined) {
    h["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }

  const res = await fetch(base + path, {
    method,
    headers: h,
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    // 非 JSON：多半是反代直接吐了 HTML（路径不存在或被 WAF 拦下）
    throw new Error(`${path}: 返回的不是 JSON（HTTP ${res.status}）`)
  }

  // accept 里的业务码原样返回，交给调用方判断语义
  if (data && accept.includes(Number(data.code))) return data

  // 业务码判错：麦块云的鉴权失败是 HTTP 200 + code 401
  if (!res.ok || (data && data.code !== undefined && data.code !== 200)) {
    const why = data?.msg ?? data?.message ?? `HTTP ${res.status}`
    const err = new Error(`${path}: ${why}`)
    const code = Number(data?.code ?? res.status)
    if (code === 401 || code === 403) err.signIn = "expired"
    err.code = code
    err.body = data
    throw err
  }
  return data
}

// =============================================================================
// 数值与显示
// =============================================================================

/** num 只接受有限数字；字符串会被忽略，避免把 "1.0" 之类误当金额。 */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/**
 * fmtTokens 把 token 数压缩成中文可读单位：
 *   1_000_000_000 → "10 亿"
 *   12_500_000    → "1250 万"
 *   1_234         → "1,234"
 * 只用于展示，不参与计算。
 */
function fmtTokens(n) {
  const v = num(n)
  if (v === undefined) return "—"
  if (v >= 1e8) return `${(Math.round((v / 1e8) * 100) / 100).toLocaleString("zh-CN")} 亿`
  if (v >= 1e4) return `${(Math.round((v / 1e4) * 100) / 100).toLocaleString("zh-CN")} 万`
  return v.toLocaleString("zh-CN")
}

/** pct 算已用百分比；额度为 0 或缺失时返回 0，避免 magpie 画出 NaN 条。 */
const pct = (used, total) => (total > 0 ? Math.min(100, (100 * used) / total) : 0)

// =============================================================================
// 模型
// =============================================================================

/**
 * fetchModels 用 API Key 拉 GET /v1/models，返回 { id: {id, name} }。
 * 麦块云返回 OpenAI 形状：{"object":"list","data":[{"id":"..."}]}。
 * 401 说明密钥被拒，挂 signIn 让 magpie 标记需要重登。
 */
async function fetchModels(base, key) {
  const res = await fetch(base + "/v1/models", {
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
    const why = body?.error?.message ?? body?.message ?? text.trim().slice(0, 200)
    const err = new Error(`${res.status} ${why}`)
    if (res.status === 401) err.signIn = "expired"
    throw err
  }

  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null
  if (!list) throw new Error("/v1/models: 返回结构无法识别")

  const out = {}
  for (const m of list) {
    const id = typeof m === "string" ? m : m?.id
    if (typeof id !== "string" || !id) continue
    out[id] = { id, name: (typeof m === "object" && (m.display_name || m.name)) || id }
  }
  return out
}

/**
 * runtimeModel 生成 magpie 需要的模型对象。
 * 麦块云是纯文本对话网关，不提供图片/音频，也不公开模型的推理档位，
 * 所以能力位保守设置，价格为 0（magpie 自己按 token 统计算费用）。
 */
function runtimeModel(m, url, providerID) {
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url, npm: CHAT },
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

/** placeholderModel 是 config 阶段顶替的占位模型，等真实账号列出模型后会被删掉。 */
function placeholderModel(base) {
  return {
    id: PLACEHOLDER,
    name: PLACEHOLDER,
    api: { npm: CHAT, url: (base || DEFAULT_BASE) + "/v1" },
  }
}

// =============================================================================
// 额度：把麦块云的 /app/token 换算成 magpie 的 usage
// =============================================================================

/**
 * usageFrom 把 /app/token 的 data 转成 magpie 的 usage 结构。
 *
 * magpie 的结构：
 *   { user, plan, windows: [...], balance, until, error }
 *   windows 里每项 { name, used(百分比), display, resetsAt?, span? }
 *
 * 麦块云的两种额度都是「预付费包」，没有周期重置，所以：
 *   - 不写 span / resetsAt，magpie 就不会把它画成「每天重置」；
 *   - 同时给出 balance（总剩余 token），让账号行直接显示剩余量。
 *
 * @param {object} data GET /app/token 的 data
 * @param {string} user 账号标识（手机号后四位之类，由调用方给）
 */
function usageFrom(data, user) {
  const out = { user, windows: [] }

  // 付费按量 token：买了 10 亿或 100 亿的包，totalIn 是累计买入，totalUsed 是累计消耗
  const paid = data?.paid
  if (paid) {
    const total = num(paid.totalIn) ?? 0
    const used = num(paid.totalUsed) ?? 0
    const left = num(paid.balance) ?? Math.max(0, total - used)
    out.plan = paid.groupName || paid.group || "按量付费"
    if (total > 0) {
      out.windows.push({
        name: "付费按量 token",
        used: pct(used, total),
        display: `已用 ${fmtTokens(used)} / 共 ${fmtTokens(total)}`,
      })
    }
    // 包用完时给一句明确提示，比 magpie 自己算出来更直观
    if (left <= 0) out.error = "付费按量 token 已用完，请到控制台「按量额度」购买"
  }

  // 免费按量额度：免费档每天/一次性的赠送额度，同样有总量和已用量
  const free = data?.permanent
  if (free) {
    const total = num(free.totalIn) ?? 0
    const used = num(free.totalUsed) ?? 0
    if (total > 0) {
      out.windows.push({
        name: "免费按量额度",
        used: pct(used, total),
        display: `已用 ${fmtTokens(used)} / 共 ${fmtTokens(total)}`,
      })
    }
  }

  // 总剩余：把两个桶相加。magpie 的账号行优先显示 balance。
  const left =
    (num(paid?.balance) ?? 0) + (num(free?.balance) ?? 0) || num(data?.remaining)
  if (left) out.balance = `${fmtTokens(left)} token`

  // 一个窗口都没有（账号还没开通过任何额度）时，明确告诉用户在控制台看
  if (!out.windows.length && !out.balance) out.error = "账号暂无可用额度"
  return out
}

/**
 * fetchTokenData 用网页令牌读 /app/token。
 * 令牌失效且账号存了密码时，先用密码续一枚新令牌、写回账号，再重试一次。
 * 这样 7 天到期不用人工介入。
 *
 * @returns {Promise<{ok: true, data: object, token: string, renewed: boolean}
 *                 | {ok: false, error: string, signIn?: string, notice?: string}>}
 */
async function fetchTokenData(client, id, auth, base) {
  let token = webTokenOf(auth)
  if (!token) {
    return { ok: false, error: "未保存网页登录令牌，无法读取额度（重新登录并填写第 3 项）" }
  }

  // 令牌快到期就提前续一次，省掉一次必然失败的请求。
  // 提前续期失败不算致命：旧令牌可能还能用，继续往下试。
  let renewed = false
  if (isStale(auth) && credentialsOf(auth)) {
    const got = await renewAndSave(client, id, auth, base)
    if (got.ok) {
      token = got.token
      auth = got.auth
      renewed = true
    }
  }

  try {
    const body = await httpJson(base, "/app/token", {
      token,
      headers: { clientid: CLIENT_ID },
    })
    return { ok: true, data: body?.data, token, renewed }
  } catch (e) {
    if (e?.signIn !== "expired") {
      return { ok: false, error: String(e?.message ?? e) }
    }
    // 令牌真的过期了：续期后重试一次
    if (!credentialsOf(auth)) {
      return {
        ok: false,
        error: String(e?.message ?? e),
        signIn: "expired",
        notice: "网页令牌已过期，且账号未保存手机号与密码，无法自动续期；请重新登录网站取新令牌",
      }
    }
    const renewed = await renewAndSave(client, id, auth, base)
    if (!renewed.ok) {
      return {
        ok: false,
        error: String(e?.message ?? e),
        signIn: "expired",
        notice: renewed.error,
      }
    }
    try {
      const body = await httpJson(base, "/app/token", {
        token: renewed.token,
        headers: { clientid: CLIENT_ID },
      })
      return { ok: true, data: body?.data, token: renewed.token, renewed: true }
    } catch (e2) {
      return {
        ok: false,
        error: String(e2?.message ?? e2),
        ...(e2?.signIn ? { signIn: e2.signIn } : {}),
      }
    }
  }
}

// =============================================================================
// usage：额度 + 签到
// =============================================================================

/**
 * checkinWindow 把签到状态做成一枚「只展示、不参与路由」的窗口行。
 *
 * magpie 的 windows 会被用于路由比较，所以签到这种纯状态必须标 aside: true，
 * 否则会被当成「额度池」参与选号。aside 的行只显示、不参与计算。
 *
 * 三种状态都要有明确文案，不能静默：
 *   已签 → 「今日已签 ✓ +10 鱼币」
 *   未签 → 「今日未签（+10 鱼币）」
 *   失败 → 「签到失败：<原因>」
 */
function checkinWindow(status) {
  if (!status) return null
  const credit = num(status.credit)
  const gain = credit ? ` +${credit} 鱼币` : ""

  if (status.state === "already" || status.state === "done") {
    return {
      name: "每日签到",
      used: 0,
      remaining: 100,
      aside: true,
      display: `今日已签 ✓${gain}`,
    }
  }
  if (status.state === "inactive") {
    return { name: "每日签到", used: 0, remaining: 100, aside: true, display: "当前没有签到活动" }
  }
  // 今天还没签：说明原因（名额满 / 上限）或提示会由宿主自动签
  if (status.state === "pending") {
    return {
      name: "每日签到",
      used: 0,
      remaining: 100,
      aside: true,
      display: status.detail ? `今日未签（${status.detail}）` : `今日未签${credit ? `（${gain.trim()}）` : ""}，等待自动签到`,
    }
  }
  // 失败：把原因带上，避免只显示一个「失败」让人无处排查
  return {
    name: "每日签到",
    used: 0,
    remaining: 100,
    aside: true,
    display: `签到失败：${status.detail || "未知原因"}`,
  }
}

/**
 * pointsWindow 做「鱼币余额」行。
 *
 * 鱼币是麦块云的站内货币（签到、邀请、充值都进这里，可兑换按量额度），
 * 和 token 余额是两套完全不同的单位，不能相加，所以单独一行展示。
 *
 * GET /app/wallet 的真实形状（2026-11-13 实测）：
 *   { giftPoints:"40.0000", heldPoints:"0.0000", paidPoints:"0.0000", totalPoints:"40.0000" }
 *   - giftPoints：赠送（签到、活动、邀请）
 *   - paidPoints：充值
 *   - heldPoints：冻结中
 *
 * 用 aside 行：只展示、不参与路由，否则会被 magpie 当成额度池。
 */
function pointsWindow(wallet) {
  const total = num(Number(wallet?.totalPoints))
  if (total === undefined) return null

  const gift = num(Number(wallet?.giftPoints))
  const paid = num(Number(wallet?.paidPoints))
  const held = num(Number(wallet?.heldPoints))

  // 只在有细分值时展开，避免 0 值把一行撑得很长
  const detail = []
  if (gift !== undefined) detail.push(`赠送 ${gift}`)
  if (paid) detail.push(`充值 ${paid}`)
  if (held) detail.push(`冻结 ${held}`)

  return {
    name: "鱼币余额",
    used: 0,
    remaining: 100,
    aside: true,
    display: detail.length > 1 ? `${total} 鱼币（${detail.join(" · ")}）` : `${total} 鱼币`,
  }
}

/**
 * dailyWindow 做「今日用量」行。
 *
 * 数据来自 GET /app/llm/requests/daily 的某一日：
 *   { date, inputTokens, cacheReadTokens, outputTokens, requests, success, failed, points }
 *
 * 口径必须和站点一致：站点的「Token」= 未命中输入 + 缓存读 + 输出
 * （前端 AdminLlmStats 的说明就是这三项），不能只算 input+output，
 * 否则缓存命中的大额部分会凭空消失。
 *
 * 用 aside 行：只展示，不参与路由。
 */
function dailyWindow(data, today = localDate()) {
  const rows = Array.isArray(data?.daily) ? data.daily : []
  if (!rows.length) return null
  // 站点按自然日给行；优先取今天，跨时区/请求跨天时退回最后一行
  const row = rows.find((r) => r?.date === today) ?? rows[rows.length - 1]
  if (!row) return null

  const input = num(Number(row.inputTokens)) ?? 0
  const cache = num(Number(row.cacheReadTokens)) ?? 0
  const output = num(Number(row.outputTokens)) ?? 0
  const requests = num(Number(row.requests)) ?? 0
  const total = input + cache + output

  return {
    name: "今日用量",
    used: 0,
    remaining: 100,
    aside: true,
    display:
      requests > 0
        ? `${fmtTokens(total)} token · ${requests} 次调用`
        : "今日暂无调用",
  }
}

/**
 * readUsage 是 auth.usage 钩子的主体。
 *
 * 负责三件事：
 *   1. 读真实额度（含令牌自动续期）；
 *   2. 读今日用量（token + 调用次数）；
 *   3. 读签到状态，作为「只展示」的窗口行挂上去。
 *      真正的签到动作仍由 magpie 原生 checkin 钩子执行（见 auth.checkin）。
 */
async function readUsage(client, id, auth, base) {
  const user = label(auth, base)
  const r = await fetchTokenData(client, id, auth, base)

  if (!r.ok) {
    return {
      user,
      windows: [],
      error: r.error,
      ...(r.signIn ? { signIn: r.signIn } : {}),
      ...(r.notice ? { notice: r.notice } : {}),
    }
  }

  const out = usageFrom(r.data, user)
  // 只有真的续过令牌才点亮这个标记，免得每行都写「已续期」
  if (r.renewed) out.renewed = true

  // 鱼币余额行：和 token 是两套单位，单独展示
  try {
    const w = await walletStatus(base, r.token)
    const win = pointsWindow(w)
    if (win) out.windows.push(win)
  } catch {
    // 钱包读不到时不显示这一行，额度照常
  }

  // 今日用量行：读不到只省略这一行，不影响额度
  try {
    const d = await dailyUsage(base, r.token)
    const win = dailyWindow(d)
    if (win) out.windows.push(win)
  } catch {
    // 每日用量读不到时不显示这一行，额度照常
  }

  // 签到状态行：读失败只省略这一行，绝不影响额度
  try {
    const st = await checkinStatus(base, r.token)
    const win = checkinWindow({
      state: st?.checkedIn ? "already" : "pending",
      credit: num(Number(st?.awardedToday)),
      detail: st?.ipLimitReached ? "今日名额已满" : st?.capReached ? "鱼币已达上限" : undefined,
    })
    if (win) out.windows.push(win)
  } catch {
    // 签到状态读不到时不显示这一行，额度照常
  }

  return out
}

/**
 * checkinOutcome 把签到结果转成 magpie 原生 checkin 钩子的契约：
 *   { outcome, credit?, streak?, message? }
 *
 * outcome 的取值由 magpie 决定，这里只用最常用的四个：
 *   claimed —— 本次签到成功，credit / streak 会被显示出来
 *   done    —— 今天已经签过，不算失败
 *   failed  —— 真的失败，magpie 会在 30 分钟后重试
 *   inactive—— 站点当前没有签到活动
 */
function checkinOutcome(result) {
  if (result.state === "done") {
    const credit = result.credit
    const streak = result.streak
    const parts = []
    if (credit) parts.push(`+${credit} 鱼币`)
    if (streak) parts.push(`连续 ${streak} 天`)
    return {
      outcome: "claimed",
      ...(credit ? { credit } : {}),
      ...(streak ? { streak } : {}),
      message: parts.length ? `签到成功 ${parts.join(" · ")}` : "签到成功",
    }
  }
  if (result.state === "already") {
    return {
      outcome: "done",
      ...(result.credit ? { credit: result.credit } : {}),
      message: result.detail || "今天已签到",
    }
  }
  if (result.state === "inactive") {
    return { outcome: "inactive", message: result.detail || "站点当前没有签到活动" }
  }
  return {
    outcome: "failed",
    message: result.detail || "签到失败",
    // 登录失效要让 magpie 知道，它才不会把失败当成普通的临时错误
    ...(result.signIn ? { signIn: result.signIn } : {}),
  }
}

/** localDate 返回本地时区的 YYYY-MM-DD，签到按自然日算。 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// =============================================================================
// 令牌续期
// =============================================================================

// 麦块云没有 refresh 接口（前端 bundle 里搜不到任何 refreshToken / /app/auth/refresh），
// 所以「自动续期」只能用账号密码重新登录换一枚新令牌。
// 手机号 + 密码走 grantType: "password"，短信验证码那条路需要人工，不能自动化。

// 网页令牌的有效期。JWT 里没有 exp 字段（实测 claims 只有 loginType/loginId/rnStr/
// clientid/tenantId/userId/userName），有效期只记录在前端 localStorage 的 expireAt 上：
// 登录时 expireAt = Date.now() + 7 天。插件拿不到那个 localStorage，所以按同一个规则估算。
const WEB_TOKEN_TTL = 7 * 24 * 3600 * 1000

/**
 * tokenExpiry 估算一枚网页令牌的到期时间：从 JWT 里能读出签发语义就按 7 天算，
 * 读不出来返回 undefined（之后靠 401 触发续期）。
 *
 * 这里刻意不去猜 JWT 里没有的字段，只做个「未来多久该续期」的边界。
 */
async function tokenExpiry(base, token) {
  // 令牌是签发后立即使用的，所以「现在 + 7 天」就是最接近真实到期时间的估计。
  // 重新登录会刷新它，误差只影响提前续期的时机，不影响正确性。
  if (typeof token !== "string" || !token) return undefined
  return Date.now() + WEB_TOKEN_TTL
}

/** credentialsOf 取登录时保存的手机号与密码；缺一个就返回 undefined。 */
function credentialsOf(auth) {
  const phone = String(auth?.metadata?.phone ?? "").trim()
  const password = String(auth?.metadata?.password ?? "")
  if (!phone || !password) return undefined
  return { phone, password }
}

/**
 * renewToken 用手机号 + 密码换一枚新的网页登录令牌。
 *
 * 成功时返回 { ok: true, token, expireAt }。
 * 失败时返回 { ok: false, error, needPassword }：
 *   - needPassword = true 表示账号没存密码（或密码错了），只能人工重登。
 *
 * 注意：这里只换令牌，不改动 API Key；写回账号由调用方负责。
 */
async function renewToken(auth, base) {
  const cred = credentialsOf(auth)
  if (!cred) return { ok: false, needPassword: true, error: "没有保存手机号与密码，无法自动续期" }

  let body
  try {
    body = await httpJson(base, "/app/auth/login", {
      method: "POST",
      headers: { clientid: CLIENT_ID },
      body: {
        grantType: "password",
        phone: cred.phone,
        password: cred.password,
        clientId: CLIENT_ID,
      },
    })
  } catch (e) {
    const msg = String(e?.message ?? e)
    // 密码被改过时站点回「手机号或密码错误」，这种只能人工处理
    if (/密码|password/i.test(msg)) {
      return { ok: false, needPassword: true, error: `自动续期失败：${msg}` }
    }
    return { ok: false, error: `自动续期失败：${msg}` }
  }

  // 登录响应的形状是 { access_token, expire_in, ... }，见前端 Ye() 里
  // se.getState().setSession(o.access_token, o.expire_in)
  const token = body?.access_token ?? body?.data?.access_token ?? body?.token
  if (typeof token !== "string" || !token) {
    return { ok: false, error: "自动续期失败：登录响应里没有 access_token" }
  }
  const expireIn = num(body?.expire_in ?? body?.data?.expire_in)
  return {
    ok: true,
    token,
    expireAt: expireIn ? Date.now() + expireIn * 1000 : undefined,
  }
}

/**
 * isStale 判断令牌是否快到期（默认提前 1 天）。
 * 只做判断、不发请求；真正的续期由 renewAndSave 完成，
 * 避免「先探测再续期」导致连续登录两次。
 *
 * 没有 expireAt 的老账号返回 false：交给 401 触发一次续期。
 */
function isStale(auth, marginMs = 24 * 3600 * 1000) {
  const expireAt = num(auth?.metadata?.webTokenExpireAt)
  if (!expireAt) return false
  return expireAt - Date.now() <= marginMs
}

// =============================================================================
// 签到
// =============================================================================

/**
 * checkinStatus 读 GET /app/checkin，返回站点原始 data。
 *
 * 真实字段（2026-11-13 实测）：
 *   {
 *     enabled, checkedIn, date,
 *     awardedToday, basePoints, memberPoints, todayBonus,
 *     streakDays, streakEvery, nextBonusInDays, streakBonus,
 *     balance, balanceCap, capReached, ipLimitReached, awardable
 *   }
 */
async function checkinStatus(base, token) {
  const body = await httpJson(base, "/app/checkin", {
    token,
    headers: { clientid: CLIENT_ID },
  })
  return body?.data ?? {}
}

/**
 * walletStatus 读 GET /app/wallet，拿鱼币余额。
 *
 * 真实字段（2026-11-13 实测）：
 *   { giftPoints:"40.0000", heldPoints:"0.0000", paidPoints:"0.0000", totalPoints:"40.0000" }
 *
 * 注意这些是字符串（"40.0000"），调用方用 Number() 转，不要直接当数字用。
 */
async function walletStatus(base, token) {
  const body = await httpJson(base, "/app/wallet", {
    token,
    headers: { clientid: CLIENT_ID },
  })
  return body?.data ?? {}
}

/**
 * dailyUsage 读 GET /app/llm/requests/daily，拿按自然日汇总的调用量。
 *
 * 真实返回（2026-11-13 实测）：
 *   {
 *     beginTime, endTime, days, todayRequests, yesterdaySameTimeRequests,
 *     daily: [{ date, inputTokens, cacheReadTokens, outputTokens,
 *               requests, success, failed, blocked, pending, points }],
 *     models: [{ model, requests, points }]
 *   }
 *
 * days=1 只返回今天；如果跨天/时区导致今天那行还没生成，退回 days=2 再取一次。
 * 读不到就让调用方省略这一行，绝不影响额度主数据。
 */
async function dailyUsage(base, token) {
  const read = async (days) => {
    const body = await httpJson(base, `/app/llm/requests/daily?days=${days}`, {
      token,
      headers: { clientid: CLIENT_ID },
    })
    return body?.data ?? {}
  }

  const today = localDate()
  let data = await read(1)
  const hasToday = Array.isArray(data?.daily) && data.daily.some((r) => r?.date === today)
  if (!hasToday) data = await read(2)
  return data
}

/**
 * checkin 执行一次签到，把站点结果整理成插件内部统一的三态。
 *
 * POST /app/checkin 的三种结果：
 *   200 → 签到成功，data 里带本次奖励
 *   409 → 今天已经签过（data.reason = "already_checked_in"），不是错误
 *   其它 → 真的失败（未登录、账号停用、名额用尽…）
 *
 * @returns {Promise<{state, label, detail, credit?, streak?, data?}>}
 *   state ∈ "done"（刚签成功）| "already"（今天已签）| "failed" | "inactive"
 */
async function checkin(base, token) {
  let body
  try {
    body = await httpJson(base, "/app/checkin", {
      method: "POST",
      token,
      headers: { clientid: CLIENT_ID },
      // 409 是「今天已签」，属于正常状态，不能当异常抛出去
      accept: [409],
    })
  } catch (e) {
    return {
      state: "failed",
      label: "签到失败",
      detail: String(e?.message ?? e),
      ...(e?.signIn ? { signIn: e.signIn } : {}),
    }
  }

  const code = Number(body?.code)
  const data = body?.data ?? {}

  if (code === 409 || data?.reason === "already_checked_in") {
    // 已签时站点不返回奖励数，再查一次状态拿到今天实际拿了多少
    let credit
    let streak
    try {
      const st = await checkinStatus(base, token)
      credit = num(Number(st?.awardedToday)) || undefined
      streak = num(Number(st?.streakDays)) || undefined
    } catch {
      // 查不到状态不影响「已签」这个结论
    }
    return {
      state: "already",
      label: "今天已签到",
      detail: `今天已签到${credit ? ` +${credit} 鱼币` : ""}，明天再来`,
      ...(credit ? { credit } : {}),
      ...(streak ? { streak } : {}),
      data,
    }
  }

  // 成功：站点把本次奖励放在 data 里，字段名随版本不同，逐个兜底
  const credit =
    num(Number(data?.awarded)) ??
    num(Number(data?.points)) ??
    num(Number(data?.award)) ??
    num(Number(data?.todayBonus))
  const streak = num(Number(data?.streakDays))
  const parts = []
  if (credit) parts.push(`+${credit} 鱼币`)
  if (streak) parts.push(`连续 ${streak} 天`)
  const st = await checkinStatus(base, token).catch(() => ({}))
  const balance = num(Number(st?.balance))
  if (balance !== undefined) parts.push(`鱼币余额 ${balance}`)

  return {
    state: "done",
    label: "签到成功",
    detail: parts.length ? parts.join(" · ") : "签到成功",
    ...(credit ? { credit } : {}),
    ...(streak ? { streak } : {}),
    data,
  }
}

// =============================================================================
// 账号
// =============================================================================

/**
 * renewAndSave 续期并把新令牌写回账号。
 * 写回是必须的：否则每次查额度都要重新登录一次，既慢又容易被风控。
 *
 * @returns {Promise<{ok:boolean, token?:string, error?:string, saved?:boolean}>}
 */
async function renewAndSave(client, id, auth, base) {
  const r = await renewToken(auth, base)
  if (!r.ok) return r

  // client.auth.set 是整体替换，所以要把原账号整个带上
  const next = {
    ...auth,
    metadata: {
      ...(auth.metadata ?? {}),
      webToken: r.token,
      ...(r.expireAt ? { webTokenExpireAt: r.expireAt } : {}),
      renewedAt: new Date().toISOString(),
    },
  }
  let saved = false
  if (typeof client?.auth?.set === "function") {
    try {
      await client.auth.set({ path: { id }, body: next })
      saved = true
    } catch {
      // 写不进去也能用这一次，下次会再续
    }
  }
  return { ...r, saved, auth: next }
}

/** webTokenOf 取登录时保存的网页登录令牌，去掉空白。 */
function webTokenOf(auth) {
  const t = auth?.metadata?.webToken
  return typeof t === "string" && t.trim() ? t.trim() : ""
}

/**
 * label 生成账号显示名：站点域名 + API Key 后四位。
 * 绝不在名字里出现令牌片段 —— 账号名会出现在 magpie 界面上。
 */
function label(auth, base) {
  const key = typeof auth?.key === "string" ? auth.key : ""
  const tail = key.length >= 8 ? " …" + key.slice(-4) : ""
  return (base ? hostOf(base) : "") + tail
}

/**
 * named 把显示名写回账号（第一次使用时）。
 * magpie 的 api/oauth 登录只保留 {type, key, metadata}，账号名靠 auth.accountId 记，
 * 所以这里主动写一次，界面才不会显示成一串随机 id。
 */
async function named(client, id, auth, base) {
  const name = label(auth, base)
  if (!name || auth.accountId === name || typeof client?.auth?.set !== "function") return
  try {
    await client.auth.set({ path: { id }, body: { ...auth, accountId: name } })
  } catch {
    // 写不进去不影响功能，忽略
  }
}

// =============================================================================
// 插件主体
// =============================================================================

/**
 * hooks 构造 magpie 的 provider 定义。
 * 注意：magpie 会把模块里每个 export 都当插件函数调用一遍，
 * 所以本文件只导出 MinekuaiPlugin 与 _internal（测试用）。
 */
function hooks(client) {
  return {
    // ---- config：provider 的静态信息 ----
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}

      // 保留上一次账号列出的真实模型，只去掉占位
      const kept = Object.fromEntries(
        Object.entries(was.models ?? {}).filter(([k]) => k !== PLACEHOLDER)
      )

      config.provider[ID] = {
        ...was,
        name: "麦块云",
        npm: was.npm || CHAT,
        models: Object.keys(kept).length ? kept : { [PLACEHOLDER]: placeholderModel(DEFAULT_BASE) },
      }
    },

    // ---- auth：登录、请求注入、查额度 ----
    auth: {
      provider: ID,

      /**
       * loader 每次发模型请求前被调用，返回 AI SDK 的客户端参数。
       * 这里只给 baseURL + apiKey；模型侧走标准 OpenAI 兼容协议。
       */
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}

        const base = root(auth?.metadata?.baseURL) || DEFAULT_BASE
        await named(undefined, ID, auth, base)
        return { baseURL: base + "/v1", apiKey: auth.key }
      },

      methods: [
        {
          // 用 oauth + auto 回调，而不是 api 方式：
          // magpie 的 api 方式会把密钥输入框排在所有提问之后，
          // 无法做到「地址 → 密钥 → 网页令牌」这个自然顺序。
          type: "oauth",
          label: "麦块云 API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "麦块云站点地址",
              placeholder: DEFAULT_BASE,
              validate: checkURL,
            },
            {
              type: "password",
              key: "apiKey",
              message: "API Key（sk-…，用于模型调用）",
              placeholder: "sk-…",
            },
            {
              type: "password",
              key: "webToken",
              message: "网页登录令牌（用于查额度 / 签到，可留空）",
              placeholder: "eyJ…；控制台 F12 执行 localStorage 里 aivideo-auth 的 state.token",
            },
            {
              type: "text",
              key: "phone",
              message: "手机号（用于令牌到期后自动续期，可留空）",
              placeholder: "11 位手机号；不填则令牌过期后需手动重登",
              condition: (i) => !!String(i?.webToken ?? "").trim(),
            },
            {
              type: "password",
              key: "password",
              message: "登录密码（用于自动续期，可留空）",
              placeholder: "与网页登录同一个密码",
              condition: (i) => !!(String(i?.phone ?? "").trim() && String(i?.webToken ?? "").trim()),
            },
          ],

          async authorize(inputs) {
            return {
              url: "",
              instructions: "",
              method: "auto",
              async callback() {
                const base = root(inputs?.baseURL) || DEFAULT_BASE
                const bad = checkURL(base)
                if (bad) return { type: "failed", error: bad }

                const apiKey = String(inputs?.apiKey ?? "").trim()
                if (!apiKey) return { type: "failed", error: "没有填写 API Key" }

                const webToken = String(inputs?.webToken ?? "").trim()
                const phone = String(inputs?.phone ?? "").trim()
                const password = String(inputs?.password ?? "")

                // 1) 用 /v1/models 验证 API Key：既能确认密钥有效，也顺手拿到模型列表
                try {
                  await fetchModels(base, apiKey)
                } catch (e) {
                  return {
                    type: "failed",
                    error: `API Key 不可用：${String(e?.message ?? e).slice(0, 300)}`,
                  }
                }

                // 2) 填了网页令牌就验证一次：提前暴露「令牌过期 / 粘贴错」，
                //    不要等存下账号后才发现额度永远是空的
                let tokenExpireAt
                if (webToken) {
                  let tokenBody
                  try {
                    tokenBody = await httpJson(base, "/app/token", {
                      token: webToken,
                      headers: { clientid: CLIENT_ID },
                    })
                  } catch (e) {
                    return {
                      type: "failed",
                      error: `网页登录令牌不可用：${String(e?.message ?? e).slice(0, 300)}`,
                    }
                  }
                  tokenExpireAt = await tokenExpiry(base, webToken)
                  // 留着下面用：签到成功与否不该阻断登录，所以这里只看额度是否可读
                  void tokenBody
                }

                // 3) 填了手机号 + 密码就试一次续期登录，确认能自动续上。
                //    失败不阻断登录：用户可能只是想先用一次，令牌过期后再补密码。
                let renewNote
                if (phone && password) {
                  const r = await renewToken(
                    { metadata: { phone, password } },
                    base
                  )
                  if (!r.ok) {
                    renewNote = `自动续期不可用：${r.error}`
                  }
                }

                return {
                  type: "success",
                  key: apiKey,
                  metadata: {
                    baseURL: base === DEFAULT_BASE ? undefined : base,
                    webToken: webToken || undefined,
                    webTokenExpireAt: tokenExpireAt,
                    phone: phone || undefined,
                    password: password || undefined,
                    renewNote,
                  },
                  accountId: label({ key: apiKey }, base),
                }
              },
            }
          },
        },
      ],

      /**
       * usage 在账号行、「magpie quota」和网关 /v1/magpie/quotas 里被调用。
       * 只读额度，含令牌自动续期。
       */
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return { error: "未登录" }
        const base = root(auth?.metadata?.baseURL) || DEFAULT_BASE
        return readUsage(client, ID, auth, base)
      },

      /**
       * 原生每日签到钩子（magpie ≥ v0.1.1083）。
       *
       * 由宿主调度：Settings → Usage → Plugins 里每个供应商的 Daily check-in 开关
       * （默认关）打开后，每天每账号自动签一次，失败 30 分钟后重试，
       * 结果直接显示在账户的 Usage 卡片上，也能用「Check in now」手动触发。
       *
       * 契约：返回 { outcome, credit?, streak?, message? }；抛异常 → 记为失败。
       * outcome 用 claimed / done / failed / inactive，语义见 checkinOutcome()。
       *
       * 用宿主调度而不是在 usage 里顺带签，是因为：
       *   - 宿主有真正的「每天一次」判断和重试，插件不必自己记日期；
       *   - magpie 不常驻调用 usage，靠它签到会漏签。
       */
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") {
          return { outcome: "failed", message: "未登录" }
        }
        const base = root(auth?.metadata?.baseURL) || DEFAULT_BASE

        // 令牌可能已过期：先走一次和查额度相同的续期逻辑，拿到可用令牌
        const r = await fetchTokenData(client, ID, auth, base)
        if (!r.ok) {
          // 登录失效就抛出去，magpie 会提示重新登录而不是无脑重试
          if (r.signIn) {
            throw Object.assign(new Error(r.notice || r.error), { signIn: r.signIn })
          }
          return { outcome: "failed", message: r.notice || r.error }
        }

        const result = await checkin(base, r.token)
        return checkinOutcome(result)
      },
    },

    // ---- provider：模型列表 ----
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models

        const base = root(auth?.metadata?.baseURL) || DEFAULT_BASE
        try {
          const listed = await fetchModels(base, auth.key)
          if (!Object.keys(listed).length) return provider.models

          const out = {}
          for (const m of Object.values(listed)) {
            out[m.id] = runtimeModel(m, base + "/v1", ID)
          }
          return out
        } catch (e) {
          // 401 交给 magpie 处理成「需要重登」；其它错误退回上次的列表，
          // 避免因为一次网络抖动把整个 provider 的模型清空
          if (e?.signIn) throw e
          return provider.models
        }
      },
    },
  }
}

/**
 * 唯一的插件入口函数。magpie 会把它当成一个 provider 来注册。
 * client 用来把续期后的令牌、签到日期写回账号（client.auth.set）。
 */
export async function MinekuaiPlugin({ client } = {}) {
  return hooks(client)
}

// _internal 只给本地测试用，不是插件。
export const _internal = {
  ID,
  CLIENT_ID,
  DEFAULT_BASE,
  WEB_TOKEN_TTL,
  root,
  checkURL,
  hostOf,
  num,
  fmtTokens,
  pct,
  fetchModels,
  runtimeModel,
  placeholderModel,
  usageFrom,
  webTokenOf,
  label,
  credentialsOf,
  isStale,
  tokenExpiry,
  renewToken,
  renewAndSave,
  fetchTokenData,
  readUsage,
  checkinStatus,
  walletStatus,
  dailyUsage,
  dailyWindow,
  checkin,
  checkinOutcome,
  checkinWindow,
  pointsWindow,
  localDate,
}
