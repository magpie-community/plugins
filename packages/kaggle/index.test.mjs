import { test, expect } from 'bun:test'
import { KagglePlugin, _internal } from './index.mjs'

test('plugin exposes auth, config and provider hooks', async () => {
  const hooks = await KagglePlugin({}, {})
  expect(typeof hooks.config).toBe('function')
  expect(hooks.auth.provider).toBe('kaggle')
  expect(hooks.auth.methods[0].type).toBe('api')
  expect(typeof hooks.auth.loader).toBe('function')
  expect(typeof hooks.auth.usage).toBe('function')
  expect(hooks.provider.id).toBe('kaggle')
  expect(typeof hooks.provider.models).toBe('function')
})

test('config hook declares the provider', async () => {
  const hooks = await KagglePlugin({}, {})
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider.kaggle.name).toBe('Kaggle Models')
  expect(cfg.provider.kaggle.npm).toBe('@ai-sdk/openai-compatible')
})

test('models hook lists entries for a signed-in account', async () => {
  const hooks = await KagglePlugin({}, {})
  const out = await hooks.provider.models({ models: {} }, { auth: { type: 'api', key: 'KGATx' } })
  const ids = Object.keys(out)
  expect(ids.length).toBeGreaterThanOrEqual(8)
  expect(out['sonnet-5'].api.npm).toBe('@ai-sdk/openai-compatible')
  expect(out['sonnet-5'].limit.context).toBeGreaterThan(0)
})

test('usageFromQuota maps daily and monthly windows', () => {
  const u = _internal.usageFromQuota([
    { quotaUsed: 1.5, totalQuotaAllowed: 10, refillPeriod: 'daily', refillTime: '2026-11-27T00:00:00Z' },
    { quotaUsed: 1.5, totalQuotaAllowed: 100, refillPeriod: 'monthly' },
  ])
  expect(u.windows.length).toBe(2)
  expect(u.windows[0].name).toBe('每日额度')
  expect(u.windows[0].used).toBeCloseTo(15)
  expect(u.windows[0].limit).toBe(10)
  expect(u.windows[1].limit).toBe(100)
})

test('the intercepted fetch answers GET /models locally', async () => {
  const f = _internal.makeFetch('KGATx', {})
  const resp = await f('https://model-proxy.kaggle.local/magpie-kaggle/v1/models')
  const j = await resp.json()
  expect(j.object).toBe('list')
  expect(j.data.some((m) => m.id === 'sonnet-5')).toBe(true)
})

test('the intercepted fetch mints and forwards chat completions', async () => {
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/models/proxy/token')) {
      return new Response(JSON.stringify({ token: 'px', baseUri: 'https://mp.example/models', expiryTime: new Date(Date.now() + 3600e3).toISOString() }), { status: 200 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 })
  }
  const f = _internal.makeFetch('KGATtestkey', { fetchImpl: fake })
  const resp = await f('https://model-proxy.kaggle.local/magpie-kaggle/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'sonnet-5', messages: [] }),
  })
  expect(resp.status).toBe(200)
  const upstream = calls.find((c) => c.url.includes('mp.example'))
  expect(upstream).toBeTruthy()
  expect(upstream.url).toBe('https://mp.example/models/openapi/v1/chat/completions')
  expect(upstream.init.headers.authorization).toBe('Bearer px')
  expect(JSON.parse(upstream.init.body).model).toBe('anthropic/claude-sonnet-5@default')
})
