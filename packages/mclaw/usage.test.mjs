// 用量窗口：aitokens 池数学、无 RHR135、票过期、明细只是加料（失败不连坐）、
// 重置时间只认账号自己的权威 endTime。全部走本地 fake。
import './nonet.mjs'
import { afterEach, expect, test } from 'bun:test'
import { MclawAuthPlugin, _internal } from './index.mjs'
import { fakeUpstream, json, TICKET_A } from './fake.mjs'

let f
afterEach(() => f?.close())

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
