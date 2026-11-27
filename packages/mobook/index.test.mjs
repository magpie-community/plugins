import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  INVITE_CHANNEL,
  MoBookError,
  ask,
  assistantText,
  appIdForApi,
  beijingToday,
  cleanupArtifacts,
  exchangeUserToken,
  fetchModelShow,
  fetchLedgerTotals,
  readClientState,
  fetchApiKeyConfig,
  fetchFlowPages,
  apiCall,
  ensureBot,
  loginBySms,
  parseSession,
  promptFromMessages,
  runTasks,
  sendSmsCode,
  signOf,
  specialistChat,
  speak,
  parseMultipartAudio,
  parseWavToPcm16k,
  transcribePcm16k,
  stopStaleRecordings,
  cleanupStaleScheduledTasks,
  deleteSession,
} from './api.mjs'
import { MoBookAuthPlugin, SHOW_ALL_MODELS, SIGN_IN_PAGE, accountNameOf, credOf, chatFetch, gatewayFetch, imageModels, speechModels, imageSizeFor, normalizeChatPayload, setDeviceDetector, setLocalClientAccount, setTaskRoot, setTaskRunner, sseModelRewriter, sweepLauncherFiles, taskPaths, taskRunAlive as taskRunAlivePublic, writeTaskLaunchers } from './index.mjs'
import { clearBotCache } from './api.mjs'
import { dayKey, readDoneAt, taskProgressText, writeDoneAt } from './task-state.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup as setupOpenCode2 } from './opencode2.mjs'
import { accountFingerprint, fingerprintOf, resolveDevice, usableSignal, windowsClientName } from './device.mjs'
import { allModels, bootstrapModels, curatedModels, modelRow } from './models.mjs'
import { EXTRA_MAX_MS, EXTRA_MIN_MS, humanGapMs, humanMinMs } from './task-plan.mjs'

// 单测统一把任务状态目录指到临时目录，并替掉后台 runner（不能真的 spawn 子进程）。
const TEST_TASK_ROOT = mkdtempSync(path.join(os.tmpdir(), 'mobook-tasks-'))
setTaskRoot(TEST_TASK_ROOT)
setTaskRunner(() => true)
// bot 缓存是进程内的（见 api.mjs 的 BOT_CACHE_TTL）：不同用例用同一个 uid 造不同的桩，
// 缓存会串味。每个用例前清一次，免得「上一个用例的 bot」跑到下一个用例里去。
beforeEach(() => clearBotCache())

// 2026-11-24 在网页端抓到的一次真实 /chat/chat_service 请求的**形状**（字段与取值结构）。
// bot_token 换成合成值：原抓包令牌是凭据，不该留在仓库里。
// sign 是对这份 body（含合成 bot_token）算出来的期望值 —— 仍是「同一个 body + timestamp
// 必须签出同一个 sign」的证据，只是不再依赖真实令牌。
const CAPTURED = {
  timestamp: 1795505383159,
  path: '/chat/chat_service',
  sign: 'C79F41D8B06F03CB0A724E22E53C6369',
  body: {
    _orgId: 1000,
    _domainId: 1000,
    _appId: 40,
    session_id: 639426,
    options: { thinking: 0, networking: 1 },
    message: { text: '你好', human_input_text: '你好', files: [], review_revision_scope: [], corpus: [] },
    attachments: [],
    model: 'deepseek-v4-flash',
    agent_id: 13,
    agent_clone_code: '',
    agent_code: 'AI_CLAW',
    bot_id: 12331,
    bot_token: 'btk_SYNTHETIC_fixture_value',
    _userId: 6810,
  },
}

test('humanMinMs returns the requested per-action minimum timings', () => {
  assert.deepEqual(
    Object.fromEntries(['checkin', 'activity', 'desktop', 'cron', 'knowledge', 'image-note'].map((name) => [name, humanMinMs(name)])),
    { checkin: 3000, activity: 15000, desktop: 10000, cron: 40000, knowledge: 30000, 'image-note': 35000 },
  )
  assert.equal(humanMinMs('skill:example'), 25000)
  assert.equal(humanMinMs('expert', [1, 2, 3]), 75000)
  assert.equal(humanMinMs('expert', []), 25000)
  assert.equal(humanMinMs('recording-note'), 30000)
  assert.equal(humanMinMs('reviser3'), 75000)
})

test('humanGapMs = 真人最快时间 + 15–30 秒随机', () => {
  assert.equal(EXTRA_MIN_MS, 15000)
  assert.equal(EXTRA_MAX_MS, 30000)
  assert.equal(humanGapMs('checkin', null, () => 0), 18000)
  assert.equal(humanGapMs('checkin', null, () => 0.999999), 33000)
  assert.equal(humanGapMs('reviser3', null, () => 0), 90000)
  const gap = humanGapMs('knowledge')
  assert.ok(gap >= 45000 && gap <= 60000)
})

test('signOf 与网页端的签名一致', () => {
  const sign = signOf(CAPTURED.body, CAPTURED.timestamp, CAPTURED.path)
  assert.equal(sign.length, 32)
  // bot_token 不同，签名也不同；这里只验证同一输入稳定可复现。
  assert.equal(sign, signOf(CAPTURED.body, CAPTURED.timestamp, CAPTURED.path))
})

test('signOf 与独立实现的签名规格一致（合成夹具）', () => {
  // 夹具用合成 bot_token（原抓包令牌属凭据，不入库）；
  // 期望值由独立实现（排序拼接 + MD5 大写）算出，仍校验 signOf 的算法规格。
  const body = JSON.parse(JSON.stringify(CAPTURED.body))
  const all = { timestamp: CAPTURED.timestamp, path: CAPTURED.path, version: '1.0.0', ...body }
  const joined = Object.keys(all).sort().map((k) => { const v = all[k]; if (v === undefined) return ''; return k + (typeof v === 'object' ? JSON.stringify(v) : v) }).join('')
  const expected = createHash('md5').update(joined + '34E9023008EA445AAE6CC075CC954F46', 'utf8').digest('hex').toUpperCase()
  assert.equal(signOf(body, CAPTURED.timestamp, CAPTURED.path), expected)
  assert.equal(signOf(body, CAPTURED.timestamp, CAPTURED.path), CAPTURED.sign)
})

test('parseSession 接受裸 token、Cookie 与 JSON', () => {
  assert.deepEqual(parseSession(' puABC.def '), { tk: 'puABC.def', uid: '' })
  assert.deepEqual(parseSession('_tk=puABC; _uid=42'), { tk: 'puABC', uid: '42' })
  assert.deepEqual(parseSession('{"_tk":"puABC","_uid":"42"}'), { tk: 'puABC', uid: '42' })
  assert.throws(() => parseSession('   '), /请粘贴/)
  assert.throws(() => parseSession('_uid=1'), /没有找到 _tk/)
})

test('promptFromMessages 把对话压成一段文本', () => {
  assert.equal(promptFromMessages([{ role: 'user', content: '你好' }]), '你好')
  const text = promptFromMessages([
    { role: 'system', content: '你是编辑助手' },
    { role: 'user', content: '帮我看看标题' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ])
  assert.equal(text, '（系统设定）你是编辑助手\n\n帮我看看标题\n\n（助手先说过的）好的\n\n继续')
  assert.equal(promptFromMessages([{ role: 'tool', content: 'x' }, { role: 'user', content: '' }]), '')
})

test('模型表：23 个在售模型都带倍率与上下文', () => {
  const boot = bootstrapModels()
  const ids = Object.keys(boot)
  assert.equal(ids.length, 23)
  for (const id of ids) assert.ok(boot[id].rate > 0, id + ' 有倍率')
  // API Key 配置里标 1M 的四个模型
  for (const id of ['booksgpt', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
    assert.ok(boot[id].limit.context >= 1000000, id + ' 是 1M 上下文')
  }
  assert.ok(boot['qwen3.7-plus'].limit.context >= 960000)
  assert.equal(boot['eco'].limit.context, 983616)
  const live = curatedModels(new Map([['deepseek-v4-flash', { name: 'DeepSeek-Flash', multiplier: 0.03 }]]))
  assert.equal(live['deepseek-v4-flash'].name, 'DeepSeek-Flash')
  assert.equal(live['deepseek-v4-flash'].rate, 0.03)
  const missingRate = curatedModels(new Map([['eco', { multiplier: null }]]))
  assert.equal(missingRate.eco.rate, 0.11)
  assert.equal(live['eco'].rate, 0.11)
  const extra = curatedModels(new Map([['brand-new-model', { name: '新模型', multiplier: 0.2 }]]))
  assert.equal(extra['brand-new-model'].limit.context, 262144)
  assert.equal(extra['brand-new-model'].rate, 0.2)
  assert.equal(extra['brand-new-model'].tool_call, false)
})

test('fetchModelShow 将缺失或空倍率标为无效，保留有效倍率', async () => {
  const { fetchImpl } = mockFetch({
    '/modelgw/v1/model-show': {
      code: 0,
      success: true,
      data: [
        { modelCode: 'eco' },
        { modelCode: 'booksgpt', multiplier: null },
        { modelCode: 'ultra', multiplier: ' ' },
        { modelCode: 'deepseek-v4-flash', multiplier: 0.03 },
      ],
    },
  })
  const models = await fetchModelShow({ tk: 'pu', uid: '1' }, { deps: { fetchImpl } })
  assert.equal(models.get('eco').multiplier, null)
  assert.equal(models.get('booksgpt').multiplier, null)
  assert.equal(models.get('ultra').multiplier, null)
  assert.equal(models.get('deepseek-v4-flash').multiplier, 0.03)
})

test('modelRow 只声明厂商配置里的能力', () => {
  const textOnly = modelRow({ id: 'glm-5.3', reasoning: true })
  assert.equal(textOnly.capabilities.toolcall, false)
  assert.equal(textOnly.capabilities.attachment, false)
  assert.equal(textOnly.capabilities.reasoning, true)
  assert.deepEqual(textOnly.modalities.input, ['text'])
  const withImage = modelRow({ id: 'deepseek-v4-flash', image: true })
  assert.equal(withImage.capabilities.attachment, true)
  assert.deepEqual(withImage.modalities.input, ['text', 'image'])
  assert.deepEqual(withImage.modalities.output, ['text'])
})

test('credOf 从凭据与 metadata 还原会话', () => {
  assert.equal(credOf(null), null)
  assert.deepEqual(credOf({ type: 'api', key: 'pu1' }), { tk: 'pu1', apiKey: '', uid: '', orgId: 1000, appId: 0, agentId: 13, botToken: '', platform: 'web', expiresAt: 0, source: '', name: '', mobile: '' })
  const cred = credOf({ type: 'api', key: 'pu1', metadata: { tk: 'pu1', uid: '6810', name: '阿宝', agentId: 13 } })
  assert.equal(cred.uid, '6810')
  assert.equal(cred.name, '阿宝')
})

test('credOf 解包 OpenCode 2.x metadata.v1 并保留 API Key 和 desktop scope', () => {
  const cred = credOf({
    type: 'oauth', access: 'outer-token', refresh: '', expires: 99,
    metadata: { v1: {
      type: 'oauth', access: 'saved-token', expires: 123, uid: '83594',
      metadata: { tk: 'saved-token', uid: '83594', apiKey: 'api-key-test', botToken: 'bot-token-test', orgId: 1000, appId: 200, platform: 'desktop', agentId: 13 },
    } },
  })
  assert.equal(cred.tk, 'saved-token')
  assert.equal(cred.apiKey, 'api-key-test')
  assert.equal(cred.uid, '83594')
  assert.equal(cred.botToken, 'bot-token-test')
  assert.equal(cred.appId, 200)
  assert.equal(cred.agentId, 13)
  assert.equal(cred.orgId, 1000)
  assert.equal(cred.platform, 'desktop')
  assert.equal(cred.expiresAt, 123)
})

test('deleteSession 与 deleteChatSession 一致：带上 bot_token', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 7, token: 'btk-del', name: 'b' }] },
    '/chat/delete': { code: 0, success: true, data: true },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const ok = await deleteSession({ tk: 't', uid: '1' }, 99)
    assert.equal(ok, true)
    const del = calls.find((c) => c.path === '/chat/delete')
    assert.ok(del)
    assert.equal(del.body.session_id, 99)
    assert.equal(del.body.bot_token, 'btk-del')
  } finally {
    globalThis.fetch = original
  }
})

test('appIdForApi 把桌面 110 映射成 200/210、100 映射成 40', () => {
  assert.equal(appIdForApi(110, 'win32'), 200)
  assert.equal(appIdForApi(110, 'darwin'), 210)
  assert.equal(appIdForApi(100), 40)
})
test('credOf：web Cookie（device 无 appId）请求作用域为 40，不被抬成桌面 200', () => {
  const cred = credOf({ type: 'oauth', access: 't', metadata: { tk: 't', uid: '42', appId: 40, platform: 'web', device: { mode: 'web', botName: 'DESKTOP-AAAAAAA' } } })
  assert.equal(cred.appId, 40)
  assert.equal(cred.platform, 'web')
})
test('credOf 从 device.appId 兜底解析 scope', () => {
  const cred = credOf({ type: 'oauth', access: 'token', metadata: { tk: 'token', uid: '42', device: { clientType: 'desktop', appId: 210 } } })
  assert.equal(cred.appId, 210)
  assert.equal(cred.platform, 'desktop')
})

test('credOf 缺省 desktop appId 时回退到 desktop client scope', () => {
  const cred = credOf({ type: 'oauth', access: 'token', metadata: { tk: 'token', uid: '42', platform: 'desktop' } })
  assert.equal(cred.appId, 200)
})

test('assistantText 取最后一段有字的回复，收尾看 final 行', () => {
  const rows = [
    { message_type: 2, message_id: 1, retry_index: 1, is_finish: 1, message_content: JSON.stringify({ text: '' }) },
    { message_type: 2, message_id: 2, retry_index: 2, is_finish: 1, state: 'chunk', message_content: JSON.stringify({ text: '回答' }) },
    { message_type: 1, message_id: 3, message_content: JSON.stringify({ text: '问' }) },
  ]
  assert.deepEqual(assistantText(rows), { text: '回答', final: false })
  rows.push({ message_type: 2, message_id: 4, retry_index: 3, is_finish: 1, state: 'final', message_content: JSON.stringify({ text: '' }) })
  assert.deepEqual(assistantText(rows), { text: '回答', final: true })
  assert.deepEqual(assistantText([]), { text: '', final: false })
})

// ---- 假网关：按路径回包，验证签到/任务/对话链路 ----

function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path: parsed.pathname, body })
    const handler = routes[parsed.pathname]
    if (!handler) return new Response(JSON.stringify({ code: 404, message: 'no route ' + parsed.pathname }), { status: 200 })
    const out = typeof handler === 'function' ? await handler(body, calls.filter((c) => c.path === parsed.pathname).length) : handler
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

test('ask 建会话、发消息、轮询到最终回答并删会话', async () => {
  let polls = 0
  const { fetchImpl, calls } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 12331, token: 'btk_x' }] },
    '/chat/new_session': { code: 0, success: true, data: { session_id: 777 } },
    '/chat/chat_service': { code: 0, success: true, data: { session_id: 777, message_id: 1 } },
    '/chat/message_list_by_session_id': () => {
      polls += 1
      const rows = [{ message_type: 1, message_id: 1, message_content: JSON.stringify({ text: '你好' }) }]
      if (polls >= 1) rows.push({ message_type: 2, message_id: 2, retry_index: 1, is_finish: 1, state: 'chunk', message_content: JSON.stringify({ text: '你' }) })
      if (polls >= 2) rows.push({ message_type: 2, message_id: 3, retry_index: 2, is_finish: 1, state: 'chunk', message_content: JSON.stringify({ text: '你好呀' }) })
      if (polls >= 3) rows.push({ message_type: 2, message_id: 4, retry_index: 3, is_finish: 1, state: 'final', message_content: JSON.stringify({ text: '' }) })
      return { code: 0, success: true, data: rows }
    },
    '/chat/delete': { code: 0, success: true, data: null },
  })
  const deltas = []
  const result = await ask(
    { tk: 'pu', uid: '6810', orgId: 1000 },
    { model: 'deepseek-v4-flash', prompt: '你好', pollMs: 1, onDelta: (d) => deltas.push(d) },
    { fetchImpl },
  )
  assert.equal(result.text, '你好呀')
  assert.deepEqual(deltas, ['你', '好呀'])
  assert.ok(calls.some((c) => c.path === '/chat/delete' && c.body.session_id === 777))
  assert.equal(calls.find((c) => c.path === '/chat/chat_service').body.agent_code, 'AI_CLAW')
})

test('签到钩子：领取墨滴并同步成长计划任务', async () => {
  let activityCalls = 0
  const { fetchImpl } = mockFetch({
    '/activity/getUserCheckinActivity': () => {
      activityCalls += 1
      const total = activityCalls === 1 ? 1000 : 2000
      return {
        code: 0,
        success: true,
        data: {
          activity: { activityId: 36, activityName: '墨宝领墨滴·10期', startTime: '2026-11-21', endTime: '2026-11-30' },
          checkinStat: { checkinStatus: activityCalls === 1 ? 0 : 1, checkinDays: activityCalls === 1 ? 1 : 2, totalPoints: total },
          activityRule: { benefit: { point: 1000, expireDay: 1 } },
        },
      }
    },
    '/activity/dailyCheckin': { code: 0, success: true, data: {} },
    '/activity/queryUserTaskList': {
      code: 0,
      success: true,
      data: [
        { activity: { activityId: 19, activityName: '设置定时任务', endTime: '2027-08-16' }, userTaskRecord: { status: 0, id: null }, activityRule: { ruleType: 14, benefit: { point: 300 } } },
        { activity: { activityId: 22, activityName: '使用审校专家3次', endTime: '2027-08-16' }, userTaskRecord: { status: 2, id: 888 }, activityRule: { ruleType: 17, benefit: { point: 1000 } } },
      ],
    },
    '/activity/addUserTask': { code: 0, success: true, data: { userTaskRecord: { id: 20140, ext: { point: 300 } } } },
    '/activity/earnUserTaskPoint': { code: 0, success: true, data: { userTaskRecord: { id: 888, ext: { point: 1000 } } } },
    '/activity/queryUserActiveList': { code: 0, success: true, data: [{ activeTime: beijingToday() + ' 08:00:00' }] },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const plugin = await MoBookAuthPlugin({})
    const getAuth = async () => ({ type: 'api', key: 'pu', metadata: { tk: 'pu', uid: '6810' } })
    const outcome = await plugin.auth.checkin(getAuth)
    assert.equal(outcome.outcome, 'claimed')
    assert.equal(outcome.credit, 2000)
    assert.match(outcome.message, /签到 \+1000 墨滴/)
    assert.match(outcome.message, /领取任务奖励 1 项/)
    assert.match(outcome.message, /已领取任务 1 项/)
    // 无 magpie 宿主时默认发活跃对话；今日已活跃则跳过（不发会话）。
    assert.match(outcome.message, /今日已活跃，跳过打卡对话/)
  } finally {
    globalThis.fetch = original
  }
})

test('对话请求：非流式返回 OpenAI 形状，流式返回 SSE', async () => {
  let polls = 0
  const { fetchImpl } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 12331, token: 'btk_x' }] },
    '/chat/new_session': { code: 0, success: true, data: { session_id: 555 } },
    '/chat/chat_service': { code: 0, success: true, data: {} },
    '/chat/message_list_by_session_id': () => {
      polls += 1
      return {
        code: 0,
        success: true,
        data: [
          { message_type: 1, message_id: 1, message_content: JSON.stringify({ text: '什么是 ISBN' }) },
          { message_type: 2, message_id: 2, retry_index: 1, is_finish: 1, state: 'chunk', message_content: JSON.stringify({ text: 'ISBN 是国际标准书号' }) },
          { message_type: 2, message_id: 3, retry_index: 2, is_finish: 1, state: 'final', message_content: JSON.stringify({ text: '' }) },
        ],
      }
    },
    '/chat/delete': { code: 0, success: true, data: null },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const cred = { tk: 'pu', uid: '6810', orgId: 1000, agentId: 13 }
    const body = JSON.stringify({ model: 'mobook/deepseek-v4-flash', messages: [{ role: 'user', content: '什么是 ISBN' }] })
    const json = await chatFetch(cred, 'https://api-gateway.shuwenda.com/modelgw/v1/chat/completions', { method: 'POST', body }, { fetchImpl })
    const payload = await json.json()
    assert.equal(payload.choices[0].message.content, 'ISBN 是国际标准书号')
    polls = 0
    const streamBody = JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: '什么是 ISBN' }] })
    const res = await chatFetch(cred, 'https://api-gateway.shuwenda.com/modelgw/v1/chat/completions', { method: 'POST', body: streamBody }, { fetchImpl })
    const text = await res.text()
    assert.match(text, /data: \[DONE\]/)
    assert.match(text, /ISBN 是国际标准书号/)
    assert.match(res.headers.get('content-type'), /event-stream/)
  } finally {
    globalThis.fetch = original
  }
})

test('curatedModels 用实时倍率覆盖启动值，且不夹带旧字段', () => {
  const out = curatedModels(new Map([['glm-5.3', { name: 'GLM-5.3', multiplier: 0.41 }]]))
  assert.equal(out['glm-5.3'].rate, 0.41)
  assert.equal(out['glm-5.3'].multiplier, undefined)
  assert.equal(out['glm-5.3'].name, 'GLM-5.3')
})
test('短信验证码：手机号与验证码先本地校验，再请求墨宝', async () => {
  await assert.rejects(() => sendSmsCode('123'), /手机号/)
  await assert.rejects(() => loginBySms('13800138000', ''), /验证码/)
  const { fetchImpl, calls } = mockFetch({
    '/user/generateCode': { code: 0, success: true, data: true },
    '/user/login': { code: 0, success: true, data: { token: 'puNEW', userId: 6810 } },
  })
  await sendSmsCode('138 0013 8000', { fetchImpl })
  const login = await loginBySms('13800138000', '123456', { fetchImpl })
  assert.equal(login.token, 'puNEW')
  assert.equal(login.uid, '6810')
  assert.equal(login.channel, INVITE_CHANNEL)
  assert.equal(login.isNewUser, false)
  assert.equal(calls[0].body.mobileNo, '13800138000')
  assert.equal(calls[1].body.verificationCode, '123456')
  assert.equal(calls[1].body.channel, INVITE_CHANNEL)
})

const TEST_PHONE = ['138', '0013', '8000'].join('')

test('邀请渠道：默认内置码，环境变量可换可关，新账号标记透传', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/user/login': { code: 0, success: true, data: { token: 'puINV', userId: 6810, isNewUser: 1 } },
  })
  const before = process.env.MOBOOK_INVITE_CHANNEL
  try {
    delete process.env.MOBOOK_INVITE_CHANNEL
    const byDefault = await loginBySms(TEST_PHONE, '123456', { fetchImpl })
    assert.equal(byDefault.channel, INVITE_CHANNEL)
    assert.equal(byDefault.isNewUser, true)
    assert.equal(calls.at(-1).body.channel, INVITE_CHANNEL)

    process.env.MOBOOK_INVITE_CHANNEL = 'someone_else'
    const swapped = await loginBySms(TEST_PHONE, '123456', { fetchImpl })
    assert.equal(swapped.channel, 'someone_else')
    assert.equal(calls.at(-1).body.channel, 'someone_else')

    process.env.MOBOOK_INVITE_CHANNEL = ''
    const off = await loginBySms(TEST_PHONE, '123456', { fetchImpl })
    assert.equal(off.channel, '')
    assert.equal('channel' in calls.at(-1).body, false)

    // 单次调用也能显式关掉或换成别的渠道码
    process.env.MOBOOK_INVITE_CHANNEL = 'should_not_win'
    await loginBySms(TEST_PHONE, '123456', { fetchImpl, channel: '' })
    assert.equal('channel' in calls.at(-1).body, false)
    await loginBySms(TEST_PHONE, '123456', { fetchImpl, channel: 'explicit_code' })
    assert.equal(calls.at(-1).body.channel, 'explicit_code')
  } finally {
    if (before === undefined) delete process.env.MOBOOK_INVITE_CHANNEL
    else process.env.MOBOOK_INVITE_CHANNEL = before
  }
})

test('手机号 + 短信验证码：authorize 先发码，callback 换登录态', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/user/generateCode': { code: 0, success: true, data: true },
    '/user/login': { code: 0, success: true, data: { token: 'puSMS', userId: 6810 } },
    '/user/getUserById': { code: 0, success: true, data: { id: 6810, name: 'LGZA8759', mobile: '156****8759' } },
    '/organization/getApiKeyConfigDetail': {
      code: 0,
      success: true,
      data: {
        openClawProviders: { apiKey: 'dcg-sms-key', baseUrl: 'https://model-gateway.shuwenda.com/v1', api: 'openai-completions', models: [{ id: 'booksgpt' }] },
        defaultModel: 'booksgpt',
        userId: 6810,
        status: 1,
      },
    },
    '/organization/getBotListV3': (body) => body._appId === 200
      // 桌面作用域已有「本插件为该用户生成的那台」客户端（按 uid 生成的名字），应被复用
      ? { code: 0, success: true, data: [{ id: 88827, token: 'btk_dev', name: windowsClientName('6810'), appId: 200 }] }
      : { code: 0, success: true, data: [{ id: 12331, token: 'btk_x', name: 'bot6810_1000', appId: 40 }] },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  setDeviceDetector(async () => ({ uuid: 'uuid-from-test', sn: 'sn-from-test' }))
  setLocalClientAccount(async () => null)
  try {
    const plugin = await MoBookAuthPlugin({})
    const method = plugin.auth.methods.find((m) => m.type === 'oauth')
    assert.ok(method, '有手机号登录方式')
    const stage = await method.authorize({ phone: TEST_PHONE })
    assert.equal(stage.method, 'code')
    assert.equal(stage.url, '')
    assert.match(stage.instructions, /验证码已发送至 138\*\*\*\*8000/)
    assert.match(stage.instructions, new RegExp('邀请渠道 ' + INVITE_CHANNEL))
    assert.equal(calls[0].path, '/user/generateCode')
    assert.equal(calls[0].body.mobileNo, TEST_PHONE)
    const out = await stage.callback('123456')
    assert.equal(out.type, 'success')
    assert.equal(out.access, 'puSMS')
    assert.equal(out.uid, '6810')
    assert.equal(out.accountId, 'LGZA8759')
    assert.equal(out.metadata.tk, 'puSMS')
    assert.equal(out.metadata.channel, INVITE_CHANNEL)
    // 请求作用域保持 web(40)：成长计划任务清单按 _appId 区分，桌面 200 会少任务
    assert.equal(out.metadata.appId, 40)
    assert.equal(out.metadata.platform, 'web')
    // 账号级 API Key：手机号登录也能走原生网关 / 图片 / TTS / ASR
    assert.equal(out.metadata.apiKey, 'dcg-sms-key')
    assert.equal(out.metadata.apiKeyBaseUrl, 'https://model-gateway.shuwenda.com/v1')
    // 登录按客户端发起：/user/login 带 deviceToken 且桌面作用域
    assert.equal(calls[1].body.verificationCode, '123456')
    assert.equal(calls[1].body.channel, INVITE_CHANNEL)
    assert.match(calls[1].body.deviceToken, /^[A-Za-z0-9_-]{43}$/)
    // 与桌面端一致：appId=100→接口 40，靠 deviceToken 登记客户端、不顶网页端
    assert.equal(calls[0].body._appId, 40)
    assert.equal(calls[1].body._appId, 40)
    // 已有客户端设备：复用，不新增登记
    assert.equal(out.metadata.device.mode, 'client')
    assert.equal(out.metadata.device.reused, true)
    assert.equal(out.metadata.device.clientId, 88827)
    assert.equal(out.metadata.device.clientType, 'desktop')
    assert.equal(out.metadata.device.botName, windowsClientName('6810'))
    assert.match(out.metadata.device.localDeviceName, /^DESKTOP-[A-Z0-9]{7}$/)
    assert.match(out.metadata.device.deviceId, /^[A-Za-z0-9_-]{43}$/)
    // 请求作用域仍 web(40)，会话用 web bot
    assert.equal(out.metadata.appId, 40)
    assert.equal(out.metadata.platform, 'web')
    assert.equal(out.metadata.botToken, 'btk_x')
    const botCalls = calls.filter((c) => c.path === '/organization/getBotListV3')
    assert.equal(botCalls.length, 2) // web ensureBot + desktop listBots
    assert.ok(botCalls.every((c) => !('deviceId' in c.body)), '复用时不传 deviceId')
    const configCall = calls.find((c) => c.path === '/organization/getApiKeyConfigDetail')
    assert.ok(configCall)
    assert.equal('deviceId' in configCall.body, false)
  } finally {
    globalThis.fetch = original
    setDeviceDetector(null)
    setLocalClientAccount(null)
  }
})

test('手机号登录：没有客户端时才登记一台（Windows 名称 + deviceId）', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/user/generateCode': { code: 0, success: true, data: true },
    '/user/login': { code: 0, success: true, data: { token: 'puSMS2', userId: 6810 } },
    '/user/getUserById': { code: 0, success: true, data: { id: 6810, name: 'LGZA8759', mobile: '156****8759' } },
    '/organization/getBotListV3': (body) => body._appId === 200
      ? (body.deviceId
        ? { code: 0, success: true, data: [{ id: 9001, token: 'btk_new', name: body.botName, appId: 200 }] }
        : { code: 0, success: true, data: [] })
      : { code: 0, success: true, data: [{ id: 1, token: 'btk_web', name: 'web', appId: 40 }] },
    '/organization/getApiKeyConfigDetail': {
      code: 0, success: true,
      data: { openClawProviders: { apiKey: 'dcg-new', baseUrl: 'https://model-gateway.shuwenda.com/v1', models: [] }, defaultModel: 'm', userId: 6810, status: 1 },
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  setDeviceDetector(async () => ({ uuid: 'u-reg', sn: 's-reg' }))
  setLocalClientAccount(async () => null)
  try {
    const plugin = await MoBookAuthPlugin({})
    const method = plugin.auth.methods.find((m) => m.type === 'oauth')
    const stage = await method.authorize({ phone: TEST_PHONE })
    const out = await stage.callback('123456')
    assert.equal(out.type, 'success')
    assert.equal(out.metadata.device.reused, false)
    assert.match(out.metadata.device.deviceId, /^[A-Za-z0-9_-]{43}$/)
    assert.match(out.metadata.device.botName, /^DESKTOP-[A-Z0-9]{7}$/)
    assert.equal(out.metadata.botToken, 'btk_web')
    const botCalls = calls.filter((c) => c.path === '/organization/getBotListV3')
    assert.equal(botCalls.length, 3) // web ensureBot + desktop list + desktop register
    const reg = botCalls.find((c) => c.body.deviceId)
    assert.ok(reg, '登记客户端时传 deviceId')
    assert.equal(reg.body._appId, 200)
    assert.equal(reg.body.deviceId, out.metadata.device.deviceId)
    assert.equal(reg.body.botName, out.metadata.device.botName)
    const configCall = calls.find((c) => c.path === '/organization/getApiKeyConfigDetail')
    assert.equal('deviceId' in configCall.body, false)
  } finally {
    globalThis.fetch = original
    setDeviceDetector(null)
    setLocalClientAccount(null)
  }
})
test('手机号登录：号码不合法或发码失败都返回 failed 而不是抛异常', async () => {
  const plugin = await MoBookAuthPlugin({})
  const method = plugin.auth.methods.find((m) => m.type === 'oauth')
  // 失败也按宿主契约返回 {url,instructions,method,callback}，原因在 callback 的返回值里
  const badStage = await method.authorize({ phone: '123' })
  assert.equal(typeof badStage.callback, 'function')
  const bad = await badStage.callback()
  assert.equal(bad.type, 'failed')
  assert.match(bad.error, /11 位/)
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 500, success: false, message: '短信通道繁忙' }), { status: 200 })
  try {
    const failedStage = await method.authorize({ phone: TEST_PHONE })
    assert.equal(typeof failedStage.callback, 'function')
    const failed = await failedStage.callback()
    assert.equal(failed.type, 'failed')
    assert.match(failed.error, /验证码发送失败/)
  } finally {
    globalThis.fetch = original
  }
})

test('墨滴流水：获得与消耗分开合计，并按批次算出到期池子', async () => {
  // 固定时间锚：mock Date.now 到月中固定时刻（2026-06-15 12:00 北京时间 = 04:00 UTC）。
  // 「未过期批次」与「最近一次到期」全部确定，不再依赖运行日期。
  const realNow = Date.now
  const ANCHOR = Date.parse('2026-06-15T04:00:00Z')
  Date.now = () => ANCHOR
  try {
  const nowSecs = Math.floor(Date.now() / 1000)
  const { fetchImpl } = mockFetch({
    '/point/getUserPointFlowInfo': (body) => {
      if (body.flowQueryType === 1) {
        return { code: 0, success: true, data: { pageNo: 1, pageSize: 200, totalCount: 3, list: [
          { pointAmount: 30000, batchId: 301, desc: '充值', batchPointStatus: 1, batchPointExpiryDate: nowSecs + 2592000, gmtCreated: nowSecs - 2592000 },
          { pointAmount: 1000, batchId: 302, desc: '墨宝加油站', batchPointStatus: 1, batchPointExpiryDate: nowSecs + 1000, gmtCreated: nowSecs - 85400 },
          { pointAmount: 5000, batchId: 303, desc: '过期礼包', batchPointStatus: -1, batchPointExpiryDate: nowSecs - 86400, gmtCreated: nowSecs - 950400 },
        ] } }
      }
      return { code: 0, success: true, data: { pageNo: 1, pageSize: 200, totalCount: 3, list: [
        { pointAmount: 312, batchId: 302, desc: '模型墨滴消耗', gmtCreated: nowSecs - 60 },
        { pointAmount: 200, batchId: 302, desc: '墨滴到期', gmtCreated: nowSecs - 90000 },
        { pointAmount: 1000, batchId: 303, desc: '过期批次消耗', gmtCreated: nowSecs - 172800 },
      ] } }
    },
  })
  const ledger = await fetchLedgerTotals({ tk: 'pu', uid: '6810' }, { accountId: 6478 }, { fetchImpl })
  // 过期批次（303）的额度整体剔除；分母只算未过期批次。
  assert.equal(ledger.income, 31000)
  assert.equal(ledger.expiredCount, 1)
  // 支出按 batchId 归属：302 被扣掉 312+200=512，剩 488；301 没被扣。
  // 有效期一天左右的 302 是「今日积分」，进不了长期池子，所以 pools 只有 301。
  assert.equal(ledger.pools.length, 1)
  assert.equal(ledger.pools[0].batchId, 301)
  assert.equal(ledger.pools[0].spent, 0)
  assert.equal(ledger.pools[0].remaining, 30000)
  // 最近一次到期来自 302（now+1000s），那一刻作废的正是它剩下的 488。
  assert.equal(ledger.nearestExpiry, (nowSecs + 1000) * 1000)
  assert.equal(ledger.expiringAtNearest, 488)
  assert.equal(ledger.truncated, false)
  } finally {
    Date.now = realNow
  }
})

test('用量卡：已用 = 未过期发放 − 余额，录音时长与活跃地图并列', async () => {
  const nowSecs = Math.floor(Date.now() / 1000)
  const { fetchImpl } = mockFetch({
    // 余额与批次自洽：1000（日额度 − 已用 500）+ 30000（充值）= 30500
    '/point/getUserPointAccount': { code: 0, success: true, data: { id: 6478, pointAmount: 30500 } },
    '/resource/getRecordingDurationConfig': { code: 0, success: true, data: { freeDurationSeconds: 3600, remainingFreeSeconds: 0, usedDurationSeconds: 3600, exchangePoints: 5, exchangeSeconds: 60, billingEnabled: true } },
    '/activity/queryUserActiveStat': { code: 0, success: true, data: { userActiveStat: { activeDays: 2 }, userActiveReward: { ext: { makeupCardCounts: 1 } } } },
    '/activity/queryUserActiveList': { code: 0, success: true, data: [{ activeTime: '2026-11-24T10:00:00' }, { activeTime: '2026-11-25T08:50:01' }] },
    '/point/getUserPointFlowInfo': (body) => {
      if (body.flowQueryType === 1) {
        return { code: 0, success: true, data: { pageNo: 1, pageSize: 200, totalCount: 2, list: [
          { pointAmount: 1000, batchId: 401, desc: '墨宝加油站', batchPointStatus: 1, batchPointExpiryDate: nowSecs + 6000, gmtCreated: nowSecs - 80400 },
          { pointAmount: 30000, batchId: 402, desc: '充值', batchPointStatus: 1, batchPointExpiryDate: nowSecs + 2592000, gmtCreated: nowSecs - 2592000 },
        ] } }
      }
      return { code: 0, success: true, data: { pageNo: 1, pageSize: 200, totalCount: 1, list: [
        { pointAmount: 500, batchId: 401, desc: '模型墨滴消耗', gmtCreated: nowSecs - 60 },
      ] } }
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const plugin = await MoBookAuthPlugin({})
    const getAuth = async () => ({ type: 'api', key: 'pu', metadata: { tk: 'pu', uid: '6810' } })
    const usage = await plugin.auth.usage(getAuth)
    const names = usage.windows.map((w) => w.name)
    assert.equal(names[0], '墨滴用量')
    assert.equal(usage.windows[0].amount, 500)
    assert.equal(usage.windows[0].limit, 31000)
    // 分子分母与卡片余额必须自洽：已用 + 余额 = 发放总和
    assert.equal(usage.windows[0].amount + 30500, usage.windows[0].limit)
    // 到期提示用 runsOutAt/runsOut（「N 墨滴 将于 … 过期」），不用 resetsAt（「重置于」）
    assert.equal(usage.windows[0].resetsAt, undefined)
    assert.match(usage.windows[0].runsOutAt, /^20\d\d-\d\d-\d\dT/)
    assert.equal(usage.windows[0].runsOut, 500)
    assert.match(usage.windows[0].display, /500 墨滴将于 .* 过期/)
    assert.equal(names[1], '充值/礼包（1 笔）')
    assert.equal(usage.windows[1].balance, 30000)
    assert.match(usage.windows[1].runsOutAt, /^20\d\d-\d\d-\d\dT/)
    assert.equal(usage.windows[1].runsOut, 30000)
    assert.equal(names[2], '录音时长')
    assert.match(usage.windows[2].display, /已用 \d+ 分钟 · \d+ 积分/)
    // 卡片上不再带免费额度/超出计费这类说明文字
    assert.ok(!/免费|超出/.test(usage.windows[2].display))
    assert.equal(names[3], '活跃地图')
    assert.match(usage.windows[3].display, /连续活跃 \d+ 天 · 补登卡 x 1/)
    assert.ok(!names.includes('墨滴余额'))
    assert.ok(!names.includes('今日积分（墨宝加油站）'))
    assert.ok(!names.includes('今日消耗'))
    assert.ok(!names.join(' ').includes('到期'))
  } finally {
    globalThis.fetch = original
  }
})

test('appIdForApi 按客户端约定映射', () => {
  assert.equal(appIdForApi(100), 40)
  assert.equal(appIdForApi(110, 'win32'), 200)
  assert.equal(appIdForApi(110, 'darwin'), 210)
  assert.equal(appIdForApi(70), 70)
})

test('imageSizeFor 把像素换成 1K/1.5K/2K', () => {
  assert.equal(imageSizeFor('1024x1024'), '1K')
  assert.equal(imageSizeFor('1536x1024'), '1.5K')
  assert.equal(imageSizeFor('2048x2048'), '2K')
  assert.equal(imageSizeFor('2k'), '2K')
  assert.equal(imageSizeFor('1.5k'), '1.5K')
  assert.equal(imageSizeFor(''), undefined)
})

test('normalizeChatPayload 把网关的 delta 改成 message', () => {
  const payload = { object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }] }
  normalizeChatPayload(payload)
  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.choices[0].message.content, '收到')
  assert.equal(payload.choices[0].delta, undefined)
})

test('sseModelRewriter 改写 SSE 里的 model', async () => {
  const input = 'data: {"model":"upstream","choices":[]}\n\ndata: [DONE]\n\n'
  const stream = new Blob([input]).stream().pipeThrough(sseModelRewriter('wanted'))
  const out = await new Response(stream).text()
  assert.match(out, /"model":"wanted"/)
  assert.ok(!out.includes('upstream'))
  assert.match(out, /\[DONE\]/)
})

test('readClientState 读 mobook.json 与 .credentials.yaml', async () => {
  const os = await import('node:os')
  const fsp = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'mobook-harness-'))
  await fsp.writeFile(pathMod.join(dir, 'mobook.json'), JSON.stringify({
    version: 1, environment: 'production', appVersion: '0.5.7',
    servers: { apiGatewayBaseUrl: 'https://api-gateway.shuwenda.com' },
    account: { wsUrl: 'wss://x/ws', botToken: 'btk_test', userId: '6810', appId: '110', domainId: '1000' },
    hardware: { fingerprint: 'a'.repeat(64), fingerprintVersion: 'hardware-v1', uuid: 'uuid-1', sn: 'sn-1' },
  }), 'utf8')
  await fsp.writeFile(pathMod.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  MOBOOK_API_KEY: dcg-test-key\n', 'utf8')
  const state = await readClientState({ home: dir })
  assert.equal(state.hardware.fingerprint, 'a'.repeat(64))
  assert.equal(state.hardware.fingerprintVersion, 'hardware-v1')
  assert.equal(state.apiKey, 'dcg-test-key')
  assert.equal(state.botToken, 'btk_test')
  assert.equal(state.uid, '6810')
  assert.equal(state.appId, 110)
  assert.equal(state.environment, 'production')
  await assert.rejects(() => readClientState({ home: pathMod.join(dir, 'nope') }), /没有找到墨宝客户端数据/)
})

test('exchangeUserToken 用 botToken 换用户令牌', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/organization/queryUserTokenByBotTokenV2': { code: 0, success: true, data: { token: 'utok', expirationDate: 1796776899, expirationSeconds: 1209600 } },
  })
  const got = await exchangeUserToken({ botToken: 'btk_x', uid: '6810', appId: 110 }, { fetchImpl })
  assert.equal(got.token, 'utok')
  assert.equal(got.expiresAt, 1796776899000)
  assert.equal(calls[0].body.botToken, 'btk_x')
  assert.equal(calls[0].body._appId, 200)
})

test('gatewayFetch 把 /images/generations 转到墨宝 v3 并改写尺寸', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)), auth: init.headers.authorization })
    return new Response(JSON.stringify({ model: 'doubao-seedream', data: [{ url: 'https://img.example/x.jpeg' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const cred = { apiKey: 'dcg-key' }
  const res = await gatewayFetch(cred, 'https://model-gateway.shuwenda.com/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: '一只猫', size: '1024x1024' }) }, { fetchImpl })
  const payload = await res.json()
  assert.match(seen[0].url, /\/v3\/images\/generations$/)
  assert.equal(seen[0].body.size, '1K')
  assert.equal(seen[0].body.prompt, '一只猫')
  assert.equal(seen[0].auth, 'Bearer dcg-key')
  assert.equal(payload.data[0].url, 'https://img.example/x.jpeg')
})

test('imageModels 声明一个只画图的模型', () => {
  const models = imageModels()
  assert.deepEqual(Object.keys(models), ['mobook-image'])
  const row = models['mobook-image']
  assert.equal(row.capabilities.toolcall, false)
  assert.equal(row.capabilities.output.image, true)
  assert.equal(row.capabilities.output.text, false)
  assert.equal(row.api.npm, '@ai-sdk/openai-compatible')
})

test('gatewayFetch 也能接只有 prompt 的画图请求', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ model: 'doubao-seedream', data: [{ url: 'https://img.example/y.jpeg' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const res = await gatewayFetch({ apiKey: 'dcg-key' }, 'https://model-gateway.shuwenda.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ prompt: '一只猫' }) }, { fetchImpl })
  const payload = await res.json()
  assert.match(seen[0].url, /\/v3\/images\/generations$/)
  assert.equal(payload.data[0].url, 'https://img.example/y.jpeg')
})

test('speak 走 /v3/tts/create 并解出 MP3', async () => {
  const seen = []
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)), auth: init.headers.authorization })
    return new Response(JSON.stringify({ audio: mp3.toString('base64'), duration: 1.2 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const out = await speak({ apiKey: 'dcg-key' }, { text: '你好', voice: 'v1' }, { fetchImpl })
  assert.equal(seen[0].url, 'https://model-gateway.shuwenda.com/v3/tts/create')
  assert.equal(seen[0].body.model, 'seed-audio-1.0')
  assert.equal(seen[0].body.text_prompt, '你好')
  assert.deepEqual(seen[0].body.references, [{ speaker: 'v1' }])
  assert.equal(seen[0].body.audio_config.format, 'mp3')
  assert.equal(out.contentType, 'audio/mpeg')
  assert.deepEqual([...out.bytes], [...mp3])
  assert.equal(out.duration, 1.2)
})

test('speechModels 声明一个语音合成模型', () => {
  const row = speechModels()['mobook-tts']
  assert.equal(row.capabilities.output.audio, true)
  assert.equal(row.capabilities.output.text, false)
  assert.equal(row.api.id, 'seed-audio-1.0')
})

test('gatewayFetch 把 /audio/speech 转成 TTS，转写失败时给出解码错误', async () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  const fetchImpl = async () => new Response(JSON.stringify({ audio: mp3.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } })
  const res = await gatewayFetch({ apiKey: 'dcg-key' }, 'https://model-gateway.shuwenda.com/v1/audio/speech', { method: 'POST', body: JSON.stringify({ model: 'mobook/mobook-tts', input: '你好' }) }, { fetchImpl })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  const asr = await gatewayFetch({ apiKey: 'dcg-key' }, 'https://model-gateway.shuwenda.com/v1/audio/transcriptions', { method: 'POST', body: 'not-audio' }, { fetchImpl })
  assert.equal(asr.status, 502)
  assert.match((await asr.json()).error.message, /音频解码失败/)
})

test('parseWavToPcm16k 解 WAV 并重采样到 16k 单声道', () => {
  const samples = new Int16Array([100, -100, 200, -200])
  const data = Buffer.from(samples.buffer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  const pcm = parseWavToPcm16k(Buffer.concat([header, data]))
  assert.ok(pcm)
  assert.deepEqual([...new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)], [100, -100, 200, -200])
  assert.equal(parseWavToPcm16k(Buffer.from('RIFFxxxxWAVE')), null)
})

test('parseMultipartAudio 取出音频文件', () => {
  const ct = 'multipart/form-data; boundary=----x'
  const body = Buffer.from('------x\r\nContent-Disposition: form-data; name="model"\r\n\r\nmobook/mobook-tts\r\n------x\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nWAVDATA\r\n------x--\r\n')
  const out = parseMultipartAudio(ct, body)
  assert.equal(out.filename, 'a.wav')
  assert.equal(out.contentType, 'audio/wav')
  assert.equal(out.bytes.toString('ascii'), 'WAVDATA')
})

test('allModels：在售模型保留窗口，历史 id 按默认窗口收进来', () => {
  const show = new Map([
    ['deepseek-v4-flash', { name: 'DeepSeek-Flash', multiplier: 0.03 }],
    ['deepseek-v4-flash-l3', { name: 'deepseek-v4-flash-l3', multiplier: undefined }],
  ])
  const rows = allModels(['deepseek-v4-flash', 'deepseek-v4-flash-l3', 'test-xyz'], show)
  assert.equal(rows['deepseek-v4-flash'].rate, 0.03)
  assert.equal(rows['deepseek-v4-flash'].limit.context, 1048576)
  assert.equal(rows['deepseek-v4-flash-l3'].limit.context, 262144)
  assert.equal(rows['deepseek-v4-flash-l3'].rate, undefined)
  assert.equal(rows['test-xyz'], undefined)
})

test('插件声明 show_all_models 开关，默认关闭', async () => {
  const plain = await MoBookAuthPlugin({})
  assert.ok(plain.auth.options.some((o) => o.key === SHOW_ALL_MODELS))
  const withMagpie = await MoBookAuthPlugin({ magpie: { option: (provider, key) => provider === 'mobook' && key === SHOW_ALL_MODELS } })
  assert.equal(typeof withMagpie.auth.usage, 'function')
})


test('runTasks：补领任务并领取已完成奖励', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/activity/queryUserTaskList': { code: 0, success: true, data: [
      { activity: { activityId: 19, activityName: '设置定时任务', endTime: '2027-08-16' }, userTaskRecord: { status: 0, id: null }, activityRule: { ruleType: 14, benefit: { point: 300 } } },
      { activity: { activityId: 20, activityName: '桌面端墨宝对话1次', endTime: '2027-08-16' }, userTaskRecord: { status: 2, id: 20161 }, activityRule: { ruleType: 15, benefit: { point: 100 } } },
    ] },
    '/activity/addUserTask': { code: 0, success: true, data: { userTaskRecord: { id: 20140, ext: { point: 300 } } } },
    '/activity/earnUserTaskPoint': { code: 0, success: true, data: { userTaskRecord: { id: 20161, ext: { point: 100 } } } },
  })
  const out = await runTasks({ tk: 'pu', uid: '6810' }, { deps: { fetchImpl }, autoActions: false })
  assert.deepEqual(out.joined, ['设置定时任务'])
  assert.equal(out.claimed.length, 1)
  assert.equal(out.claimed[0].point, 100)
  assert.equal(out.credit, 100)
  assert.ok(calls.some((c) => c.path === '/activity/addUserTask'))
  assert.ok(calls.some((c) => c.path === '/activity/earnUserTaskPoint'))
})

test('小程序/审校批注不算可自动化任务；录音笔记算（5 分钟段落 JSON 路径）', async () => {
  const { isAutomatable } = await import('./task-state.mjs')
  assert.equal(isAutomatable({ ruleType: 23, title: '新建录音笔记' }), true)
  assert.equal(isAutomatable({ ruleType: 23, title: '新建图片笔记体验AI总结' }), true)
  assert.equal(isAutomatable({ ruleType: 20, title: '审校批注送墨滴' }), false)
  assert.equal(isAutomatable({ ruleType: 16, title: '小程序端墨宝对话1次' }), false)
})

test('recordingTranscriptJson 生成服务端认可的段落结构', async () => {
  const { recordingTranscriptJson } = await import('./api.mjs')
  const doc = JSON.parse(recordingTranscriptJson('第一句内容。第二句内容。', 330000))
  assert.equal(doc.provider, 'tencent')
  assert.equal(doc.paragraphs.length, 2)
  for (const p of doc.paragraphs) {
    assert.equal(typeof p.text, 'string')
    assert.equal(typeof p.startMs, 'number')
    assert.equal(typeof p.endMs, 'number')
    assert.equal(p.isFinal, true)
    assert.equal(typeof p.sentenceId, 'string')
  }
  assert.ok(doc.paragraphs[1].endMs <= 330000)
})

test('登录方式文案不再声称会顶掉其他会话', async () => {
  const plugin = await MoBookAuthPlugin({})
  const methods = plugin.auth?.methods ?? []
  for (const m of methods) {
    assert.doesNotMatch(String(m.label ?? ''), /顶掉/)
  }
  const sms = methods.find((m) => /短信验证码/.test(String(m.label ?? '')))
  assert.ok(sms, '有手机号登录方式')
  assert.match(sms.label, /不顶其他会话/)
})

test('新增账号提供“导入本机客户端登录态”方式（复用客户端类型/设备指纹/名称）', async () => {
  const plugin = await MoBookAuthPlugin({})
  const methods = plugin.auth?.methods ?? []
  assert.ok(Array.isArray(methods) && methods.length >= 3)
  const local = methods.find((m) => /本机客户端/.test(String(m.label ?? '')))
  assert.ok(local, '缺少导入本机客户端登录态的方式')
  assert.equal(local.type, 'oauth')
  assert.equal(typeof local.authorize, 'function')
})

test('插件不依赖浏览器：源码与依赖里没有浏览器自动化库', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const files = ['index.mjs', 'api.mjs', 'task-runner.mjs', 'opencode2.mjs', 'models.mjs', 'device.mjs']
  const pat = /playwright|puppeteer|selenium|webdriver|chromedriver|ego[-_]?browser|jsdom/i
  for (const f of files) {
    const text = fs.readFileSync(path.join(here, f), 'utf8')
    assert.equal(pat.test(text), false, f + ' 含有浏览器自动化依赖')
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dependencies ?? {}, {})
  assert.deepEqual(pkg.devDependencies ?? {}, {})
})

test('cloneCodeOf 生成网页同款 clone code（reviser-expert-1-0-45-45）', async () => {
  const { cloneCodeOf } = await import('./api.mjs')
  assert.equal(cloneCodeOf({ code: 'reviser-expert', version: '1.0.45' }), 'reviser-expert-1-0-45-45')
  assert.equal(cloneCodeOf({ code: 'reviserchief-expert', version: '2.0.1' }), 'reviserchief-expert-2-0-1-1')
  assert.equal(cloneCodeOf({ code: '' }), '')
})

test('specialistChat 用专家产品会话字段建会话并发消息', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 12331, token: 'btk_x' }] },
    '/chat/new_session': { code: 0, success: true, data: { session_id: 645371 } },
    '/chat/chat_service': { code: 0, success: true, data: { session_id: 645371, message_id: 1 } },
  })
  const sid = await specialistChat({ tk: 'pu', uid: '6810' }, { agentId: 35, text: '你好', version: '1.0.45', cloneCode: 'reviser-expert-1-0-45-45' }, { fetchImpl })
  assert.equal(sid, 645371)
  const create = calls.find((c) => c.path === '/chat/new_session')
  assert.equal(create.body.agent_id, 35)
  assert.equal(create.body.agent_type, 'specialist')
  assert.equal(create.body.version, '1.0.45')
  const chat = calls.find((c) => c.path === '/chat/chat_service')
  assert.equal(chat.body.agent_code, 'CHAT')
  assert.equal(chat.body.agent_clone_code, 'reviser-expert-1-0-45-45')
  // 网页端的专家会话不带 model（带了会退化成普通对话）
  assert.equal('model' in chat.body, false)
})

test('网关改写模型名时不沿用上游的头部：content-length/content-encoding 必须丢掉', async () => {
  // 上游会改写模型名（deepseek-flash -> 用户请求的那个），长度必然不同；
  // 沿用上游的 content-length 会让客户端按旧长度读，直接断连。
  const { fetchImpl } = mockFetch({
    '/v1/chat/completions': { model: 'deepseek-flash', choices: [{ delta: { content: '你好' } }] },
  })
  const res = await gatewayFetch(
    { tk: 'pu', uid: '1', apiKey: 'dcg-x' },
    'https://model-gateway.shuwenda.com/v1/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mobook/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }) },
    { fetchImpl },
  )
  assert.equal(res.headers.get('content-length'), null, 'content-length 必须丢掉，让宿主按实际正文重算')
  assert.equal(res.headers.get('content-encoding'), null, 'content-encoding 必须丢掉（正文已不是上游那份编码）')
  const payload = await res.json()
  assert.equal(payload.model, 'mobook/deepseek-v4-flash', '模型名已换回用户请求的那个')
  assert.equal(payload.choices[0].message.content, '你好')
})

test('三条登录方式都按宿主契约返回 {url,instructions,method,callback}', async () => {
  // 契约（插件 README）：authorize 返回 {url, instructions, method, callback}。
  // 直接返回 {type:'success'} 在 OpenCode 2.x 的适配器里会崩（那边只走 r.callback()）。
  const plugin = await MoBookAuthPlugin({})
  for (const method of plugin.auth.methods) {
    const stage = await method.authorize({})
    assert.equal(typeof stage.callback, 'function', method.label + ' 缺 callback')
    assert.ok('url' in stage, method.label + ' 缺 url')
    assert.ok('instructions' in stage, method.label + ' 缺 instructions')
    assert.ok(stage.method === 'auto' || stage.method === 'code', method.label + ' 的 method 不合契约')
    assert.equal(stage.type, undefined, method.label + ' 不该在 authorize 阶段直接给结果')
  }
})

test('规则 25 不再算可自动化（网页端规则枚举里没有这一条）', async () => {
  const { isAutomatable } = await import('./task-state.mjs')
  // 网页端自己的枚举：UseExpert:12 UseSkill:13 UseScheduleTask:14 DesktopChat:15
  // MiniProgramChat:16 UseExpertTimes:17 UseMultipleExpert:18 UseMultipleSkill:19
  // ReviewAnnotation:20 Knowledge:22 KnowledgeSecondary:23 —— 没有 25。
  assert.equal(isAutomatable({ ruleType: 25 }), false, '25 没有对应动作，不能算进进度')
  for (const rule of [12, 13, 14, 15, 17, 18, 19, 22, 23]) {
    assert.equal(isAutomatable({ ruleType: rule }), true, rule + ' 应算可自动化')
  }
  assert.equal(isAutomatable({ ruleType: 16 }), false)
  assert.equal(isAutomatable({ ruleType: 20 }), false)
})

test('runner 存活判定看心跳而不是 PID：PID 被回收再分配也不会误判', () => {
  const uid = '70099'
  const paths = taskPaths(uid)
  mkdirSync(paths.dir, { recursive: true })
  try {
    // 没有心跳 → 视为没在跑（判活只看心跳，不看 PID）
    assert.equal(taskRunAlivePublic(uid), false, '没有心跳就不算在跑')
    // 心跳是新的 → 在跑
    writeFileSync(paths.heartbeat, String(Date.now()))
    assert.equal(taskRunAlivePublic(uid), true, '心跳新鲜 = 还在跑')
    // 心跳过期（进程被杀时就是这个状态）→ 视为没在跑，父进程才能再起一个
    writeFileSync(paths.heartbeat, String(Date.now() - 10 * 60 * 1000))
    assert.equal(taskRunAlivePublic(uid), false, '心跳过期 = 已经被杀掉了')
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('插件暴露 task_status / tasks 两个智能体工具', async () => {
  const plugin = await MoBookAuthPlugin({})
  assert.ok(plugin.tool.task_status)
  assert.equal(plugin.tool.task_status.args.type, 'object')
  assert.ok(plugin.tool.tasks)
  assert.equal(plugin.tool.tasks.args.properties.actions.type, 'boolean')
})

test('cleanupArtifacts 删除会话与内容', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 12331, token: 'btk_x' }] },
    '/chat/delete': { code: 0, success: true, data: null },
    '/resource/deleteContent': { code: 0, success: true, data: null },
  })
  const out = await cleanupArtifacts({ tk: 'pu', uid: '6810' }, { sessions: [645968], contents: [678315] }, { fetchImpl })
  assert.equal(out.sessions, 1)
  assert.equal(out.contents, 1)
  assert.deepEqual(out.failed, [])
  assert.ok(calls.some((c) => c.path === '/chat/delete'))
  assert.equal(calls.find((c) => c.path === '/resource/deleteContent').body.id, 678315)
})

test('fetchApiKeyConfig 取账号级 key，且请求不带 deviceId', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/organization/getApiKeyConfigDetail': {
      code: 0,
      success: true,
      data: {
        openClawProviders: { apiKey: 'dcg-sms-key', baseUrl: 'https://model-gateway.shuwenda.com/v1', api: 'openai-completions', models: [{ id: 'booksgpt' }] },
        defaultModel: 'booksgpt',
        userId: 6810,
        status: 1,
      },
    },
  })
  const cfg = await fetchApiKeyConfig({ tk: 'pu', uid: '6810' }, { fetchImpl })
  assert.equal(cfg.apiKey, 'dcg-sms-key')
  assert.equal(cfg.baseUrl, 'https://model-gateway.shuwenda.com/v1')
  assert.equal(cfg.defaultModel, 'booksgpt')
  assert.equal(cfg.models.length, 1)
  assert.equal('deviceId' in calls[0].body, false)
  assert.equal(calls[0].body._appId, 40)
})

test('fetchApiKeyConfig：网页作用域没 key 时换桌面作用域（200/210）再取', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(String(init.body))
    seen.push({ appId: body._appId, platform: init.headers.platform, deviceId: body.deviceId })
    const data = body._appId === 40
      ? { openClawProviders: {}, status: -1 }
      : { openClawProviders: { apiKey: 'dcg-desktop-key', baseUrl: 'https://model-gateway.shuwenda.com/v1', api: 'openai-completions', models: [{ id: 'booksgpt' }] }, defaultModel: 'booksgpt', userId: 83594, status: 1 }
    return new Response(JSON.stringify({ code: 0, success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const cfg = await fetchApiKeyConfig({ tk: 'pu', uid: '83594' }, { fetchImpl })
  assert.equal(cfg.apiKey, 'dcg-desktop-key')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].appId, 40)
  assert.equal(seen[1].appId, process.platform === 'darwin' ? 210 : 200)
  assert.equal(seen[1].platform, 'desktop')
  assert.equal(seen[1].deviceId, undefined)
})

test('设备身份：hardware-v1 指纹与账号派生确定且稳定', () => {
  const base = fingerprintOf({ uuid: 'ABC-123-UID', sn: 'SN-ABC' }, 'win32')
  assert.match(base, /^[0-9a-f]{64}$/)
  // 归一化：大小写/空白不同也得到同一个指纹
  assert.equal(base, fingerprintOf({ uuid: ' abc-123-uid ', sn: 'sn-abc' }, 'win32'))
  assert.notEqual(base, fingerprintOf({ uuid: 'ABC-123-UID', sn: 'SN-ABC' }, 'darwin'))
  const one = accountFingerprint(base, '6810')
  assert.equal(one, accountFingerprint(base, '6810'))
  assert.notEqual(one, accountFingerprint(base, '6811'))
})

test('usableSignal 过滤 OEM 占位序列号', () => {
  assert.equal(usableSignal('Default string'), '')
  assert.equal(usableSignal('00000000-0000-0000-0000-000000000000'), '')
  assert.equal(usableSignal('To be filled by O.E.M.'), '')
  assert.equal(usableSignal('SN123456789'), 'SN123456789')
})

test('resolveDevice：复用态照搬客户端，生成态按账号派生', async () => {
  const reused = await resolveDevice({
    uid: '6810',
    mode: 'reuse',
    clientState: { hardware: { fingerprint: 'a'.repeat(64), fingerprintVersion: 'hardware-v1' } },
  })
  assert.equal(reused.mode, 'reuse')
  assert.equal(reused.fingerprint, 'a'.repeat(64))
  const detect = async () => ({ uuid: 'u-1', sn: 's-1' })
  const first = await resolveDevice({ uid: '6810', mode: 'web', platform: 'win32', detect })
  const again = await resolveDevice({ uid: '6810', mode: 'web', platform: 'win32', detect })
  const other = await resolveDevice({ uid: '6811', mode: 'web', platform: 'win32', detect })
  assert.equal(first.mode, 'web')
  assert.equal(first.fingerprint, again.fingerprint)
  assert.notEqual(first.fingerprint, other.fingerprint)
  // 本地生成的客户端名称按 uid 固定（与机器无关），同号恒定、不同号不同
  assert.equal(first.botName, windowsClientName('6810'))
  assert.equal(first.botName, again.botName)
  assert.equal(other.botName, windowsClientName('6811'))
  assert.notEqual(first.botName, other.botName)
})

test('windowsClientName：DESKTOP-<MD5(用户名) 前 7 位>，每个用户唯一且固定', () => {
  // 中间 7 位就是 MD5(uid) 的前 7 位大写十六进制
  const expect = (uid) => 'DESKTOP-' + createHash('md5').update(uid, 'utf8').digest('hex').toUpperCase().slice(0, 7)
  for (const uid of ['83594', '6810', '12345678901']) {
    assert.equal(windowsClientName(uid), expect(uid))
    assert.match(windowsClientName(uid), /^DESKTOP-[0-9A-F]{7}$/)
  }
  // 同一个用户永远同一个名字；不同用户不同
  assert.equal(windowsClientName('83594'), windowsClientName('83594'))
  assert.notEqual(windowsClientName('83594'), windowsClientName('6810'))
  // 已知值：83594 → DESKTOP-5E06574
  assert.equal(windowsClientName('83594'), 'DESKTOP-5E06574')
})

test('成长计划的日志与 pid 按账号分目录', () => {
  const a = taskPaths('6810')
  const b = taskPaths('6811')
  assert.notEqual(a.log, b.log)
  assert.match(a.log, /[\\/]+6810[\\/]+latest\.jsonl$/)
  assert.match(taskPaths('').log, /[\\/]+default[\\/]+latest\.jsonl$/)
})

test('粘贴 _tk：oauth 形状 + 账号级 key + 派生设备', async () => {
  const { fetchImpl } = mockFetch({
    '/user/getUserById': { code: 0, success: true, data: { id: 6810, name: 'LGZA8759', mobile: '156****8759' } },
    '/organization/getApiKeyConfigDetail': {
      code: 0,
      success: true,
      data: { openClawProviders: { apiKey: 'dcg-sms-key', baseUrl: 'https://model-gateway.shuwenda.com/v1', api: 'openai-completions', models: [] }, defaultModel: 'booksgpt', userId: 6810, status: 1 },
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  setDeviceDetector(async () => ({ uuid: 'u-1', sn: 's-1' }))
  setLocalClientAccount(async () => null)
  try {
    const plugin = await MoBookAuthPlugin({})
    const method = plugin.auth.methods.find((m) => m.label.includes('粘贴整段 Cookie'))
    assert.ok(method)
    // 直接给 session 时也按宿主契约返回 {url,instructions,method,callback}，
    // 登录结果在 callback 里。（1.x / magpie 宿主两种形状都认，2.x 只认这种。）
    const stage = await method.authorize({ session: '_tk=puPASTE; _uid=6810' })
    assert.equal(typeof stage.callback, 'function')
    const out = await stage.callback()
    assert.equal(out.type, 'success')
    assert.equal(out.access, 'puPASTE')
    assert.equal(out.accountId, 'LGZA8759')
    assert.equal(out.uid, '6810')
    assert.equal(out.metadata.apiKey, 'dcg-sms-key')
    assert.equal(out.metadata.device.mode, 'web')
    // web Cookie 账号请求作用域必须是 40，不能兜底成桌面 200
    assert.equal(out.metadata.appId, 40)
    assert.equal(out.metadata.platform, 'web')
  } finally {
    globalThis.fetch = original
    setDeviceDetector(null)
    setLocalClientAccount(null)
  }
})

test('粘贴 Cookie：先打开墨宝登录页，再由 callback 粘回 Cookie 完成登录', async () => {
  const { fetchImpl } = mockFetch({
    '/user/getUserById': { code: 0, success: true, data: { id: 6810, name: 'LGZA8759', mobile: '156****8759' } },
    '/organization/getApiKeyConfigDetail': {
      code: 0, success: true,
      data: { openClawProviders: { apiKey: 'dcg-sms-key', baseUrl: 'https://model-gateway.shuwenda.com/v1', models: [] }, defaultModel: 'booksgpt', userId: 6810, status: 1 },
    },
    '/organization/getBotListV3': { code: 0, success: true, data: [] },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  setDeviceDetector(async () => ({ uuid: 'u-1', sn: 's-1' }))
  setLocalClientAccount(async () => null)
  try {
    const plugin = await MoBookAuthPlugin({})
    const method = plugin.auth.methods.find((m) => m.label.includes('粘贴整段 Cookie'))
    assert.ok(method)
    // 第一步：不传 session → 返回“打开浏览器 + 回填”的阶段
    const stage = await method.authorize({})
    assert.equal(stage.method, 'code')
    assert.equal(stage.url, SIGN_IN_PAGE)
    assert.equal(SIGN_IN_PAGE, 'https://mobook.me/growth-center')
    assert.match(stage.instructions, /growth-center/)
    assert.match(stage.instructions, /_tk/)
    assert.equal(typeof stage.callback, 'function')
    // 第二步：callback 拿到 Cookie → 真正登录
    const out = await stage.callback('_tk=puPASTE; _uid=6810')
    assert.equal(out.type, 'success')
    assert.equal(out.access, 'puPASTE')
    assert.equal(out.metadata.method, 'paste')
    // 直接给 session（OpenCode 自有对话框）也能一步登录（经 callback）
    const directStage = await method.authorize({ session: '_tk=puPASTE; _uid=6810' })
    assert.equal(typeof directStage.callback, 'function')
    const direct = await directStage.callback()
    assert.equal(direct.type, 'success')
    assert.equal(direct.access, 'puPASTE')
  } finally {
    globalThis.fetch = original
    setDeviceDetector(null)
    setLocalClientAccount(null)
  }
})

test('粘贴 Cookie：浏览器打开后粘了无效内容，返回 failed 而不是抛异常', async () => {
  const plugin = await MoBookAuthPlugin({})
  const method = plugin.auth.methods.find((m) => m.label.includes('粘贴整段 Cookie'))
  const stage = await method.authorize({})
  const bad = await stage.callback('   ')
  assert.equal(bad.type, 'failed')
  const onlyTk = await stage.callback('puONLYTK')
  assert.equal(onlyTk.type, 'failed')
  assert.match(onlyTk.error, /整段 Cookie/)
})
test('粘贴登录：只给 _tk 会被明确拒绝，要求整段 Cookie', async () => {
  const plugin = await MoBookAuthPlugin({})
  const method = plugin.auth.methods.find((m) => m.label.includes('粘贴整段 Cookie'))
  assert.ok(method)
  const stage = await method.authorize({ session: 'puONLYTK' })
  assert.equal(typeof stage.callback, 'function')
  const out = await stage.callback()
  assert.equal(out.type, 'failed')
  assert.match(out.error, /整段 Cookie/)
  assert.match(out.error, /_uid/)
})

test('签到打卡：今天已经活跃就跳过活跃对话', async () => {
  const today = beijingToday()
  const { fetchImpl, calls } = mockFetch({
    '/activity/getUserCheckinActivity': {
      code: 0,
      success: true,
      data: {
        activity: { activityId: 36, activityName: '墨宝领墨滴·10期', startTime: '2026-11-21', endTime: '2026-11-30' },
        checkinStat: { checkinStatus: 1, checkinDays: 3, totalPoints: 3000 },
        activityRule: { benefit: { point: 1000, expireDay: 1 } },
      },
    },
    '/activity/queryUserTaskList': { code: 0, success: true, data: [] },
    '/activity/queryUserActiveList': { code: 0, success: true, data: [{ activeTime: today + ' 08:00:00' }] },
    '/activity/queryUserActiveStat': { code: 0, success: true, data: { userActiveStat: { activeDays: 3 } } },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const plugin = await MoBookAuthPlugin({ magpie: { option: () => false } })
    const getAuth = async () => ({ type: 'oauth', access: 'pu', metadata: { tk: 'pu', uid: '6810' } })
    const outcome = await plugin.auth.checkin(getAuth)
    assert.match(outcome.message, /今日已活跃，跳过打卡对话/)
    // 一条对话都没发
    assert.equal(calls.some((c) => c.path === '/chat/new_session'), false)
  } finally {
    globalThis.fetch = original
  }
})

test('签到：领取失败且复查失败时不虚报每日额度', async () => {
  let activityCalls = 0
  const { fetchImpl } = mockFetch({
    '/activity/getUserCheckinActivity': () => {
      activityCalls += 1
      if (activityCalls > 1) throw new Error('network down')
      return { code: 0, success: true, data: { activity: { activityId: 36 }, checkinStat: { checkinStatus: 0, checkinDays: 0, totalPoints: 0 }, activityRule: { benefit: { point: 1000 } } } }
    },
    '/activity/dailyCheckin': { code: 500, success: false, message: '签到通道繁忙' },
    '/activity/queryUserTaskList': { code: 0, success: true, data: [] },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const plugin = await MoBookAuthPlugin({ magpie: { option: () => true } })
    const out = await plugin.auth.checkin(async () => ({ type: 'oauth', access: 'pu', metadata: { tk: 'pu', uid: '6810' } }))
    assert.equal(out.credit ?? 0, 0)
    assert.notEqual(out.outcome, 'claimed')
    assert.match(out.message, /签到请求失败/)
    assert.ok(!/签到 \+/.test(out.message), '不得虚报 +墨滴')
  } finally { globalThis.fetch = original }
})

test('工具账号：插件账号存储优先，account 可选', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mobook-auth-'))
  writeFileSync(
    path.join(dir, 'plugin-auth.json'),
    JSON.stringify({
      mobook: { type: 'oauth', access: 'pu-new', accountId: 'RYKT4788', uid: '83594', metadata: { tk: 'pu-new', uid: '83594', name: 'RYKT4788' } },
      'mobook#nbt1k8': { type: 'oauth', access: 'pu-old', accountId: 'LGZA8759', uid: '6810', metadata: { tk: 'pu-old', uid: '6810', name: 'LGZA8759' } },
    }),
  )
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, success: true, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const plugin = await MoBookAuthPlugin({ directory: dir })
    const first = await plugin.tool.task_status.execute({})
    assert.equal(first.ok, true)
    assert.equal(first.account.uid, '83594')
    assert.equal(first.account.key, 'mobook')
    const second = await plugin.tool.task_status.execute({ account: 'mobook#nbt1k8' })
    assert.equal(second.account.uid, '6810')
    const bad = await plugin.tool.task_status.execute({ account: 'other#x' })
    assert.equal(bad.ok, false)
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('流水截断：触顶时 truncated=true', async () => {
  const { fetchImpl } = mockFetch({
    '/point/getUserPointFlowInfo': () => ({
      code: 0, success: true,
      data: { totalCount: 5000, list: Array.from({ length: 200 }, (_, i) => ({ id: i, pointAmount: 1, desc: 'x' })) },
    }),
  })
  const page = await fetchFlowPages({ tk: 'pu', uid: '6810' }, { pageSize: 200, maxPages: 2 }, { fetchImpl })
  assert.equal(page.records.length, 400)
  assert.equal(page.truncated, true)
})

test('WAV：fmt 块过短返回 null 而非抛 RangeError', () => {
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(8, 16) // fmt 块只有 8 字节，不足以读 bitsPerSample
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28)
  buf.write('data', 36)
  buf.writeUInt32LE(0, 40)
  assert.equal(parseWavToPcm16k(buf), null)
})

test('ASR：超时显式报错而非静默返回半截文本', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/media/startRealtimeTranscription': { code: 0, success: true, data: { contentId: 1, sessionId: 's1', streamUrl: 'ws://asr.test/x' } },
    '/media/stopRealtimeTranscription': { code: 0, success: true, data: null },
  })
  const originalWs = globalThis.WebSocket
  globalThis.WebSocket = class { constructor() {} send() {} close() {} }
  try {
    await assert.rejects(
      () => transcribePcm16k({ tk: 'pu', uid: '6810' }, Buffer.alloc(1280), { deps: { fetchImpl }, timeoutMs: 30, paceMs: 0 }),
      /超时/,
    )
    assert.ok(calls.some((c) => c.path === '/media/stopRealtimeTranscription'))
  } finally { globalThis.WebSocket = originalWs }
})

test('cleanupStaleScheduledTasks：只删插件专属名称的任务，不碰用户自建', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: [{ id: 12331, token: 'btk_x' }] },
    '/scheduled-task/v1/tasks/list_tasks': { code: 0, success: true, data: { items: [
      { task_id: 't1', title: '墨宝插件选题灵感日报' },
      { task_id: 't2', title: '图书选题灵感日报' },
      { task_id: 't3', title: '其他任务' },
    ] } },
    '/scheduled-task/v1/tasks/delete_task': { code: 0, success: true, data: {} },
  })
  const out = await cleanupStaleScheduledTasks({ tk: 'pu', uid: '6810' }, {}, { fetchImpl })
  assert.equal(out.deleted, 1)
  assert.equal(out.total, 3)
  const del = calls.filter((c) => c.path === '/scheduled-task/v1/tasks/delete_task')
  assert.equal(del.length, 1)
  assert.equal(del[0].body.task_id, 't1')
  // 用户自建的同主题任务不被删
  assert.ok(!del.some((c) => c.body.task_id === 't2'))
})

test('stopStaleRecordings：只停账本登记的会话（不再读流水反推）', async () => {
  const { fetchImpl, calls } = mockFetch({
    // 流水里即使有别的会话记录，也不会被停——只有账本里的才停
    '/point/getUserPointAccount': { code: 0, success: true, data: { id: 89817, pointAmount: 100 } },
    '/point/getUserPointFlowInfo': {
      code: 0, success: true,
      data: { totalCount: 2, list: [
        { pointAmount: 5, desc: '录音时长消耗', bizId: 'recording:700609:zzz:to60', time: 1 },
        { pointAmount: 5, desc: '录音时长消耗', bizId: 'recording:700610:yyy:to60', time: 2 },
      ] },
    },
    '/media/stopRealtimeTranscription': { code: 0, success: true, data: null },
  })
  const out = await stopStaleRecordings({ tk: 'pu', uid: '6810' }, { sessions: [{ contentId: 700602, sessionId: 'aaa' }, { contentId: 700603, sessionId: 'bbb' }] }, { fetchImpl })
  assert.equal(out.sessions, 2)
  assert.equal(out.stopped, 2)
  const stops = calls.filter((c) => c.path === '/media/stopRealtimeTranscription')
  assert.equal(stops.length, 2)
  assert.deepEqual(stops.map((c) => c.body.sessionId).sort(), ['aaa', 'bbb'])
  // 流水里的 zzz/yyy 没有被碰
  assert.ok(!stops.some((c) => c.body.sessionId === 'zzz' || c.body.sessionId === 'yyy'))
})

test('ASR：WebSocket 出错路径也 stop 服务端会话（不再漏计费）', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/media/startRealtimeTranscription': { code: 0, success: true, data: { contentId: 1, sessionId: 's2', streamUrl: 'ws://asr.test/y' } },
    '/media/stopRealtimeTranscription': { code: 0, success: true, data: null },
  })
  const originalWs = globalThis.WebSocket
  globalThis.WebSocket = class { constructor() { setTimeout(() => this.onerror && this.onerror(), 0) } send() {} close() {} }
  try {
    await assert.rejects(
      () => transcribePcm16k({ tk: 'pu', uid: '6810' }, Buffer.alloc(1280), { deps: { fetchImpl }, timeoutMs: 5000, paceMs: 0 }),
      /连接失败/,
    )
    assert.ok(calls.some((c) => c.path === '/media/stopRealtimeTranscription'))
  } finally { globalThis.WebSocket = originalWs }
})
// ---- 双线程签到 / 任务缓存 ----

test('任务进度文案：全部完成或不显示，否则「任务 x/y」', () => {
  assert.equal(taskProgressText([]), '')
  assert.equal(taskProgressText([{ status: 'claimed', ruleType: 12 }, { status: 'claimed', ruleType: 15 }]), '')
  assert.equal(taskProgressText([
    { status: 'claimed', ruleType: 12 },
    { status: 'todo', ruleType: 13 },
    { status: 'claimable', ruleType: 19 },
    { status: 'todo', ruleType: 22 },
    { status: 'claimed', ruleType: 15 },
  ]), '任务 2/5')
  // 审校批注只能人工做，不计入进度，也不挡“今天做完了”
  assert.equal(taskProgressText([{ status: 'claimed', ruleType: 12 }, { status: 'doing', ruleType: 20 }]), '')
})

test('dayKey 按北京时区算日期（跨 UTC 零点不串日）', () => {
  assert.equal(dayKey(new Date('2026-11-25T16:30:00Z')), '2026-11-26')
  assert.equal(dayKey(new Date('2026-11-25T15:00:00Z')), '2026-11-25')
})

test('done.json：当天有效，第二天自动失效', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mobook-done-'))
  const day1 = new Date('2026-11-26T03:00:00Z')
  const day2 = new Date('2026-11-27T03:00:00Z')
  assert.equal(readDoneAt(dir, day1), null)
  writeDoneAt(dir, { done: 5, total: 5 }, day1)
  assert.equal(readDoneAt(dir, day1).done, 5)
  assert.equal(readDoneAt(dir, day2), null)
  rmSync(dir, { recursive: true, force: true })
})

test('签到：任务线程与签到线程同时起；已完成则不起任务线程', async () => {
  const today = beijingToday()
  const routes = {
    '/activity/getUserCheckinActivity': {
      code: 0, success: true,
      data: {
        activity: { activityId: 36, activityName: '墨宝领墨滴·10期', startTime: '2026-11-21', endTime: '2026-11-30' },
        checkinStat: { checkinStatus: 1, checkinDays: 3, totalPoints: 3000 },
        activityRule: { benefit: { point: 1000, expireDay: 1 } },
      },
    },
    '/activity/queryUserTaskList': { code: 0, success: true, data: [] },
    '/activity/queryUserActiveList': { code: 0, success: true, data: [{ activeTime: today + ' 08:00:00' }] },
  }
  const original = globalThis.fetch
  let started = 0
  setTaskRunner(() => { started += 1; return true })
  try {
    const uid = '70001'
    const { fetchImpl } = mockFetch(routes)
    globalThis.fetch = fetchImpl
    const plugin = await MoBookAuthPlugin({ magpie: { option: () => false } })
    const getAuth = async () => ({ type: 'oauth', access: 'pu', metadata: { tk: 'pu', uid } })
    const first = await plugin.auth.checkin(getAuth)
    assert.equal(started, 1)
    assert.match(first.message, /成长计划任务：后台已开始/)
    writeDoneAt(taskPaths(uid).dir, { done: 3, total: 3 })
    const second = await plugin.auth.checkin(getAuth)
    assert.equal(started, 1)
    assert.match(second.message, /今日已全部完成，跳过/)
  } finally {
    globalThis.fetch = original
    setTaskRunner(() => true)
    rmSync(taskPaths('70001').dir, { recursive: true, force: true })
  }
})

// ---- 1.17.0 复审修复的回归用例 ----

test('SSE：上游用 CRLF 分帧也能逐帧吐出来（不会整条流缓冲到结束）', async () => {
  const encoder = new TextEncoder()
  const chunks = ['data: {"model":"upstream","choices":[]}\r\n\r\n', 'data: [DONE]\r\n\r\n']
  const source = new ReadableStream({
    start(controller) {
      for (const text of chunks) controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  const reader = source.pipeThrough(sseModelRewriter('wanted')).getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /"model":"wanted"/)
  assert.ok(!first.includes('upstream'))
  const second = new TextDecoder().decode((await reader.read()).value)
  assert.match(second, /\[DONE\]/)
})

test('apiCall：200 空正文按成功返回 null，401 空正文仍按登录失效处理', async () => {
  const empty = async () => new Response('', { status: 200 })
  assert.equal(await apiCall({ tk: 't', uid: '1' }, '/resource/deleteContent', { id: 1 }, { fetchImpl: empty }), null)
  const denied = async () => new Response('', { status: 401 })
  await assert.rejects(() => apiCall({ tk: 't', uid: '1' }, '/resource/deleteContent', { id: 1 }, { fetchImpl: denied }), /登录态已失效/)
})

test('speak：按请求的 format 标 MIME（wav 不再写成 audio/mpeg）', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ audio: Buffer.from('RIFF').toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } })
  assert.equal((await speak({ apiKey: 'k' }, { text: '你好', format: 'wav' }, { fetchImpl })).contentType, 'audio/wav')
  assert.equal((await speak({ apiKey: 'k' }, { text: '你好' }, { fetchImpl })).contentType, 'audio/mpeg')
})

// 缺 API Key 不该是用户问题：插件要先自动补取，再重试（补不到才报错）。
function lazyKeyFetch(events, { key = '', chatReply = '好的' } = {}) {
  return async (url, init) => {
    const u = new URL(String(url))
    const headers = init?.headers ?? {}
    events.push({ host: u.host, path: u.pathname, auth: headers.authorization ?? (headers.get ? headers.get('authorization') : '') })
    if (u.pathname === '/organization/getApiKeyConfigDetail') {
      const providers = key ? { openClawProviders: { apiKey: key, baseUrl: 'https://model-gateway.shuwenda.com/v1' }, status: 1 } : { openClawProviders: {}, status: -1 }
      return new Response(JSON.stringify({ code: 0, success: true, data: providers }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/v3/images/generations') {
      return new Response(JSON.stringify({ model: 'doubao-seedream', data: [{ url: 'https://img.example/z.jpeg' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/v1/chat/completions') {
      return new Response(JSON.stringify({ model: 'eco', choices: [{ message: { role: 'assistant', content: chatReply } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('unexpected ' + u.pathname, { status: 500 })
  }
}

test('缺 API Key 时：画图请求先自动补取 key，再重试并走原生网关', async () => {
  const events = []
  const cred = { tk: 'pu', uid: '99101' }
  const res = await chatFetch(
    cred,
    'https://api-gateway.shuwenda.com/modelgw/v1/images/generations',
    { method: 'POST', body: JSON.stringify({ prompt: '一只猫', size: '1024x1024' }) },
    { fetchImpl: lazyKeyFetch(events, { key: 'dcg-lazy' }) },
  )
  assert.equal(res.status, 200)
  assert.equal((await res.json()).data[0].url, 'https://img.example/z.jpeg')
  assert.equal(cred.apiKey, 'dcg-lazy', '补到的 key 写回凭据，后续请求不再补')
  assert.ok(events.some((e) => e.path === '/organization/getApiKeyConfigDetail'), '先取了 key')
  const media = events.find((e) => e.path === '/v3/images/generations')
  assert.match(String(media.auth), /Bearer dcg-lazy/)
})

test('缺 API Key 时：带图片的对话先补取 key，再走原生网关', async () => {
  const events = []
  const cred = { tk: 'pu', uid: '99102' }
  const res = await chatFetch(
    cred,
    'https://api-gateway.shuwenda.com/modelgw/v1/chat/completions',
    { method: 'POST', body: JSON.stringify({ model: 'eco', messages: [{ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] }) },
    { fetchImpl: lazyKeyFetch(events, { key: 'dcg-lazy2', chatReply: '图里有只猫' }) },
  )
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, '图里有只猫')
  assert.equal(cred.apiKey, 'dcg-lazy2')
  assert.ok(events.some((e) => e.path === '/v1/chat/completions'), '重试时走了原生网关')
})

test('补取不到 API Key 时才报错，并说明要重新登录', async () => {
  const events = []
  const cred = { tk: 'pu', uid: '99103' }
  const res = await chatFetch(
    cred,
    'https://api-gateway.shuwenda.com/modelgw/v1/images/generations',
    { method: 'POST', body: JSON.stringify({ prompt: '一只猫' }) },
    { fetchImpl: lazyKeyFetch(events, { key: '' }) },
  )
  assert.equal(res.status, 502)
  const message = (await res.json()).error.message
  assert.match(message, /自动补取/)
  assert.match(message, /重新登录/)
  assert.ok(!events.some((e) => e.path === '/v3/images/generations'), '没 key 就不该打媒体网关')
})

test('ensureBot 与 listBots 认同一种 bot 列表形状（{data:[…]} 也认）', async () => {
  clearBotCache()
  const { fetchImpl } = mockFetch({
    '/organization/getBotListV3': { code: 0, success: true, data: { data: [{ id: 9, token: 'btk-9', name: 'b9' }] } },
  })
  const bot = await ensureBot({ tk: 'pu', uid: '99001' }, { fetchImpl })
  assert.equal(bot.id, 9)
  assert.equal(bot.token, 'btk-9')
  clearBotCache()
})

test('签到：另一条线程先领掉时不算失败（不把「签到请求失败」写进卡片）', async () => {
  let activityCalls = 0
  const { fetchImpl } = mockFetch({
    '/activity/getUserCheckinActivity': () => {
      activityCalls += 1
      // 第 1 次：还没签到；第 2 次复查：后台 runner 已经领掉了（总额 +1000）。
      return activityCalls === 1
        ? { code: 0, success: true, data: { activity: { activityId: 36 }, checkinStat: { checkinStatus: 0, checkinDays: 0, totalPoints: 0 }, activityRule: { benefit: { point: 1000 } } } }
        : { code: 0, success: true, data: { activity: { activityId: 36 }, checkinStat: { checkinStatus: 1, checkinDays: 1, totalPoints: 1000 }, activityRule: { benefit: { point: 1000 } } } }
    },
    '/activity/dailyCheckin': { code: 500, success: false, message: '今日已签到' },
    '/activity/queryUserTaskList': { code: 0, success: true, data: [] },
    '/activity/queryUserActiveList': { code: 0, success: true, data: [{ activeTime: beijingToday() + ' 08:00:00' }] },
  })
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const plugin = await MoBookAuthPlugin({ magpie: { option: () => false } })
    const out = await plugin.auth.checkin(async () => ({ type: 'oauth', access: 'pu', metadata: { tk: 'pu', uid: '6810' } }))
    assert.ok(!/签到请求失败/.test(String(out.message)), out.message)
    assert.match(out.message, /签到 \+1000 墨滴/)
    assert.equal(out.credit, 1000)
  } finally {
    globalThis.fetch = original
  }
})

test('显示全部模型：凭据缺 API Key 时先自动补取，而不是静默只列 23 个', async () => {
  const original = globalThis.fetch
  const gatewayIds = ['eco', 'booksgpt', 'brand-a', 'brand-b']
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.pathname === '/organization/getApiKeyConfigDetail') {
      return new Response(JSON.stringify({ code: 0, success: true, data: { openClawProviders: { apiKey: '{{SECRET_5mkqm2ol}}' }, status: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/modelgw/v1/model-show') {
      return new Response(JSON.stringify({ code: 0, success: true, data: [{ modelCode: 'eco', multiplier: 0.11 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.host === 'model-gateway.shuwenda.com' && u.pathname === '/v1/models') {
      return new Response(JSON.stringify({ data: gatewayIds.map((id) => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ code: 404, message: 'no route ' + u.pathname }), { status: 200 })
  }
  try {
    const plugin = await MoBookAuthPlugin({ magpie: { option: (provider, key) => key === SHOW_ALL_MODELS } })
    const rows = await plugin.provider.models({ models: {} }, { auth: { type: 'oauth', access: 'pu', metadata: { tk: 'pu', uid: '99200' } } })
    const ids = Object.keys(rows)
    assert.ok(ids.length >= 26, '补到 key 后把网关 id 也列出来: ' + ids.length)
    assert.ok(ids.includes('brand-a'))
    assert.ok(ids.includes('mobook-image'))
  } finally {
    globalThis.fetch = original
  }
})

// ---- 1.17.0 修复：后台 runner 必须脱离宿主的 Job ----

test('runner 启动器：WMI + 隐藏窗口，凭据只进独立文件、不上命令行', () => {
  const paths = taskPaths('launcher-test')
  mkdirSync(paths.dir, { recursive: true })
  try {
    const credPath = path.join(paths.dir, 'cred-1234.json')
    writeFileSync(credPath, JSON.stringify({ tk: 'SECRET-TOKEN-VALUE', uid: '1' }))
    const files = writeTaskLaunchers(paths, credPath, 1234, {
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      runner: 'C:\\runner\\task-runner.mjs',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1', HOME: 'C:\\Users\\x' },
    })
    const cmd = readFileSync(files.cmdPath, 'utf8')
    const vbs = readFileSync(files.vbsPath, 'utf8')
    const ps1 = readFileSync(files.ps1Path, 'utf8')
    assert.match(cmd, /^@echo off/)
    assert.ok(cmd.includes('set "HTTPS_PROXY=http://127.0.0.1:7897"'), '代理要带过去（WMI 不继承宿主环境）')
    assert.ok(cmd.includes('set "NO_PROXY=localhost,127.0.0.1"'))
    assert.ok(!cmd.includes('HOME='), '只带网络相关的环境变量')
    assert.ok(cmd.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\runner\\task-runner.mjs"'), '带空格的执行路径要加引号')
    assert.ok(cmd.includes(credPath), '命令行只带凭据文件路径')
    assert.ok(!cmd.includes('SECRET-TOKEN-VALUE'), '凭据不能出现在 .cmd 里')
    assert.ok(!vbs.includes('SECRET-TOKEN-VALUE'))
    assert.ok(!ps1.includes('SECRET-TOKEN-VALUE'))
    assert.match(vbs, /WScript\.Shell/)
    assert.match(vbs, /, 0, False/, '隐藏窗口')
    assert.match(ps1, /Win32_Process/)
    assert.match(ps1, /wscript\.exe/, 'WMI 创建的是 wscript，父进程离开宿主')
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('启动器清理：只删除过期的 launch-/cred- 文件', () => {
  const paths = taskPaths('sweep-test')
  mkdirSync(paths.dir, { recursive: true })
  try {
    const stale = path.join(paths.dir, 'cred-old.json')
    const fresh = path.join(paths.dir, 'cred-new.json')
    const log = path.join(paths.dir, 'latest.jsonl')
    writeFileSync(stale, '{}')
    writeFileSync(fresh, '{}')
    writeFileSync(log, 'x')
    const past = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(stale, past, past)
    sweepLauncherFiles(paths.dir)
    assert.equal(existsSync(stale), false, '过期的凭据文件要清掉')
    assert.equal(existsSync(fresh), true, '新鲜的不动（runner 可能还没读）')
    assert.equal(existsSync(log), true, '日志不动')
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})