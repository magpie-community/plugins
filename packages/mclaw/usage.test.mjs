// 用量窗口：aitokens 池数学、无 RHR135、票过期、明细只是加料（失败不连坐）、
// 重置时间只认账号自己的权威 endTime、SSO 换票链自动补 vip 会话。全部走本地 fake。
import './nonet.mjs'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MclawAuthPlugin, _internal } from './index.mjs'
import { fakeUpstream, json, TICKET_A } from './fake.mjs'

let f
afterEach(() => f?.close())
beforeEach(() => _internal.resetSsoState()) // SSO 缓存/冷却是模块级的，用例间隔离

const authOf = (ticket, extra) => ({
  type: 'oauth', refresh: 'browser', access: ticket, expires: Date.now() + 86400e3,
  metadata: { apiKey: 'na-test-key', email: '131****9239', ...(extra ?? {}) },
})

const plugin = async () => MclawAuthPlugin({}, {})

test('aitokens 池数学：amount/limit/used%，名字不带权益编号', async () => {
  f = fakeUpstream()
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A))
  expect(out.windows).toHaveLength(1)
  const w = out.windows[0]
  expect(w.name).toBe('MClaw tokens')
  expect(w.amount).toBe(11375000)
  expect(w.limit).toBe(30500000)
  expect(w.used).toBeCloseTo((11375000 / 30500000) * 100, 6)
  expect(w.display).toContain('凭证至')
  // 没配 vip Cookie：没有权威 endTime，就不给「重置于」
  expect(w.resetsAt).toBeUndefined()
  expect(w.display).not.toContain('重置于')
})

test('权益列表里没有 aitokens → 明确报错', async () => {
  f = fakeUpstream()
  f.route('POST /isbo2/openApi/queryAvailableBenefitV2', () => json({
    result: { resultCode: '0', resultDesc: 'SUCCESS' },
    userAvailableBenefitList: [{ benefitNo: 'RHR077', benefitName: '一键成片VIP模板', benefitValue: '1', benefitUsed: '0' }],
  }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A))
  expect(out.error).toContain('aitokens')
  expect(out.windows).toEqual([])
})

test('票被上游拒绝（授权）→ signIn expired', async () => {
  f = fakeUpstream()
  f.route('POST /isbo2/openApi/queryAvailableBenefitV2', () => json({
    result: { resultCode: '1', resultDesc: '授权失败' },
  }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A))
  expect(out.signIn).toBe('expired')
  expect(out.windows).toEqual([])
})

test('vip 明细挂了不连坐：池窗口照常，只是没有重置时间', async () => {
  f = fakeUpstream()
  f.route('POST /m4c/benefit/getAiTokenConsumptionRecords', () => new Response('boom', { status: 500 }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A, { vipCookie: 'mc_at=x; mc_bt=y' }))
  expect(out.error).toBeUndefined()
  expect(out.windows).toHaveLength(1)
  expect(out.windows[0].resetsAt).toBeUndefined()
})

test('权威 endTime → resetsAt/startsAt/span，重置时间进 display', async () => {
  f = fakeUpstream()
  // 未来 10 天的北京时间墙钟（endTime 按 +08:00 解析，UTC 分量即北京墙钟）
  const t = new Date(Date.now() + 10 * 86400e3 + 8 * 3600e3)
  const pad = (n) => String(n).padStart(2, '0')
  const endTimeText = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  f.route('POST /m4c/benefit/getAiTokenConsumptionRecords', () => json({
    resultCode: '0',
    data: { aiTokenConsumptionRecordList: [{ recordTime: '2026-11-05 09:00:00', endTime: endTimeText, benefitNum: '123456', modelName: 'Qwen3.8-Flash', coefficient: '0.18', comments: '对话' }] },
  }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A, { vipCookie: 'mc_at=x; mc_bt=y' }))
  const w = out.windows[0]
  const expectedReset = _internal.endTimeMs(endTimeText)
  expect(new Date(w.resetsAt).getTime()).toBe(expectedReset)
  expect(new Date(w.startsAt).getTime()).toBe(_internal.cycleStartMs(expectedReset))
  expect(w.span).toBeGreaterThan(28 * 86400)
  expect(w.span).toBeLessThan(32 * 86400)
  expect(w.display).toContain('重置于')
  expect(w.display).toContain('最近 2026-11-05 09:00:00')
})

test('明细里的 endTime 是上轮周期的（已过去）→ 不显示重置时间', async () => {
  f = fakeUpstream()
  f.route('POST /m4c/benefit/getAiTokenConsumptionRecords', () => json({
    resultCode: '0',
    data: { aiTokenConsumptionRecordList: [{ recordTime: '2026-10-01 09:00:00', endTime: '2026-10-11 15:20:47', benefitNum: '1', modelName: 'x' }] },
  }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A, { vipCookie: 'mc_at=x; mc_bt=y' }))
  expect(out.windows[0].resetsAt).toBeUndefined()
  expect(out.windows[0].display).not.toContain('重置于')
})

// 未来 10 天的北京时间墙钟 → 明细接口的 endTime 文本
const futureEndTime = () => {
  const t = new Date(Date.now() + 10 * 86400e3 + 8 * 3600e3)
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
}

test('没配 vip Cookie：SSO 链自动换票，明细与重置时间全自动', async () => {
  f = fakeUpstream()
  const end = futureEndTime()
  f.route('POST /m4c/benefit/getAiTokenConsumptionRecords', () => json({
    resultCode: '0',
    data: { aiTokenConsumptionRecordList: [{ recordTime: '2026-11-05 09:00:00', endTime: end, benefitNum: '1000', modelName: 'Qwen3.8-Flash' }] },
  }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A)) // metadata 里没有 vipCookie
  const paths = f.seen.map((r) => r.path)
  expect(paths).toContain('/user/querySpecTokenV2')
  expect(paths).toContain('/m4c/login/ssoLogin')
  // 出票的渠道号必须是 001005（001003/001221 会被 USER_DOMAIN 拒）
  const mint = f.seen.find((r) => r.path === '/user/querySpecTokenV2')
  expect(mint.json.toSourceId).toBe('001005')
  // 明细请求带上了全部 6 个 cookie，含 httpOnly 的 mc_at/mc_pat（curl jar 会漏）
  const recordsReq = f.seen.find((r) => r.path === '/m4c/benefit/getAiTokenConsumptionRecords')
  expect(recordsReq.headers.get('cookie')).toContain('mc_at=fake-at')
  expect(recordsReq.headers.get('cookie')).toContain('mc_pat=fake-pat')
  expect(recordsReq.headers.get('cookie')).toContain('mc_pac=fake-pac')
  const w = out.windows[0]
  expect(new Date(w.resetsAt).getTime()).toBe(_internal.endTimeMs(end))
  expect(w.display).toContain('重置于')
})

test('SSO 换票失败有冷却：两次 usage 只出一次票', async () => {
  f = fakeUpstream()
  f.route('POST /m4c/login/ssoLogin', () => json({ resultCode: '500400', resultDesc: '统一通信证临时票据验证失败' }))
  const p = await plugin()
  const out1 = await p.auth.usage(async () => authOf(TICKET_A))
  const out2 = await p.auth.usage(async () => authOf(TICKET_A))
  const mints = f.seen.filter((r) => r.path === '/user/querySpecTokenV2').length
  expect(mints).toBe(1)
  expect(out1.windows[0].resetsAt).toBeUndefined()
  expect(out2.windows[0].resetsAt).toBeUndefined()
  expect(out1.error).toBeUndefined() // 换票不成也不连坐池窗口
})

test('配置的 vip Cookie 有效 → 不打换票链', async () => {
  f = fakeUpstream()
  const end = futureEndTime()
  f.route('POST /m4c/benefit/getAiTokenConsumptionRecords', () => json({
    resultCode: '0',
    data: { aiTokenConsumptionRecordList: [{ recordTime: '2026-11-05 09:00:00', endTime: end, benefitNum: '1000', modelName: 'x' }] },
  }))
  const p = await plugin()
  const out = await p.auth.usage(async () => authOf(TICKET_A, { vipCookie: 'mc_at=mine; mc_bt=mine' }))
  expect(f.seen.map((r) => r.path)).not.toContain('/user/querySpecTokenV2')
  expect(out.windows[0].resetsAt).toBeTruthy()
})
