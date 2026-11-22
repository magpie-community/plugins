import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createProxyServer } from '../bin/serve.mjs'
import { startFakeQuick } from './helpers/fake-quick.mjs'

let fake
let server
let baseUrl

before(async () => {
  fake = await startFakeQuick({})
  const outpost = {
    outpostId: async () => 'proxy-outpost-1',
    session: async () => ({
      ws_host: fake.wsHost,
      id_token: 'proxy-tok',
      actor_arn: 'arn:proxy',
      usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
  }
  server = createProxyServer({
    token: 'secret-token',
    outpostMgr: { ensure: async () => outpost },
    options: { identity: 'proxy-test', log: () => {} },
    maxBodyBytes: 512,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server?.close(r))
  await fake?.close()
})

test('proxy enforces PROXY_TOKEN and exposes /health + /v1/models', async () => {
  const unauth = await fetch(`${baseUrl}/health`)
  assert.equal(unauth.status, 401)

  const bad = await fetch(`${baseUrl}/health`, { headers: { Authorization: 'Bearer wrong' } })
  assert.equal(bad.status, 401)

  const ok = await fetch(`${baseUrl}/health`, { headers: { Authorization: 'Bearer secret-token' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true })

  const models = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': 'secret-token' } })
  assert.equal(models.status, 200)
  const data = await models.json()
  assert.equal(data.object, 'list')
  assert.equal(data.data.length, 4)
})

test('proxy serves chat completions and handles 400 / 404 / 413 cleanly', async () => {
  const headers = { Authorization: 'Bearer secret-token', 'content-type': 'application/json' }

  const r404 = await fetch(`${baseUrl}/v1/nope`, { method: 'POST', headers, body: '{}' })
  assert.equal(r404.status, 404)

  const r400 = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: 'not-json' })
  assert.equal(r400.status, 400)

  const r413 = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'x'.repeat(1024) }] }),
  })
  assert.equal(r413.status, 413)

  const r200 = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'hello proxy' }] }),
  })
  assert.equal(r200.status, 200)
  const json = await r200.json()
  assert.ok(json.choices[0].message.content.startsWith('echo:hello proxy'))
})
