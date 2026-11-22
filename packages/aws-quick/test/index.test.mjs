import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AwsQuickAuthPlugin } from '../index.mjs'
import { makeFetch } from '../lib/fetch.mjs'
import { createSessionStore, buildSession } from '../lib/oauth.mjs'
import { startFakeQuick } from './helpers/fake-quick.mjs'

test('AwsQuickAuthPlugin exposes expected metadata, concurrency, and models', async () => {
  const plugin = await AwsQuickAuthPlugin({}, {})
  assert.equal(plugin.auth.provider, 'aws-quick')
  assert.equal(plugin.auth.maxConcurrency, 2)
  assert.equal(plugin.auth.methods.length, 2)

  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider['aws-quick'].name, 'AWS Quick')

  const unauthModels = await plugin.provider.models({ models: { keep: true } }, {})
  assert.deepEqual(unauthModels, { keep: true })

  const models = await plugin.provider.models({ models: {} }, { auth: { type: 'api', key: 'k' } })
  assert.deepEqual(Object.keys(models).sort(), ['advanced', 'balanced', 'fast', 'smart'])
  assert.equal(models.smart.id, 'smart')
  assert.equal(models.smart.name, 'Quick Smart')
})

test('makeFetch enforces routes, methods, JSON parsing, and pre-aborted signals', async () => {
  const dummyMgr = { ensure: async () => { throw new Error('should not be called') } }
  const qf = makeFetch(dummyMgr, {}, undefined)

  const r404 = await qf('https://quick.aws.com/magpie-aws-quick/v1/embeddings', { method: 'POST' })
  assert.equal(r404.status, 404)

  const r405a = await qf('https://quick.aws.com/magpie-aws-quick/v1/models', { method: 'POST' })
  assert.equal(r405a.status, 405)
  assert.equal(r405a.headers.get('allow'), 'GET')

  const r405b = await qf('https://quick.aws.com/magpie-aws-quick/v1/chat/completions', { method: 'GET' })
  assert.equal(r405b.status, 405)
  assert.equal(r405b.headers.get('allow'), 'POST')

  const rModels = await qf('https://quick.aws.com/magpie-aws-quick/v1/models', { method: 'GET' })
  assert.equal(rModels.status, 200)
  const modelsJson = await rModels.json()
  assert.equal(modelsJson.data.length, 4)

  const rBadJson = await qf('https://quick.aws.com/magpie-aws-quick/v1/chat/completions', { method: 'POST', body: '{bad' })
  assert.equal(rBadJson.status, 400)

  const ac = new AbortController()
  ac.abort()
  const rAbort = await qf('https://quick.aws.com/magpie-aws-quick/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }),
    signal: ac.signal,
  })
  assert.equal(rAbort.status, 499)
})

test('loader reuses OAuth direct backend and WebSocket across repeated loader() calls', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plugin-test-'))
  const fake = await startFakeQuick({})
  try {
    const store = createSessionStore({ dir })
    const sess = buildSession({
      tenant_url: 'https://qbs-x.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
      tokens: { access_token: 'a', refresh_token: 'rt', id_token: 'id-1', expires_in: 3600 },
      user_info: { user_arn: 'arn:u', email: 'u@x.com' },
      client_id: 'c', client_secret: 's', discovery: { idc_region: 'us-east-1' },
    })
    sess.ws_host = fake.wsHost
    store.set('oauth-key', sess)

    const plugin = await AwsQuickAuthPlugin({}, { sessionDir: dir, log: () => {} })
    const getAuth = async () => ({ type: 'api', key: 'oauth-key', metadata: { mode: 'oauth' } })

    const loaded1 = await plugin.auth.loader(getAuth)
    const r1 = await loaded1.fetch(`${loaded1.baseURL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'one' }] }),
    })
    assert.equal(r1.status, 200)
    await r1.json()

    const loaded2 = await plugin.auth.loader(getAuth)
    const r2 = await loaded2.fetch(`${loaded2.baseURL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'two' }] }),
    })
    assert.equal(r2.status, 200)
    await r2.json()

    // Both loader calls must share one underlying WebSocket connection.
    assert.equal(fake.state.connections, 1)
  } finally {
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
