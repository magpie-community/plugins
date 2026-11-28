import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as api from './api.mjs'
import { humanGapMs } from './task-plan.mjs'
import { automatableTasks, claimDaily, taskDoneCount, taskProgressText, writeDoneAt } from './task-state.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// settleSession 等一条会话真正收到回答再返回：专家会话/技能会话在回答落地前删掉，
// 服务端不会记这次使用（这就是「使用审校专家3次」一直不计数、清理又太早的根因）。
export async function settleSession(cred, sessionId, agentId = 13, timeoutMs = 30000, { apiImpl = api, sleepImpl = sleep } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const rows = await apiImpl.listMessages(cred, { sessionId, agentId, limit: 20 })
      const { text } = apiImpl.assistantText(rows)
      if (String(text ?? '').trim()) return true
    } catch {}
    await sleepImpl(3000)
  }
  return false
}
// 临时产品的卸载可能被服务端「服务连接中，请稍后再试」临时拒掉：退避重试；
// 仍失败就记进 uninstall-pending.json，下一次运行开头补卸——否则产品会一直留在账号里。
const UNINSTALL_PENDING_FILE = 'uninstall-pending.json'
export function readPendingUninstalls(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, UNINSTALL_PENDING_FILE), 'utf8'))
    return Array.isArray(raw?.productIds) ? raw.productIds.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []
  } catch { return [] }
}
export function writePendingUninstalls(stateDir, ids) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
  try {
    if (!list.length) fs.rmSync(path.join(stateDir, UNINSTALL_PENDING_FILE), { force: true })
    else fs.writeFileSync(path.join(stateDir, UNINSTALL_PENDING_FILE), JSON.stringify({ productIds: list, at: new Date().toISOString() }))
  } catch {}
}
export async function uninstallWithRetry(cred, productId, { apiImpl = api, sleepImpl = sleep, append = () => {}, backoff = [2000, 6000] } = {}) {
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try {
      await apiImpl.uninstallProduct(cred, productId)
      append('uninstall', 'ok', { productId, attempt: attempt + 1 })
      return true
    } catch (e) {
      if (attempt === backoff.length) {
        append('uninstall', 'failed', { productId, error: String(e?.message ?? e), attempts: attempt + 1 })
        return false
      }
      await sleepImpl(backoff[attempt])
    }
  }
  return false
}
// 凭据由插件交进来（环境变量或 per-run 文件），这样手机号 / 粘贴 _tk 登录的账号也能跑任务。
// 缺失或不完整时终止，不能回退读本机客户端而误用另一账号。
function credFromObject(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const tk = String(parsed.tk ?? '').trim()
  const uid = String(parsed.uid ?? '').trim()
  if (!tk || !uid) return null
  return {
    tk,
    uid,
    apiKey: String(parsed.apiKey ?? '').trim(),
    botToken: String(parsed.botToken ?? '').trim(),
    orgId: Number(parsed.orgId) || api.ORG_ID,
    appId: Number(parsed.appId) || api.APP_ID,
    platform: String(parsed.platform ?? 'web'),
  }
}

export function credFromEnv(env = process.env) {
  try {
    const raw = env.MOBOOK_TASK_CRED
    if (!raw) return null
    return credFromObject(JSON.parse(raw))
  } catch {
    return null
  }
}

// credFromFile 读插件写下的 per-run 凭据文件，读到就删。
// 走 WMI/任务计划拉起的 runner 拿不到宿主的环境变量，只能靠这个文件。
export function credFromFile(filePath) {
  if (!filePath) return null
  let raw
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return null }
  try { fs.unlinkSync(filePath) } catch {}
  try { return credFromObject(JSON.parse(raw)) } catch { return null }
}

// runGrowthPlan 是 runner 的全部编排：启动清扫 → 读任务 → join → 规划动作（从易到难）→
// 逐条「复查状态 → 运行 → 核验 → 领奖 → 清理 → 等真人最快时间」→ 收尾补领 → 写 done.json。
// 只在 CLI 直跑时（node task-runner.mjs <log>）由下面的守卫调用；测试直接调用本函数并注入 apiImpl。
// HANDLED_RULES 是 runner 真有动作能做的规则类型：12 专家创作 / 13 技能 / 14 定时任务 /
// 15 桌面端对话 / 17 审校专家 3 次 / 18 使用 3 个专家 / 19 使用 3 个技能 / 22 知识库 / 23 图片·录音笔记。
// 取自网页端自己的规则枚举（UseExpert:12, UseSkill:13, UseScheduleTask:14, DesktopChat:15,
// MiniProgramChat:16, UseExpertTimes:17, UseMultipleExpert:18, UseMultipleSkill:19,
// ReviewAnnotation:20, Knowledge:22, KnowledgeSecondary:23）——平台没有第 25 条规则。
// 不变量：task-state 的 AUTOMATABLE_RULES ⊆ HANDLED_RULES。
// 少了哪一条，规则就会被算进「任务 x/y」却没人做它，done.json 永远写不出来，
// 每天的签到都会重跑一遍、白花墨滴（这条不变量由 task-runner.test.mjs 守住）。
export const HANDLED_RULES = [12, 13, 14, 15, 17, 18, 19, 22, 23]

export async function runGrowthPlan({ cred, logPath, heartbeatPath = '', apiImpl = api, random = Math.random, sleepImpl = sleep } = {}) {
  const stateDir = path.dirname(logPath)
  fs.mkdirSync(stateDir, { recursive: true })
  // 心跳：每 15 秒刷新一次 run.heartbeat 的时间戳。
  // 父进程靠它判断「这个 runner 是不是还活着」（见 index.mjs 的 taskRunAlive）：
  // 不用 PID 判活是因为 PID 会被回收再分配，会把别人的进程当成自己的 runner。
  // 进程被杀时 finally 不执行，心跳自然停更，过期后父进程就知道可以再起一个。
  let heartbeatTimer = null
  const stopHeartbeat = () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null } }
  if (heartbeatPath) {
    const beat = () => { try { fs.writeFileSync(heartbeatPath, String(Date.now())) } catch {} }
    beat()
    heartbeatTimer = setInterval(beat, 15000)
    heartbeatTimer.unref?.()
  }
  const append = (step, status, detail = {}) => {
    try { fs.appendFileSync(logPath, JSON.stringify({ time: new Date().toISOString(), step, status, detail }) + '\n') } catch {}
  }
  // 老凭据里可能没存 API Key（登录时还没补），这里按桌面作用域补一次，录音/TTS 要用。
  if (!cred.apiKey) {
    try { const cfg = await apiImpl.fetchApiKeyConfig(cred); cred.apiKey = cfg.apiKey } catch {}
  }
  // 录音会话账本：本插件每开一条实时转写会话先记下 {contentId, sessionId}，
  // 异常退出后下一次运行的启动清扫按这份账本停会话（不再按积分流水反推，避免误停用户自己的录音）。
  const ledgerPath = path.join(stateDir, 'recording-sessions.json')
  const readLedger = () => {
    try { const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); return Array.isArray(raw?.sessions) ? raw.sessions : [] } catch { return [] }
  }
  const recordLedger = (contentId, sessionId) => {
    if (!contentId || !sessionId) return
    const sessions = readLedger()
    if (!sessions.some((s) => s.sessionId === sessionId)) sessions.push({ contentId: Number(contentId), sessionId: String(sessionId), at: new Date().toISOString() })
    try { fs.writeFileSync(ledgerPath, JSON.stringify({ sessions })) } catch {}
  }
  const clearLedger = (contentId, sessionId) => {
    const sessions = readLedger().filter((s) => !(String(s.sessionId) === String(sessionId) && (!contentId || Number(s.contentId) === Number(contentId))))
    try { fs.writeFileSync(ledgerPath, JSON.stringify({ sessions })) } catch {}
  }
  // 启动先停掉账本里登记的残留录音会话（上次异常退出会一直计费：5 分/分钟，免费 60 分钟后开始扣）。
  // 只停插件自己登记过的会话；停掉的销账，失败的保留到下次运行重试。
  const staleSessions = readLedger()
  if (staleSessions.length) {
    const stale = await apiImpl.stopStaleRecordings(cred, { sessions: staleSessions }).catch(() => null)
    if (stale) {
      append('cleanup', 'stale-recordings', { stopped: stale.stopped, failed: stale.failed, sessions: stale.sessions })
      for (const row of stale.results ?? []) {
        if (row.stopped) clearLedger(row.contentId, row.sessionId)
      }
      if (readLedger().length === 0) { try { fs.rmSync(ledgerPath, { force: true }) } catch {} }
    }
  }
  // 上次运行可能留下插件专属名称的定时任务，这里先清掉（只按专属标题匹配，不碰用户自建任务）。
  const staleCron = await apiImpl.cleanupStaleScheduledTasks(cred).catch(() => null)
  if (staleCron) append('cleanup', 'stale-scheduled-tasks', staleCron)
  // 上一次运行没卸掉的临时产品，这里补卸（只碰本插件自己装过、记下来的 id）。
  const pendingUninstalls = readPendingUninstalls(stateDir)
  if (pendingUninstalls.length) {
    const left = []
    for (const productId of pendingUninstalls) {
      if (!(await uninstallWithRetry(cred, productId, { apiImpl, sleepImpl, append }))) left.push(productId)
    }
    writePendingUninstalls(stateDir, left)
    append('cleanup', 'pending-uninstall', { done: pendingUninstalls.length - left.length, left: left.length })
  }
  const artifacts = { sessions: [], contents: [] }
  const createdCronTasks = []
  let tasks = await apiImpl.fetchTasks(cred)
  // 只按可自动化的任务算进度/完成；审校批注、小程序对话这类人工任务不挡缓存。
  const automatable = automatableTasks(tasks)
  const total = automatable.length
  const done = taskDoneCount(tasks)
  append('start', 'running', { total, done, progress: taskProgressText(tasks) })
  // 先看今天是否已经全部做完：做完就直接结束并记缓存，不再产生任何动作。
  if (done >= total) {
    writeDoneAt(stateDir, { done, total })
    append('finish', 'all-done', { done, total })
    // 这条早退路径也在 finally 之外：心跳与锁要在这里自己收掉，否则当天会一直留着一把锁。
    stopHeartbeat()
    if (heartbeatPath) {
      try { fs.rmSync(path.join(path.dirname(heartbeatPath), 'run.lock'), { force: true }) } catch {}
    }
    return { done, total, cached: true }
  }
  for (const task of tasks) {
    if (task.status !== 'todo') continue
    try { await apiImpl.joinTask(cred, task.activityId); append('join', 'ok', { id: task.activityId, title: task.title }) } catch (e) { append('join', 'failed', { id: task.activityId, error: String(e?.message ?? e) }) }
  }
  tasks = await apiImpl.fetchTasks(cred).catch(() => tasks)
  const experts = await apiImpl.fetchExperts(cred).catch(() => new Map())
  const skills = await apiImpl.fetchMySkills(cred).catch(() => [])
  const actions = []
  // 每个动作规划时针对的任务 activityId：执行前复查这些任务是否仍是「待做」。
  const plannedTaskIds = new Map()
  const planFor = (name, list) => { plannedTaskIds.set(name, list.map((t) => t.activityId).filter((id) => Number.isFinite(id))) }
  const unclaimed = (types) => tasks.some((t) => types.includes(t.ruleType) && t.status !== 'claimed')
  // 某些规则由「动作组」覆盖、没有单条 planFor（规则 19 = 使用3个技能），单独登记，
  // 免得兜底逻辑把它们误报成 uncovered（曾经把规则 19 也点了名，纯日志噪音）。
  const coveredRules = new Set()
  const pendingTitle = (re) => tasks.some((t) => t.status !== 'claimed' && re.test(String(t.title ?? '')))
  // 技能/专家产品安装记录（轮末统一卸载）
  const installedProducts = []
  const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  // ── 按难度从易到难：先能一键完成的，再单条对话，再装产品/多发几条。──

  // 1. 签到：一次点击
  // 2. 活跃地图：一条短对话（已活跃就跳过，省墨滴）
  // 这两条与插件的签到线程（magpie 宿主进程）做的是同一件事，是跨进程的重复劳动：
  // 两边各签一次、各发一条活跃对话 → 墨滴花两倍。故用一把跨进程锁（task-state 的
  // acquireDailyLock）让「今天已经有人做过」的那边直接跳过。
  actions.push(['checkin', async () => {
    // 签到由服务端管（一天只让领一次），这里只做一次尝试：
    // 插件的签到线程可能已经领过了，服务端会拒，多一次请求但不会多花钱。
    const act = await apiImpl.checkinActivity(cred)
    if (!act) return 'no-activity'
    if (act.claimedToday) return 'already'
    await apiImpl.claimCheckin(cred, act.activityId)
    return 'checked-in'
  }])

  actions.push(['activity', async () => {
    // 活跃对话是真正花钱的那一步（服务端不管一天几次），插件的签到线程与这个 runner
    // 是两个进程，都做一遍就是双倍墨滴。用当天的标记决定谁来做：
    //   - 拿不到 → 今天已经有人做了（消息发出去了），跳过；
    //   - 拿得到 → 做；**只有真的发出去了**才留下标记，失败要释放（今天还能重试）。
    const claim = claimDaily(stateDir, 'activity')
    if (!claim) return { active: true, skipped: true, by: 'plugin' }
    try {
      if (await apiImpl.isActiveToday(cred).catch(() => false)) return { active: true, skipped: true }
      const out = await apiImpl.recordActivityChat(cred)
      if (!out?.active) claim.release() // 对话发出去了但没被标记成活跃 → 标记不认，明天还能再试
      return { active: out.active, model: out.model }
    } catch (error) {
      claim.release()
      throw error
    }
  }])

  // 3. 图片笔记：纯接口，传一张图建 IMAGE 笔记
  if (unclaimed([23]) && pendingTitle(/图片/)) {
    planFor('image-note', tasks.filter((t) => t.ruleType === 23 && t.status !== 'claimed' && /图片/.test(String(t.title ?? ''))))
    actions.push(['image-note', async () => {
      const up = await apiImpl.uploadOss(cred, Buffer.from(ONE_PX, 'base64'), 'note-' + Date.now() + '.png', 'image/png')
      const note = await apiImpl.addImageNote(cred, up.url, '图片笔记 ' + Date.now())
      const nid = Number(note?.id ?? note?.contentId)
      if (nid) artifacts.contents.push(nid)
      return nid
    }])
  }

  // 3.5 录音笔记：要求「5 分钟以上」，用段落 JSON 直接造（不推流、不计费），再点一次智能总结。
  // 开转写会话前先记进账本，正常结束后销账；异常退出时下次启动的清扫按账本停会话。
  if (unclaimed([23]) && pendingTitle(/录音/)) {
    planFor('recording-note', tasks.filter((t) => t.ruleType === 23 && t.status !== 'claimed' && /录音/.test(String(t.title ?? ''))))
    actions.push(['recording-note', async () => {
      let result = null
      let used = null
      try {
        result = await apiImpl.recordNoteViaTranscriptWithSession(cred, {
          text: '这是一段用于完成成长计划的录音笔记。今天讨论人工智能在教育领域的应用，包括个性化学习、智能评估与语音交互三个方向，并提醒关注数据隐私与算法公平。',
          title: '录音笔记 ' + Date.now(),
          durationMs: 330000,
          // 会话建立瞬间记账：进程若在转写中途被杀，下次启动的清扫仍能按账本停会话。
          onSession: (s) => { used = s; recordLedger(s.contentId, s.sessionId) },
        })
      } finally {
        // 正常结束（API 内部已 stop 会话）或中途抛错（API 的 finally 已 stop）都销账；
        // 只有进程被硬杀（finally 不执行）账本才保留到下次启动清扫。
        if (used) clearLedger(used.contentId, used.sessionId)
      }
      if (!result) return null
      const cid = result.contentId
      artifacts.contents.push(cid)
      try {
        const libs = await apiImpl.searchMyLibraries(cred)
        const lib = libs.find((x) => x.bizType === 'NOTE') || libs[0]
        await apiImpl.apiCall(cred, '/resource/getNoteLiveSummarySnapshot', { orgId: 1000, userId: Number(cred.uid), libraryId: Number(lib?.id) || 0, contentId: cid, requestId: 'sum-' + Date.now() })
      } catch {}
      return cid
    }])
  }
  // 4. 个人知识库：传一份 PDF，再在库内提一次问
  if (unclaimed([22])) {
    planFor('knowledge', tasks.filter((t) => t.ruleType === 22 && t.status !== 'claimed'))
    actions.push(['knowledge', async () => {
    // 必须用自己名下的个人知识库：没有就建一个（审校专家知识库不算，「试用个人知识库」不认它）。
    const lib = await apiImpl.ensurePersonalLibrary(cred).catch(() => null)
    if (!lib) return null
    const added = await apiImpl.addKnowledgeFile(cred, lib.id, apiImpl.samplePdf('AI and Education. This is a test document for the personal knowledge base. Artificial intelligence is changing education.'), 'task-' + Date.now() + '.pdf')
    const cid = Number(added?.id ?? added?.contentId)
    if (cid) artifacts.contents.push(cid)
    if (cid) {
      // 上传后服务端要先解析这份 PDF，解析没完成就提问，这条问答不会被算成「知识库问答」。
      await sleepImpl(8000)
      const sid = await apiImpl.knowledgeChat(cred, { contentId: cid, libraryId: lib.id, libName: lib.name, text: '这段内容讲了什么？用一句话概括。' })
      artifacts.sessions.push(sid)
      await settleSession(cred, sid, undefined, undefined, { apiImpl, sleepImpl })
    }
    return cid
    }])
  }

  // 5. 桌面端对话：一条消息
  if (unclaimed([15])) {
    planFor('desktop', tasks.filter((t) => t.ruleType === 15 && t.status !== 'claimed'))
    actions.push(['desktop', async () => { const sid = await apiImpl.completeDesktopTask(cred); if (sid) artifacts.sessions.push(sid); return sid }])
  }

  // 6. 定时任务：建一个（要填名称/时间/提示词）。名称是插件专属的「墨宝插件选题灵感日报」，
  // 清扫（cleanupStaleScheduledTasks）只按这个名称匹配，不会误删用户自建的同主题任务。
  if (unclaimed([14])) {
    planFor('cron', tasks.filter((t) => t.ruleType === 14 && t.status !== 'claimed'))
    actions.push(['cron', async () => {
    // 定时任务也是脚本产物：记下这次新建的 task_id，核验领奖后连同会话一起删掉。
    const before = new Set((await apiImpl.listScheduledTasks(cred).catch(() => [])).map((t) => t.taskId))
    const sid = await apiImpl.createCronTask(cred, '创建一个名为「墨宝插件选题灵感日报」的定时任务：每日上午十点依据最新最热图书数据、热点新闻以及政策信息，给我推送选题灵感日报。')
    artifacts.sessions.push(sid)
    for (let k = 0; k < 6; k += 1) {
      await sleepImpl(3000)
      const now = await apiImpl.listScheduledTasks(cred).catch(() => [])
      const added = now.filter((t) => !before.has(t.taskId))
      if (added.length) { for (const t of added) createdCronTasks.push(t.taskId); break }
    }
    return { sid, tasks: createdCronTasks.slice() }
    }])
  }

  // ── 技能类（比对话麻烦：要先装/找技能，再调一次）──
  const usedSkills = new Set()
  const skillTextFor = (task) => {
    const t = String(task.title ?? '') + ' ' + String(task.description ?? '')
    if (/参考文献/.test(t)) return '请核查这条参考文献的格式：张三. 图书编校实务[M]. 北京: 人民邮电出版社, 2020.'
    if (/对校|比对/.test(t)) return '请对比两份文档差异：A 写了今天天气很好，B 写了今天天气不错。'
    if (/选题/.test(t)) return '请生成一份图书选题报告：主题是人工智能与教育。'
    if (/小红书/.test(t)) return '请写一篇小红书图文笔记：主题是一本关于人工智能与教育的书。'
    return '请用这个技能处理一份示例：请按技能说明给出一次完整处理结果。'
  }
  const PRODUCT_HINTS = [
    [/参考文献/, [/reference.*reviser/i, /参考文献/]],
    [/对校|比对|文档对比/, [/pdf-compare/i, /对比/]],
    [/选题/, [/book-proposal/i, /选题/]],
  ]
  const skillWords = (task) => {
    const t = String(task.title ?? '') + ' ' + String(task.description ?? '')
    const hit = PRODUCT_HINTS.find(([re]) => re.test(t))
    return hit ? hit[1] : []
  }
  const findSkill = (task) => {
    const words = skillWords(task)
    return skills.find((s) =>
      (task.productId > 0 && s.productId === task.productId) ||
      (task.productName && String(s.name).includes(task.productName)) ||
      words.some((re) => re.test(String(s.name))),
    ) ?? null
  }

  const resolveProductId = async (task) => {
    const words = skillWords(task)
    const products = await apiImpl.fetchOnlineProducts(cred).catch(() => [])
    // 只挑免费产品：临时安装是要下安装单的，绝不能误装付费产品。
    // 这条闸门对「按名字找产品」和「任务自带 productId」两条路都要管：
    // 任务给的 id 同样可能指向付费产品，照装就会真的下付费订单。
    const free = products.filter((p) => p.price === 0)
    const isFree = (productId) => {
      const hit = products.find((p) => Number(p.productId) === Number(productId))
      // 查不到价格（接口失败/分页没覆盖到）时不放行：宁可这次不做，也不冒险装付费的。
      return !!hit && Number(hit.price) === 0
    }
    if (task.productId > 0) {
      if (isFree(task.productId)) return task.productId
      append('install', 'skipped-paid', { productId: task.productId, title: task.title })
      return 0
    }
    if (!words.length) return 0
    const hit =
      free.find((p) => words.some((re) => re.test(p.name))) ??
      free.find((p) => words.some((re) => re.test(p.description)))
    return hit?.productId ?? 0
  }
  const ensureSkill = async (task) => {
    let skill = findSkill(task)
    if (skill) return skill
    const productId = await resolveProductId(task)
    if (!(productId > 0)) return null
    try {
      await apiImpl.installProduct(cred, productId)
      installedProducts.push(productId)
      for (let attempt = 0; attempt < 5 && !skill; attempt += 1) {
        const fresh = await apiImpl.fetchMySkills(cred).catch(() => skills)
        for (const s of fresh) if (!skills.some((x) => x.code === s.code)) skills.push(s)
        skill = fresh.find((s) => s.productId === productId) ?? findSkill(task)
        if (!skill) await sleepImpl(2000)
      }
      append('install', skill ? 'ok' : 'missing', { productId, name: skill?.name ?? task.title })
    } catch (e) {
      append('install', 'failed', { productId, error: String(e?.message ?? e) })
    }
    return skill
  }

  // 7. 技能类任务（ruleType 13）
  const skillTasks = tasks.filter((t) => t.status !== 'claimed' && t.ruleType === 13)
  // 在规划阶段先预留已经匹配到的技能；ruleType 19 后续据此挑不同技能，避免顺序执行时才登记导致重复。
  for (const task of skillTasks) {
    const matched = findSkill(task)
    if (matched) usedSkills.add(matched.code)
  }
  for (const task of skillTasks) {
    const name = 'skill:' + (task.productName || ('task' + task.activityId))
    planFor(name, [task])
    actions.push([name, async () => {
      const skill = await ensureSkill(task)
      if (!skill) return 'no-skill'
      if (!usedSkills.has(skill.code)) usedSkills.add(skill.code)
      const sid = await apiImpl.skillChat(cred, { skill, text: skillTextFor(task) })
      artifacts.sessions.push(sid)
      await settleSession(cred, sid, undefined, undefined, { apiImpl, sleepImpl })
      return { skill: skill.name, sid }
    }])
  }

  // 8. 使用3个技能：已装的补足 3 个；一个都没有就临时装免费技能
  if (unclaimed([19])) {
    const planSkill = async (skill) => {
      if (usedSkills.has(skill.code)) return null
      usedSkills.add(skill.code) // 规划阶段预留，避免与 ruleType 13 重复。
      actions.push(['skill:' + skill.code, async () => {
        const sid = await apiImpl.skillChat(cred, { skill, text: '请用这个技能处理一份示例：请按技能说明给出一次完整处理结果。' })
        artifacts.sessions.push(sid)
        await settleSession(cred, sid, undefined, undefined, { apiImpl, sleepImpl })
        return sid
      }])
      return skill
    }
    const fill = skills.filter((s) => !usedSkills.has(s.code)).slice(0, 3)
    if (fill.length) {
      for (const skill of fill) await planSkill(skill)
    } else {
      const free = await apiImpl.fetchOnlineProducts(cred).catch(() => [])
      const picks = free.filter((p) => p.price === 0).slice(0, 3)
      for (const p of picks) {
        const task = { title: p.name, description: p.description, productId: p.productId, productName: p.name, activityId: 'p' + p.productId }
        const name = 'skill:' + p.name
        if (actions.some(([n]) => n === name)) continue
        actions.push([name, async () => {
          const skill = await ensureSkill(task)
          if (!skill || usedSkills.has(skill.code)) return 'no-skill'
          usedSkills.add(skill.code)
          const sid = await apiImpl.skillChat(cred, { skill, text: '请用这个技能处理一份示例：请按技能说明给出一次完整处理结果。' })
          artifacts.sessions.push(sid)
          await settleSession(cred, sid, undefined, undefined, { apiImpl, sleepImpl })
          return sid
        }])
      }
    }
  }

  // 规则 19 由上面的技能动作组覆盖：有技能动作就登记，兜底不再点名它。
  if (unclaimed([19]) && actions.some(([name]) => name.startsWith('skill:'))) coveredRules.add(19)
  // 9. 小红书图文：装产品 3366（小红书图文笔记数字专家 agent 22），再发创作请求。
  // 这条任务指名要「小红书图文笔记数字专家」：拿别的专家（比如数字内容专家）发，平台不认——
  // 实测发了 2 轮、11/13 里唯独它没计数。所以按早期逻辑直接装它；已装的不动，轮末再卸载。
  // 不再过「专家商品列表」的免费闸门：那个接口 productType=EXPERT 一直 500，闸门恒为 false，
  // 结果这条动作永远被跳过（就是这次被改坏的地方）。
  const xhsTasks = tasks.filter((t) => t.ruleType === 12 && t.status !== 'claimed' && /小红书/.test(String(t.title ?? '')))
  if (xhsTasks.length) {
    planFor('xhs', xhsTasks)
    actions.push(['xhs', async () => {
    // 用户可能本来就已经装了这个专家（数字内容专家 3366）。插件只负责收尾自己装的东西，
    // 不能把用户原有的那份也卸掉：先查专家列表，已装就不装、也不进待卸载名单。
    const alreadyInstalled = experts.has(22)
    if (!alreadyInstalled) {
      try {
        await apiImpl.installProduct(cred, 3366, 22)
        installedProducts.push(3366)
        const fresh = await apiImpl.fetchExperts(cred).catch(() => experts)
        for (const [id, e] of fresh) experts.set(id, e)
      } catch (e) {
        append('install', 'failed', { productId: 3366, error: String(e?.message ?? e) })
      }
    }
    const digital = experts.has(22) ? 22 : [...experts.entries()].find(([, e]) => /数字内容|小红书/.test(String(e?.name ?? '')))?.[0]
    if (!digital) return 'no-expert'
    const expert = experts.get(digital)
    const sid = await apiImpl.specialistChat(cred, { agentId: digital, cloneCode: apiImpl.cloneCodeOf(expert), version: expert?.version, text: '请创作一篇小红书图文笔记：主题是人工智能与教育，包含标题、正文和话题标签。' })
    artifacts.sessions.push(sid)
    await settleSession(cred, sid, digital, undefined, { apiImpl, sleepImpl })
    return [digital]
    }, 'expert'])
  }

  // 10. 使用3个专家：任务给了 agentId 就按它发，没给就用已装的前 3 个
  if (unclaimed([18])) {
    planFor('experts3', tasks.filter((t) => t.ruleType === 18 && t.status !== 'claimed'))
    actions.push(['experts3', async () => {
    const ids = new Set()
    for (const t of tasks) { if (t.status === 'claimed' || t.ruleType !== 18) continue; if (t.agentId) ids.add(t.agentId) }
    if (!ids.size) for (const id of [...experts.keys()].slice(0, 3)) ids.add(id)
    const used = []
    for (const id of ids) {
      const expert = experts.get(id)
      const text = /数字内容/.test(String(expert?.name ?? ''))
        ? '请帮我写一篇小红书图文笔记，主题是一本关于人工智能与教育的书。'
        : '请审校下面这句话，给出修改意见：今天天气很好，我们去公园玩儿。'
      const sid = await apiImpl.specialistChat(cred, { agentId: id, cloneCode: apiImpl.cloneCodeOf(expert), version: expert?.version, text })
      artifacts.sessions.push(sid)
      await settleSession(cred, sid, id, undefined, { apiImpl, sleepImpl })
      used.push(id)
    }
    return used
    }, 'expert'])
  }

  // 11. 使用审校专家3次（最难：要带稿件，且同一专家 3 次）
  if (unclaimed([17]) || pendingTitle(/书稿审校/)) {
    planFor('reviser3', tasks.filter((t) => (t.ruleType === 17 || /书稿审校/.test(String(t.title ?? ''))) && t.status !== 'claimed'))
    actions.push(['reviser3', async () => {
    let reviewFiles = []
    try {
      const bytes = apiImpl.samplePdf('Manuscript sample for review. Artificial intelligence in education. This sentense has a speling error and bad punctuation ,for review.')
      const up = await apiImpl.uploadOss(cred, bytes, 'manuscript-' + Date.now() + '.pdf', 'application/pdf')
      const fid = await apiImpl.uploadChatFile(cred, { name: 'manuscript.pdf', key: up.key })
      if (fid) reviewFiles = [fid]
      append('upload', fid ? 'ok' : 'missing', { fileId: fid })
    } catch (e) {
      append('upload', 'failed', { error: String(e?.message ?? e) })
    }
    const reviser =
      [...experts.entries()].find(([, e]) => e.name === '审校专家')?.[0] ??
      [...experts.entries()].find(([, e]) => /审校/.test(String(e?.name ?? '')))?.[0]
    if (!reviser) return 'no-expert'
    const expert = experts.get(reviser)
    for (let k = 0; k < 3; k += 1) {
      const sid = await apiImpl.specialistChat(cred, { agentId: reviser, cloneCode: apiImpl.cloneCodeOf(expert), version: expert?.version, text: '请审校下面这句话，给出修改意见：今天天气很好，我们去公园玩儿。', files: reviewFiles })
      artifacts.sessions.push(sid)
      await settleSession(cred, sid, reviser, undefined, { apiImpl, sleepImpl })
    }
    return [reviser, reviser, reviser]
    }, 'expert'])
  }
  // 12. 兜底：兜住「算进进度、却没被上面任何动作认领」的任务。
  // 规则 12（用专家）与 23（建笔记）是按标题分支的，平台改一次文案就会漏；
  // 漏一条 = done >= total 永远不成立 = done.json 写不出来 = 每天重跑整轮、白花墨滴
  // （规则 25 就是这么出事的）。这里给漏掉的任务补一个最省的动作，并把漏了哪些写进日志。
  const plannedIds = new Set([...plannedTaskIds.values()].flat())
  const uncovered = automatableTasks(tasks).filter((t) => t.status !== 'claimed' && !plannedIds.has(t.activityId) && !coveredRules.has(t.ruleType))
  if (uncovered.length) {
    append('plan', 'uncovered', { rules: uncovered.map((t) => t.ruleType), titles: uncovered.map((t) => t.title) })
  }
  for (const task of uncovered) {
    if (task.ruleType === 23) {
      const name = 'note-fallback:' + task.activityId
      planFor(name, [task])
      actions.push([name, async () => {
        const up = await apiImpl.uploadOss(cred, Buffer.from(ONE_PX, 'base64'), 'note-' + Date.now() + '.png', 'image/png')
        const note = await apiImpl.addImageNote(cred, up.url, '图片笔记 ' + Date.now())
        const nid = Number(note?.id ?? note?.contentId)
        if (nid) artifacts.contents.push(nid)
        return nid
      }])
      continue
    }
    if (task.ruleType === 12) {
      const name = 'expert-fallback:' + task.activityId
      planFor(name, [task])
      actions.push([name, async () => {
        // 兜底专家按任务文案挑对的人：小红书要数字内容专家（就是这条任务的答案），
        // 审校要审校专家；随便抓第一个专家（以前会抓到「首席审校」）平台不认。
        const text = String(task.title ?? '') + ' ' + String(task.description ?? '')
        const byName = (re) => [...experts.entries()].find(([, e]) => re.test(String(e?.name ?? '')))?.[0]
        const agentId = Number(task.agentId) || (/(小红书|图文|笔记)/.test(text) ? (byName(/数字内容/) ?? byName(/小红书/)) : /审校/.test(text) ? byName(/审校/) : undefined) || [...experts.keys()][0] || 0
        if (!agentId) return 'no-expert'
        const expert = experts.get(agentId)
        const isDigital = /数字内容/.test(String(expert?.name ?? ''))
        const sid = await apiImpl.specialistChat(cred, {
          agentId,
          cloneCode: apiImpl.cloneCodeOf(expert),
          version: expert?.version,
          text: isDigital ? '请创作一篇小红书图文笔记：主题是人工智能与教育，包含标题、正文和话题标签。' : '请用一句话介绍你能帮编辑做什么，并举一个具体例子。',
        })
        artifacts.sessions.push(sid)
        await settleSession(cred, sid, agentId, undefined, { apiImpl, sleepImpl })
        return [agentId]
      }, 'expert'])
    }
  }
  // 每条动作的循环：读进度 → 复查任务状态 → 运行 → 查结果（没成功立刻补跑一次）→ 成功就善后 → 领积分+进度 → 按最快操作时间等待（最后一条不等）。
  append('plan', 'ready', { actions: actions.map(([name]) => name), timing: 'human-minimum', progress: taskProgressText(tasks) })
  const deferred = []
  // finalizeRun 放在 finally 里执行：不管动作中途是否出错，延迟产物都会被清、临时安装的产品都会被卸。
  const finalizeRun = async () => {
    if (deferred.length) {
      const all = { sessions: deferred.flatMap((d) => d.sessions), contents: deferred.flatMap((d) => d.contents) }
      const cleaned = await apiImpl.cleanupArtifacts(cred, all).catch(() => null)
      append('cleanup', 'done', { name: 'deferred', ...(cleaned && typeof cleaned === 'object' ? cleaned : {}) })
    }
    // 定时任务本身也要删（任务已完成，不留脚本产物）。
    for (const taskId of [...new Set(createdCronTasks)]) {
      try { await apiImpl.deleteScheduledTask(cred, taskId); append('cleanup', 'scheduled-task', { taskId }) } catch (e) { append('cleanup', 'scheduled-task-failed', { taskId, error: String(e?.message ?? e) }) }
    }
    const uninstalled = new Set()
    const stillFailed = []
    for (const productId of [...new Set(installedProducts)]) {
      if (await uninstallWithRetry(cred, productId, { apiImpl, sleepImpl, append })) uninstalled.add(productId)
      else stillFailed.push(productId)
    }
    // 重试后还没卸掉的，记进账本，下一次运行开头补卸。
    const pending = readPendingUninstalls(stateDir).filter((id) => !uninstalled.has(id))
    writePendingUninstalls(stateDir, [...pending, ...stillFailed])
  }
  const claimReady = async () => {
    const fresh = await apiImpl.fetchTasks(cred).catch(() => null)
    if (!fresh) return
    tasks = fresh
    let claimedAny = false
    for (const task of fresh) {
      if (task.status !== 'claimable' || task.userTaskId == null) continue
      try { const out = await apiImpl.claimTask(cred, task); claimedAny = true; append('claim', 'ok', { id: task.activityId, point: out.point }) } catch (e) { append('claim', 'failed', { id: task.activityId, error: String(e?.message ?? e) }) }
    }
    if (claimedAny) tasks = await apiImpl.fetchTasks(cred).catch(() => tasks)
  }
  // checkin / activity 不对应任何任务：核验不会让 done 涨，所以只跑一次、不补跑。
  // 否则「活跃对话发出去了但服务端还没标记活跃」会被当成失败，补跑再发一条 = 多花一次墨滴。
  const shouldVerify = (name) => name !== 'checkin' && name !== 'activity'
  try {
  for (let i = 0; i < actions.length; i += 1) {
    const [name, run, timingType] = actions[i]
    const maxAttempts = shouldVerify(name) ? 2 : 1
    await claimReady() // 读进度：刷新任务并把已完成的奖励领掉
    // 执行前复查：这个动作对应的任务若已不在「待做」状态（用户在网页上手动完成了、
    // 或上一条动作已顺带完成），就不再重复执行，省下这笔墨滴。
    // 记录动作当时针对的任务，规划期的 unclaimed() 与执行期可能已不同。
    const taskIdsForAction = plannedTaskIds.get(name) ?? []
    if (taskIdsForAction.length) {
      // todo/doing 都是「仍待做」（启动时 joinTask 会把 todo 变成 doing）；
      // 全部变成 claimable/claimed（已完成待领/已领）才说明任务已被完成，跳过动作。
      const stillPending = tasks.some((t) => taskIdsForAction.includes(t.activityId) && (t.status === 'todo' || t.status === 'doing'))
      if (!stillPending) {
        append('skip', 'already-done', { name })
        continue
      }
    }
    const beforeDone = taskDoneCount(tasks)
    const attempts = []
    let verified = false
    let lastDetail = null
    let detail = null
    // 最多两次：第一次没核验到就立刻补跑一次，不隔长间隔。
    for (let attempt = 1; attempt <= maxAttempts && !verified; attempt += 1) {
      const fromSessions = artifacts.sessions.length
      const fromContents = artifacts.contents.length
      detail = null
      try { detail = await run(); lastDetail = detail; append('action', 'ok', { name, attempt, detail }) } catch (e) {
        // 登录态失效就别再往下跑了：后面每个动作都会用同一份过期凭据再失败一次，
        // 白等几十分钟还拿不到任何结果。直接中止整轮，把原因写进日志。
        if (e?.signIn === 'expired') {
          append('abort', 'sign-in-expired', { name, error: String(e?.message ?? e) })
          throw e
        }
        append('action', 'failed', { name, attempt, error: String(e?.message ?? e) })
      }
      const used = { sessions: artifacts.sessions.slice(fromSessions), contents: artifacts.contents.slice(fromContents) }
      attempts.push(used)
      if (!shouldVerify(name)) break
      // 查结果：服务端核验是异步的，最多 6 轮 × 10 秒，每轮补领一次。
      for (let k = 0; k < 6 && !verified; k += 1) {
        await claimReady()
        if (taskDoneCount(tasks) > beforeDone) { verified = true; break }
        if (used.sessions.length || used.contents.length) append('wait', 'settle', { seconds: 10, name, attempt, try: k + 1 })
        else break
        await sleepImpl(10000)
      }
      // 只有「真的会补跑一次」才写这条日志：checkin / activity 只跑一次，写了会误导。
      if (!verified && attempt < maxAttempts) append('retry', 'immediate', { name })
    }
    const allUsed = { sessions: attempts.flatMap((u) => u.sessions), contents: attempts.flatMap((u) => u.contents) }
    // 成功后善后：核验通过就立刻清理；没通过就留到整轮结束。
    if (verified) {
      // 先领奖励，再清理这次运行留下的会话/笔记。
      await claimReady()
      const cleaned = await apiImpl.cleanupArtifacts(cred, allUsed).catch(() => null)
      append('cleanup', 'done', { name, ...(cleaned && typeof cleaned === 'object' ? cleaned : {}) })
    } else if (allUsed.sessions.length || allUsed.contents.length) {
      deferred.push(allUsed)
      append('cleanup', 'deferred', { name, sessions: allUsed.sessions.length, contents: allUsed.contents.length })
    }
    // 领积分 + 进度
    await claimReady()
    append('progress', 'done', { name, done: taskDoneCount(tasks), total: automatableTasks(tasks).length, progress: taskProgressText(tasks) })
    // 等“真人最快时间 + 15–30 秒随机”，最后一个任务不等。
    if (i < actions.length - 1) {
      const wait = humanGapMs(timingType ?? name, lastDetail, random)
      append('wait', 'sleep', { ms: wait, seconds: Math.round(wait / 1000), name, kind: 'human-min+15-30s' })
      await sleepImpl(wait)
    }
  }
  // 服务端对定时任务/知识库这类任务的核验是异步的：隔一会儿再补领几次，别刚做完就收尾。
  for (let pass = 0; pass < 3; pass += 1) {
    const left = automatableTasks(tasks).filter((t) => t.status !== 'claimed').length
    if (left === 0) break
    append('wait', 'settle', { seconds: 45, left })
    await sleepImpl(45000)
    await claimReady()
  }
  await claimReady()
  } finally {
    stopHeartbeat()
    await finalizeRun()
    // 锁也一并放开：正常跑完就清掉，下一次签到可以再起一个。
    // 异常退出（进程被杀）时这段不执行 → 锁留在那儿，但心跳也停了 →
    // 父进程看到心跳过期会清掉锁再起新的（见 index.mjs 的 startTaskRun）。
    if (heartbeatPath) {
      try { fs.rmSync(path.join(path.dirname(heartbeatPath), 'run.lock'), { force: true }) } catch {}
    }
  }
  const finalTasks = await apiImpl.fetchTasks(cred).catch(() => tasks)
  const finalDone = taskDoneCount(finalTasks)
  const finalTotal = automatableTasks(finalTasks).length
  if (finalDone >= finalTotal) {
    writeDoneAt(stateDir, { done: finalDone, total: finalTotal })
    append('cache', 'all-done', { done: finalDone, total: finalTotal })
  }
  append('finish', 'done', { done: finalDone, total: finalTotal, progress: taskProgressText(finalTasks) })
  return { done: finalDone, total: finalTotal, claimed: taskDoneCount(finalTasks) }
}

// CLI 直跑入口：node task-runner.mjs <logPath> [heartbeatPath]（插件经 MOBOOK_TASK_CRED 交凭据）。
const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (IS_CLI) {
  const args = process.argv.slice(2)
  const logPath = args[0] || path.join(os.homedir(), '.mobook-harness', 'mobook-tasks', 'latest.jsonl')
  const heartbeatPath = args[1] || ''
  // 第三个参数是插件写的 per-run 凭据文件（WMI 拉起的进程没有宿主环境变量）。
  const credPath = args[2] || ''
  try {
    const cred = (credPath ? credFromFile(credPath) : null) ?? credFromEnv()
    if (!cred) throw new Error('缺少有效的凭据（凭据文件或 MOBOOK_TASK_CRED），拒绝回退到本机桌面端账号')
    // 老凭据里可能没存 API Key（登录时还没补），这里按桌面作用域补一次，录音/TTS 要用。
    if (!cred.apiKey) {
      try { const cfg = await api.fetchApiKeyConfig(cred); cred.apiKey = cfg.apiKey } catch {}
    }
    await runGrowthPlan({ cred, logPath, heartbeatPath })
  } catch (error) {
    try { fs.appendFileSync(logPath, JSON.stringify({ time: new Date().toISOString(), step: 'finish', status: 'failed', detail: { error: String(error?.message ?? error) } }) + '\n') } catch {}
    process.exitCode = 1
  }
}