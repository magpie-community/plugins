import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

const catalogue = [
  { chatApiModel: 'JoyAI-Code-1.6', label: 'JoyAI-Code-1.6', maxTotalTokens: 200000, respMaxTokens: 64000, features: ['function_call'] },
  { chatApiModel: 'GLM-5.3-agent', label: 'GLM-5.3', maxTotalTokens: 200000, respMaxTokens: 64000, features: ['function_call'] },
  { chatApiModel: 'GPT-5.6 Sol', label: 'GPT-5.6 Sol', extJson: { adapterType: 'openai-response' } },
  { chatApiModel: 'Claude-Opus-5-hq', label: 'Claude-Opus-5', extJson: { adapterType: 'anthropic' } },
]
const billingRate = { excludeTenants: ['JD'], billingRates: [
  { chatApiModel: 'JoyAI-Code-1.6', billingRate: '0x' },
  { chatApiModel: 'GLM-5.3-agent', billingRate: '0.6x' },
  { chatApiModel: 'unavailable-model', billingRate: '0.2x' },
] }
async function load(t, { tenant = 'personal', failRates = false, failList = false, list = catalogue } = {}) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const fn = new URL(url).searchParams.get('functionId')
    assert.equal(init.headers.tenant, tenant)
    if (fn === 'joycode_modelList') {
      if (failList) throw new Error('offline')
      assert.equal(init.body, '{}')
      return Response.json({ code: 0, data: list })
    }
    assert.equal(fn, 'plugin_config')
    assert.deepEqual(JSON.parse(init.body), { sceneType: 'billingRate' })
    if (failRates) throw new Error('offline')
    return Response.json({ code: 0, data: { billingRate } })
  })
  const hooks = await plugin.server({})
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.joycode
  assert.equal(typeof hooks.provider?.models, 'function')
  return { provider, models: await hooks.provider.models(provider, { auth: { type: 'api', key: 'fake', metadata: { tenant } } }) }
}

test('sync current model multipliers including zero without adding pricing-only models', async t => {
  const { models } = await load(t)
  assert.deepEqual(Object.keys(models), ['JoyAI-Code-1.6', 'GLM-5.3-agent', 'GPT-5.6 Sol', 'Claude-Opus-5-hq'])
  assert.equal(models['JoyAI-Code-1.6'].rate, 0)
  assert.equal(models['JoyAI-Code-1.6'].free, true)
  assert.equal(models['GLM-5.3-agent'].rate, 0.6)
  assert.equal(models['GLM-5.3-agent'].capabilities.input.image, false)
})
test('model adapter chooses the SDK that speaks its upstream protocol', async t => {
  const { models } = await load(t)
  assert.equal(models['JoyAI-Code-1.6'].api.npm, '@ai-sdk/openai-compatible')
  assert.equal(models['GPT-5.6 Sol'].api.npm, '@ai-sdk/openai')
  assert.equal(models['Claude-Opus-5-hq'].api.npm, '@ai-sdk/anthropic')
  for (const model of Object.values(models)) assert.equal(model.api.url, 'https://api-ai.jd.com/v1')
})
test('raises context only for exact input-verified models and preserves output limits', async t => {
  const { models } = await load(t, { list: [
    {
      chatApiModel: 'GPT-6 Astra', maxTotalTokens: 200000, respMaxTokens: 17000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 1500000 } },
    },
    {
      chatApiModel: 'GPT-6.1 Sol', maxTotalTokens: 200000, respMaxTokens: 16000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 1000000 } },
    },
    {
      chatApiModel: 'GLM-5.3', maxTotalTokens: 200000, respMaxTokens: 22000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 1000000 } },
    },
    {
      chatApiModel: 'GLM-5.3-jcloud', maxTotalTokens: 200000, respMaxTokens: 23000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 2000000 } },
    },
    {
      chatApiModel: 'GLM-5.3-agent', maxTotalTokens: 200000, respMaxTokens: 24000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 2000000 } },
    },
    {
      chatApiModel: 'DeepSeek-V4.1-Flash', maxTotalTokens: 200000, respMaxTokens: 18000,
      extJson: JSON.stringify({
        adapterType: 'openai-response',
        contextWindowByPlatform: { 'JoyCode Desktop': 1500000 },
      }),
    },
    {
      chatApiModel: 'GPT-6 Astra-preview', maxTotalTokens: 200000, respMaxTokens: 19000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 2000000 } },
    },
    {
      chatApiModel: 'GPT-6.1 Sol-preview', maxTotalTokens: 200000, respMaxTokens: 21000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 2000000 } },
    },
    {
      chatApiModel: 'Claude-Opus-5-hq', maxTotalTokens: 200000, respMaxTokens: 20000,
      extJson: { adapterType: 'anthropic', contextWindowByPlatform: { 'JoyCode Desktop': 2000000 } },
    },
  ] })
  assert.equal(models['GPT-6 Astra'].limit.context, 900000)
  assert.equal(models['GPT-6.1 Sol'].limit.context, 900000)
  assert.equal(models['GLM-5.3'].limit.context, 900000)
  assert.equal(models['GLM-5.3-jcloud'].limit.context, 200000)
  assert.equal(models['GLM-5.3-agent'].limit.context, 200000)
  assert.equal(models['DeepSeek-V4.1-Flash'].limit.context, 1000000)
  assert.equal(models['GPT-6 Astra-preview'].limit.context, 200000)
  assert.equal(models['GPT-6.1 Sol-preview'].limit.context, 200000)
  assert.equal(models['Claude-Opus-5-hq'].limit.context, 200000)
  assert.equal(models['GPT-6 Astra'].limit.output, 17000)
  assert.equal(models['GPT-6.1 Sol'].limit.output, 16000)
  assert.equal(models['GLM-5.3'].limit.output, 22000)
  assert.equal(models['GLM-5.3-jcloud'].limit.output, 23000)
  assert.equal(models['GLM-5.3-agent'].limit.output, 24000)
  assert.equal(models['DeepSeek-V4.1-Flash'].limit.output, 18000)
  assert.equal(models['GPT-6.1 Sol-preview'].limit.output, 21000)
  assert.equal(models['DeepSeek-V4.1-Flash'].api.npm, '@ai-sdk/openai')
})
test('floors smaller directory limits and preserves larger base contexts', async t => {
  const { models } = await load(t, { list: [
    {
      chatApiModel: 'GPT-6 Astra', maxTotalTokens: 200000, respMaxTokens: 17000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 850000 } },
    },
    {
      chatApiModel: 'DeepSeek-V4.1-Flash', maxTotalTokens: 1200000, respMaxTokens: 18000,
      extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 1300000 } },
    },
  ] })
  assert.equal(models['GPT-6 Astra'].limit.context, 800000)
  assert.equal(models['DeepSeek-V4.1-Flash'].limit.context, 1200000)
  assert.equal(models['GPT-6 Astra'].limit.output, 17000)
  assert.equal(models['DeepSeek-V4.1-Flash'].limit.output, 18000)
})
test('requires a valid numeric JoyCode Desktop directory context', async t => {
  const cases = [
    { name: 'missing extJson', id: 'GPT-6 Astra' },
    { name: 'malformed extJson JSON', id: 'DeepSeek-V4.1-Flash', extJson: '{' },
    { name: 'missing platform entry', id: 'GPT-6.1 Sol', extJson: {} },
    { name: 'GLM-5.3 missing platform entry', id: 'GLM-5.3', extJson: {} },
    { name: 'numeric string', id: 'DeepSeek-V4.1-Flash', extJson: { contextWindowByPlatform: { 'JoyCode Desktop': '1000000' } } },
    { name: 'nonpositive context', id: 'GPT-6 Astra', extJson: { contextWindowByPlatform: { 'JoyCode Desktop': 0 } } },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const model = { chatApiModel: scenario.id, maxTotalTokens: 200000, respMaxTokens: 12000 }
      if (Object.hasOwn(scenario, 'extJson')) model.extJson = scenario.extJson
      const { models } = await load(t, { list: [model] })
      assert.equal(models[scenario.id].limit.context, 200000)
      assert.equal(models[scenario.id].limit.output, 12000)
    })
  }
})
test('excluded tenants do not inherit public pricing', async t => {
  const { models } = await load(t, { tenant: 'JD' })
  assert.equal(models['GLM-5.3-agent'].rate, undefined)
  assert.notEqual(models['JoyAI-Code-1.6'].free, true)
})
test('model-specific billing rate takes priority', async t => {
  const { models } = await load(t, { list: [{ ...catalogue[1], billingRate: '0.3x' }] })
  assert.equal(models['GLM-5.3-agent'].rate, 0.3)
})
test('pricing fetch failure retains models without invented rates', async t => {
  const { models } = await load(t, { failRates: true })
  assert.equal(Object.keys(models).length, 4)
  assert.equal(models['GLM-5.3-agent'].rate, undefined)
})
test('catalogue fetch failure returns original fallback model list', async t => {
  const { models, provider } = await load(t, { failList: true })
  assert.equal(models, provider.models)
})
test('empty catalogue keeps the fallback model list', async t => {
  const { models, provider } = await load(t, { list: [] })
  assert.equal(models, provider.models)
})
test('a catalogue of only hidden models does not fall back', async t => {
  const { models } = await load(t, { list: [{ chatApiModel: 'JoyAI-Code-1.6', hidden: true }] })
  assert.deepEqual(models, {})
})
test('static fallback models do not advertise image input', async t => {
  const hooks = await plugin.server({})
  const cfg = {}
  await hooks.config(cfg)
  for (const id of ['Kimi-K2.6-agent', 'MiniMax-M3-agent', 'Doubao-Seed-2.0-pro-agent']) {
    assert.deepEqual(cfg.provider.joycode.models[id].modalities.input, ['text'])
  }
})
