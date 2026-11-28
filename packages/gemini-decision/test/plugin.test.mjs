// 零依赖测试：直接 import 插件的 _internal，验证协议改写与分流。
// 运行：node test/run.mjs（需要 node>=18）

import assert from 'node:assert/strict'
import test from 'node:test'
import { startMockUpstream } from './mock-upstream.mjs'
import plugin, { _internal } from '../index.mjs'

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

test('model 是未知裸值（非 gemini-decision 开头）-> 强制 gemini-decision-1', () => {
  const { body } = _internal.normalizeDecisionBody(
    enc({ state: 'x', questions: {}, model: 'some-random-model' }),
  )
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.equal(parsed.model, 'gemini-decision-1')
})

// ---- noul criteria 键名映射 ----

test('noul criteria {true,false} -> {true_description,false_description}', () => {
  const questions = {
    urgent: { type: 'noul', instructions: 'i', criteria: { true: 'Urgent', false: 'Not urgent' } },
  }
  const { body } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.deepEqual(parsed.questions.urgent.criteria, {
    true_description: 'Urgent',
    false_description: 'Not urgent',
  })
})

test('noul criteria 为 null/undefined 描述 -> 空串（含 true/false 键）', () => {
  const questions = {
    urgent: { type: 'noul', instructions: 'i', criteria: { true: null, false: null } },
  }
  const { body } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.deepEqual(parsed.questions.urgent.criteria, {
    true_description: '',
    false_description: '',
  })
})

test('choice criteria 不做键名映射，null 值转空串', () => {
  const questions = {
    dept: { type: 'choice', instructions: 'i', criteria: { billing: null, tech: 'Tech' } },
  }
  const { body } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.deepEqual(parsed.questions.dept.criteria, { billing: '', tech: 'Tech' })
})

// ---- question id 清洗与还原 ----

test('非法字符 id 清洗（tool:Agent -> tool_Agent）且 idMap 返回', () => {
  const questions = { 'tool:Agent': { type: 'noul', instructions: 'i' } }
  const { body, idMap } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const p = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.ok(p.questions['tool_Agent'], '清洗后的键应存在')
  assert.equal(p.questions['tool:Agent'], undefined)
  assert.equal(idMap['tool_Agent'], 'tool:Agent')
})

test('清洗后撞名追加序号 suffix', () => {
  const questions = {
    'tool:Agent': { type: 'noul', instructions: 'i' },
    'tool_Agent': { type: 'noul', instructions: 'i' },
  }
  const { body, idMap } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const p = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  const keys = Object.keys(p.questions)
  assert.equal(keys.length, 2)
  assert.ok(keys.includes('tool_Agent'))
  assert.ok(keys.includes('tool_Agent_2'), '撞名的第二个应得到 _2 后缀')
  assert.equal(idMap['tool_Agent'], 'tool:Agent')
  assert.equal(idMap['tool_Agent_2'], 'tool_Agent')
})

test('64 字符以上的 id 清洗后仍带 suffix 且不超 64', () => {
  const longA = 'k'.repeat(70)
  const longB = 'k'.repeat(69) + 'x' // 清洗前不同，截断后相同
  const longC = 'k'.repeat(69) + 'y'
  const questions = {
    [longA]: { type: 'noul', instructions: 'i' },
    [longB]: { type: 'noul', instructions: 'i' },
    [longC]: { type: 'noul', instructions: 'i' },
  }
  const { body, idMap } = _internal.normalizeDecisionBody(enc({ state: 'x', questions, model: 'm' }))
  const p = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  const keys = Object.keys(p.questions)
  assert.equal(keys.length, 3)
  for (const key of keys) {
    assert.ok(key.length <= 64, `id ${key.length} chars 必须 ≤ 64`)
    assert.ok(/^[A-Za-z0-9_-]+$/.test(key), 'id 必须符合谷歌字符集')
  }
  assert.ok(idMap, '应产生 idMap')
  assert.equal(Object.keys(idMap).length, 3)
  // 映射表是 清洗后id -> 原始id，必须一一对应且可逆
  const restored = keys.map((k) => idMap[k])
  assert.deepEqual(new Set(restored), new Set([longA, longB, longC]))
})

test('restoreAnswerIds 把清洗后的键换回原始 id', () => {
  const idMap = { tool_Agent: 'tool:Agent' }
  const text = enc({ answers: { tool_Agent: { type: 'noul', noul: 0.5 } }, usage: {} })
  const out = JSON.parse(_internal.restoreAnswerIds(text, idMap))
  assert.equal(out.answers['tool:Agent'].noul, 0.5)
  assert.equal(out.answers['tool_Agent'], undefined)
})

// ---- usage 映射 ----

test('mapUsageInBody 把 total_input_tokens 映射成 input_tokens，output_tokens 为 0', () => {
  const text = enc({
    answers: {},
    usage: { total_input_tokens: 120, total_output_tokens: 5, total_tokens: 125 },
  })
  const out = JSON.parse(_internal.mapUsageInBody(text))
  assert.equal(out.usage.input_tokens, 120)
  assert.equal(out.usage.output_tokens, 0)
  assert.equal(out.usage.total_input_tokens, 120, '谷歌原字段保留')
})

test('mapUsage 处理缺失/空 usage', () => {
  assert.deepEqual(_internal.mapUsage(null), { input_tokens: 0, output_tokens: 0 })
  assert.deepEqual(_internal.mapUsage({}), { input_tokens: 0, output_tokens: 0 })
})

// ---- 媒体 / assets 转换 ----

test('https png 图片 URL 猜测 mime_type 为 image/png（不是 jpeg）', () => {
  const item = { type: 'image_url', image_url: { url: 'https://example.com/cat.png?x=1' } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block.type, 'image')
  assert.equal(block.uri, 'https://example.com/cat.png?x=1')
  assert.equal(block.mime_type, 'image/png')
})

test('未知扩展名的图片 URL 不带 mime_type（不臆造 jpeg）', () => {
  const item = { type: 'image_url', image_url: { url: 'https://example.com/image' } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block.type, 'image')
  assert.equal(block.mime_type, undefined)
})

test('webm 视频 URL 猜测 video/webm，mp4 为 video/mp4', () => {
  const webm = _internal.convertStatePart({ type: 'video_url', video_url: { url: 'https://x/a.webm' } }, {})
  assert.equal(webm.mime_type, 'video/webm')
  const mp4 = _internal.convertStatePart({ type: 'video_url', video_url: { url: 'https://x/a.mp4' } }, {})
  assert.equal(mp4.mime_type, 'video/mp4')
})

test('非 pdf input_file URL 整块丢弃（谷歌 document 只吃 application/pdf）', () => {
  const item = { type: 'input_file', input_file: { file_data: 'https://x/data.csv' } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block, null)
})

test('pdf input_file URL 保留 document 块且 mime 为 application/pdf', () => {
  const item = { type: 'input_file', input_file: { file_data: 'https://x/data.pdf' } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block.type, 'document')
  assert.equal(block.mime_type, 'application/pdf')
})

test('文本类 data URL 文档解码成 text 块（csv base64）', () => {
  const item = { type: 'input_file', input_file: { file_data: 'data:text/csv;base64,' + Buffer.from('a,b\n1,2').toString('base64') } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block.type, 'text')
  assert.equal(block.text, 'a,b\n1,2')
})

test('未知音频 format 不臆造 mime_type', () => {
  const item = { type: 'input_audio', input_audio: { data: 'https://x/sound.bin', format: 'weird' } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block.type, 'audio')
  assert.equal(block.mime_type, undefined)
})

test('data URL 媒体按 data URL 自带 mime 转换', () => {
  const item = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }
  const block = _internal.convertStatePart(item, {})
  assert.equal(block.data, 'aGk=')
  assert.equal(block.mime_type, 'image/png')
})

test('assets 表解析：state 字符串引用 asset 键 -> 媒体块', () => {
  const { body } = _internal.normalizeDecisionBody(enc({
    state: ['look at this', 'img1'],
    assets: { img1: { data: 'aGk=', mime_type: 'image/png' } },
    questions: {},
    model: 'm',
  }))
  const parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
  assert.equal(parsed.assets, undefined)
  assert.equal(parsed.input[0].type, 'text')
  assert.equal(parsed.input[1].type, 'image')
  assert.equal(parsed.input[1].data, 'aGk=')
  assert.equal(parsed.input[1].mime_type, 'image/png')
})

test('assets data URL 形式 -> 拆出 mime 与字节', () => {
  const blocks = _internal.parseAssets({ a: { data: 'data:audio/mpeg;base64,AAAA' } })
  assert.equal(blocks.a.type, 'audio')
  assert.equal(blocks.a.mime_type, 'audio/mpeg')
  assert.equal(blocks.a.data, 'AAAA')
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
    // usage：谷歌的蛇形 total_input_tokens 必须映射成 magpie 读的 input_tokens/output_tokens
    assert.equal(data.usage.input_tokens, 120, 'usage.input_tokens 来自 total_input_tokens')
    assert.equal(data.usage.output_tokens, 0)

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
    const body = await res.json()
    assert.match(body.error.message, /gemini-decision/)
    assert.doesNotMatch(body.error.message, /typesafe-jev/)
  } finally {
    await mock.close()
  }
})

test('端到端：非法 question id 清洗后发出，answers 键还原为原 id', async () => {
  const mock = await startMockUpstream({ validKey: 'k' })
  try {
    const hooks = await plugin({}, { baseURL: mock.url })
    const loader = await hooks.auth.loader(async () => ({ key: 'k' }), {})
    const res = await loader.fetch(`${mock.url}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enc({
        state: 'x',
        questions: { 'tool:Agent': { type: 'noul', instructions: 'i' } },
        model: 'm',
      }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    // 响应侧键名还原
    assert.ok(data.answers['tool:Agent'], 'answers 应还原为原始 id')
    assert.equal(data.answers['tool_Agent'], undefined)
    // 上游实际收到的是清洗后的键
    const upstreamReq = mock.requests.find((r) => r.url.endsWith('/decisions'))
    const sent = JSON.parse(upstreamReq.body)
    assert.ok(sent.questions['tool_Agent'])
    assert.equal(sent.questions['tool:Agent'], undefined)
  } finally {
    await mock.close()
  }
})

// ---- models hook ----

test('models hook：剥 models/ 前缀、分页、只保留 gemini-decision-*', async () => {
  const mock = await startMockUpstream({ validKey: 'k' })
  try {
    const hooks = await plugin({}, { baseURL: mock.url })
    const models = await hooks.provider.models({}, { auth: async () => ({ key: 'k' }) })
    assert.ok(models['gemini-decision-1'], '决策模型必须存在')
    assert.equal(models['gemini-decision-1'].decides, true)
    assert.equal(models['gemini-decision-1'].description, 'The decision model')
    // 普通聊天/embedding 模型不能混进来
    assert.equal(models['gemini-2.5-flash'], undefined)
    assert.equal(models['text-embedding-004'], undefined)
    assert.equal(models['gemini-2.5-flash-lite'], undefined)
    // id 不应残留 models/ 前缀
    assert.equal(models['models/gemini-decision-1'], undefined)
    // 分页确实发生了（page1 + page2 两个请求）
    const modelReqs = mock.requests.filter((r) => r.url.includes('/models'))
    assert.ok(modelReqs.length >= 2, '应翻页拉完 models 列表')
  } finally {
    await mock.close()
  }
})

test('models hook：无 key 回退静态表', async () => {
  const hooks = await plugin({}, {})
  const models = await hooks.provider.models({ models: { existing: { id: 'existing' } } }, { auth: async () => ({}) })
  assert.deepEqual(models, { models: { existing: { id: 'existing' } } }.models)
})

// ---- review 补测：model facts / timeout / env override / hook id ----

test('config hook 登记的模型事实与谷歌文档一致（context/cost/modalities）', async () => {
  const hooks = await plugin({}, {})
  const cfg = {}
  hooks.config(cfg)
  const model = cfg.provider['gemini-decision'].models['gemini-decision-1']
  assert.equal(model.limit.context, 262144, '上下文窗口必须是 262144')
  assert.equal(model.cost.input, 0.10, '输入 $0.10/1M')
  assert.equal(model.cost.output, 0, '输出免费')
  assert.deepEqual(model.modalities.input, ['text', 'image', 'audio', 'video', 'file'])
})

test('provider hook 的 id 必须等于 provider id（否则 magpie/OpenCode 永远不会调用 models hook）', async () => {
  const hooks = await plugin({}, {})
  assert.equal(hooks.provider.id, 'gemini-decision')
  assert.equal(typeof hooks.provider.models, 'function')
})

test('models hook：宿主 signal 已 abort 时立即回退静态表，不发出任何请求', async () => {
  const mock = await startMockUpstream({ validKey: 'k' })
  try {
    const hooks = await plugin({ magpie: { option: { baseURL: mock.url } } }, { baseURL: mock.url })
    const controller = new AbortController()
    controller.abort()
    const before = mock.requests.length
    const models = await hooks.provider.models(
      { models: { existing: { id: 'existing' } } },
      { auth: async () => ({ key: 'k' }), signal: controller.signal },
    )
    assert.deepEqual(models, { existing: { id: 'existing' } })
    assert.equal(mock.requests.length, before, 'signal 已 abort 时不应发出任何 models 请求')
  } finally {
    await mock.close()
  }
})

test('models hook：正常路径带超时 signal，且与宿主 signal 组合后仍可完成', async () => {
  const mock = await startMockUpstream({ validKey: 'k' })
  try {
    const hooks = await plugin({ magpie: { option: { baseURL: mock.url } } }, { baseURL: mock.url })
    const controller = new AbortController()
    const models = await hooks.provider.models({}, { auth: async () => ({ key: 'k' }), signal: controller.signal })
    assert.ok(models['gemini-decision-1'], '组合 signal 不应误伤正常请求')
  } finally {
    await mock.close()
  }
})

test('GEMINI_DECISION_BASE_URL 环境变量被忽略，无法把 key 重定向到任意主机', async () => {
  process.env.GEMINI_DECISION_BASE_URL = 'http://127.0.0.1:1/evil'
  try {
    const hooks = await plugin({}, {})
    const cfg = {}
    hooks.config(cfg)
    assert.equal(
      cfg.provider['gemini-decision'].api,
      'https://generativelanguage.googleapis.com/v1beta',
      'env override 不得生效',
    )
  } finally {
    delete process.env.GEMINI_DECISION_BASE_URL
  }
})
