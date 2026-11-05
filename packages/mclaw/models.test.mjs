// 账号模型目录：agent/list × apikey/get v1 的合并（倍率、名字）、票过期向外抛、
// 无凭证时静态目录原样返回。全部走本地 fake。
import './nonet.mjs'
import { beforeEach, afterEach, expect, test } from 'bun:test'
import { MclawAuthPlugin, _internal } from './index.mjs'
import { fakeUpstream, json, TICKET_A, TICKET_B } from './fake.mjs'

let f
afterEach(() => f?.close())
beforeEach(() => _internal.resetModelCache())

const authOf = (ticket) => ({
  type: 'oauth', refresh: 'browser', access: ticket, expires: Date.now() + 86400e3,
  metadata: { apiKey: 'na-test-key', email: '131****9239' },
})

test('agent/list × apikey/get 合并出账号目录与倍率', async () => {
  f = fakeUpstream()
  const p = await MclawAuthPlugin({}, {})
  const models = await p.provider.models({ models: {} }, { auth: authOf(TICKET_A) })
  expect(Object.keys(models).sort()).toEqual(['blian_qwen38_flash', 'huoshan_glm_5_3'])
  expect(models.blian_qwen38_flash.rate).toBe(0.18)
  expect(models.huoshan_glm_5_3.rate).toBe(3.5)
  expect(models.blian_qwen38_flash.api.url).toContain('/api/llm/102001/v1')
  expect(models.blian_qwen38_flash.tool_call).toBe(true)
  expect(models.huoshan_glm_5_3.reasoning).toBe(true)
})

test('票过期（01000002）向外抛 expired', async () => {
  f = fakeUpstream()
  f.route('POST /api/adapter/assistant/agent/list', () => json({ success: false, code: '01000002', message: '无效的凭证' }))
  const p = await MclawAuthPlugin({}, {})
  let caught
  try {
    await p.provider.models({ models: {} }, { auth: authOf(TICKET_B) })
  } catch (error) {
    caught = error
  }
  expect(caught?.signIn).toBe('expired')
})

test('倍率接口挂了、config/get 兜底也不可用 → 仍有目录（无倍率）', async () => {
  f = fakeUpstream()
  f.route('POST /api/llm/apikey/get', () => new Response('boom', { status: 500 }))
  f.route('POST /api/openclaw/config/get', () => new Response('boom', { status: 500 }))
  const p = await MclawAuthPlugin({}, {})
  const models = await p.provider.models({ models: {} }, { auth: authOf(TICKET_B) })
  expect(models.blian_qwen38_flash).toBeTruthy()
  expect(models.blian_qwen38_flash.rate).toBeUndefined()
})

test('无凭证 → 静态目录原样返回，不发请求', async () => {
  const p = await MclawAuthPlugin({}, {})
  const staticModels = { static_model: { name: 'S' } }
  const models = await p.provider.models({ models: staticModels }, { auth: undefined })
  expect(models).toBe(staticModels)
})
