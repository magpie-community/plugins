import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

const catalogue = [
  { chatApiModel: 'JoyAI-Code-1.6', label: 'JoyAI-Code-1.6', maxTotalTokens: 200000, respMaxTokens: 64000, features: ['function_call'] },
  { chatApiModel: 'GLM-5.3-agent', label: 'GLM-5.3', maxTotalTokens: 200000, respMaxTokens: 64000, features: ['function_call'] },
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
  assert.deepEqual(Object.keys(models), ['JoyAI-Code-1.6', 'GLM-5.3-agent'])
  assert.equal(models['JoyAI-Code-1.6'].rate, 0)
  assert.equal(models['JoyAI-Code-1.6'].free, true)
  assert.equal(models['GLM-5.3-agent'].rate, 0.6)
  assert.equal(models['GLM-5.3-agent'].capabilities.input.image, false)
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
  assert.equal(Object.keys(models).length, 2)
  assert.equal(models['GLM-5.3-agent'].rate, undefined)
})
test('catalogue fetch failure returns original fallback model list', async t => {
  const { models, provider } = await load(t, { failList: true })
  assert.equal(models, provider.models)
})
