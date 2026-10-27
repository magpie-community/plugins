import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

async function request(t, response) {
  t.mock.method(globalThis, 'fetch', async url => new URL(url).searchParams.get('functionId') === 'joycode_userInfo'
    ? Response.json({ code: 0, data: { userId: 'test-user', tenant: 'test-tenant', orgFullName: 'test-org' } })
    : response)
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  return loader.fetch('https://api-ai.jd.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'JoyAI-Code-1.6', messages: [{ role: 'user', content: 'OK' }], stream: true }),
  })
}
function chunks(parts) {
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close() } })
}
test('HTTP 200 raw gateway denial becomes actionable error, not empty SSE', async t => {
  const r = await request(t, new Response(chunks([' {"error":', '{"code":"AI_GRAY_ACCESS_DENIED","message":"访问受限，请联系管理员开通"}}']), { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 403)
  assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
  assert.equal((await r.json()).error.code, 'AI_GRAY_ACCESS_DENIED')
})
test('HTTP 200 SSE with JD msg preserves the business error reason', async t => {
  const r = await request(t, new Response(JSON.stringify({ code: 9, msg: '积分已用完', data: { private: 'private-marker' } }), { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 502)
  assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
  assert.deepEqual((await r.json()).error, { type: 'upstream_error', code: 9, message: '积分已用完' })
})

test('HTTP 200 SSE code 401 expires a ticket after identity has been cached', async t => {
  let infoCalls = 0, chats = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).searchParams.get('functionId') === 'joycode_userInfo') {
      infoCalls++
      return Response.json({ code: 0, data: { userId: 'test-user' } })
    }
    chats++
    return new Response(chats === 1 ? 'data: [DONE]\n\n' : JSON.stringify({ code: 401, data: null, msg: '登录票据已失效' }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  const send = () => loader.fetch('https://api-ai.jd.com/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'JoyAI-Code-1.6', messages: [{ role: 'user', content: 'OK' }], stream: true }),
  })
  const first = await send()
  assert.equal(first.status, 200)
  await first.text()
  const expired = await send()
  assert.equal(infoCalls, 1)
  assert.equal(chats, 2)
  assert.equal(expired.status, 401)
  assert.equal(expired.headers.get('x-magpie-sign-in'), 'expired')
  assert.deepEqual((await expired.json()).error, { type: 'upstream_error', code: 401, message: '登录票据已失效' })
})

test('valid SSE including tool deltas is preserved byte for byte', async t => {
  const text = ': heartbeat\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n'
  const r = await request(t, new Response(chunks([text.slice(0,4), text.slice(4)]), { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 200)
  assert.equal(await r.text(), text)
})
test('empty upstream success becomes gateway error', async t => {
  const r = await request(t, new Response('', { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.status, 502)
})
test('chat adds authenticated account metadata while preserving tools and messages', async t => {
  let infoCalls = 0
  const payload = { model: 'JoyAI-Code-1.6', messages: [{ role: 'user', content: 'OK' }], tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }], stream: true, userId: 'untrusted-user' }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).searchParams.get('functionId') === 'joycode_userInfo') {
      infoCalls++
      return Response.json({ code: 0, data: { userId: 'test-user', tenant: 'test-tenant', orgFullName: 'test-org' } })
    }
    const sent = JSON.parse(init.body)
    assert.equal(sent.userId, 'test-user')
    assert.equal(sent.tenant, 'test-tenant')
    assert.equal(sent.orgFullName, 'test-org')
    assert.equal(sent.language, 'UNKNOWN')
    assert.deepEqual(sent.messages, payload.messages)
    assert.deepEqual(sent.tools, payload.tools)
    assert.equal(init.headers.get('tenant'), 'test-tenant')
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  for (let i = 0; i < 2; i++) {
    const r = await loader.fetch('https://api-ai.jd.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(payload) })
    await r.text()
  }
  assert.equal(infoCalls, 1)
})

test('HTTP 403 permission denial is not marked as expired credentials', async t => {
  const r = await request(t, Response.json({ error: { code: 'AI_GRAY_ACCESS_DENIED', message: 'denied' } }, { status: 403 }))
  assert.equal(r.status, 403)
  assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
})
