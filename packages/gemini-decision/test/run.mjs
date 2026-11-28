// 零依赖测试：直接 import 插件的 _internal，验证协议改写与分流。
// 运行：node test/run.mjs（需要 node>=18）

import assert from 'node:assert/strict'
import { startMockUpstream } from './mock-upstream.mjs'
import plugin, { _internal } from '../index.mjs'

const results = []
function test(name, fn) {
  results.push({ name, fn })
}

const enc = (obj) => JSON.stringify(obj)

// ---- normalizeDecisionBody ----

test('state 字符串 -> input 原样', () => {
  const { body, changed } = _internal.normalizeDecisionBody(
    enc({ state: 'hello', questions: {}, model: 'gemini-decision/gemini-decision-1' }),
  )
  assert.equal(changed, true)
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.equal(parsed.input, 'hello')
  assert.equal(parsed.state, undefined)
})

test('state 对象 -> input 序列化成 text 块', () => {
  const { body } = _internal.normalizeDecisionBody(
    enc({ state: { order: 1 }, questions: {}, model: 'x' }),
  )
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.ok(Array.isArray(parsed.input))
  assert.equal(parsed.input[0].type, 'text')
  assert.equal(parsed.input[0].text, '{"order":1}')
})

test('state 为 content 块数组 -> 原样透传', () => {
  const blocks = [{ type: 'text', text: 'a' }, { type: 'image', data: 'xx', mime_type: 'image/png' }]
  const { body } = _internal.normalizeDecisionBody(
    enc({ state: blocks, questions: {}, model: 'x' }),
  )
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.deepEqual(parsed.input, blocks)
})

test('model 剥 provider 前缀并归一到 gemini-decision-1', () => {
  const { body } = _internal.normalizeDecisionBody(
    enc({ state: 'x', questions: {}, model: 'gemini-decision/gemini-decision-1' }),
  )
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.equal(parsed.model, 'gemini-decision-1')
})

test('model 是 jev-latest（Octop 习惯值）-> 强制 gemini-decision-1', () => {
  const { body } = _internal.normalizeDecisionBody(
    enc({ state: 'x', questions: {}, model: 'jev-latest' }),
  )
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.equal(parsed.model, 'gemini-decision-1')
})

test('questions 原样透传不被改写', () => {
  const questions = {
    dept: { type: 'choice', instructions: 'x', criteria: { billing: 'b' } },
    urgent: { type: 'noul', instructions: 'y' },
  }
  const { body } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.deepEqual(parsed.questions, questions)
})

test('字节形态 body 处理后仍是字节', () => {
  const bytes = new TextEncoder().encode(enc({ state: 'x', questions: {}, model: 'm' }))
  const { body } = _internal.normalizeDecisionBody(bytes)
  assert.ok(body instanceof Uint8Array)
})

test('非 JSON body 原样返回不炸', () => {
  const { body, changed } = _internal.normalizeDecisionBody('not json')
  assert.equal(changed, false)
  assert.equal(body, 'not json')
})

// ---- classifyTarget ----

test('classifyTarget 识别 systemone', () => {
  assert.equal(_internal.classifyTarget('http://x/v1/systemone').kind, 'systemone')
})

test('classifyTarget 未知路径', () => {
  assert.equal(_internal.classifyTarget('http://x/v1/whatever').kind, 'unknown')
})

// ---- 插件形状 ----

test('插件导出契约：default/GeminiDecisionPlugin 函数和 _internal 对象', async () => {
  const mod = await import('../index.mjs')
  const keys = Object.keys(mod)
  assert.deepEqual(keys.sort(), ['GeminiDecisionPlugin', '_internal', 'default'])
  assert.equal(typeof mod.default, 'function')
  assert.equal(typeof mod._internal, 'object')
})

test('config hook 注册 gemini-decision provider 且 decide=true', async () => {
  const hooks = await plugin({}, {})
  const cfg = {}
  hooks.config(cfg)
  assert.equal(cfg.provider['gemini-decision'].decide, true)
  assert.equal(cfg.provider['gemini-decision'].models['gemini-decision-1'].decides, true)
})

// ---- 端到端：mock 上游 ----

test('端到端：/systemone 经 loader.fetch 打到 /decisions，x-goog-api-key 正确，state 已转换', async () => {
  const mock = await startMockUpstream({ validKey: 'gemini-key-123' })
  try {
    const hooks = await plugin({ magpie: { option: { baseURL: mock.url } } }, { baseURL: mock.url })
    const loader = await hooks.auth.loader(async () => ({ key: 'gemini-key-123' }), {})
    const res = await loader.fetch(`${mock.url}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enc({
        state: '用户要退款',
        questions: {
          urgent: { type: 'noul', instructions: '是否紧急' },
          dept: { type: 'choice', instructions: '分给谁', criteria: { billing: '退款', tech: '故障' } },
        },
        model: 'gemini-decision/gemini-decision-1',
      }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.answers.urgent.noul, 0.87)
    assert.equal(data.answers.dept.choice, 'billing')

    // 校验上游实际收到的报文
    const upstreamReq = mock.requests.find((r) => r.url.endsWith('/decisions'))
    assert.ok(upstreamReq, '上游应收到 /decisions 请求')
    assert.equal(upstreamReq.headers['x-goog-api-key'], 'gemini-key-123')
    assert.equal(upstreamReq.headers['authorization'], undefined)
    const sent = JSON.parse(upstreamReq.body)
    assert.equal(sent.model, 'gemini-decision-1')
    assert.equal(sent.input, '用户要退款')
    assert.equal(sent.state, undefined)
    assert.ok(sent.questions.urgent)
  } finally {
    await mock.close()
  }
})

test('端到端：错误 key 返回 401 且带 X-Magpie-Sign-In', async () => {
  const mock = await startMockUpstream({ validKey: 'right-key' })
  try {
    const hooks = await plugin({}, { baseURL: mock.url })
    const loader = await hooks.auth.loader(async () => ({ key: 'wrong-key' }), {})
    const res = await loader.fetch(`${mock.url}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enc({ state: 'x', questions: { q: { type: 'noul', instructions: 'i' } }, model: 'm' }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
  } finally {
    await mock.close()
  }
})

test('端到端：未知路径返回 404', async () => {
  const mock = await startMockUpstream({})
  try {
    const hooks = await plugin({}, { baseURL: mock.url })
    const loader = await hooks.auth.loader(async () => ({ key: 'test-key' }), {})
    const res = await loader.fetch(`${mock.url}/something-else`, { method: 'GET' })
    assert.equal(res.status, 404)
  } finally {
    await mock.close()
  }
})

// ---- 运行 ----

let passed = 0
let failed = 0
for (const { name, fn } of results) {
  try {
    await fn()
    passed++
    console.log(`ok   - ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL - ${name}`)
    console.error(`       ${err.message}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
