// 书灵墨宝（MoBook）网页接口客户端：签名、登录态、墨滴积分、签到与成长计划任务，
// 以及把 OpenAI 对话请求转成墨宝智能体的会话（/chat/chat_service + 消息轮询）。
//
// 签名算法取自官网前端（11231858-release-2f5b858 的 chunk-packages）：
//   sign = MD5(按 key 排序后的 key+value 拼接串 + secret).toUpperCase()
// 每个请求都带 appKey / sign / timestamp / version，身份是 Cookie 里的 _tk。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const GATEWAY = 'https://api-gateway.shuwenda.com'
// 桌面客户端用的 OpenAI 兼容网关：API Key（dcg-…）走这里，支持原生流式与用量。
export const MODEL_GATEWAY = 'https://model-gateway.shuwenda.com/v1'
// 桌面客户端的图片/语音网关（v3）。图片不需要 model 字段，由网关按 Key 的配置决定。
export const MEDIA_GATEWAY_V3 = 'https://model-gateway.shuwenda.com/v3'
// 登录后对话时固定用网页端的旗舰应用身份（web appId 40、平台机构 1000）。
export const APP_KEY = '2A1C74D315CB4A01BF3DA8983695AFE2'
export const APP_SECRET = '34E9023008EA445AAE6CC075CC954F46'
export const VERSION = '1.0.0'
export const APP_ID = 40
export const ORG_ID = 1000
export const DOMAIN_ID = 1000
// 墨宝（AI_CLAW）智能体的固定 id；网页端所有默认对话都走它。
export const DEFAULT_AGENT_ID = 13

export function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase()
}

// signOf 与网页端完全一致：把 timestamp/path/version 和请求体放进同一张表，
// 按 key 排序后拼成 'key+value' 串，对象值用 JSON.stringify，最后接密钥取 MD5。
export function signOf(data, timestamp, path, { secret = APP_SECRET, version = VERSION } = {}) {
  const all = { timestamp, path, version, ...(data ?? {}) }
  const joined = Object.keys(all)
    .sort()
    .map((key) => {
      const value = all[key]
      if (value === undefined) return ''
      return key + (typeof value === 'object' ? JSON.stringify(value) : value)
    })
    .join('')
  return md5(joined + secret)
}

function metaOf(cred) {
  return {
    _orgId: Number(cred?.orgId) || ORG_ID,
    _domainId: DOMAIN_ID,
    _appId: Number(cred?.appId) || APP_ID,
    _userId: Number(cred?.uid) || 0,
  }
}

export class MoBookError extends Error {
  constructor(message, { code = null, path = '', expired = false, body = null } = {}) {
    super(message)
    this.name = 'MoBookError'
    this.code = code
    this.path = path
    this.body = body
    if (expired) this.signIn = 'expired'
  }
}

// apiCall 发一个带签名的网页接口请求，返回 data。
// code !== 0 一律抛 MoBookError；401/未登录映射成 signIn: 'expired'。
export async function apiCall(cred, path, data = {}, { method = 'POST', fetchImpl = fetch, timeoutMs = 20000, signal } = {}) {
  const meta = metaOf(cred)
  const body = { ...meta, ...data }
  const timestamp = Date.now()
  const sign = signOf(body, timestamp, path)
  // GET 没有请求体：data 必须和 meta 一起进 query，否则参数丢失且与签名不一致。
  const querySource = method === 'GET' ? body : meta
  const query = new URLSearchParams(Object.entries(querySource).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)])).toString()
  const headers = {
    'content-type': 'application/json',
    ...(cred?.tk ? { authorization: String(cred.tk) } : {}),
    appkey: APP_KEY,
    sign,
    timestamp: String(timestamp),
    version: VERSION,
    locale: 'zh-CN',
    platform: String(cred?.platform || 'web'),
    source_system: 'dcg-agent-web',
    app_version: VERSION,
    user_id: String(meta._userId),
    org_id: String(meta._orgId),
  }
  const url = GATEWAY + path + '?' + query
  let res
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (signal?.aborted) throw new MoBookError('请求已取消', { path })
    throw new MoBookError('墨宝接口连不上（' + path + '）：' + (error?.message ?? error), { path })
  }
  const text = await res.text()
  // 有些删除/停止类接口成功时回 200 + 空正文：这不是失败，别把它当成「接口失败」。
  // 401 仍然要看状态码——空正文时没有 code 可判。
  if (!text.trim()) {
    if (res.status === 401) {
      throw new MoBookError('墨宝登录态已失效，请重新粘贴 _tk 登录', { path, expired: true })
    }
    if (!res.ok) throw new MoBookError('墨宝接口失败（' + path + '，HTTP ' + res.status + '）', { path })
    return null
  }
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    throw new MoBookError('墨宝接口返回的不是 JSON（' + path + '，HTTP ' + res.status + '）', { path })
  }
  const code = payload?.code
  const message = payload?.message || payload?.error?.message || ''
  if (res.status === 401 || code === 401 || /Illegal authorization|未登录|登录已过期/i.test(String(message))) {
    throw new MoBookError('墨宝登录态已失效，请重新粘贴 _tk 登录', { path, code, expired: true, body: payload })
  }
  if (code !== 0 && payload?.success !== true) {
    throw new MoBookError(message || '墨宝接口失败（' + path + '）', { path, code, body: payload })
  }
  return payload?.data
}

// ---- 登录态 ----

// parseSession 接受三种粘贴形态：裸 _tk、整段 Cookie（_tk=…; _uid=…）、JSON。
export function parseSession(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('请粘贴 _tk 或整段 Cookie')
  const out = {}
  if (text.startsWith('{')) {
    let obj
    try {
      obj = JSON.parse(text)
    } catch {
      throw new Error('粘贴的 JSON 解析失败')
    }
    out.tk = String(obj?._tk ?? obj?.tk ?? obj?.token ?? '').trim()
    out.uid = String(obj?._uid ?? obj?.uid ?? obj?.userId ?? '').trim()
  } else if (text.includes('=')) {
    for (const part of text.split(';')) {
      const at = part.indexOf('=')
      if (at < 0) continue
      const key = part.slice(0, at).trim()
      const value = part.slice(at + 1).trim().replace(/^"|"$/g, '')
      if (key === '_tk' || key === 'tk') out.tk = value
      if (key === '_uid' || key === 'uid' || key === 'userId') out.uid = value
    }
  } else {
    out.tk = text
  }
  if (!out.tk) throw new Error('没有找到 _tk：Cookie 里应有 _tk=…')
  return { tk: out.tk, uid: out.uid || '' }
}

// fetchUser 用 _tk 读账号资料；返回 { id, name, mobile }。
export async function fetchUser(cred, deps = {}) {
  const data = await apiCall(cred, '/user/getUserById', {}, deps)
  const id = Number(data?.id) || Number(cred?.uid) || 0
  if (!id) throw new MoBookError('墨宝没有返回账号 id，请补填 _uid')
  return { id, name: String(data?.name ?? '').trim(), mobile: String(data?.mobile ?? '').trim(), logo: String(data?.logo ?? '').trim() }
}

// ---- 墨滴与签到 ----

export async function fetchBalance(cred, deps = {}) {
  const data = await apiCall(cred, '/point/getUserPointAccount', { accountType: '10', userId: Number(cred.uid) }, deps)
  const amount = Number(data?.pointAmount)
  if (!Number.isFinite(amount)) throw new MoBookError('墨宝没有返回墨滴余额')
  return { amount, accountId: Number(data?.id) || 0, modifiedAt: String(data?.gmtModified ?? '') }
}

// checkinActivity 读本期签到活动；没有活动或活动已结束返回 null。
export async function checkinActivity(cred, deps = {}) {
  const data = await apiCall(cred, '/activity/getUserCheckinActivity', { userId: Number(cred.uid), appId: APP_ID, _appId: APP_ID }, deps)
  const activity = data?.activity
  if (!activity || activity.activityId == null) return null
  const stat = data?.checkinStat ?? {}
  const benefit = data?.activityRule?.benefit ?? data?.activityRule?.activityBenefit ?? {}
  const daily = Number(benefit?.point)
  return {
    activityId: Number(activity.activityId),
    name: String(activity.activityName ?? '').trim(),
    startTime: String(activity.startTime ?? ''),
    endTime: String(activity.endTime ?? ''),
    dailyAmount: Number.isFinite(daily) && daily > 0 ? daily : 0,
    expireDay: Number(benefit?.expireDay) || 0,
    claimedToday: Number(stat.checkinStatus) === 1,
    claimedDays: Number(stat.checkinDays) || 0,
    totalClaimed: Number(stat.totalPoints) || 0,
  }
}

export async function claimCheckin(cred, activityId, deps = {}) {
  return await apiCall(cred, '/activity/dailyCheckin', { userId: Number(cred.uid), activityId: Number(activityId) }, deps)
}

// ---- 成长计划任务 ----

export const TASK_STATUS = { todo: 0, doing: 1, claimable: 2, claimed: 3 }

export function taskStatusName(status) {
  const n = Number(status)
  if (n === TASK_STATUS.claimable) return 'claimable'
  if (n === TASK_STATUS.claimed) return 'claimed'
  if (n === TASK_STATUS.doing) return 'doing'
  return 'todo'
}

export function taskRow(item, index) {
  const activity = item?.activity ?? {}
  const rule = item?.activityRule ?? {}
  const record = item?.userTaskRecord ?? {}
  const benefit = rule?.benefit ?? rule?.activityBenefit ?? {}
  const point = Number(benefit?.point)
  return {
    index,
    activityId: Number(activity.activityId),
    userTaskId: record?.id != null ? Number(record.id) : null,
    title: String(activity.activityName ?? '').trim(),
    description: String(activity.description ?? '').trim(),
    reward: Number.isFinite(point) && point > 0 ? point : 0,
    ruleType: Number(rule?.ruleType) || 0,
    agentId: Number(rule?.agentId) || 0,
    productId: Number(rule?.productId) || 0,
    productName: String(rule?.productName ?? rule?.skillName ?? '').trim(),
    status: taskStatusName(record?.status),
    endTime: String(activity.endTime ?? ''),
  }
}

export async function fetchTasks(cred, deps = {}) {
  const data = await apiCall(cred, '/activity/queryUserTaskList', { userId: Number(cred.uid), platform: 'web' }, deps)
  const list = Array.isArray(data) ? data : []
  return list.map((item, index) => taskRow(item, index)).filter((row) => Number.isFinite(row.activityId))
}

// joinTask 领取任务（todo -> doing），返回任务记录 id。
export async function joinTask(cred, activityId, deps = {}) {
  const data = await apiCall(cred, '/activity/addUserTask', { userId: Number(cred.uid), activityId: Number(activityId) }, deps)
  const id = data?.userTaskRecord?.id
  const point = Number(data?.userTaskRecord?.ext?.point)
  return { userTaskId: id != null ? Number(id) : null, point: Number.isFinite(point) ? point : 0, raw: data }
}

// claimTask 领取已完成任务（claimable -> claimed），返回本次实际发放的墨滴。
export async function claimTask(cred, task, deps = {}) {
  const data = await apiCall(
    cred,
    '/activity/earnUserTaskPoint',
    { userId: Number(cred.uid), userTaskId: Number(task.userTaskId), activityId: Number(task.activityId) },
    deps,
  )
  const ext = data?.userTaskRecord?.ext
  const point = Number(ext?.point)
  // 只报实际发放的墨滴：ext.point 缺失时记 0，不回退任务名义奖励（避免虚报）。
  return { point: Number.isFinite(point) && point > 0 ? point : 0, raw: data }
}

// ---- 成长计划：做任务 ----

// TASK_HINTS 把规则类型翻译成“怎么完成”，给用量/签到消息里做提示用。
export const TASK_HINTS = {
  12: '在对应数字专家里完成一次创作/审校',
  13: '在「技能」里跑一次对应技能',
  14: '创建一个定时任务',
  15: '用桌面端墨宝对话一次',
  16: '用小程序端墨宝对话一次',
  17: '在审校专家里用满 3 次',
  18: '使用 3 个不同专家',
  19: '使用 3 个不同技能',
  20: '在审校批注里留一条批注',
  22: '创建/打开个人知识库',
  23: '新建一条录音/图片笔记',
}

// completeDesktopTask 用桌面端身份聊一句：活动侧的“桌面端对话”就按 appId 计。
// 回答可能较慢，超时不算失败——服务端已经记了这次对话。
export async function completeDesktopTask(cred, deps = {}) {
  const desktop = { ...cred, appId: 200, platform: 'desktop' }
  try {
    const out = await ask(desktop, { model: 'deepseek-v4-flash', prompt: '只回复两个字：收到', pollMs: 1200, timeoutMs: 24000 }, deps)
    return Number(out?.sessionId) || 0
  } catch {}
  return 0
}

// fetchExperts 读已安装专家：agent_id -> code/version，用来拼 agent_clone_code。
export async function fetchExperts(cred, deps = {}) {
  const bot = await ensureBot(cred, deps)
  const data = await apiCall(cred, '/skill-market/v1/user_expert/get_my_agents', { user_id: Number(cred.uid), bot_token: bot?.token, page_no: 1, page_size: 200 }, deps)
  const items = Array.isArray(data?.installed_list) ? data.installed_list : []
  const map = new Map()
  for (const item of items) {
    const agentId = Number(item?.agent_id)
    if (!Number.isFinite(agentId) || agentId <= 0) continue
    map.set(agentId, {
      name: String(item?.name ?? '').trim(),
      code: String(item?.code ?? '').trim(),
      version: String(item?.version ?? '').trim(),
    })
  }
  return map
}

export function cloneCodeOf(expert) {
  if (!expert?.code) return ''
  const parts = String(expert.version || '').split('.').filter(Boolean)
  // 网页端格式：reviser-expert + 1.0.45 → reviser-expert-1-0-45-45（最后一段重复一次，不是 -7）。
  return expert.code + (parts.length ? '-' + parts.join('-') + '-' + parts[parts.length - 1] : '')
}

// specialistChat 按网页同款字段建一条“专家产品会话”并发一句话：
// 抓包是 /chat/new_session {agent_id, agent_type:'specialist', bot_id, bot_token, version:'1.0.1'}，
// 然后 /chat/chat_service 带上同样的 agent_type。
// uploadChatFile 把已上传到 OSS 的文件登记成聊天附件，返回 file_id。
export async function uploadChatFile(cred, { name, key }, deps = {}) {
  const data = await apiCall(cred, '/chat/upload_file', { file_name: String(name), file_url: String(key), agent_id: 0 }, deps)
  return Number(data?.file_id ?? data?.id ?? 0)
}

export async function specialistChat(cred, { agentId, text, cloneCode, version, files = [] }, deps = {}) {
  const bot = await ensureBot(cred, deps)
  if (!bot?.id) throw new MoBookError('没有可用的墨宝智能体')
  const agentVersion = String(version || '1.0.45')
  const created = await apiCall(cred, '/chat/new_session', {
    agent_id: Number(agentId),
    agent_type: 'specialist',
    bot_id: bot.id,
    ...(bot.token ? { bot_token: bot.token } : {}),
    version: agentVersion,
  }, deps)
  const sessionId = Number(created?.session_id)
  if (!Number.isFinite(sessionId) || sessionId <= 0) throw new MoBookError('专家会话创建失败')
  await apiCall(cred, '/chat/chat_service', {
    session_id: sessionId,
    options: { thinking: 0, networking: 1 },
    message: { text, human_input_text: text, files: files.filter(Boolean).map((id) => ({ file_id: Number(id), is_referenced: 1 })), review_revision_scope: [], corpus: [] },
    attachments: [],
    // 网页端的专家会话不带 model 字段（带 qwen4-max 会被当成普通对话，审校专家不会真正跑审校）。
    agent_id: Number(agentId),
    agent_code: 'CHAT',
    ...(cloneCode ? { agent_clone_code: String(cloneCode) } : {}),
    bot_id: bot.id,
    ...(bot.token ? { bot_token: bot.token } : {}),
  }, deps).catch(() => null)
  return sessionId
}
// runTasks 做成长计划的「领取」侧：补齐未领取的任务、领已完成奖励。
// 「做任务」的动作侧只由 task-runner.mjs 后台执行（固定顺序 + 按人类最快操作时间等待）。
// 这里不做任何动作，所以 cleanup 恒为空——不是「清理失败」，是「没东西要清」。
export async function runTasks(cred, { deps = {} } = {}) {
  let list = await fetchTasks(cred, deps)
  const joined = []
  for (const task of list) {
    if (task.status !== 'todo') continue
    try {
      await joinTask(cred, task.activityId, deps)
      joined.push(task.title)
    } catch {}
  }
  if (joined.length) list = await fetchTasks(cred, deps).catch(() => list)
  const claimed = []
  for (const task of list) {
    if (task.status !== 'claimable' || task.userTaskId == null) continue
    try {
      const out = await claimTask(cred, task, deps)
      claimed.push({ title: task.title, point: out.point })
    } catch {}
  }
  const tasks = await fetchTasks(cred, deps).catch(() => list)
  return {
    joined,
    actions: [],
    claimed,
    credit: claimed.reduce((n, item) => n + item.point, 0),
    // 这里不产生会话/笔记，所以没有东西要清：failed 为空数组，计数恒为 0。
    cleanup: { sessions: 0, contents: 0, failed: [] },
    tasks,
    hints: tasks
      .filter((task) => task.status !== 'claimed' && TASK_HINTS[task.ruleType])
      .map((task) => task.title + '：' + TASK_HINTS[task.ruleType]),
  }
}

// fetchActiveRecords 读成长计划「活跃地图」的活跃记录。
export async function fetchActiveRecords(cred, deps = {}) {
  const data = await apiCall(cred, '/activity/queryUserActiveList', { userId: Number(cred.uid), platform: 'web' }, deps)
  const rows = Array.isArray(data) ? data : (data?.list ?? [])
  return rows.map((row) => ({ activeTime: String(row?.activeTime ?? ''), makeup: row?.makeup === true, id: row?.userActiveRecordId }))
}

// wallClockMs 把服务端的北京墙钟字符串（'YYYY-MM-DD HH:mm:ss'）按 +08:00 解析，
// 不依赖本机时区；已带时区偏移/Z 的字符串按原样解析。
function wallClockMs(value) {
  const text = String(value ?? '').trim()
  if (!text) return NaN
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(text)) return Date.parse(text)
  return Date.parse(text.replace(' ', 'T') + '+08:00')
}

// activeDayOf 把活跃记录时间换成北京日期前缀（数值毫秒时间戳直接换算）。
function activeDayOf(value) {
  const ms = typeof value === 'number' ? value : wallClockMs(value)
  return Number.isFinite(ms) ? beijingDateOf(ms) : ''
}

// fetchActiveMap 活跃地图摘要：本月活跃天数、当前连续天数、补登卡张数。
export async function fetchActiveMap(cred, deps = {}) {
  const [stat, rows] = await Promise.all([
    apiCall(cred, '/activity/queryUserActiveStat', { userId: Number(cred.uid), platform: 'web' }, deps).catch(() => null),
    fetchActiveRecords(cred, deps).catch(() => []),
  ])
  const activeDays = Number(stat?.userActiveStat?.activeDays) || 0
  const makeupCards = Number(stat?.userActiveReward?.ext?.makeupCardCounts ?? stat?.userActiveStat?.makeupCardCounts) || 0
  const days = new Set(rows.map((row) => activeDayOf(row.activeTime)).filter(Boolean))
  const todayMs = Date.now() + 8 * 3600 * 1000
  let cursor = new Date(todayMs)
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor = new Date(todayMs - 86400000)
  let streak = 0
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1
    cursor = new Date(cursor.getTime() - 86400000)
  }
  return { activeDays, streak, makeupCards, todayActive: days.has(new Date(todayMs).toISOString().slice(0, 10)) }
}

// isActiveToday 今天（北京时间）是否已在活跃地图上。
export async function isActiveToday(cred, deps = {}) {
  const rows = await fetchActiveRecords(cred, deps).catch(() => [])
  const today = beijingToday()
  return rows.some((row) => activeDayOf(row.activeTime) === today)
}

// recordActivityChat 完成一次对话让“活跃地图”记活跃：先 deepseek-v4-flash，失败回退“快速”（eco），
// 然后轮询活跃记录，确认今天已标记活跃才算成功；会话最后删掉。
// 超时给 120 秒：40 秒在真实账号上实测会超时（日志里出现过「墨宝这次回答超时了（40s）」），
// 活跃对话一旦没发出去，当天的活跃打卡就白等。登录态失效则直接抛，不再拿死凭据重试一次。
export const ACTIVITY_CHAT_TIMEOUT_MS = 120000
export async function recordActivityChat(cred, { attempts = 6, waitMs = 5000, deps = {} } = {}) {
  const badReply = (value) => !String(value?.text ?? '').trim() || /Gateway reported an invalid request/i.test(String(value.text))
  const askOnce = (askModel) => ask(cred, { model: askModel, prompt: '你好，报到一下。', pollMs: 1200, timeoutMs: ACTIVITY_CHAT_TIMEOUT_MS }, deps)
  let out
  let model = 'deepseek-v4-flash'
  try {
    out = await askOnce(model)
    if (badReply(out)) throw new MoBookError('flash 回复异常')
  } catch (error) {
    if (error?.signIn === 'expired') throw error
    model = 'eco'
    out = await askOnce(model)
  }
  const sessionId = Number(out?.sessionId) || 0
  if (sessionId > 0) {
    const bot = await ensureBot(cred, deps).catch(() => null)
    await apiCall(cred, '/chat/delete', { session_id: sessionId, bot_token: bot?.token }, deps).catch(() => null)
  }
  let active = false
  for (let i = 0; i < attempts && !active; i += 1) {
    active = await isActiveToday(cred, deps).catch(() => false)
    if (!active) await new Promise((r) => setTimeout(r, waitMs))
  }
  return { ok: true, active, model, sessionId, text: String(out?.text ?? '') }
}

// ---- 清理：删会话 / 删内容 / 删知识库文件 / 卸载技能 ----

export async function deleteChatSession(cred, sessionId, deps = {}) {
  const bot = await ensureBot(cred, deps)
  return await apiCall(cred, '/chat/delete', { session_id: Number(sessionId), bot_token: bot?.token }, deps)
}

export async function deleteContent(cred, contentId, deps = {}) {
  return await apiCall(cred, '/resource/deleteContent', { id: Number(contentId) }, deps)
}

// cleanupArtifacts 是任务流程的最后一步：把这次造出来的会话、笔记、知识库文件删掉。
export async function cleanupArtifacts(cred, { sessions = [], contents = [] } = {}, deps = {}) {
  const result = { sessions: 0, contents: 0, failed: [] }
  for (const id of sessions) {
    try { await deleteChatSession(cred, id, deps); result.sessions += 1 } catch { result.failed.push('chat:' + id) }
  }
  for (const id of contents) {
    try { await deleteContent(cred, id, deps); result.contents += 1 } catch { result.failed.push('content:' + id) }
  }
  return result
}

// ---- 任务动作：技能 / 安装 / 笔记 / 知识库 / 定时任务 ----

// ossPut 用 STS 临时凭证把文件传到 OSS；isPrivate=1 传私有桶（录音音频走这条）。
async function ossPut(cred, bytes, name, mime, isPrivate, deps = {}) {
  const crypto = await import('node:crypto')
  const sts = await apiCall(cred, '/user/getStsTokenByAsync', { sourceFileName: name, isPrivate }, deps)
  const date = new Date().toUTCString()
  const canonical = '/' + sts.bucket + '/' + sts.uploadDir + sts.ossFileKey
  const ossHeaders = 'x-oss-security-token:' + sts.tempSecurityToken + '\n'
  const sign = crypto.createHmac('sha1', sts.tempAccessKeySecret).update(['PUT', '', mime, date, ossHeaders + canonical].join('\n')).digest('base64')
  const url = sts.protocol + '://' + sts.endPoint + '/' + sts.uploadDir + sts.ossFileKey
  const put = await (deps.fetchImpl ?? fetch)(url, { method: 'PUT', headers: { 'content-type': mime, date, 'x-oss-security-token': sts.tempSecurityToken, authorization: 'OSS ' + sts.tempAccessKeyId + ':' + sign }, body: bytes, signal: AbortSignal.timeout(deps.timeoutMs ?? 60000) })
  if (!put.ok) throw new MoBookError('OSS 上传失败（HTTP ' + put.status + '）')
  return { url, key: sts.uploadDir + sts.ossFileKey, bucket: sts.bucket }
}

// uploadOss 公共读上传（图片、稿件等）。
export async function uploadOss(cred, bytes, name, mime = 'application/octet-stream', deps = {}) {
  return await ossPut(cred, bytes, name, mime, 0, deps)
}

// uploadPrivateOss 私有上传（录音音频，服务端按 audioOssUrl 去读）。
export async function uploadPrivateOss(cred, bytes, name, mime = 'application/octet-stream', deps = {}) {
  return await ossPut(cred, bytes, name, mime, 1, deps)
}

// fetchMySkills 已安装技能列表（id/code/name/product_id）。
export async function fetchMySkills(cred, deps = {}) {
  const bot = await ensureBot(cred, deps)
  const data = await apiCall(cred, '/skill-market/v1/public/get_my_skills', { bot_token: bot?.token }, deps)
  const items = Array.isArray(data?.installed_skill_list) ? data.installed_skill_list : []
  return items.map((item) => ({ id: Number(item.id), code: String(item.code ?? ''), name: String(item.name ?? ''), productId: Number(item.product_id) }))
}

// fetchOnlineProducts 列线上商品（技能/专家），用来按名字找到要临时安装的 productId。
export async function fetchOnlineProducts(cred, { productType = 'SKILL', pageSize = 100 } = {}, deps = {}) {
  const all = []
  for (let pageNo = 1; pageNo <= 5; pageNo += 1) {
    const data = await apiCall(cred, '/resource/getOnlineProductsV2', { productType, pageNo, pageSize }, deps)
    const list = Array.isArray(data?.list) ? data.list : []
    all.push(...list)
    if (!list.length || (Number(data?.totalCount) > 0 && all.length >= Number(data.totalCount))) break
  }
  return all.map((p) => ({ productId: Number(p.productId), name: String(p.name ?? ''), code: String(p.code ?? ''), price: Number(p.price) || 0, description: String(p.description ?? '') }))
}

// installProduct / uninstallProduct 装/卸载一个免费产品（技能或专家）。
// 任务行里带 productId 的技能类任务（ruleType 13/19）可以直接按它安装。
export async function installProduct(cred, productId, agentId = 13, deps = {}) {
  const bot = await ensureBot(cred, deps)
  return await apiCall(cred, '/trade/order/create', { botToken: bot?.token, userName: String(cred.name ?? cred.mobile ?? ''), productId: Number(productId), operationType: 'install', agentId: Number(agentId) }, deps)
}

export async function uninstallProduct(cred, productId, agentId = 13, deps = {}) {
  const bot = await ensureBot(cred, deps)
  return await apiCall(cred, '/trade/order/create', { botToken: bot?.token, userName: String(cred.name ?? cred.mobile ?? ''), productId: Number(productId), operationType: 'uninstall', agentId: Number(agentId) }, deps)
}

// searchMyLibraries 个人知识库列表。
export async function searchMyLibraries(cred, deps = {}) {
  const data = await apiCall(cred, '/resource/searchMyLibraries', { scope: 'PERSONAL', pageNo: 1, pageSize: 100, bizType: 'KNOWLEDGE', includeReviewLibrary: true, sortBy: 'UPDATED_TIME', sortOrder: 'DESC' }, deps)
  const list = Array.isArray(data) ? data : (data?.list ?? data?.records ?? [])
  return list.map((x) => ({ id: Number(x.id), name: String(x.name ?? x.libraryName ?? ''), bizType: String(x.bizType ?? '') }))
}

// skillChat 在普通会话里用 skills_scope 跑一个技能。
export async function skillChat(cred, { skill, text }, deps = {}) {
  const bot = await ensureBot(cred, deps)
  const created = await apiCall(cred, '/chat/new_session', { agent_id: 13, bot_id: bot.id, ...(bot.token ? { bot_token: bot.token } : {}), version: '1.0.1' }, deps)
  const sessionId = Number(created?.session_id)
  const scope = [{ addChat: true, url: '', name: skill.name, shortName: skill.name, bizType: 'skill', skillCode: skill.code, skillId: Number(skill.id) }]
  // 消息必须真的发出去：发失败就抛出来。
  // 原来这里吞掉错误 → 调用方（runner 的 settleSession）只会等到超时，
  // 日志里看不出「消息压根没发出去」，白等一轮还拿不到技能结果。
  await apiCall(cred, '/chat/chat_service', { session_id: sessionId, options: { thinking: 0, networking: 1 }, message: { text, human_input_text: text, files: [], skills_scope: scope, review_revision_scope: [], corpus: [] }, attachments: [], model: 'qwen4-max', agent_id: 13, agent_code: 'AI_CLAW', bot_id: bot.id, ...(bot.token ? { bot_token: bot.token } : {}) }, deps)
  return sessionId
}

// addNote 系列：图片笔记（children 带 ossUrl）。
export async function addImageNote(cred, ossUrl, title, deps = {}) {
  return await apiCall(cred, '/resource/addNote', { botToken: cred.botToken, title, contentType: 'IMAGE', children: [{ contentType: 'IMAGE', ossUrl, sort: 1 }], metadata: { noteScene: 'IMAGE_SUMMARY', editorFormat: 'lexical', editorVersion: 0 } }, deps)
}

// samplePdf 生成一份最小可用的 PDF（知识库只认文档；txt 会被判「解析失败」）。
export function samplePdf(text) {
  const lines = String(text).match(/.{1,60}/g) ?? ['test']
  const content = 'BT /F1 14 Tf 50 750 Td ' + lines.map((l, i) => (i ? '0 -20 Td ' : '') + '(' + l.replace(/[()\\]/g, '') + ') Tj').join(' ') + ' ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objs.length; i += 1) { offsets.push(Buffer.byteLength(out)); out += (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n' }
  const xref = Buffer.byteLength(out)
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n'
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n'
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF'
  return Buffer.from(out, 'latin1')
}

// ensurePersonalLibrary 找「个人知识库」，没有就按网页端「创建个人知识库」的同一个接口建一个。
// 账号可能从来没用过知识库（searchMyLibraries 只会返回审校专家知识库），此时把文件传进审校库提问，
// 平台不认「试用个人知识库」——必须是自己名下的 KNOWLEDGE 库。
export async function ensurePersonalLibrary(cred, deps = {}) {
  const mine = async () => (await searchMyLibraries(cred, deps)).filter((x) => x.bizType !== 'REVIEW_KNOWLEDGE')
  let libs = await mine().catch(() => [])
  if (libs.length) return libs[0]
  const name = '插件试用知识库'
  // 网页端创建：POST /resource/createUpdateLibrary {libraryId:null,name,cover,bizType:'KNOWLEDGE',pinned:false}
  // cover 不能为空（服务端报「封面不能为空」）：用一张 1px PNG 的 data URI 顶上。
  const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await apiCall(cred, '/resource/createUpdateLibrary', { libraryId: null, name, cover, bizType: 'KNOWLEDGE', pinned: false }, deps).catch(() => null)
  for (let i = 0; i < 6; i += 1) {
    libs = await mine().catch(() => [])
    const hit = libs.find((x) => x.name === name) ?? libs[0]
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

// addKnowledgeFile 把一段文本传进个人知识库。
export async function addKnowledgeFile(cred, libraryId, bytes, name, deps = {}) {
  // 服务器只解析 PDF/Word 这类文档；txt 会显示「解析失败」，任务也就不计数。
  const lower = String(name).toLowerCase()
  const mime = lower.endsWith('.pdf')
    ? 'application/pdf'
    : lower.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : lower.endsWith('.doc')
        ? 'application/msword'
        : 'text/plain'
  const up = await uploadOss(cred, bytes, name, mime, deps)
  return await apiCall(cred, '/resource/addContent', { botToken: cred.botToken, nodeRole: 'CONTENT', libraryId: Number(libraryId), parentId: 0, title: name, contentType: 'FILE', ossUrl: up.url }, deps)
}

// knowledgeChat 在知识库文件上发一次提问（「试用个人知识库」这种任务要的正是这一步）。
// 网页端知识库问答是一条 rag_chat 会话（NoteChatPanel 的 fj()：knowledge/file → {session_type:'rag_chat', rag_type:0}），
// 请求里还要带 implicitKnowledgeReferences 和 {lib_id, lib_name} 形状的 corpus；
// 之前按普通对话发（corpus 形状也不对），服务端不认这条「知识库问答」，任务永远不计数。
export async function knowledgeChat(cred, { contentId, libraryId, libName = '', text }, deps = {}) {
  const bot = await ensureBot(cred, deps)
  const created = await apiCall(cred, '/chat/new_session', { agent_id: 13, bot_id: bot.id, ...(bot.token ? { bot_token: bot.token } : {}), version: '1.0.1' }, deps)
  const sessionId = Number(created?.session_id)
  const corpus = [{ lib_id: Number(libraryId), lib_name: String(libName ?? '') }]
  const implicitKnowledgeReferences = [{ type: 'knowledge-file', id: Number(contentId), libraryId: Number(libraryId) }]
  // 网页端知识库问答靠这枚 message_tags 认成「知识库问答」：Pg() =
  // {chat_type:'knowledge_qa', library_id, content_id}，D5() 再用 chat_type 判定；
  // 少了它，服务端只当成普通对话，任务永远不计数。
  const messageTags = { chat_type: 'knowledge_qa', library_id: Number(libraryId), content_id: Number(contentId) }
  // 消息发失败要抛出来：吞掉的话调用方只能等到超时，看不出「消息没发出去」。
  await apiCall(cred, '/chat/chat_service', {
    session_id: sessionId,
    options: { thinking: 0, networking: 1 },
    message: { text, human_input_text: text, files: [], review_revision_scope: [], corpus },
    attachments: [],
    session_type: 'rag_chat',
    rag_type: 0,
    message_tags: messageTags,
    implicitKnowledgeReferences,
    agent_id: 13,
    agent_code: 'AI_CLAW',
    bot_id: bot.id,
    ...(bot.token ? { bot_token: bot.token } : {}),
  }, { ...deps, timeoutMs: Math.max(Number(deps?.timeoutMs) || 0, 120000) })
  return sessionId
}

// createCronTask 用聊天让 Agent 建定时任务（网页同款模板消息）。
export async function createCronTask(cred, text, deps = {}) {
  const bot = await ensureBot(cred, deps)
  const created = await apiCall(cred, '/chat/new_session', { agent_id: 13, bot_id: bot.id, ...(bot.token ? { bot_token: bot.token } : {}), version: '1.0.1' }, deps)
  const sessionId = Number(created?.session_id)
  // 同上：消息发失败要抛出来，否则建定时任务会「看起来成功了其实没建」。
  await apiCall(cred, '/chat/chat_service', { session_id: sessionId, options: { thinking: 0, networking: 1 }, message: { text, human_input_text: text, files: [], review_revision_scope: [], corpus: [] }, attachments: [], model: 'qwen4-max', agent_id: 13, agent_code: 'AI_CLAW', bot_id: bot.id, ...(bot.token ? { bot_token: bot.token } : {}) }, deps)
  return sessionId
}
// ---- 模型目录 ----

// fetchGatewayModelIds 用客户端 API Key 读 model-gateway 的 OpenAI 模型目录。
export async function fetchGatewayModelIds(cred, deps = {}) {
  const apiKey = String(cred?.apiKey ?? '')
  if (!apiKey) throw new MoBookError('没有 API Key')
  const res = await (deps.fetchImpl ?? fetch)(MODEL_GATEWAY + '/models', {
    headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 20000),
  })
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new MoBookError('墨宝网关拒绝了这份 API Key（HTTP ' + res.status + '）'), { signIn: 'expired' })
  }
  if (!res.ok) throw new MoBookError('模型目录读取失败（HTTP ' + res.status + '）')
  const payload = await res.json().catch(() => null)
  const list = Array.isArray(payload?.data) ? payload.data : []
  return list.map((m) => String(m?.id ?? '')).filter(Boolean)
}
// ---- 语音：TTS / ASR ----

// speak 走客户端同款 TTS 网关 POST /v3/tts/create：
// body 是 {model, text_prompt, references?, audio_config}，回 {audio(base64)|url, duration}。
// 回来的字节按请求的 format 标 MIME：原来不论 wav/mp3 都写 audio/mpeg，wav 会被客户端当 mp3 解。
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/L16', opus: 'audio/ogg', ogg: 'audio/ogg' }
export async function speak(cred, { text, voice, speed, format = 'mp3', sampleRate } = {}, deps = {}) {
  const apiKey = String(cred?.apiKey ?? '')
  if (!apiKey) throw new MoBookError('语音合成需要客户端 API Key（dcg-…）')
  const prompt = String(text ?? '').trim()
  if (!prompt) throw new MoBookError('朗读文本为空')
  if (prompt.length > 3000) throw new MoBookError('朗读文本不能超过 3000 字')
  const rate = Number(speed)
  const mime = AUDIO_MIME[String(format).toLowerCase()] ?? 'audio/mpeg'
  const body = {
    model: 'seed-audio-1.0',
    text_prompt: prompt,
    ...(voice ? { references: [{ speaker: String(voice) }] } : {}),
    audio_config: {
      format: String(format),
      sample_rate: Number(sampleRate) || 48000,
      pitch_rate: 0,
      speech_rate: Number.isFinite(rate) && rate > 0 ? Math.round((rate - 1) * 50) : 0,
      loudness_rate: 0,
    },
  }
  const res = await (deps.fetchImpl ?? fetch)(MEDIA_GATEWAY_V3 + '/tts/create', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 180000),
  })
  const text2 = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text2)
  } catch {
    throw new MoBookError('语音网关返回的不是 JSON（HTTP ' + res.status + '）')
  }
  if (!res.ok) throw new MoBookError(payload?.error?.message ?? payload?.message ?? '语音合成失败（HTTP ' + res.status + '）')
  if (typeof payload?.audio === 'string' && payload.audio) {
    return { bytes: Buffer.from(payload.audio, 'base64'), contentType: mime, duration: Number(payload.duration) || 0 }
  }
  if (typeof payload?.url === 'string' && payload.url) {
    const audio = await (deps.fetchImpl ?? fetch)(payload.url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 60000) })
    if (!audio.ok) throw new MoBookError('语音文件下载失败（HTTP ' + audio.status + '）')
    return { bytes: Buffer.from(await audio.arrayBuffer()), contentType: mime, duration: Number(payload.duration) || 0 }
  }
  throw new MoBookError('语音网关没有返回音频')
}
// fetchRecordingQuota 读录音时长配置（网页“60 分钟免费，超出计费”那块）。
// 返回 freeDurationSeconds/remainingFreeSeconds/usedDurationSeconds、
// exchangePoints + exchangeSeconds（超出后每 N 秒扣多少积分）。
export async function fetchRecordingQuota(cred, deps = {}) {
  const data = await apiCall(cred, '/resource/getRecordingDurationConfig', {}, deps)
  return {
    freeDurationSeconds: Number(data?.freeDurationSeconds) || 0,
    remainingFreeSeconds: Number(data?.remainingFreeSeconds) || 0,
    usedDurationSeconds: Number(data?.usedDurationSeconds) || 0,
    totalDurationSeconds: Number(data?.totalDurationSeconds) || 0,
    remainingTotalSeconds: Number(data?.remainingTotalSeconds) || 0,
    exchangePoints: Number(data?.exchangePoints) || 0,
    exchangeSeconds: Number(data?.exchangeSeconds) || 0,
    billingEnabled: data?.billingEnabled === true,
    continueOnInsufficientPoints: data?.continueOnInsufficientPoints === true,
    description: String(data?.description ?? ''),
  }
}
// fetchRecordingUsage 录音时长的“记录”：网页没有单独接口，记录在积分流水里
// （desc 录音时长消耗、bizId recording:<contentId>:<session>:to<seconds>），5 积分 = 1 分钟。
export async function fetchRecordingUsage(cred, deps = {}) {
  const balance = await fetchBalance(cred, deps)
  const page = await fetchFlowPages(cred, { flowQueryType: 2, pageSize: 200, accountId: balance.accountId }, deps)
  const rows = (page.records ?? []).filter((row) => String(row.desc ?? '').includes('录音时长消耗'))
  const points = rows.reduce((n, row) => n + Number(row.pointAmount || 0), 0)
  return {
    records: rows.length,
    points,
    truncated: page.truncated === true,
    items: rows.map((row) => ({
      time: row.gmtCreated,
      points: Number(row.pointAmount || 0),
      bizId: String(row.bizId ?? ''),
    })),
  }
}

// recordingTranscriptJson 生成录音段落 JSON（服务端按它解析转写；音频文件只是陪衬）。
// 结构来自网页端校验器：{provider, paragraphs:[{text,startMs,endMs,sentenceId,isFinal,speakerId}]}。
export function recordingTranscriptJson(text, durationMs, { provider = 'tencent', speakerId = '1' } = {}) {
  const lines = String(text ?? '').split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean)
  const list = lines.length ? lines : ['测试录音']
  const tail = Math.max(1000, Number(durationMs) || list.length * 2000)
  const step = Math.max(1, Math.floor(tail / list.length))
  const paragraphs = list.map((line, i) => ({
    text: line,
    startMs: i * step,
    endMs: Math.min(tail, (i + 1) * step),
    sentenceId: 'tencent:' + (i + 1),
    isFinal: true,
    speakerId: String(speakerId),
  }))
  return JSON.stringify({ provider, paragraphs })
}

// recordNoteViaTranscript 直接造一条能处理的录音笔记：
// addNote → start → 私有上传 mp3 + 段落 JSON → update(audioOssUrl/realtimeParagraphsUrl) → stop。
// 服务端读段落 JSON 生成正文，不再依赖客户端推流。
export async function recordNoteViaTranscript(cred, { text, title, durationMs }, deps = {}) {
  const tts = await speak(cred, { text, format: 'mp3', sampleRate: 16000 }, deps)
  const ms = Math.max(1000, Number(durationMs) || Math.round(Number(tts.duration || 3) * 1000))
  const note = await apiCall(cred, '/resource/addNote', { botToken: cred.botToken, title, contentType: 'AUDIO', durationMs: 0, metadata: { noteScene: 'DICTATION', durationMs: 0, titleManuallyEdited: false, editorFormat: 'lexical', editorVersion: 0 } }, deps)
  const contentId = Number(note?.id ?? note?.contentId)
  if (!contentId) return contentId
  const session = await startRealtimeAsr(cred, { provider: 'tencent', contentId, format: 'pcm', sampleRate: 16000, sourceLanguage: 'cn', requestId: 'rec-' + Date.now(), diarizationEnabled: true, diarizationSpeakerCount: 0 }, deps)
  try {
    const audio = await uploadPrivateOss(cred, tts.bytes, 'recording-' + contentId + '.mp3', 'audio/mpeg', deps)
    const paras = await uploadPrivateOss(cred, Buffer.from(recordingTranscriptJson(text, ms)), 'recording-' + contentId + '.tr.json', 'application/json', deps)
    await apiCall(cred, '/media/updateRealtimeTranscription', {
      sessionId: session.sessionId,
      taskId: session.taskId,
      contentId,
      audioOssUrl: audio.key,
      realtimeParagraphsUrl: paras.key,
      displayDurationMs: ms,
    }, deps)
  } finally {
    await apiCall(cred, '/media/pauseRealtimeTranscription', { sessionId: session.sessionId, provider: 'tencent' }, deps).catch(() => null)
    await apiCall(cred, '/media/stopRealtimeTranscription', { contentId, sessionId: session.sessionId }, deps).catch(() => null)
  }
  return contentId
}

// recordNoteViaTranscriptWithSession 同上，但把 {contentId, sessionId} 一起带回来，
// runner 用它登记录音会话账本（异常退出后下次启动按账本停会话）。
// 无论后续哪一步抛错，转写会话都会在这里 stop；返回后调用方只需负责笔记与账本。
// onSession({contentId, sessionId}) 在转写会话建立瞬间回调：调用方（runner）用它把会话
// 记进本地账本，进程中途被杀时下次启动仍能按账本停会话，不漏计费。
export async function recordNoteViaTranscriptWithSession(cred, { text, title, durationMs, onSession }, deps = {}) {
  const tts = await speak(cred, { text, format: 'mp3', sampleRate: 16000 }, deps)
  const ms = Math.max(1000, Number(durationMs) || Math.round(Number(tts.duration || 3) * 1000))
  const note = await apiCall(cred, '/resource/addNote', { botToken: cred.botToken, title, contentType: 'AUDIO', durationMs: 0, metadata: { noteScene: 'DICTATION', durationMs: 0, titleManuallyEdited: false, editorFormat: 'lexical', editorVersion: 0 } }, deps)
  const contentId = Number(note?.id ?? note?.contentId)
  if (!contentId) return null
  const session = await startRealtimeAsr(cred, { provider: 'tencent', contentId, format: 'pcm', sampleRate: 16000, sourceLanguage: 'cn', requestId: 'rec-' + Date.now(), diarizationEnabled: true, diarizationSpeakerCount: 0 }, deps)
  try {
    if (typeof onSession === 'function') {
      try { onSession({ contentId, sessionId: String(session.sessionId ?? '') }) } catch {}
    }
    const audio = await uploadPrivateOss(cred, tts.bytes, 'recording-' + contentId + '.mp3', 'audio/mpeg', deps)
    const paras = await uploadPrivateOss(cred, Buffer.from(recordingTranscriptJson(text, ms)), 'recording-' + contentId + '.tr.json', 'application/json', deps)
    await apiCall(cred, '/media/updateRealtimeTranscription', {
      sessionId: session.sessionId,
      taskId: session.taskId,
      contentId,
      audioOssUrl: audio.key,
      realtimeParagraphsUrl: paras.key,
      displayDurationMs: ms,
    }, deps)
    return { contentId, sessionId: String(session.sessionId ?? '') }
  } finally {
    await apiCall(cred, '/media/pauseRealtimeTranscription', { sessionId: session.sessionId, provider: 'tencent' }, deps).catch(() => null)
    await apiCall(cred, '/media/stopRealtimeTranscription', { contentId, sessionId: session.sessionId }, deps).catch(() => null)
  }
}

// listScheduledTasks 列账号的定时任务（/scheduled-task/v1/tasks/list_tasks，items[]）。
export async function listScheduledTasks(cred, deps = {}) {
  const bot = await ensureBot(cred, deps)
  const data = await apiCall(cred, '/scheduled-task/v1/tasks/list_tasks', { bot_id: bot.id, bot_token: bot.token, limit: 100, offset: 0 }, deps)
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.list) ? data.list : []
  return items
    .map((t) => ({ taskId: String(t.task_id ?? t.id ?? ''), title: String(t.title ?? t.name ?? t.desc ?? t.summary ?? '') }))
    .filter((t) => t.taskId)
}

// deleteScheduledTask 删一个定时任务（任务完成后不留残余）。
export async function deleteScheduledTask(cred, taskId, deps = {}) {
  const bot = await ensureBot(cred, deps)
  return await apiCall(cred, '/scheduled-task/v1/tasks/delete_task', { task_id: String(taskId), bot_token: bot.token, bot_id: bot.id }, deps)
}

// cleanupStaleScheduledTasks 删掉 runner 之前建过的定时任务。runner 建任务时在提示词里
// 指定专属名称「墨宝插件选题灵感日报」（见 task-runner.mjs），清扫只按这个名称匹配，
// 不会碰用户自己建的同主题定时任务。
export async function cleanupStaleScheduledTasks(cred, { match = /墨宝插件选题灵感日报/ } = {}, deps = {}) {
  const tasks = await listScheduledTasks(cred, deps).catch(() => [])
  let deleted = 0
  for (const task of tasks) {
    if (!match.test(task.title)) continue
    try { await deleteScheduledTask(cred, task.taskId, deps); deleted += 1 } catch {}
  }
  return { deleted, total: tasks.length }
}

// stopStaleRecordings 只停「插件自己登记过的」实时转写会话：runner 每开一条录音会话，
// 先把 {contentId, sessionId} 记进账号目录的 recording-sessions.json 账本（见 task-runner.mjs），
// 启动清扫按这份账本停会话，停掉的销账、失败的保留待下次重试。
// 不再按积分流水反推会话——那会误停用户此刻正在网页上进行的合法录音。
export async function stopStaleRecordings(cred, { sessions = [] } = {}, deps = {}) {
  const seen = new Set()
  const results = []
  let stopped = 0
  let failed = 0
  for (const item of Array.isArray(sessions) ? sessions : []) {
    const contentId = Number(item?.contentId)
    const sessionId = String(item?.sessionId ?? '').trim()
    if (!contentId || !sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    try {
      await apiCall(cred, '/media/stopRealtimeTranscription', { contentId, sessionId }, deps)
      stopped += 1
      results.push({ contentId, sessionId, stopped: true })
    } catch {
      failed += 1
      results.push({ contentId, sessionId, stopped: false })
    }
  }
  return { stopped, failed, sessions: seen.size, results }
}

// ---- 语音识别（实时转写） ----

// startRealtimeAsr 向墨宝申请一条实时转写会话。provider 选 tencent 时返回
// wss://asr.cloud-rtc.com/... 的签名地址（tingwu 那条被平台禁用）。
export async function startRealtimeAsr(cred, { provider = 'tencent', contentId = 1, ...rest } = {}, deps = {}) {
  const data = await apiCall(cred, '/media/startRealtimeTranscription', { contentId, provider, ...rest }, deps)
  const streamUrl = String(data?.streamUrl ?? '').trim()
  if (!streamUrl) throw new MoBookError('墨宝没有返回实时转写地址')
  return { ...data, streamUrl }
}

// transcribePcm16k 把 16k/单声道/16bit 的 PCM 推给腾讯实时转写，收到 final 结束。
// 协议：每帧 1280 字节（40ms）二进制；结束发 JSON 指令 {type:'end'}；文本在 sentences.text / result.voice_text_str。
// 超时按音频长度缩放（发送间隔 20ms ≈ 2 倍实时）；超时、或连接关闭时还没收到 final（哪怕帧已全部发完）一律显式报错，不静默返回半截文本。
// 无论成功失败都必须 stop 服务端会话，否则它一直按分钟计费。
export async function transcribePcm16k(cred, pcm, { deps = {}, timeoutMs, frameBytes = 1280, paceMs = 20 } = {}) {
  const session = await startRealtimeAsr(cred, {}, deps)
  const frames = Math.ceil(pcm.length / frameBytes)
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : Math.max(120000, frames * paceMs + 60000)
  let stopped = false
  const stopServer = () => {
    if (stopped) return
    stopped = true
    try {
      apiCall(cred, '/media/stopRealtimeTranscription', {
        contentId: Number(session.contentId) || 1,
        sessionId: String(session.sessionId ?? ''),
      }, deps).catch(() => {})
    } catch {}
  }
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(session.streamUrl)
    const texts = []
    let settled = false
    let gotFinal = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      stopServer()
      fn(value)
    }
    const finish = () => settle(resolve, { text: texts.join(''), session })
    const fail = (message) => settle(reject, new MoBookError(message))
    const timer = setTimeout(() => fail('实时转写超时（' + Math.round(budgetMs / 1000) + 's）：已收 ' + texts.length + ' 句，音频约 ' + Math.round(pcm.length / 32000) + ' 秒，未完整转写'), budgetMs)
    ws.onerror = () => fail('实时转写连接失败')
    ws.onclose = () => {
      // 帧发完也可能只是服务端提前断开：没收到 final 就算转写未完成，显式报错。
      if (gotFinal) finish()
      else fail('实时转写连接提前关闭，转写未完成')
    }
    ws.onmessage = (message) => {
      let data = null
      try {
        data = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8'))
      } catch {
        return
      }
      if (data?.code && Number(data.code) !== 0) {
        fail('腾讯实时转写失败（code ' + data.code + '）')
        return
      }
      const isFinalSentence =
        Number(data?.sentences?.sentence_type) === 1 || Number(data?.result?.slice_type) === 2
      const piece = String(data?.sentences?.text ?? data?.result?.voice_text_str ?? '').trim()
      if (piece && isFinalSentence && texts[texts.length - 1] !== piece) texts.push(piece)
      if (Number(data?.final) === 1) { gotFinal = true; finish() }
    }
    ws.onopen = async () => {
      try {
        for (let offset = 0; offset < pcm.length; offset += frameBytes) {
          ws.send(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length)))
          if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs))
        }
        ws.send(JSON.stringify({ type: 'end' }))
      } catch {
        fail('实时转写音频发送失败')
      }
    }
  })
}

// ---- 音频解码：WAV 自己解，其它交给 ffmpeg ----

// parseMultipartAudio 从 OpenAI multipart 请求里取出音频文件与文件名。
export function parseMultipartAudio(contentType, body) {
  const match = String(contentType ?? '').match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = match ? (match[1] || match[2]) : ''
  if (!boundary) throw new MoBookError('转写请求不是 multipart')
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const marker = Buffer.from('--' + boundary)
  let start = buffer.indexOf(marker)
  while (start >= 0) {
    const headerStart = start + marker.length + 2
    const headerEnd = buffer.indexOf('\r\n\r\n', headerStart)
    if (headerEnd < 0) break
    const headers = buffer.subarray(headerStart, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const next = buffer.indexOf(marker, dataStart)
    const dataEnd = next >= 0 ? next - 2 : buffer.length
    const filename = (headers.match(/filename="([^"]*)"/i) ?? [])[1] ?? ''
    const partType = (headers.match(/content-type:\s*([^\r\n]+)/i) ?? [])[1]?.trim() ?? ''
    if (filename || /^audio\//i.test(partType)) {
      return { bytes: buffer.subarray(dataStart, Math.max(dataStart, dataEnd)), filename, contentType: partType }
    }
    start = next
  }
  throw new MoBookError('转写请求里没有音频文件')
}

// parseWavToPcm16k 解 WAV（PCM16）并重采样到 16k 单声道。
export function parseWavToPcm16k(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }
  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length))
    if (id === 'fmt ') {
      if (body.length < 16) return null
      format = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      }
    } else if (id === 'data') {
      data = body
    }
    offset += 8 + size + (size % 2)
  }
  if (!format || !data || format.audioFormat !== 1 || format.bitsPerSample !== 16) return null
  const channels = Math.max(1, format.channels)
  const frames = Math.floor(data.length / (2 * channels))
  const mono = new Int16Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((i * channels + c) * 2)
    mono[i] = Math.round(sum / channels)
  }
  const rate = format.sampleRate
  if (rate === 16000) return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength)
  const ratio = rate / 16000
  const outFrames = Math.max(1, Math.floor(frames / ratio))
  const out = new Int16Array(outFrames)
  for (let i = 0; i < outFrames; i += 1) {
    const src = i * ratio
    const lo = Math.floor(src)
    const hi = Math.min(frames - 1, lo + 1)
    const frac = src - lo
    out[i] = Math.round(mono[lo] * (1 - frac) + mono[hi] * frac)
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}
// ---- 本机墨宝客户端（桌面端）登录态 ----

// 墨宝桌面端是 DSH（Cordis）壳：数据目录默认 ~/.mobook-harness，
// mobook.json 存账号（botToken/userId/appId/domainId）与environment，
// .credentials.yaml 的 refs.MOBOOK_API_KEY 是网关 API Key（dcg-…）。
// 有了它就能直接走 model-gateway 的 OpenAI 兼容接口，不必再自己登录。
export function clientHome(env = process.env) {
  if (env.MOBOOK_HARNESS_HOME) return String(env.MOBOOK_HARNESS_HOME)
  return join(homedir(), '.mobook-harness')
}

function parseApiKeyFromYaml(text) {
  const match = String(text ?? '').match(/^\s*MOBOOK_API_KEY:\s*(\S+)\s*$/m)
  return match ? match[1] : ''
}

// readClientState 读本机客户端的账号与 API Key；读不到 mobook.json 就报“先登录客户端”。
export async function readClientState({ home, readFileImpl = readFile, env = process.env } = {}) {
  // 显式给了目录就只认它；否则依次试 MOBOOK_HARNESS_HOME → ~/.mobook-harness → DSH_HOME。
  const candidates = home
    ? [String(home)]
    : [clientHome(env), env.DSH_HOME ? String(env.DSH_HOME) : ''].filter(Boolean)
  let base = candidates[0]
  let meta = null
  let lastPath = join(base, 'mobook.json')
  for (const candidate of candidates) {
    const metaPath = join(candidate, 'mobook.json')
    try {
      meta = JSON.parse(await readFileImpl(metaPath, 'utf8'))
      base = candidate
      lastPath = metaPath
      break
    } catch {
      lastPath = metaPath
    }
  }
  if (!meta) {
    throw new MoBookError('本机没有找到墨宝客户端数据（' + lastPath + '）。请先打开并登录书灵墨宝桌面端')
  }
  let apiKey = ''
  try {
    apiKey = parseApiKeyFromYaml(await readFileImpl(join(base, '.credentials.yaml'), 'utf8'))
  } catch {}
  const account = meta?.account ?? {}
  // hardware 是桌面端自己算的设备身份（hardware-v1），复用态下插件原样沿用，不自己造。
  const rawHardware = meta?.hardware
  const hardware = rawHardware && typeof rawHardware.fingerprint === 'string' && rawHardware.fingerprint.trim()
    ? {
        fingerprint: rawHardware.fingerprint.trim(),
        ...(typeof rawHardware.fingerprintVersion === 'string' ? { fingerprintVersion: rawHardware.fingerprintVersion } : {}),
        ...(typeof rawHardware.uuid === 'string' ? { uuid: rawHardware.uuid } : {}),
        ...(typeof rawHardware.sn === 'string' ? { sn: rawHardware.sn } : {}),
      }
    : null
  return {
    home: base,
    apiKey,
    botToken: String(account.botToken ?? '').trim(),
    uid: String(account.userId ?? '').trim(),
    appId: Number(account.appId) || 0,
    domainId: Number(account.domainId) || DOMAIN_ID,
    wsUrl: String(account.wsUrl ?? ''),
    environment: String(meta?.environment ?? ''),
    apiGatewayBaseUrl: String(meta?.servers?.apiGatewayBaseUrl ?? ''),
    appVersion: String(meta?.appVersion ?? ''),
    hardware,
  }
}

// appIdForApi 把桌面 appId 映射成接口用的 _appId（客户端 README 的约定）：
// 100 → 40；110 → Windows 200 / macOS 210；其它原样。
export function appIdForApi(appId, platform = process.platform) {
  const n = Number(appId)
  if (n === 100) return 40
  if (n === 110) return platform === 'darwin' ? 210 : 200
  return n
}

// exchangeUserToken 用客户端的 botToken 换一个用户令牌（14 天，等同网页 _tk）。
export async function exchangeUserToken(state, deps = {}) {
  if (!state?.botToken) throw new MoBookError('客户端登录态里没有 botToken')
  const cred = { tk: '', uid: state.uid, orgId: ORG_ID, appId: appIdForApi(state.appId), platform: 'desktop' }
  const data = await apiCall(cred, '/organization/queryUserTokenByBotTokenV2', { botToken: state.botToken }, deps)
  const token = String(data?.token ?? '').trim()
  if (!token) throw new MoBookError('墨宝没有返回用户令牌')
  return {
    token,
    expiresAt: data?.expirationDate ? Number(data.expirationDate) * 1000 : 0,
    expirationSeconds: Number(data?.expirationSeconds) || 0,
  }
}

// 桌面客户端作用域：API Key 是按 _appId 分作用域的。
// 网页端 40 下，新账号取不到 key（status -1）；同一账号在桌面端 200（Windows）/210（macOS）下就有。
// 桌面客户端自己存的是 110，接口侧要用映射后的 200/210。
export const DESKTOP_CLIENT_APP_ID = 110
export function desktopScope(cred) {
  return { ...cred, appId: appIdForApi(DESKTOP_CLIENT_APP_ID), platform: 'desktop' }
}

// fetchApiKeyConfig 读账号的模型 / API Key 配置（网页桌面壳里调的就是 getApiKeyConfigDetail）。
// 不带 deviceId 时返回账号级配置；带一个服务端不认识的 deviceId 会被拒（code 2022「请先申请api key」），
// 所以插件只在这里取账号级 key，绝不为了拿 key 去伪造/新建设备。
// 先按网页作用域取；新账号在 40 下没有 key，就换桌面作用域（200/210）再取一次。
// 返回 { apiKey, baseUrl, api, defaultModel, models, userId, status }。
export async function fetchApiKeyConfig(cred, deps = {}, device = null) {
  const deviceBody = device?.deviceId ? { deviceId: String(device.deviceId), ...(device.botName ? { botName: String(device.botName) } : {}) } : {}
  let data = null
  try {
    data = await apiCall(cred, '/organization/getApiKeyConfigDetail', deviceBody, deps)
  } catch (error) {
    if (String(error?.code) !== '2022') throw error
  }
  let apiKey = String(data?.openClawProviders?.apiKey ?? '').trim()
  if (!apiKey) {
    data = await apiCall(desktopScope(cred), '/organization/getApiKeyConfigDetail', deviceBody, deps)
    apiKey = String(data?.openClawProviders?.apiKey ?? '').trim()
  }
  const provider = data?.openClawProviders ?? {}
  if (!apiKey) throw new MoBookError('墨宝没有返回 API Key（该账号可能还没开通）')
  return {
    apiKey,
    baseUrl: String(provider.baseUrl ?? '').trim(),
    api: String(provider.api ?? '').trim(),
    defaultModel: String(data?.defaultModel ?? '').trim(),
    models: Array.isArray(provider.models) ? provider.models : [],
    userId: Number(data?.userId) || 0,
    status: Number(data?.status) || 0,
  }
}

// generateImage 走客户端同款图片网关 POST /v3/images/generations。
// 注意：请求体没有 model 字段，网关按 API Key 的配置挑模型；
// size 是 1K / 1.5K / 2K 这类档位，image 可以给参考图（URL/Base64，最多 10 张）。
export async function generateImage(cred, { model, prompt, size, image, responseFormat = 'url' } = {}, deps = {}) {
  const apiKey = String(cred?.apiKey ?? '')
  if (!apiKey) throw new MoBookError('图片生成需要客户端 API Key（dcg-…）')
  const body = { prompt: String(prompt ?? '').trim(), response_format: responseFormat }
  if (model) body.model = String(model)
  if (size) body.size = String(size)
  if (image) body.image = image
  if (!body.prompt) throw new MoBookError('图片提示词不能为空')
  const res = await (deps.fetchImpl ?? fetch)(MEDIA_GATEWAY_V3 + '/images/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 180000),
  })
  const text = await res.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    throw new MoBookError('图片网关返回的不是 JSON（HTTP ' + res.status + '）')
  }
  if (!res.ok) throw new MoBookError(payload?.error?.message ?? '图片生成失败（HTTP ' + res.status + '）')
  return { model: String(payload?.model ?? ''), images: Array.isArray(payload?.data) ? payload.data : [] }
}
// ---- 手机号 + 短信验证码登录 ----

// sendSmsCode 给手机号发验证码。这一步不需要登录态：只有签名和 appKey。
export async function sendSmsCode(mobileNo, deps = {}) {
  const phone = String(mobileNo ?? '').replace(/\D/g, '')
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new MoBookError('手机号格式不对：要 11 位大陆手机号')
  // 桌面端客户端 appId=100→接口 40，故发码用 web 应用作用域（与桌面端一致）。
  const data = await apiCall({ tk: '', uid: '' }, '/user/generateCode', { mobileNo: phone }, deps)
  return { mobileNo: phone, data }
}

// 邀请渠道（channelCode）。网页登录页把地址栏的 ?channelCode=（或 ?channel=）读出来，
// 作为 channel 字段随 /user/login 一起提交；服务端在**新账号首次登录**时把账号记到
// 这个渠道名下（已有账号再传也不会改归属，所以对老用户没有副作用）。
// 插件默认带上这个邀请码；要换人，设环境变量 MOBOOK_INVITE_CHANNEL；
// 设成空串（MOBOOK_INVITE_CHANNEL=）就是不带。
export const INVITE_CHANNEL = 'yunkmzpZ'

// inviteChannelOf 收敛渠道码：只留字母、数字、下划线、短横线，长度 2-64。
export function inviteChannelOf(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return /^[A-Za-z0-9_-]{2,64}$/.test(text) ? text : ''
}

// defaultInviteChannel 读环境变量覆盖，没设就用上面的插件常量。
export function defaultInviteChannel() {
  const fromEnv = process.env?.MOBOOK_INVITE_CHANNEL
  if (fromEnv === undefined) return INVITE_CHANNEL
  return inviteChannelOf(fromEnv)
}

// newUserFlag 找“这是新注册账号”的标记：墨宝在不同层用过几种字段名。
export function newUserFlag(data) {
  const hit = [data?.isNewUser, data?.is_new_user, data?.newUser, data?.new_user, data?.registerUser, data?.isRegister]
    .find((value) => value !== undefined && value !== null)
  if (hit === undefined) return false
  return hit === true || hit === 1 || hit === '1' || String(hit).toLowerCase() === 'true'
}

// loginBySms 用验证码换登录态，返回 { token, uid, channel, isNewUser }。
// channel 默认就是插件的邀请渠道（见 INVITE_CHANNEL），传 '' 可以这一次不带。
// 与桌面端一致：带 deviceToken 时服务端登记设备会话，不替换网页会话；
// 不带 deviceToken 才会替换同账号的网页会话（网页端同时只有一个）。
export async function loginBySms(mobileNo, verificationCode, options = {}) {
  const { channel = defaultInviteChannel(), deviceToken = '', ...deps } = options ?? {}
  const phone = String(mobileNo ?? '').replace(/\D/g, '')
  const code = String(verificationCode ?? '').replace(/\s/g, '')
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new MoBookError('手机号格式不对：要 11 位大陆手机号')
  if (!/^\d{4,8}$/.test(code)) throw new MoBookError('验证码格式不对：一般是 4-6 位数字')
  const invite = inviteChannelOf(channel)
  const body = {
    mobileNo: phone,
    verificationCode: code,
    ...(invite ? { channel: invite } : {}),
    // 客户端登录会带 deviceToken：服务端按设备登记会话，不再顶掉网页端。
    ...(deviceToken ? { deviceToken: String(deviceToken) } : {}),
  }
  // 与桌面端完全一致：appId=100→接口 40 + deviceToken。deviceToken 使服务端登记设备会话，不顶网页端。
  const data = await apiCall({ tk: '', uid: '' }, '/user/login', body, deps)
  const token = String(data?.token ?? '').trim()
  const uid = String(data?.userId ?? '').trim()
  if (!token) throw new MoBookError('登录成功但墨宝没有返回 token')
  return { token, uid, channel: invite, isNewUser: newUserFlag(data) }
}

// ---- 计费倍率（墨滴/Token） ----

// fetchModelShow 读网页端模型选择器用的那份列表：每个模型的显示名与计费倍率。
// multiplier 就是“每个 Token 扣多少墨滴”。
export async function fetchModelShow(cred, { agentId, deps = {} } = {}) {
  const query = agentId != null ? { agentId: Number(agentId) } : {}
  const data = await apiCall(cred, '/modelgw/v1/model-show', query, { ...deps, method: 'GET' })
  const list = Array.isArray(data) ? data : []
  const out = new Map()
  for (const m of list) {
    const id = String(m?.modelCode ?? '').trim()
    if (!id) continue
    const rawMultiplier = m?.multiplier
    const multiplier = Number(rawMultiplier)
    out.set(id, {
      id,
      name: String(m?.name ?? '').trim(),
      multiplier:
        rawMultiplier != null && String(rawMultiplier).trim() !== '' && Number.isFinite(multiplier) && multiplier >= 0
          ? multiplier
          : null,
      description: String(m?.description ?? '').trim(),
      sortNo: Number(m?.sortNo) || 0,
      isDefault: m?.isDefault === true,
    })
  }
  return out
}

// ---- 墨滴消耗（流水） ----

const FLOW_QUERY = { spend: 2, income: 1 }

function flowRecords(data) {
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : []
  return list
}

// flowAmount 取一条流水的墨滴数：pointAmount 是正数，方向由 flowQueryType 表示。
function flowAmount(record) {
  const raw = record?.pointAmount ?? record?.point ?? record?.amount ?? record?.points ?? record?.changeAmount
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

// flowTimeMs 把流水时间换成毫秒：gmtCreated 是秒级时间戳，也可能直接是 ISO 字符串。
function flowTimeMs(record) {
  const raw = record?.gmtCreated ?? record?.createTime ?? record?.createdAt ?? record?.create_time
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000
  const text = String(raw ?? '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return n > 1e12 ? n : n * 1000
  }
  const parsed = wallClockMs(text)
  return Number.isFinite(parsed) ? parsed : 0
}

// isSpendRecord 判断一条流水是不是支出。服务端按 flowQueryType 过滤时字段会带上；
// 兼容没有该字段的响应，调用方可以说明“这批本来就是支出查询的结果”。
function isSpendRecord(record, { assumeSpend = false } = {}) {
  if (Number(record?.flowQueryType) === FLOW_QUERY.spend) return true
  if (Number(record?.direction) === 2) return true
  if (Number(record?.pointType) === 2) return true
  if (flowAmount(record) < 0) return true
  return assumeSpend
}

// fetchFlowPages 逐页读墨滴流水。flowQueryType：0 = 全部，1 = 获得，2 = 消耗。
// accountId 是墨滴账户自己的 id（/point/getUserPointAccount 的 data.id），不是用户 id。
export async function fetchFlowPages(cred, { flowQueryType = 0, accountId = 0, pageSize = 200, maxPages = 12 } = {}, deps = {}) {
  const id = Number(accountId) || Number(cred?.accountId) || 0
  const records = []
  let totalCount = 0
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const data = await apiCall(
      cred,
      '/point/getUserPointFlowInfo',
      { pageSize, pageNo, flowQueryType, accountId: id },
      deps,
    )
    const rows = flowRecords(data)
    totalCount = Number(data?.totalCount) || totalCount
    records.push(...rows)
    // 服务端的 hasNext 不可靠（明明还有页也返回 false），只按行数判断。
    if (!rows.length || (totalCount > 0 && records.length >= totalCount)) break
  }
  // 触顶时显式标记截断：调用方（用量卡）不能把近似数字当精确值。
  const truncated = totalCount > records.length || (totalCount === 0 && records.length >= maxPages * pageSize)
  return { records, totalCount: totalCount || records.length, truncated }
}

// fetchLedgerTotals 汇总墨滴账本：未过期批次的发放总额、每笔还剩多少、最近一次到期。
// 用量卡的口径很直接：已用 = 未过期批次的发放总和 − 账户当前余额。余额来自
// /point/getUserPointAccount，它恰好等于各未过期批次剩余量之和，所以进度条与卡片天然对账。
// 支出流水只用来算「每个批次还剩多少」，不再做周期/月度之类的二次推断——
// 那套口径（cycleStart / 今日 / 本月）曾经算过，但卡片从没读过，只会让文档和实现对不上。
export async function fetchLedgerTotals(cred, { accountId = 0, pageSize = 200 } = {}, deps = {}) {
  const [income, spend] = await Promise.all([
    fetchFlowPages(cred, { flowQueryType: FLOW_QUERY.income, accountId, pageSize }, deps),
    fetchFlowPages(cred, { flowQueryType: FLOW_QUERY.spend, accountId, pageSize }, deps),
  ])
  // 收入按批次记账：每条收入有自己的到期时间，支出记录带 batchId，
  // 所以“哪个池子还剩多少”可以直接算出来。没有 batchId 的收入不进账本（无法归属到某一笔）。
  const batches = new Map()
  for (const record of income.records) {
    const batchId = Number(record?.batchId) || 0
    if (!batchId) continue
    batches.set(batchId, {
      batchId,
      amount: Math.abs(flowAmount(record)),
      desc: String(record?.desc ?? record?.remark ?? '').trim() || '墨滴',
      status: Number(record?.batchPointStatus),
      createdAt: flowTimeMs(record) || 0,
      expiresAt: record?.batchPointExpiryDate ? Number(record.batchPointExpiryDate) * 1000 : 0,
      spent: 0,
    })
  }
  // 支出只记到它所属的批次上；batchId 缺失或不在本次读取范围内的，不归属。
  for (const record of spend.records) {
    if (!isSpendRecord(record, { assumeSpend: true })) continue
    const batch = batches.get(Number(record?.batchId) || 0)
    if (batch) batch.spent += Math.abs(flowAmount(record))
  }
  const nowMs = Date.now()
  const isExpired = (batch) => batch.status === -1 || (batch.expiresAt > 0 && batch.expiresAt <= nowMs)
  // 过期批次的额度与它对应的消耗都整体剔除：别让过期积分把分母撑大。
  const activeBatches = [...batches.values()]
    .map((batch) => ({ ...batch, remaining: batch.amount - batch.spent }))
    .filter((batch) => !isExpired(batch))
  const incomeTotal = activeBatches.reduce((n, batch) => n + batch.amount, 0)
  // 有效期只有一天左右的是“今日积分”（墨宝加油站/签到类奖励），不算进长期池子的“充值/礼包”里。
  const isDaily = (batch) =>
    batch.createdAt > 0 && batch.expiresAt > batch.createdAt &&
    batch.expiresAt - batch.createdAt <= 36 * 3600 * 1000
  const pools = activeBatches
    .filter((batch) => batch.remaining > 0 && !isDaily(batch))
    .sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity))
  // 最近一次「真的会有墨滴作废」的到期：只在还有剩余量的未过期批次里取最早的一个
  // （已经用光的批次到时不会损失什么，拿它做提示会显示「0 墨滴过期」）。
  const futureWithLeft = activeBatches
    .filter((batch) => Number.isFinite(batch.expiresAt) && batch.expiresAt > nowMs && batch.remaining > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt)
  const nearestExpiry = futureWithLeft[0]?.expiresAt || 0
  // 那一刻会作废的剩余量：卡片提示写作「N 墨滴 将于 <时间> 过期」（runsOutAt/runsOut 语义）。
  const expiringAtNearest = nearestExpiry
    ? futureWithLeft
      .filter((batch) => batch.expiresAt === nearestExpiry)
      .reduce((n, batch) => n + Math.max(0, batch.remaining), 0)
    : 0
  const earliestCreated = activeBatches
    .map((batch) => batch.createdAt)
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((x, y) => x - y)[0] || 0
  return {
    income: incomeTotal,
    nearestExpiry,
    expiringAtNearest,
    earliestCreated,
    expiredCount: [...batches.values()].filter(isExpired).length,
    pools,
    truncated: income.truncated || spend.truncated,
  }
}

// beijingToday 取北京日期前缀。
export function beijingToday(nowMs = Date.now()) {
  const date = new Date(nowMs + 8 * 3600 * 1000)
  return date.toISOString().slice(0, 10)
}

// beijingTimeLabel 把时间戳写成北京时间标签：同年 "12-23 09:37"，跨年带年份。
export function beijingTimeLabel(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const value = new Date(ms + 8 * 3600 * 1000)
  const now = new Date(nowMs + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const year = value.getUTCFullYear() === now.getUTCFullYear() ? '' : value.getUTCFullYear() + '-'
  return year + pad(value.getUTCMonth() + 1) + '-' + pad(value.getUTCDate()) + ' ' + pad(value.getUTCHours()) + ':' + pad(value.getUTCMinutes())
}

// beijingDateOf 把一个毫秒时间戳换成北京日期前缀。
export function beijingDateOf(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

// ---- 智能体会话（对话） ----

// promptFromMessages 把 OpenAI 的 messages 压成一段给墨宝智能体的文本：
// 智能体只有“一问一答”的会话入口，没有 tools/多令牌/多模态通道。
export function promptFromMessages(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = String(m?.role ?? 'user')
    const content = typeof m?.content === 'string' ? m.content : textOfParts(m?.content)
    if (!content.trim()) continue
    if (role === 'system') parts.push('（系统设定）' + content.trim())
    else if (role === 'assistant') parts.push('（助手先说过的）' + content.trim())
    else if (role === 'tool') continue
    else parts.push(content.trim())
  }
  if (parts.length === 1) return parts[0]
  return parts.join('\n\n')
}

function textOfParts(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

// botRowsOf 统一解析 getBotListV3：服务端两种形状都出现过（裸数组 / 包一层 {data:[…]}），
// 三个调用点（listBots / ensureDeviceBot / ensureBot）必须认同一种，否则一个活一个死。
export function botRowsOf(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
  return list
    .filter((row) => row?.id)
    .map((row) => ({
      id: Number(row.id),
      token: String(row.token ?? ''),
      name: String(row.name ?? ''),
      appId: Number(row.appId) || 0,
      clawType: String(row.clawType ?? ''),
    }))
}

// listBots 只读账号已有的客户端列表（不带 deviceId，不会新建任何设备）。
export async function listBots(cred, deps = {}) {
  const data = await apiCall(cred, '/organization/getBotListV3', { userId: Number(cred.uid) }, deps)
  return botRowsOf(data)
}

// ensureDeviceBot 用 {deviceId, botName} 调 getBotListV3：设备未登记时服务端会为这台客户端建 bot，
// 返回 botToken。只给“手机号登录到客户端”用；其它登录方式仍然不传 deviceId、不建 bot。
export async function ensureDeviceBot(cred, { deviceId, botName } = {}, deps = {}) {
  const body = { userId: Number(cred.uid) }
  if (deviceId) body.deviceId = String(deviceId)
  if (botName) body.botName = String(botName)
  const data = await apiCall(cred, '/organization/getBotListV3', body, deps)
  const bot = botRowsOf(data)[0] ?? null
  // 登记设备可能建出新的 bot，缓存要作废（否则 60 秒内还拿到旧的）。
  clearBotCache(cred?.uid)
  if (!bot) return null
  return { id: bot.id, token: bot.token, name: bot.name }
}

export async function ensureBot(cred, deps = {}) {
  // 客户端列表的第一次元素就是本作用域的 bot（web 40 下是 harness bot，桌面 200 下是设备 bot）。
  // 一次对话要用它两次（建会话前 + 删会话时），外加若干辅助调用——每次都问一遍服务端是白花的往返。
  // 故按 (uid, appId, platform) 缓存一小会儿：作用域不同就是不同的 bot，键里必须带上。
  // 失效与变更：bot 列表只在登录/登记设备时才会变（见 ensureDeviceBot），
  // 缓存 60 秒足够覆盖一次对话，又不至于让「刚登记的客户端」迟迟用不上。
  const key = botCacheKey(cred)
  const hit = botCache.get(key)
  if (hit && Date.now() - hit.at < BOT_CACHE_TTL) return hit.bot
  const data = await apiCall(cred, '/organization/getBotListV3', { userId: Number(cred.uid) }, deps)
  const bot = botRowsOf(data)[0] ?? null
  if (!bot) {
    // 没有 bot 时不缓存：服务端可能刚建好，下一次就该拿得到。
    botCache.delete(key)
    return null
  }
  const value = { id: bot.id, token: bot.token, name: bot.name }
  botCache.set(key, { bot: value, at: Date.now() })
  return value
}

// botCache 是进程内的 bot 缓存：键是 (uid, appId, platform)，值是 {bot, at}。
const botCache = new Map()
const BOT_CACHE_TTL = 60 * 1000

function botCacheKey(cred) {
  return [String(cred?.uid ?? ''), Number(cred?.appId) || 0, String(cred?.platform ?? 'web')].join('|')
}

// clearBotCache 在登录/登记设备后清掉缓存：那时 bot 列表可能变了。
export function clearBotCache(uid = null) {
  if (!uid) {
    botCache.clear()
    return
  }
  const id = String(uid)
  for (const key of [...botCache.keys()]) {
    if (key.startsWith(id + '|')) botCache.delete(key)
  }
}

export async function createSession(cred, { model, agentId, bot }, deps = {}) {
  const body = { agent_id: agentId, model, ...(bot?.id ? { bot_id: bot.id } : {}) }
  const data = await apiCall(cred, '/chat/new_session', body, deps)
  const sessionId = Number(data?.session_id)
  if (!Number.isFinite(sessionId) || sessionId <= 0) throw new MoBookError('墨宝没有创建出会话')
  return sessionId
}

export async function sendChatMessage(cred, { sessionId, model, agentId, bot, text }, deps = {}) {
  const message = { text, human_input_text: text, files: [], review_revision_scope: [], corpus: [] }
  const body = {
    session_id: sessionId,
    options: { thinking: 0, networking: 1 },
    message,
    attachments: [],
    model,
    agent_id: agentId,
    agent_clone_code: '',
    agent_code: 'AI_CLAW',
    ...(bot?.id ? { bot_id: bot.id } : {}),
    ...(bot?.token ? { bot_token: bot.token } : {}),
  }
  return await apiCall(cred, '/chat/chat_service', body, deps)
}

export async function listMessages(cred, { sessionId, agentId, bot, limit = 20 }, deps = {}) {
  const body = { session_id: sessionId, last_message_id: 0, limit, agent_id: agentId, ...(bot?.id ? { bot_id: bot.id } : {}) }
  const data = await apiCall(cred, '/chat/message_list_by_session_id', body, deps)
  return Array.isArray(data) ? data : []
}

// assistantText 读一条回复的正文与收尾标记。
// 墨宝把一次回答拆成多段回复（retry_index 递增，message_id 递增）：
// 有正文的那段 message_content.text 是内容，所有段都标 is_finish: 1；
// 真正的收尾是额外多出的一条 state='final'、正文为空的行。
// 所以正文取“最后一条有字的段”，收尾看 final 行。
export function assistantText(rows) {
  const replies = (Array.isArray(rows) ? rows : [])
    .filter((m) => Number(m?.message_type) === 2)
    .sort((a, b) => (Number(a?.message_id) || 0) - (Number(b?.message_id) || 0))
  if (!replies.length) return { text: '', final: false }
  let text = ''
  for (const row of replies) {
    let parsed = null
    try {
      parsed = JSON.parse(String(row?.message_content ?? '{}'))
    } catch {
      parsed = null
    }
    const piece = String(parsed?.text ?? '')
    if (piece.trim()) text = piece
  }
  const final = replies.some((row) => String(row?.state ?? '') === 'final')
  return { text, final }
}

export async function deleteSession(cred, sessionId, deps = {}) {
  try {
    const bot = await ensureBot(cred, deps).catch(() => null)
    await apiCall(cred, '/chat/delete', { session_id: sessionId, ...(bot?.token ? { bot_token: bot.token } : {}) }, { ...deps, timeoutMs: 8000 })
    return true
  } catch {
    return false
  }
}

// ask 走完整链路：建会话 -> 发消息 -> 轮询回复 -> 删会话。
// onDelta 在每次文本变长时收到“新增的这一段”，方便转成 SSE。
export async function ask(cred, { model, prompt, agentId = DEFAULT_AGENT_ID, signal, pollMs = 700, timeoutMs = 180000, onDelta = null }, deps = {}) {
  // 把取消信号传进各次接口请求；删会话（finally）不带信号，确保取消后仍清理。
  const d = signal ? { ...deps, signal } : deps
  const bot = await ensureBot(cred, d).catch(() => null)
  const sessionId = await createSession(cred, { model, agentId, bot }, d)
  const startedAt = Date.now()
  let emitted = ''
  let finalAt = 0
  try {
    await sendChatMessage(cred, { sessionId, model, agentId, bot, text: prompt }, d)
    for (;;) {
      if (signal?.aborted) throw new MoBookError('对话已取消')
      if (Date.now() - startedAt > timeoutMs) throw new MoBookError('墨宝这次回答超时了（' + Math.round(timeoutMs / 1000) + 's）')
      await new Promise((r) => setTimeout(r, pollMs))
      const rows = await listMessages(cred, { sessionId, agentId, bot }, d)
      const { text, final } = assistantText(rows)
      if (text.length > emitted.length && onDelta) {
        onDelta(text.slice(emitted.length), text)
      }
      if (text.length > emitted.length) emitted = text
      if (final && !finalAt) finalAt = Date.now()
      // final 行先到、正文还没落库时等一小会儿，避免把空回答当成结果。
      if (finalAt && (emitted.length > 0 || Date.now() - finalAt > 20000)) {
        return { text: emitted, sessionId, elapsedMs: Date.now() - startedAt }
      }
    }
  } finally {
    await deleteSession(cred, sessionId, deps)
  }
}