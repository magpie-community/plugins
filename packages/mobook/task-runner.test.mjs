import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runGrowthPlan, settleSession, credFromEnv, credFromFile, HANDLED_RULES, readPendingUninstalls, writePendingUninstalls, uninstallWithRetry } from './task-runner.mjs'
import { AUTOMATABLE_RULES, claimDaily } from './task-state.mjs'
import { EXTRA_MIN_MS } from './task-plan.mjs'

// ---- 假 API：默认全部动作可跑通，按测试需要覆盖 ----

function baseApiMock(overrides = {}) {
  const log = []
  const fn = (name, impl) => async (...a) => { log.push({ name, args: a }); return impl ? impl(...a) : undefined }
  const api = {
    ORG_ID: 1000,
    APP_ID: 40,
    fetchApiKeyConfig: fn('fetchApiKeyConfig', () => ({ apiKey: 'dcg-x' })),
    stopStaleRecordings: fn('stopStaleRecordings', () => ({ stopped: 0, failed: 0, sessions: 0, results: [] })),
    cleanupStaleScheduledTasks: fn('cleanupStaleScheduledTasks', () => ({ deleted: 0, total: 0 })),
    fetchTasks: fn('fetchTasks', () => []),
    joinTask: fn('joinTask'),
    fetchExperts: fn('fetchExperts', () => new Map()),
    fetchMySkills: fn('fetchMySkills', () => []),
    checkinActivity: fn('checkinActivity', () => null),
    isActiveToday: fn('isActiveToday', () => true),
    claimCheckin: fn('claimCheckin'),
    recordActivityChat: fn('recordActivityChat', () => ({ active: true })),
    uploadOss: fn('uploadOss', () => ({ url: 'https://oss/x', key: 'k' })),
    addImageNote: fn('addImageNote', () => ({ id: 101 })),
    recordNoteViaTranscriptWithSession: fn('recordNoteViaTranscriptWithSession', () => null),
    searchMyLibraries: fn('searchMyLibraries', () => []),
    ensurePersonalLibrary: fn('ensurePersonalLibrary', () => ({ id: 103, name: '插件试用知识库', bizType: 'KNOWLEDGE' })),
    addKnowledgeFile: fn('addKnowledgeFile', () => ({ id: 102 })),
    knowledgeChat: fn('knowledgeChat', () => 201),
    samplePdf: fn('samplePdf', () => Buffer.from('%PDF-1.4 test')),
    completeDesktopTask: fn('completeDesktopTask', () => 202),
    listScheduledTasks: fn('listScheduledTasks', () => []),
    createCronTask: fn('createCronTask', () => 203),
    fetchOnlineProducts: fn('fetchOnlineProducts', () => []),
    installProduct: fn('installProduct'),
    uninstallProduct: fn('uninstallProduct'),
    skillChat: fn('skillChat', () => 204),
    specialistChat: fn('specialistChat', () => 205),
    uploadChatFile: fn('uploadChatFile', () => 9001),
    listMessages: fn('listMessages', () => [{ message_type: 2, message_id: 1, message_content: JSON.stringify({ text: '回答' }) }]),
    assistantText: (rows) => ({ text: JSON.parse(rows[0].message_content).text, final: false }),
    cleanupArtifacts: fn('cleanupArtifacts', () => ({ sessions: 0, contents: 0, failed: [] })),
    deleteScheduledTask: fn('deleteScheduledTask'),
    claimTask: fn('claimTask', () => ({ point: 100 })),
    // 专家会话要用它拼 agent_clone_code（真实模块里有，桩里也要有，否则兜底动作会抛）。
    cloneCodeOf: (expert) => (expert?.code ? String(expert.code) : ''),
    // runner 直接调 apiCall 的那条路（录音笔记的「点一次智能总结」）也要在桩里，
    // 否则它恒为 undefined → 整条路径在测试里从未被真正验证过。
    apiCall: fn('apiCall', () => ({})),
    ...overrides,
  }
  return { api, log }
}

const CRED = { tk: 'pu', uid: '70001' }

function task(activityId, ruleType, title, status = 'todo', extra = {}) {
  return { activityId, userTaskId: status === 'claimable' ? 5000 + activityId : null, title, ruleType, status, reward: 100, ...extra }
}

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'mobook-run-'))
}

test('credFromEnv：缺失/残缺凭据拒绝，完整凭据透传', () => {
  assert.equal(credFromEnv({}), null)
  assert.equal(credFromEnv({ MOBOOK_TASK_CRED: 'not json' }), null)
  assert.equal(credFromEnv({ MOBOOK_TASK_CRED: JSON.stringify({ tk: 'x' }) }), null)
  const got = credFromEnv({ MOBOOK_TASK_CRED: JSON.stringify({ tk: 't', uid: '1', apiKey: 'k' }) })
  assert.equal(got.tk, 't')
  assert.equal(got.uid, '1')
  assert.equal(got.apiKey, 'k')
  assert.equal(got.appId, 40)
})

test('settleSession：拿到非空回答就返回 true，超时返回 false', async () => {
  let polls = 0
  const apiMock = {
    listMessages: async () => { polls += 1; return [{ message_type: 2, message_id: 1, message_content: JSON.stringify({ text: polls >= 2 ? '回答' : '' }) }] },
    assistantText: (rows) => ({ text: JSON.parse(rows[0].message_content).text, final: false }),
  }
  const noWait = () => {}
  const ok = await settleSession({}, 1, 13, 8000, { apiImpl: apiMock, sleepImpl: noWait })
  assert.equal(ok, true)
  const empty = await settleSession({}, 2, 13, 10, { apiImpl: { listMessages: async () => [], assistantText: () => ({ text: '' }) }, sleepImpl: noWait })
  assert.equal(empty, false)
  assert.ok(polls >= 2)
})

test('启动清扫：按账本停残留录音会话，停掉的销账', async () => {
  const dir = tmpDir()
  writeFileSync(path.join(dir, 'recording-sessions.json'), JSON.stringify({ sessions: [{ contentId: 42, sessionId: 's-live' }, { contentId: 43, sessionId: 's-dead' }] }))
  let stopped = []
  const { api } = baseApiMock({
    stopStaleRecordings: async (cred, { sessions }) => {
      stopped = sessions.map((s) => s.sessionId)
      return { stopped: 1, failed: 1, sessions: 2, results: [
        { contentId: 42, sessionId: 's-live', stopped: true },
        { contentId: 43, sessionId: 's-dead', stopped: false },
      ] }
    },
    fetchTasks: async () => [task(1, 12, '书稿审校', 'claimed')],
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.deepEqual(stopped.sort(), ['s-dead', 's-live'])
  const ledger = JSON.parse(readFileSync(path.join(dir, 'recording-sessions.json'), 'utf8'))
  assert.deepEqual(ledger.sessions.map((s) => s.sessionId), ['s-dead']) // 成功的销账，失败的保留
  rmSync(dir, { recursive: true, force: true })
})

test('启动清扫：定时任务按专属标题匹配（不碰用户自建任务）', async () => {
  // runner 调用 cleanupStaleScheduledTasks(cred) 不带参数，默认正则在 api.mjs 里——
  // 这里直接测 api 函数的默认行为：只删标题带插件专属名称的，用户自建的不动。
  const dir = tmpDir()
  const deleted = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 12, '书稿审校', 'claimed')],
    listScheduledTasks: async () => ({ items: [
      { task_id: 'mine', title: '墨宝插件选题灵感日报' },
      { task_id: 'user-1', title: '每日图书行业新闻摘要' },
    ] }),
    deleteScheduledTask: async (cred, taskId) => { deleted.push(taskId) },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  const cleanupLog = []
  rmSync(dir, { recursive: true, force: true })
  // 直接验证 api.mjs 的默认匹配正则
  const { cleanupStaleScheduledTasks } = await import('./api.mjs')
  const origFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    calls.push({ path: parsed.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (parsed.pathname === '/organization/getBotListV3') return new Response(JSON.stringify({ code: 0, success: true, data: [{ id: 1, token: 'btk', name: 'b' }] }), { status: 200 })
    if (parsed.pathname === '/scheduled-task/v1/tasks/list_tasks') return new Response(JSON.stringify({ code: 0, success: true, data: { items: [
      { task_id: 'mine', title: '墨宝插件选题灵感日报' },
      { task_id: 'user-1', title: '每日图书行业新闻摘要' },
    ] } }), { status: 200 })
    if (parsed.pathname === '/scheduled-task/v1/tasks/delete_task') return new Response(JSON.stringify({ code: 0, success: true, data: {} }), { status: 200 })
    return new Response(JSON.stringify({ code: 404, message: 'no route' }), { status: 200 })
  }
  try {
    const out = await cleanupStaleScheduledTasks({ tk: 'pu', uid: '1' })
    assert.equal(out.deleted, 1)
    assert.equal(out.total, 2)
    const delCalls = calls.filter((c) => c.path === '/scheduled-task/v1/tasks/delete_task')
    assert.equal(delCalls.length, 1)
    assert.equal(delCalls[0].body.task_id, 'mine')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('全部完成时写 done.json 并直接返回，不执行任何动作', async () => {
  const dir = tmpDir()
  writeFileSync(path.join(dir, 'run.lock'), String(Date.now()))
  writeFileSync(path.join(dir, 'run.heartbeat'), String(Date.now()))
  const { api, log } = baseApiMock({
    fetchTasks: async () => [task(1, 12, '书稿审校', 'claimed'), task(2, 13, '技能', 'claimed')],
  })
  const out = await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), heartbeatPath: path.join(dir, 'run.heartbeat'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.equal(out.cached, true)
  assert.equal(existsSync(path.join(dir, 'run.lock')), false, '早退也要把锁收掉')
  assert.equal(out.done, 2)
  assert.ok(!log.some((c) => c.name === 'joinTask'))
  assert.ok(existsSyncSafe(dir))
  rmSync(dir, { recursive: true, force: true })
})

function existsSyncSafe(dir) {
  try { return readFileSync(path.join(dir, 'done.json'), 'utf8').includes('all') || !!readFileSync(path.join(dir, 'done.json'), 'utf8') } catch { return false }
}

test('执行前复查：任务在规划后、执行前被完成（claimable）的动作被跳过，不花墨滴', async () => {
  const dir = tmpDir()
  let round = 0
  const { api, log } = baseApiMock({
    fetchTasks: async () => {
      round += 1
      // round1 todo（启动拉清单）→ round2 doing（join 后，规划期任务仍待做）
      // → round3 claimable（执行前用户在网页上手动完成）→ round4+ claimed（claimReady 已领）。
      // round1 todo → round2 doing（join 后）→ round3 claimable（执行前用户完成）
      // 动作循环内第一次 claimReady 读到 round3 的 claimable 并领掉 → fetchTasks 回 claimed → skip。
      const status = round === 1 ? 'todo' : round === 2 ? 'doing' : round === 3 ? 'claimable' : 'claimed'
      return [task(1, 15, '桌面端墨宝对话1次', status)]
    },
    completeDesktopTask: async () => { throw new Error('不应该执行桌面端对话动作') },
    claimTask: async () => ({ point: 100 }),
  })
  const out = await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.equal(out.done, 1)
  assert.ok(!log.some((c) => c.name === 'completeDesktopTask'), '桌面端对话动作没有执行')
  const linesAll = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(linesAll.some((l) => l.step === 'claim' && l.status === 'ok'), '奖励已被领取')
  assert.ok(linesAll.some((l) => l.step === 'skip' && l.status === 'already-done'), '日志里有 skip already-done')
  rmSync(dir, { recursive: true, force: true })
})

test('定时任务动作：提示词带专属名称「墨宝插件选题灵感日报」，新建任务被记录', async () => {
  const dir = tmpDir()
  const prompts = []
  let listed = 0
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 14, '设置定时任务', 'doing')],
    listScheduledTasks: async () => {
      listed += 1
      // cron 动作里建任务后轮询：第 2 次起返回新建的定时任务（api.mjs 已把 items 映射成数组）
      return listed >= 2 ? [{ taskId: 'cron-1', title: '墨宝插件选题灵感日报' }] : []
    },
    createCronTask: async (cred, text) => { prompts.push(text); return 203 },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.ok(prompts.some((p) => /墨宝插件选题灵感日报/.test(p)), '提示词带专属名称: ' + prompts.join(' / '))
  const lines = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.step === 'action' && l.status === 'ok' && l.detail?.name === 'cron'), 'cron 动作执行过')
  rmSync(dir, { recursive: true, force: true })
})

test('技能任务：resolveProductId 只挑免费产品（价格>0 的不装）', async () => {
  const dir = tmpDir()
  const installed = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 13, '完成一次AI选题报告生成', 'todo', { productId: 0 })],
    fetchMySkills: async () => [],
    fetchOnlineProducts: async () => [
      { productId: 11, name: 'book-proposal-pro', description: '选题报告', price: 9900 },
      { productId: 12, name: 'book-proposal', description: '选题报告', price: 0 },
    ],
    installProduct: async (cred, productId) => { installed.push(productId); return {} },
    fetchExperts: async () => new Map(),
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.ok(installed.length >= 1, '至少安装过一次')
  assert.ok(installed.every((id) => id === 12), '每次安装的都是免费产品（不碰付费 11 号）: ' + JSON.stringify(installed))
  rmSync(dir, { recursive: true, force: true })
})

test('录音笔记：会话建立瞬间记账、正常结束销账；并点一次智能总结', async () => {
  const dir = tmpDir()
  let ledgerMid = []
  const summaryCalls = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 23, '新建录音笔记', 'todo')],
    recordNoteViaTranscriptWithSession: async (cred, { onSession }) => {
      onSession({ contentId: 42, sessionId: 'sess-42' })
      // 模拟会话存在期间的账本内容
      try { ledgerMid = JSON.parse(readFileSync(path.join(dir, 'recording-sessions.json'), 'utf8')).sessions } catch {}
      return { contentId: 42, sessionId: 'sess-42' }
    },
    searchMyLibraries: async () => [{ id: 1, bizType: 'NOTE' }],
    uploadOss: async () => ({ url: 'https://oss/x', key: 'k' }),
    addImageNote: async () => ({ id: 101 }),
    apiCall: async (cred, path, body) => { summaryCalls.push({ path, body }); return {} },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.deepEqual(ledgerMid.map((s) => s.sessionId), ['sess-42'], '会话建立时已记账')
  let after
  try { after = JSON.parse(readFileSync(path.join(dir, 'recording-sessions.json'), 'utf8')).sessions } catch { after = [] }
  assert.deepEqual(after, [], '正常结束后已销账')
  // 智能总结那一步真的发了（此前这条 apiCall 在测试桩里根本不存在，从未被验证）。
  // 桩不会把任务标成 claimed → runner 核验不过会补跑一次，所以这里是 2 次（不是 1 次）。
  assert.ok(summaryCalls.length >= 1, '录音笔记后应点一次智能总结')
  assert.ok(summaryCalls.every((c) => c.path === '/resource/getNoteLiveSummarySnapshot'))
  assert.equal(summaryCalls[0].body.contentId, 42)
  assert.equal(summaryCalls[0].body.userId, 70001)
  rmSync(dir, { recursive: true, force: true })
})

test('收尾：核验通过的动作产物被清理，未核验的延迟清理；临时安装的产品被卸载', async () => {
  const dir = tmpDir()
  const cleaned = []
  const uninstalled = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 15, '桌面端墨宝对话1次', 'todo')],
    completeDesktopTask: async () => 202,
    cleanupArtifacts: async (cred, { sessions }) => { cleaned.push(...sessions); return { sessions: sessions.length, contents: 0, failed: [] } },
    uninstallProduct: async (cred, productId) => { uninstalled.push(productId) },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.ok(cleaned.length >= 1, '产物被清理过至少一次')
  assert.ok(cleaned.every((sid) => sid === 202), '清理的正是本次动作建的会话: ' + JSON.stringify(cleaned))
  rmSync(dir, { recursive: true, force: true })
})

test('不变量：runner 能做的规则 ⊇ 算进进度的规则（少一条就永远写不出 done.json）', () => {
  // 算进「任务 x/y」却没人做的规则，会让 done >= total 永远不成立 →
  // done.json 永不写 → 每天的签到都重跑一遍成长任务、白花墨滴（规则 25 造成过这个问题）。
  for (const rule of AUTOMATABLE_RULES) {
    assert.ok(HANDLED_RULES.includes(rule), '规则 ' + rule + ' 算进进度，但 runner 没有对应动作')
  }
  // 网页端自己的规则枚举里没有第 25 条，它不该出现在任何一边。
  assert.equal(HANDLED_RULES.includes(25), false)
  assert.equal(AUTOMATABLE_RULES.includes(25), false)
})

test('当天的签到/活跃标记只给一个线程：第二个线程拿不到，不再重复做', () => {
  const dir = tmpDir()
  const first = claimDaily(dir, 'activity')
  assert.ok(first, '第一个线程拿到标记')
  const second = claimDaily(dir, 'activity')
  assert.equal(second, null, '第二个线程拿不到 → 跳过，避免重复发活跃对话')
  // 另一件事（签到）与活跃打卡互不影响
  assert.ok(claimDaily(dir, 'checkin'), '签到是另一把标记')
  rmSync(dir, { recursive: true, force: true })
})

test('已装的产品不会被卸载（用户原有的那份要留着）', async () => {
  const dir = tmpDir()
  const uninstalled = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 12, '完成一次小红书图文笔记创作', 'todo', { productId: 3366 })],
    // 用户本来就已经装了数字内容专家（22）
    fetchExperts: async () => new Map([[22, { name: '数字内容专家', code: 'x', version: '1.0.1' }]]),
    installProduct: async () => {},
    uninstallProduct: async (cred, productId) => { uninstalled.push(productId) },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.deepEqual(uninstalled, [], '用户自己装的产品不该被卸载')
  rmSync(dir, { recursive: true, force: true })
})

test('任务自带的 productId 也要过付费闸门（装了就是真下付费订单）', async () => {
  const dir = tmpDir()
  const installed = []
  const { api } = baseApiMock({
    // 任务指向 11 号（付费 9900）——之前这条入口直接装，不查价格
    fetchTasks: async () => [task(1, 13, '完成一次AI选题报告生成', 'todo', { productId: 11, productName: 'book-proposal-pro' })],
    fetchMySkills: async () => [],
    fetchOnlineProducts: async () => [
      { productId: 11, name: 'book-proposal-pro', description: '选题报告', price: 9900 },
      { productId: 12, name: 'book-proposal', description: '选题报告', price: 0 },
    ],
    installProduct: async (cred, productId) => { installed.push(productId) },
    fetchExperts: async () => new Map(),
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.ok(installed.every((id) => id !== 11), '付费的 11 号不该被装: ' + JSON.stringify(installed))
  rmSync(dir, { recursive: true, force: true })
})

test('登录态失效时整轮中止，不再用过期凭据把每个动作都跑一遍', async () => {
  const dir = tmpDir()
  const ran = []
  const expired = Object.assign(new Error('登录态已过期'), { signIn: 'expired' })
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 15, '桌面端墨宝对话1次', 'todo')],
    checkinActivity: async () => { ran.push('checkin'); return null },
    completeDesktopTask: async () => { ran.push('desktop'); throw expired },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
    .catch(() => {})
  const lines = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.step === 'abort' && l.status === 'sign-in-expired'), '应记录中止原因')
  // 失效后不该再跑后面的动作（这里只有一个动作，但断言它只被尝试了一次）
  assert.equal(ran.filter((r) => r === 'desktop').length, 1, '失效的动作不应被反复重试')
  rmSync(dir, { recursive: true, force: true })
})

test('消息发失败要抛出来：不能吞掉错误让调用方只能干等到超时', async () => {
  // skillChat / knowledgeChat / createCronTask 原来把 chat_service 的失败吞掉，
  // 于是 settleSession 只会等到超时，日志里看不出「消息压根没发出去」。
  const { skillChat } = await import('./api.mjs')
  const { fetchImpl } = (() => {
    const routes = {
      '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 1, token: 'btk' }] },
      '/chat/new_session': { code: 0, success: true, data: { session_id: 5 } },
      '/chat/chat_service': { code: 500, success: false, message: '发送失败' },
    }
    return {
      fetchImpl: async (url, init) => {
        const parsed = new URL(String(url))
        const route = routes[parsed.pathname]
        if (!route) return new Response(JSON.stringify({ code: 404, message: 'no route' }), { status: 200 })
        return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
  })()
  await assert.rejects(
    () => skillChat({ tk: 'pu', uid: '1' }, { skill: { id: 9, code: 'x', name: 'X' }, text: 'hi' }, { fetchImpl }),
    /发送失败|500|失败/,
    '消息发失败必须抛出来，不能被吞掉',
  )
})

test('随机等待落在「真人最快 + 15–30 秒」区间：random=0 时取下界', async () => {
  const dir = tmpDir()
  // 两个动作：desktop（10s 档）与 reviser3（75s 档，按 3 个专家计）
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 15, '桌面端墨宝对话1次', 'doing'), task(2, 12, '完成一次书稿审校', 'doing')],
    completeDesktopTask: async () => 202,
    specialistChat: async () => 205,
    fetchExperts: async () => new Map([[7, { name: '审校专家', code: 'reviser-expert', version: '1.0.45' }]]),
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  const lines = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const waits = lines.filter((l) => l.step === 'wait' && l.status === 'sleep')
  // 核验不过会补跑一次，等待日志按动作名分组后每组 ≥1；最后一个动作（reviser3）之后没有等待。
  const byName = new Map()
  for (const w of waits) byName.set(w.detail.name, (byName.get(w.detail.name) ?? 0) + 1)
  assert.ok(byName.get('desktop') >= 1, 'desktop（非最后动作）之后有等待')
  assert.equal(byName.get('reviser3'), undefined, '最后一个动作 reviser3 之后不再等待')
  // 最后一条进度日志（最后一个动作）之后不应再有 sleep
  const allWaits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.step === 'wait' && l.status === 'sleep')
  const lastWait = allWaits.at(-1)
  const progressAfterLastWait = lines.slice(lastWait.i + 1).some((l) => l.step === 'progress')
  assert.ok(progressAfterLastWait, '最后一个等待之后还有动作在跑（等待只插在动作之间）')
  // random=0：desktop 等待 = 10s + 15s 下界
  assert.ok(waits.every((w) => w.detail.kind === 'human-min+15-30s'))
  const desktopWaits = waits.filter((w) => w.detail.name === 'desktop')
  assert.ok(desktopWaits.every((w) => w.detail.ms === 10 * 1000 + EXTRA_MIN_MS), 'desktop 等待取下界 25s')
  rmSync(dir, { recursive: true, force: true })
})

// ---- 1.17.0 兜底动作 ----

test('兜底：标题不匹配的规则 12/23 也有动作，done.json 能写出来', async () => {
  const dir = tmpDir()
  let expertDone = false
  let noteDone = false
  const { api } = baseApiMock({
    fetchTasks: async () => [
      task(1, 12, '完成一次专家创作', expertDone ? 'claimed' : 'doing'),
      task(2, 23, '新建一条灵感笔记', noteDone ? 'claimed' : 'doing'),
    ],
    fetchExperts: async () => new Map([[7, { name: '审校专家', code: 'reviser-expert', version: '1.0.45' }]]),
    specialistChat: async () => { expertDone = true; return 205 },
    addImageNote: async () => { noteDone = true; return 101 },
  })
  const out = await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.equal(out.done, 2)
  assert.equal(out.total, 2)
  const lines = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.step === 'plan' && l.status === 'uncovered'), '日志里点名了没被匹配到的任务')
  assert.ok(lines.some((l) => l.step === 'action' && l.detail?.name === 'expert-fallback:1'), '规则 12 由兜底专家动作顶掉')
  assert.ok(lines.some((l) => l.step === 'action' && l.detail?.name === 'note-fallback:2'), '规则 23 由兜底笔记动作顶掉')
  const done = JSON.parse(readFileSync(path.join(dir, 'done.json'), 'utf8'))
  assert.equal(done.done, 2)
  assert.equal(done.total, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('小红书：专用专家（产品 3366 → agent 22）没装时照装，再发创作请求', async () => {
  // 这条任务指名要「小红书图文笔记数字专家」。曾经加过按专家商品列表查免费的闸门，
  // 但 productType=EXPERT 的接口一直 500 → 闸门恒 false → 动作整条被跳过。这里锁住「照装」。
  const dir = tmpDir()
  const installed = []
  const picked = []
  let doneFlag = false
  let expertsMap = new Map()
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 12, '完成一次小红书图文笔记创作', doneFlag ? 'claimed' : 'doing')],
    fetchOnlineProducts: async () => [], // 商品列表不可用也不能挡住安装
    installProduct: async (cred, productId) => {
      installed.push(productId)
      expertsMap = new Map([[22, { name: '小红书图文笔记数字专家', code: 'digital-content-expert', version: '1.0.1' }]])
    },
    fetchExperts: async () => expertsMap,
    specialistChat: async (cred, { agentId }) => { picked.push(agentId); doneFlag = true; return 205 },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.deepEqual(installed, [3366], '专用专家 3366 要装上')
  assert.deepEqual(picked, [22], '创作请求要发给 agent 22')
  rmSync(dir, { recursive: true, force: true })
})

test('credFromFile：读 per-run 凭据文件、读完即删，残缺时也删', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'cred-run.json')
  writeFileSync(file, JSON.stringify({ tk: 't', uid: '42', apiKey: 'k' }))
  const cred = credFromFile(file)
  assert.equal(cred.tk, 't')
  assert.equal(cred.uid, '42')
  assert.equal(cred.apiKey, 'k')
  assert.equal(existsSync(file), false, '读完要删掉凭据文件')
  assert.equal(credFromFile(file), null, '文件没了就返回 null')
  writeFileSync(file, JSON.stringify({ tk: 'only-token' }))
  assert.equal(credFromFile(file), null, '缺 uid 的凭据拒绝')
  assert.equal(existsSync(file), false, '残缺文件也要删，不能留凭据')
  rmSync(dir, { recursive: true, force: true })
})

// ---- 卸载重试与 pending 账本 ----

test('uninstallWithRetry：失败一次后重试成功', async () => {
  let calls = 0
  const apiMock = { uninstallProduct: async () => { calls += 1; if (calls === 1) throw new Error('服务连接中，请稍后再试') } }
  const ok = await uninstallWithRetry(CRED, 1461, { apiImpl: apiMock, sleepImpl: () => {} })
  assert.equal(ok, true)
  assert.equal(calls, 2)
})

test('uninstallWithRetry：多次失败记进 pending，下次运行开头补卸', async () => {
  const dir = tmpDir()
  const failing = { uninstallProduct: async () => { throw new Error('服务连接中，请稍后再试') } }
  const ok = await uninstallWithRetry(CRED, 1461, { apiImpl: failing, sleepImpl: () => {}, backoff: [] })
  assert.equal(ok, false)
  writePendingUninstalls(dir, [1461, 1260, 1461])
  assert.deepEqual(readPendingUninstalls(dir), [1461, 1260])
  const removed = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 18, '使用3个专家', 'claimed')],
    uninstallProduct: async (cred, productId) => { removed.push(productId) },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.deepEqual(removed.sort((a, b) => a - b), [1260, 1461])
  assert.deepEqual(readPendingUninstalls(dir), [])
  const lines = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.step === 'cleanup' && l.status === 'pending-uninstall' && l.detail.done === 2))
  rmSync(dir, { recursive: true, force: true })
})

test('规则 19（使用3个技能）由技能动作覆盖，不再被兜底误报为 uncovered', async () => {
  const dir = tmpDir()
  let doneFlag = false
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 19, '使用3个技能', doneFlag ? 'claimed' : 'doing')],
    fetchMySkills: async () => [{ code: 's1', name: '示例技能', productId: 1 }],
    skillChat: async () => { doneFlag = true; return 204 },
  })
  const out = await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.equal(out.done, 1)
  const lines = readFileSync(path.join(dir, 'latest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(!lines.some((l) => l.step === 'plan' && l.status === 'uncovered'), '规则 19 不该被点名')
  assert.ok(!lines.some((l) => l.detail?.name === 'expert-fallback:1'), '不该落到兜底专家')
  rmSync(dir, { recursive: true, force: true })
})

test('兜底专家按任务文案挑人：小红书选数字内容专家', async () => {
  const dir = tmpDir()
  let doneFlag = false
  const picked = []
  const { api } = baseApiMock({
    fetchTasks: async () => [task(1, 12, '完成一次小红书图文笔记创作', doneFlag ? 'claimed' : 'doing')],
    fetchOnlineProducts: async (cred, { productType } = {}) => (productType === 'EXPERT'
      ? [{ productId: 3366, name: '数字内容专家', description: '小红书图文笔记', price: 9900 }]
      : []),
    fetchExperts: async () => new Map([
      [35, { name: '首席审校', code: 'reviserchief-expert', version: '1.0.1' }],
      [16, { name: '审校专家', code: 'reviser-expert', version: '1.0.45' }],
      [33, { name: '数字内容专家', code: 'digital-content-expert', version: '1.2.0' }],
    ]),
    specialistChat: async (cred, { agentId }) => { picked.push(agentId); doneFlag = true; return 205 },
  })
  await runGrowthPlan({ cred: CRED, logPath: path.join(dir, 'latest.jsonl'), apiImpl: api, random: () => 0, sleepImpl: () => {} })
  assert.deepEqual(picked, [33], '小红书任务要发给数字内容专家')
  rmSync(dir, { recursive: true, force: true })
})