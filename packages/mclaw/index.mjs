#!/usr/bin/env bun
/**
 * mclaw — 中国移动云「MClaw」作为 magpie / OpenCode 的 OpenAI 兼容供应商。
 *
 * 接口协议（2026-11-04 从移动云盘 App 13.2.5 抓包逆向，Mac 直连全部实测通过）：
 *
 *   chat    POST {base}/v1/chat/completions
 *           Authorization: Bearer <llm key>（na-…，开放接口 key）
 *           base 默认 https://ai.yun.139.com/api/llm/102001
 *           ⚠️ 网关会以 HTTP 200 返回裸 JSON 错误（如 {"error":{"code":"01000002"}}），
 *             normalizeChatResponse 会把这种响应转成明确的失败。
 *
 *   models  POST https://ai.yun.139.com/api/adapter/assistant/agent/list
 *           Authorization: Basic base64("mobile:<手机号>:<token>")（App 抓包凭证）
 *                        或 base64("pc:<手机号>:<token>")（网页登录票，等价）
 *           headers: x-yun-app-channel: 101, x-yun-api-version: v1,
 *                    Origin: mcloudlocal://yun.139.com
 *           body: {"sourceChannel":"101","sceneType":"homePage"}（免 userId）
 *           → agentList[] 里 agentType=mclaw 的 agentId 即 openclawId，
 *             其 modelList 是账号实际可用的模型。
 *
 *   key+倍率 POST https://ai.yun.139.com/api/llm/apikey/get
 *           Authorization: Basic <同上>（mobile: / pc: 均可，实测）
 *           headers: x-yun-api-version: v1   ← 必须 v1；v2 会返回另一个
 *                    不能直连 chat 的 key 且要求 userId
 *           body: {"channelId":"102001"}
 *           → data: { apikey（真正的 llm key）, modelUrl,
 *                     modelList[{modelCode, modelName, ability, tokenRatio}] }
 *           一次拿全：chat key + 带倍率的模型表，无需手动粘贴 key。
 *
 *   usage   POST https://ypqy.mcloud.139.com/isbo2/openApi/queryAvailableBenefitV2
 *           Authorization: Basic <同上>（此接口可空账号，无需 userId）
 *           body: {"account":{"userDomainId":""}}
 *           → userAvailableBenefitList[] 里 benefitNo=RHR135 的
 *             benefitValue（总额）/benefitUsed（已用），即 aitokens 池。
 *
 *   明细    POST https://vip.yun.139.com/m4c/benefit/getAiTokenConsumptionRecords
 *           Cookie: <vip.yun.139.com 会话 cookie>（网页版会话，可自动换取）
 *           body: {"pageNum":1,"pageSize":3,"action":["1","4"]}
 *           → 每条：modelCode/modelName/benefitNum(消耗)/coefficient(倍率)/recordTime
 *                   /endTime（当前周期权威重置点）
 *
 *   换票链  POST https://user-njs.yun.139.com/user/querySpecTokenV2
 *           Authorization: Basic <票>   body: {"toSourceId":"001005"}
 *           ⚠️ 必须 001005（App vip 会员中心 H5 的 app.js 自配值）；001003/001221
 *             会被 USER_DOMAIN 拒 200050409。
 *           → data.token（YZsid 临时票）
 *           POST https://vip.yun.139.com/m4c/login/ssoLogin
 *           body: {"ticket":"YZsid…","source":"503016","channelSrc":""}
 *           → Set-Cookie 下发 6 个（mc_at/mc_bt/mc_pat/mc_pbt/mc_ac/mc_pac，
 *             .139.com 域，24h；mc_at/mc_pat httpOnly），getSetCookie() 整段收全
 *           → 拼 Cookie 串查明细。pc:/mobile: 票均可。
 *
 *   两套凭证互不通用（实测对照过）：llm key 只管 chat；Basic 票只管
 *   models/usage/key发放。Basic 票格式 "<渠道>:<手机号>:<…>|RCS|<到期ms>|<…>"
 *   （渠道 = mobile: App 票 / pc: 网页票），到期时间可从票文本里读出。
 *   config/get（倍率）只认 mobile: 票 → 网页票的倍率走 apikey/get。
 *
 *   浏览器登录（v0.4.0）：yun.139.com 网页登录一次（方式不限），CDP（--remote-
 *   debugging-pipe，每次登录一个全新 profile）收割 authorization Cookie =
 *   pc: 票，apikey/get v1 自动取 chat key + 倍率；profile 目录存进账号
 *   metadata，续期 = headless 复开该账号自己的 profile，网页应用自己刷新
 *   会话后重新收割（收割的票会校验是不是这个账号的）。见 browser.mjs。
 *
 * Options (magpie plugin options mclaw '{"…"}'):
 *   { "base": "https://ai.yun.139.com/api/llm/102001" }
 *   环境变量：MCLAW_CHROME_PATH（Chrome 路径）、MCLAW_BROWSER_PROFILE（登录
 *   profile 目录的根，每个账号是它下面的一个子目录）
 *   测试缝：options.signinPrerequisites（预检函数）、options.browserCandidates
 */
import { randomUUID } from 'node:crypto'
import * as browserDefault from './browser.mjs'

const PROVIDER = 'mclaw'
const DEFAULT_BASE = 'https://ai.yun.139.com/api/llm/102001'
// 测试通过 _internal.HOSTS 重定向到本地 fake（见 *.test.mjs）。
const HOSTS = {
  openclaw: 'https://ai.yun.139.com',
  benefit: 'https://ypqy.mcloud.139.com',
  vip: 'https://vip.yun.139.com',
  userNjs: 'https://user-njs.yun.139.com',
}
const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) AIModeHome MCloudApp/13.2.5 iPhone AppLanguage/zh-CN'

// 每进程稳定的伪设备标识（App 侧头，服务端用来路由，内容不敏感）
const TID = randomUUID()
const DEVICE_ID = randomUUID()
const CLIENT_INFO = `||2|13.2.5||iPhone|${DEVICE_ID}||ios 18.7|||||`
const DEVICE_INFO = `||36|13.2.5||iPhone|${DEVICE_ID}||ios 18.7|||||`

// 模型目录（2026-11-04 config/get 抓包快照；配置了 App 凭证后由账号实际目录覆盖）。
// rate = tokenRatio（积分倍率，App 计费口径，非美元价）。
const MODELS = {
  'blian_qwen38_flash': {
    name: 'Qwen3.8-Flash',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    rate: 0.18,
  },
  'blian_qwen38_max': {
    name: 'Qwen3.8-Max',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    rate: 1.5,
  },
  'huoshan_glm_5_3': {
    name: 'GLM-5.3',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    rate: 3.5,
  },
  'blian_qwen37_plus': {
    name: 'Qwen3.7-Plus',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    rate: 1.5,
  },
  'blian_qwen36_plus': {
    name: 'Qwen3.6-Plus',
    limit: { context: 200000, output: 32000 },
    tool_call: true,
    rate: 1.0,
  },
  'blian_qwen35_plus': {
    name: 'Qwen3.5-Plus',
    limit: { context: 200000, output: 32000 },
    tool_call: true,
    modalities: { input: ['text', 'image'] },
    rate: 0.6,
  },
  'blian_deepseek_v4_pro': {
    name: 'DeepSeek-V4-Pro',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    rate: 2.5,
  },
  'vlm_huoshan_2_0_lite_thinking_vision': {
    name: 'Seed-2.0-Lite',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ['text', 'image'] },
    rate: 1.0,
  },
  'vlm_huoshan_2_0_mini_thinking_vision': {
    name: 'Seed-2.0-Mini',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ['text', 'image'] },
    rate: 0.3,
  },
  'huoshan_deepseek_v4_1_flash': {
    name: 'DeepSeek-V4.1-Flash',
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    tool_call: true,
    // config/get 的计费表里没有它，倍率未知
  },
}

// ---------------------------------------------------------------- helpers
// （辅助函数不导出为模块级函数：插件宿主会把每个导出的函数当插件调用。
//   测试面统一走 _internal 对象。）

const fmt = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)

/** App 侧（openclaw）公共请求头。 */
function appHeaders(appAuth) {
  return {
    'content-type': 'application/json',
    accept: '*/*',
    authorization: appAuth,
    'x-yun-app-channel': '101',
    'x-yun-api-version': 'v1',
    'x-yun-client-info': CLIENT_INFO,
    'x-deviceinfo': DEVICE_INFO,
    'x-yun-tid': TID,
    origin: 'mcloudlocal://yun.139.com',
    'user-agent': APP_UA,
  }
}

function expired(message) {
  return Object.assign(new Error(message), { signIn: 'expired' })
}

/** 统一解析 JSON API 响应，识别凭证失效。 */
async function readJson(response, label) {
  const json = await response.json().catch(() => null)
  if (response.status === 401) throw expired(`${label} 登录已失效，请重新抓取凭证`)
  if (!json) throw new Error(`${label} 返回非 JSON 响应（HTTP ${response.status}）`)
  return json
}

/** MClaw 实例（openclawId）自动发现 + 账号实际模型清单。
 *  agent/list 免 userId：agentList 里 agentType=mclaw 的 agentId 即 openclawId。 */
async function fetchAgentList(appAuth) {
  let response
  try {
    response = await fetch(`${HOSTS.openclaw}/api/adapter/assistant/agent/list`, {
      method: 'POST',
      headers: appHeaders(appAuth),
      body: JSON.stringify({ sourceChannel: '101', sceneType: 'homePage' }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('MClaw agent 列表查询网络失败或超时')
  }
  const json = await readJson(response, 'MClaw agent 列表')
  const agents = json?.data?.agentList
  if (json?.success !== true || !Array.isArray(agents)) {
    const code = json?.code ?? response.status
    if (String(code) === '01000002' || response.status === 401) {
      throw expired('MClaw App 凭证已失效，请重新抓取')
    }
    throw new Error(`MClaw agent 列表查询失败（code ${code}：${json?.message ?? '未知错误'}）`)
  }
  const agent = agents.find((a) => a?.agentType === 'mclaw') ??
    agents.find((a) => /claw/i.test(`${a?.agentType ?? ''}${a?.applicationName ?? ''}`))
  if (!agent?.agentId) throw new Error('agent 列表里没有 MClaw 实例')
  return {
    agentId: String(agent.agentId),
    // 账号实际可用的模型（modelCode + 描述）；config/get 给倍率
    models: Array.isArray(agent.modelList)
      ? agent.modelList.map((m) => ({ code: m?.modelCode, name: m?.description }))
      : [],
  }
}

/** 模型目录（openclaw config/get），给每个模型的积分倍率。 */
async function fetchModelCatalogue(appAuth, openclawId) {
  let response
  try {
    response = await fetch(`${HOSTS.openclaw}/api/openclaw/config/get`, {
      method: 'POST',
      headers: appHeaders(appAuth),
      body: JSON.stringify({ sourceChannel: '101', openclawId }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('MClaw 模型目录查询网络失败或超时')
  }
  const json = await readJson(response, 'MClaw 模型目录')
  if (json?.success !== true || !Array.isArray(json?.data?.modelList)) {
    const code = json?.code ?? response.status
    if (String(code) === '01000002' || response.status === 401) {
      throw expired('MClaw App 凭证已失效，请重新抓取')
    }
    throw new Error(`MClaw 模型目录查询失败（code ${code}：${json?.message ?? '未知错误'}）`)
  }
  return json.data.modelList
}

/** llm 渠道号（从 base 里推导，默认 102001）。 */
function llmChannelId() {
  return activeBase.match(/\/api\/llm\/(\d+)/)?.[1] ?? '102001'
}

/** apikey/get v1：Basic 票（mobile:/pc: 均可，实测）一次拿全 llm key + 带倍率模型表。
 *  ⚠️ 必须 x-yun-api-version: v1——v2 返回另一个不能直连 chat 的 key，且要求 userId。 */
async function fetchLlmKeyAndRates(appAuth, channelId = '102001') {
  let response
  try {
    response = await fetch(`${HOSTS.openclaw}/api/llm/apikey/get`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: appAuth,
        'x-yun-api-version': 'v1',
        'user-agent': APP_UA,
      },
      body: JSON.stringify({ channelId }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('MClaw key/倍率查询网络失败或超时')
  }
  const json = await readJson(response, 'MClaw key/倍率')
  const data = json?.data
  if (json?.success !== true || !data?.apikey) {
    const code = json?.code ?? response.status
    if (String(code) === '01000002' || response.status === 401) {
      throw expired('MClaw Basic 票已失效，请重新登录')
    }
    throw new Error(`MClaw key/倍率查询失败（code ${code}：${json?.message ?? '未知错误'}）`)
  }
  return data
}

/** 两种存储形态的 Basic 票：oauth 型（浏览器登录）在 access；api 型（0.4.1 已移除的
 *  手动粘贴方式）的老账号在 metadata.appAuth，登录方式删了，老登录态仍兼容。 */
function appAuthOf(auth) {
  const raw = auth?.access ?? auth?.metadata?.appAuth
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** aitokens 权益池（总量/已用）。空账号即可，无需 userId。 */
async function fetchBenefit(appAuth) {
  let response
  try {
    response = await fetch(`${HOSTS.benefit}/isbo2/openApi/queryAvailableBenefitV2`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: appAuth,
        'user-agent': APP_UA,
      },
      body: JSON.stringify({ account: { userDomainId: '' } }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('MClaw 用量查询网络失败或超时')
  }
  const json = await readJson(response, 'MClaw 用量')
  const list = json?.userAvailableBenefitList
  if (json?.result?.resultCode !== '0' || !Array.isArray(list)) {
    const desc = json?.result?.resultDesc ?? `HTTP ${response.status}`
    if (/授权|登录|token/i.test(desc)) throw expired('MClaw App 凭证已失效，请重新抓取')
    throw new Error(`MClaw 用量查询失败（${desc}）`)
  }
  return list.find((item) => item?.benefitNo === 'RHR135') ??
    list.find((item) => /token/i.test(`${item?.benefitName ?? ''}${item?.benefitDesc ?? ''}`))
}

/** 逐条消耗明细（vip 网页会话 Cookie，可选）。 */
async function fetchRecords(vipCookie) {
  let response
  try {
    response = await fetch(`${HOSTS.vip}/m4c/benefit/getAiTokenConsumptionRecords`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: vipCookie,
        origin: HOSTS.vip,
        referer: `${HOSTS.vip}/vip/consumptionDetail?sourceid=503016`,
        'user-agent': APP_UA,
      },
      body: JSON.stringify({ pageNum: 1, pageSize: 3, action: ['1', '4'] }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('MClaw 明细查询网络失败或超时')
  }
  const json = await response.json().catch(() => null)
  if (json?.resultCode !== '0') {
    const desc = json?.resultDesc ?? `HTTP ${response.status}`
    if (/授权|401/.test(desc)) throw expired('vip 会话 Cookie 已失效')
    throw new Error(`MClaw 明细查询失败（${desc}）`)
  }
  return json?.data?.aiTokenConsumptionRecordList ?? []
}

/** 从 Basic 票里解出掩码手机号（mobile:/pc: 前缀均可），解不出返回空。 */
function nameFromAppAuth(appAuth) {
  try {
    const raw = Buffer.from(appAuth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
    const phone = raw.match(/(?:mobile|pc):(\d{11})/)?.[1]
    return phone ? `${phone.slice(0, 3)}****${phone.slice(7)}` : undefined
  } catch {
    return undefined
  }
}

/** 记录里的 endTime（"2026-11-11 15:20:47"，北京时间）→ ms。 */
function endTimeMs(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return undefined
  const ms = new Date(`${text.replace(' ', 'T')}+08:00`).getTime()
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** App Basic 凭证内嵌的到期时间（mobile:…|1|RCS|<到期ms>|…）。 */
function basicExpiryMs(appAuth) {
  try {
    const raw = Buffer.from(appAuth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
    const ms = Number(raw.split('|').find((part) => /^\d{13}$/.test(part)))
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  } catch {
    return undefined
  }
}

/** 周期起点（近似）：从权威 endTime 回退一个日历月（北京时间的年月日时分秒
 *  原样前移一个月，小月会滚到下月 1 日）。上游不给周期起止，这只在有了该账号
 *  自己的权威 endTime 时才用于 startsAt/span，绝不凭空猜一个周期。endMs 是
 *  +08:00 解析出的 epoch，先 +8h 让 UTC 分量还原成北京墙钟再取。 */
function cycleStartMs(endMs) {
  const d = new Date(endMs + 8 * 3600e3)
  let year = d.getUTCFullYear()
  let month = d.getUTCMonth() + 1 // 1-based（此刻的 UTC 分量即北京墙钟）
  month -= 1
  if (month === 0) { month = 12; year -= 1 }
  const pad = (n) => String(n).padStart(2, '0')
  return new Date(`${year}-${pad(month)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`).getTime()
}

// vip 会话 Cookie 的进程内缓存与换票失败冷却（宿主进程长驻，缓存跨请求有效）
const cookieCache = new Map()
const ssoFailedAt = new Map()
const SSO_COOLDOWN = 30 * 60e3

/** SSO 换票链：Basic 票 → user-njs querySpecTokenV2 → 出 YZsid 临时票 →
 *  vip ssoLogin 换 vip 会话 Cookie。toSourceId 必须是 **001005**（App vip 会员
 * 中心 H5 的 app.js 自配值；001003/001221 会被 USER_DOMAIN 拒 200050409）。
 *  ssoLogin 的 Set-Cookie 一次下发 6 个（mc_at/mc_bt/mc_pat/mc_pbt/mc_ac/
 *  mc_pac，.139.com 域，24h；mc_at/mc_pat 是 httpOnly）——必须从 getSetCookie()
 *  整段收全，curl 式 cookie jar 会漏。pc: 和 mobile: 票都认（实测）。 */
async function ssoCookie(appAuth) {
  const last = ssoFailedAt.get(appAuth)
  if (last && Date.now() - last < SSO_COOLDOWN) return undefined
  try {
    const mint = await fetch(`${HOSTS.userNjs}/user/querySpecTokenV2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: appAuth, 'user-agent': APP_UA },
      body: JSON.stringify({ toSourceId: '001005' }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json())
    const ticket = mint?.data?.token
    if (typeof ticket !== 'string' || !ticket) throw new Error('出票失败')
    const response = await fetch(`${HOSTS.vip}/m4c/login/ssoLogin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: HOSTS.vip,
        referer: `${HOSTS.vip}/vip/consumptionDetail?sourceid=503016`,
        'user-agent': APP_UA,
      },
      body: JSON.stringify({ ticket, source: '503016', channelSrc: '' }),
      signal: AbortSignal.timeout(15_000),
    })
    const json = await response.json().catch(() => null)
    if (json?.resultCode !== '0') throw new Error(json?.resultDesc ?? `HTTP ${response.status}`)
    const raw = response.headers.getSetCookie?.() ?? []
    const lines = []
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      // Bun 会把多条 Set-Cookie 折叠成一条（逗号连接），而 Expires 日期里本身
      // 就有逗号——只在「逗号后紧跟 名字=」的边界切开，日期逗号保持原样。
      for (const piece of String(entry).split(/,(?=\s*[-\w]+=)/)) {
        const pair = piece.trim().split(';')[0]
        if (pair) lines.push(pair)
      }
    }
    const cookies = [...new Set(lines)]
    if (!cookies.length) throw new Error('ssoLogin 未下发会话 Cookie')
    const cookie = cookies.join('; ')
    cookieCache.set(appAuth, cookie)
    return cookie
  } catch {
    ssoFailedAt.set(appAuth, Date.now())
    return undefined
  }
}

/** 清 SSO 缓存与冷却（测试用）。 */
function resetSsoState() {
  cookieCache.clear()
  ssoFailedAt.clear()
}

/** 清模型/key 进程内缓存（测试用）。 */
function resetModelCache() {
  llKeyRatesCache = undefined
  openclawIdCache = undefined
}

// ---------------------------------------------------------------- chat 响应守卫
// （移植自 kasisama/magpie-joycode 的 normalizeChatResponse，MIT）

function chatError(status, code, message) {
  return Response.json({ error: { type: 'upstream_error', code, message } }, {
    status,
    headers: { 'x-magpie-sign-in': status === 401 ? 'expired' : 'kept' },
  })
}

async function normalizeChatResponse(response) {
  if (!response.ok) {
    const headers = new Headers(response.headers)
    headers.set('x-magpie-sign-in', response.status === 401 ? 'expired' : 'kept')
    return new Response(response.body, { status: response.status, headers })
  }
  if (!response.body) return chatError(502, 'empty_response', 'MClaw 返回空响应')
  const reader = response.body.getReader()
  const buffered = []
  const decoder = new TextDecoder()
  let prefix = ''
  let bytes = 0
  // 网关可能以 HTTP 200 + SSE 响应头返回裸 JSON 错误，先看前缀再放行。
  while (!prefix.trim() && bytes <= 65536) {
    const next = await reader.read()
    if (next.done) break
    buffered.push(next.value)
    bytes += next.value.byteLength
    prefix += decoder.decode(next.value, { stream: true })
  }
  if (!prefix.trim()) {
    await reader.cancel()
    return chatError(502, 'empty_response', 'MClaw 返回空响应')
  }
  if (prefix.trimStart().startsWith('{')) {
    // JSON（含 200 裸 JSON 错误）：读到结尾再判。错误体很小；正常的 JSON
    // 回复可能远超 1MB，不设上限（流式回复走下面的透传分支）。
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      prefix += decoder.decode(next.value, { stream: true })
    }
    prefix += decoder.decode()
    let json
    try { json = JSON.parse(prefix) } catch {}
    if (json?.error || json?.success === false ||
      (json?.code !== undefined && json?.code !== '0000' && !json?.choices)) {
      const code = json.error?.code ?? json.code
      const message = json.error?.message ?? json.message
      const status = String(code) === '01000002' ? 401 : 502
      return chatError(status, code, typeof message === 'string'
        ? message.slice(0, 500)
        : 'MClaw 请求被拒绝')
    }
    if (json?.choices) return Response.json(json)
    return chatError(502, 'invalid_response', 'MClaw 未返回有效的对话响应')
  }
  // 把检查过的字节重放后正常透传流，保留工具调用增量。
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(new ReadableStream({
    async pull(controller) {
      if (buffered.length) { controller.enqueue(buffered.shift()); return }
      try {
        const next = await reader.read()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) { controller.error(error) }
    },
    cancel(reason) { return reader.cancel(reason) },
  }), { status: response.status, headers })
}

// ---------------------------------------------------------------- 账号模型目录

function visionByCode(code) {
  return code.startsWith('vlm_') || code.includes('vision') || code.includes('qwen35')
}

// MClaw 实例 id 的进程内缓存（agent/list 免 userId，可随时重发现）
let openclawIdCache
// 插件装载时的 llm 基址（accountModels 在模块层，读不到插件闭包的 options）
let activeBase = DEFAULT_BASE

// apikey/get v1 的进程内缓存（5 分钟）：models() 调用频繁，key+倍率不用每次拉
let llKeyRatesCache
const LLMKEY_TTL = 5 * 60e3

async function llmKeyAndRates(appAuth) {
  const cached = llKeyRatesCache
  if (cached && cached.appAuth === appAuth && Date.now() - cached.at < LLMKEY_TTL) return cached.data
  const data = await fetchLlmKeyAndRates(appAuth, llmChannelId())
  llKeyRatesCache = { appAuth, data, at: Date.now() }
  return data
}

/** 账号实际模型目录：agent/list（实例 id + 可用模型）× apikey/get v1（key+倍率，
 *  mobile:/pc: 票通用）× config/get（兜底，仅 mobile: 票）。
 *  ⚠️ 宿主传给钩子的 provider 是它归一化过的对象（自定义字段会被剥掉），
 *  所以这里只用闭包值，绝不读 provider 参数上的 base/openclawId。 */
async function accountModels(provider, { auth } = {}) {
  const appAuth = appAuthOf(auth)
  if (!appAuth) return provider.models
  let agentList
  try {
    agentList = await fetchAgentList(appAuth)
    openclawIdCache = agentList.agentId
  } catch (error) {
    if (error.signIn === 'expired') throw error
    if (!openclawIdCache) return provider.models // 连实例 id 都拿不到时保留静态目录
    agentList = { agentId: openclawIdCache, models: [] }
  }
  let rates = new Map()
  let names = new Map()
  try {
    // 首选 apikey/get v1：一张票拿全 key + 倍率，网页票（pc:）也认
    const data = await llmKeyAndRates(appAuth)
    if (Array.isArray(data.modelList)) {
      rates = new Map(data.modelList.map((m) => [m?.modelCode, Number(m?.tokenRatio)]))
      names = new Map(data.modelList.map((m) => [m?.modelCode, m?.modelName]))
    }
  } catch (error) {
    if (error.signIn === 'expired') throw error
    // 兜底 config/get（App 渠道票专用）；再失败就只剩 agent 列表（无倍率）
    try {
      const catalogue = await fetchModelCatalogue(appAuth, agentList.agentId)
      rates = new Map(catalogue.map((m) => [m?.code, Number(m?.tokenRatio)]))
      names = new Map(catalogue.map((m) => [m?.code, m?.name]))
    } catch (fallbackError) {
      if (fallbackError.signIn === 'expired') throw fallbackError
    }
  }
  const models = {}
  const source = agentList.models.length
    ? agentList.models
    : [...names].map(([code, name]) => ({ code, name }))
  for (const am of source) {
    const id = am?.code
    if (typeof id !== 'string' || !id) continue
    const base = provider.models?.[id] ?? {}
    const rate = rates.get(id)
    const image = visionByCode(id)
    models[id] = {
      ...base,
      id,
      name: names.get(id) || am.name || base.name || id,
      api: { id, url: `${activeBase}/v1`, npm: '@ai-sdk/openai-compatible' },
      limit: { ...base.limit, context: 200000, output: 32000 },
      tool_call: true,
      ...(id.includes('max') || id.includes('glm') || id.includes('deepseek') || id.includes('qwen37')
        ? { reasoning: true } : {}),
      modalities: { input: image ? ['text', 'image'] : ['text'] },
      ...(Number.isFinite(rate) && rate > 0 ? { rate } : {}),
    }
  }
  return Object.keys(models).length ? models : provider.models
}

// ---------------------------------------------------------------- plugin

export const MclawAuthPlugin = async (_input, options) => {
  const base = String(options?.base ?? DEFAULT_BASE).replace(/\/+$/, '')
  activeBase = base
  // 测试缝：fake browser 从 options.browserModule 进（宿主不会传）。
  const browser = options?.browserModule ?? browserDefault
  // 登录前的浏览器/图形界面预检（宿主不会传，测试可注入或给 browserCandidates）。
  // 失败要发生在 authorize 里、返回 opened:true 之前——不能先宣称窗口已弹出再
  // 在 callback 里报错。fake browser 不带预检时整个跳过，不碰本机真实环境。
  const signinPrerequisites = options?.signinPrerequisites
    ?? (options?.browserCandidates !== undefined
      ? (pre) => browserDefault.assertBrowserSigninPrerequisites({ ...pre, candidates: options.browserCandidates })
      : undefined)
    ?? (options?.browserModule ? undefined : (pre) => browserDefault.assertBrowserSigninPrerequisites(pre))
  // 宿主取消登录（callback 没被调）后的收尾时限：到点关浏览器、放 profile 锁，
  // 不然锁被宿主 pid 占着，后续登录/续期全要等 LOCK_TIMEOUT。
  const signinAbortMs = Number(options?.signinAbortMs) > 0 ? Number(options.signinAbortMs) : 300_000

  return {
    // 未登录也能看到的供应商与静态模型目录。
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'MClaw',
        npm: '@ai-sdk/openai-compatible', // chat completions
        api: `${base}/v1`,
        models: MODELS,
      }
    },

    // 配置了 App 凭证后按账号拉取实际模型目录与倍率。
    provider: { id: PROVIDER, models: accountModels },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: 'oauth',
          label: '浏览器登录（登录一次，凭证全自动）',
          // 没有 prompts：登录全程只有「在弹出的 Chrome 里登录」一个动作。
          // llm key 由 apikey/get v1 自动取；vip 会话由 SSO 换票链自动维持
          // （0.5.0 前老账号手动粘过的 metadata.vipCookie 仍优先、失效自动换新）。

          // 流程：宿主契约要求 authorize 立即返回 { url, opened, instructions,
          // method, callback }（参照 sensenova/joycode），Chrome 由 authorize 弹出、
          // 收割等登录放进宿主随后调的 callback()。每次登录用全新 profile 的
          // Chrome（CDP 管道驱动，不占端口），绝不带旧票：换账号登录、票被吊销
          // 后重登都不会捡到上一次的 Cookie。用户在窗口里完成移动云登录（网页
          // 支持验证码、密码、扫码等多种方式）→ 插件收割 authorization Cookie
          // （= pc: 票）→ apikey/get v1 自动取 llm key → profile 目录与手机号
          // 存进 metadata，存为 oauth 型 { refresh:'browser', access, expires,
          // metadata }，到期前宿主调 refresh 钩子 headless 续期（复开该账号
          // 自己的 profile）。
          async authorize(inputs = {}, { signal } = {}) {
            // 预检先于任何副作用：没有图形界面（Linux 无 DISPLAY/WAYLAND）或找不到
            // Chromium 内核浏览器时，直接在这里失败。参照 inkstone 0.1.1 的
            // 修法——「窗口已弹出」这类话绝不能先说出去再在 callback 里报错
            // （magpie-community/plugins#825）。
            try {
              if (typeof signinPrerequisites === 'function') await signinPrerequisites()
            } catch (error) {
              return { type: 'failed', error: error?.message ?? String(error) }
            }
            // 不 await：Chrome 立即弹出；若宿主取消（callback 没被调），定时器
            // 到点 abort——关浏览器、放 profile 锁；挂个空 catch 免得 abort 后
            // 的拒绝刷 unhandled rejection。
            const harvesting = browser.startBrowserHarvest()
            harvesting.promise.catch(() => {})
            const cleanup = setTimeout(() => { harvesting.abort().catch(() => {}) }, signinAbortMs)
            // magpie 式取消：宿主在 authorize 之后立刻调 callback(undefined, { signal })，
            // 用户关掉面板/登录超时就 abort 这个 signal。两个入口都接上它——abort
            // 一到立即收尾（关浏览器、放锁、删孤儿 profile），不等到 10 分钟 deadline。
            const onAbort = () => { harvesting.abort().catch(() => {}) }
            if (signal?.aborted) onAbort()
            else if (typeof signal?.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
            return {
              url: '',
              opened: true, // Chrome 已由本插件弹出，宿主不要再开 url
              instructions: '已弹出专用浏览器窗口：请在里面登录移动云（yun.139.com，网页支持验证码、密码、扫码等多种方式）。登录成功后本流程自动检测并继续，窗口由插件自己关闭，你不需要手动关窗。',
              method: 'auto',
              async callback(_code, { signal: callbackSignal } = {}) {
                clearTimeout(cleanup)
                if (callbackSignal?.aborted) onAbort()
                else if (typeof callbackSignal?.addEventListener === 'function') callbackSignal.addEventListener('abort', onAbort, { once: true })
                let release, close
                try {
                  const { cookie, profilePath, release: r, close: c } = await harvesting.promise
                  release = r
                  close = c
                  const token = cookie.value
                  const expires = basicExpiryMs(token) ?? (cookie.expiresMs || undefined)
                  // 票校验 + 自动取 key（顺带拿到倍率表，缓存给 models 用）
                  let apiKey
                  try {
                    apiKey = (await llmKeyAndRates(token)).apikey
                  } catch (error) {
                    if (error.signIn === 'expired') {
                      return { type: 'failed', error: `登录票校验失败：${error.message}` }
                    }
                    apiKey = undefined // 网络抖动：见下
                  }
                  if (!apiKey) {
                    return { type: 'failed', error: '登录成功但 llm key 自动获取失败（网络抖动），请重新登录重试' }
                  }
                  const metadata = { apiKey, profile: profilePath }
                  const email = nameFromAppAuth(token)
                  if (email) metadata.email = email
                  return { type: 'success', refresh: 'browser', access: token, expires, metadata }
                } catch (error) {
                  return { type: 'failed', error: error?.message ?? String(error) }
                } finally {
                  await close?.().catch(() => {})
                  await release?.()
                }
              },
            }
          },
        },
      ],

      // 每个账号请求所带的凭证。chat key 两种存储形态都认：
      // api 型在 auth.key，oauth 型（浏览器登录自动获取的）在 metadata.apiKey。
      loader: async (getAuth) => {
        const auth = await getAuth()
        const key = String(auth?.type === 'oauth' ? auth?.metadata?.apiKey : auth?.key ?? '').trim()
        if (!key) return {}
        return {
          baseURL: `${base}/v1`,

          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            headers.set('authorization', `Bearer ${key}`)
            const response = await fetch(input, { ...init, headers })
            return normalizeChatResponse(response)
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const appAuth = appAuthOf(auth)
        if (!appAuth) return { windows: [] } // 未配 Basic 票，无用量可查
        try {
          const item = await fetchBenefit(appAuth)
          if (!item) return { error: '权益列表里没有 aitokens（RHR135）', windows: [] }
          const total = Number(item.benefitValue)
          const used = Number(item.benefitUsed)
          const window = {
            // 权益识别走 benefitNo（RHR135），卡片名不带编号。
            name: 'MClaw tokens',
            used: total > 0 ? (used / total) * 100 : 0,
            amount: used,
            limit: total,
            unit: 'tokens',
            display: `已用 ${fmt(used)} / ${fmt(total)} · 剩余 ${fmt(Math.max(total - used, 0))}`,
          }
          const expiry = basicExpiryMs(appAuth)
          if (expiry) {
            const d = new Date(expiry)
            window.display += ` · 凭证至 ${d.getMonth() + 1}/${d.getDate()}${expiry < Date.now() ? '（已过期，请重新抓取）' : ''}`
          }
          // 最近明细 + 权威重置时间需要 vip 会话：优先账号配置的 Cookie，其次
          // 进程内缓存的换票成果；缺失或失效走 SSO 换票链自动补。明细只是
          // 加料：任何失败（超时、Cookie 失效、换票不成）都不影响池窗口本身。
          const cached = cookieCache.get(appAuth)
          const configured = auth.metadata?.vipCookie?.trim()
          let vipCookie = cached ?? configured
          let records = vipCookie ? await fetchRecords(vipCookie).catch(() => undefined) : undefined
          if (!records && cached) cookieCache.delete(appAuth) // 缓存的那张死了
          if (!records) {
            const fresh = await ssoCookie(appAuth)
            if (fresh) records = await fetchRecords(fresh).catch(() => undefined)
          }
          const latest = records?.[0]
          const end = endTimeMs(latest?.endTime)
          // 「重置于」只认该账号明细里的权威 endTime（当前周期的终点）。
          // 上游不给周期起止，也没有可外推的通用锚点——别家账号的周期起点
          // 各不相同，没有权威 endTime 就不显示，绝不猜一个。
          const resetsAt = end && end > Date.now() ? end : undefined
          if (resetsAt) {
            // 窗口形态带上 startsAt + span（周期起点 = endTime 回退一个日历月，
            // 近似）。当前 magpie（0.1.2906）的插件桥会把这两个量剥掉（startsAt
            // 留给自家网关窗口），「按此速度，预计…」由宿主自己的历史采样
            // （≥3 点且 ≥1h）另算；宿主哪天不剥了即生效。
            const start = cycleStartMs(resetsAt)
            window.resetsAt = new Date(resetsAt).toISOString()
            if (start > 0 && start < resetsAt) {
              window.startsAt = new Date(start).toISOString()
              window.span = (resetsAt - start) / 1000
            }
          }
          const reset = resetsAt
            ? ` · 重置于 ${new Date(resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
            : ''
          window.display += reset
          if (latest) {
            window.display += ` · 最近 ${latest.recordTime ?? ''} ${latest.comments ?? ''} -${fmt(Number(latest.benefitNum) || 0)}tok（${latest.modelName || latest.modelCode || ''}${latest.coefficient ? ` ${latest.coefficient}×` : ''}）`
          }
          return { windows: [window] }
        } catch (error) {
          return {
            error: error.message,
            windows: [],
            signIn: error.signIn === 'expired' ? 'expired' : 'kept',
          }
        }
      },

      // 浏览器登录账号（refresh === 'browser'）的自动续期：headless 复开该账号
      // 自己的 profile（metadata.profile；0.5.0 前的老账号退回老共享目录，收割
      // 成功后把目录钉进 metadata），网页应用自己刷新会话后重新收割
      // authorization Cookie；票换了就顺手刷新 metadata.apiKey。到期前
      // refreshLead 触发；其他形态原样返回。
      refreshLead: 3 * 24 * 3600e3,
      async refresh(auth) {
        if (auth?.refresh !== 'browser' || !auth?.access) return {}
        const { cookie, profilePath } = await browser.browserRefreshHarvest({ profilePath: auth?.metadata?.profile })
        const token = cookie.value
        // 收割到的票必须是这个账号的：最后一个登录的是别的账号时绝不能
        // 张冠李戴（B 的票 + B 的 key 存到 A 名下）。
        const who = nameFromAppAuth(token)
        if (auth?.metadata?.email && who && who !== auth.metadata.email) {
          throw expired(`续期收割到的是另一账号（${who}）的票，已放弃；请重新登录`)
        }
        const expires = basicExpiryMs(token) ?? (cookie.expiresMs || auth.expires)
        const metadata = { ...(auth.metadata ?? {}) }
        if (!metadata.profile && profilePath) metadata.profile = profilePath
        if (token !== auth.access) {
          try {
            metadata.apiKey = (await llmKeyAndRates(token)).apikey
          } catch {} // key 拉不到就保留旧值，chat 不一定受影响
        }
        return { access: token, expires, metadata }
      },
    },
  }
}

// 测试面（node --test / bun test）。除插件本身外不要导出别的函数。
export const _internal = {
  MODELS, appHeaders, visionByCode, nameFromAppAuth, endTimeMs, basicExpiryMs,
  appAuthOf, llmChannelId, cycleStartMs, normalizeChatResponse, accountModels, HOSTS,
  resetSsoState, resetModelCache,
}

// OpenCode v1 形态：默认导出 { id, server }，宿主只取 server。
export default { id: PROVIDER, server: MclawAuthPlugin }
