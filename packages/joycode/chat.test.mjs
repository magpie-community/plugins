import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

async function request(t, response, {
  input = 'https://api-ai.jd.com/v1/chat/completions',
  payload = { model: 'JoyAI-Code-1.6', messages: [{ role: 'user', content: 'OK' }], stream: true },
  init = {},
  upstream,
} = {}) {
  t.mock.method(globalThis, 'fetch', async (url, requestInit) => {
    if (new URL(url).searchParams.get('functionId') === 'joycode_userInfo') {
      return Response.json({ code: 0, data: { userId: 'test-user', tenant: 'test-tenant', orgFullName: 'test-org' } })
    }
    upstream?.(url, requestInit)
    return typeof response === 'function' ? response(url, requestInit) : response
  })
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  return loader.fetch(input, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...init,
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

for (const [name, input, payload, functionId, npmShape] of [
  [
    'Responses',
    'https://api-ai.jd.com/v1/responses',
    { model: 'GPT-5.6 Sol', input: 'OK', stream: true },
    'responses_completions',
    'input',
  ],
  [
    'Anthropic Messages',
    'https://api-ai.jd.com/v1/messages',
    { model: 'Claude-Opus-5-hq', max_tokens: 8, messages: [{ role: 'user', content: 'OK' }], stream: true },
    'anthropic_completions',
    'messages',
  ],
]) {
  test(`${name} requests are signed on their own gateway and keep their shape`, async t => {
    let seen
    const r = await request(t, new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }), {
      input,
      payload,
      init: { headers: { 'content-type': 'application/json', 'x-api-key': 'host-key' } },
      upstream(url, init) {
        seen = { url, init }
      },
    })
    assert.equal(new URL(seen.url).searchParams.get('functionId'), functionId)
    const sent = JSON.parse(seen.init.body)
    assert.equal(sent.model, payload.model)
    assert.deepEqual(sent[npmShape], payload[npmShape])
    assert.equal(sent.userId, 'test-user')
    assert.equal(sent.tenant, 'test-tenant')
    assert.equal(seen.init.headers.get('x-api-key'), null)
    assert.equal(seen.init.headers.get('ptkey'), 'fake-key')
    assert.equal(r.status, 200)
    assert.equal(await r.text(), 'data: [DONE]\n\n')
  })
}

test('Chat Completions keeps using the chat gateway', async t => {
  let seen
  const r = await request(t, new Response('data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), {
    upstream(url) { seen = new URL(url) },
  })
  assert.equal(seen.searchParams.get('functionId'), 'chat_completions')
  assert.equal(r.status, 200)
})

test('Request input carries its URL, body, method, and headers into routing', async t => {
  let seen
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).searchParams.get('functionId') === 'joycode_userInfo') {
      return Response.json({ code: 0, data: { userId: 'test-user', tenant: 'test-tenant' } })
    }
    seen = { url, init }
    return new Response('event: message_stop\n\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  const payload = {
    model: 'Claude-Opus-5-hq',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'OK' }],
    stream: true,
  }
  const r = await loader.fetch(new Request('https://api-ai.jd.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'host-key' },
    body: JSON.stringify(payload),
  }))
  assert.equal(new URL(seen.url).searchParams.get('functionId'), 'anthropic_completions')
  assert.equal(seen.init.method, 'POST')
  const sent = JSON.parse(seen.init.body)
  assert.equal(sent.model, payload.model)
  assert.deepEqual(sent.messages, payload.messages)
  assert.equal(sent.userId, 'test-user')
  assert.equal(sent.language, 'UNKNOWN')
  assert.equal(seen.init.headers.get('x-api-key'), null)
  assert.equal(seen.init.headers.get('ptkey'), 'fake-key')
  assert.equal(await r.text(), 'event: message_stop\n\ndata: {}\n\n')
})

test('Anthropic double-wrapped SSE is normalized across chunk boundaries', async t => {
  const upstreamText = [
    'data: event: message_start\n\n',
    'data: data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'data: event: content_block_delta\n\n',
    'data: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
    'data: event: message_stop\n\n',
    'data: data: {"type":"message_stop"}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const split = upstreamText.indexOf('data: data:', 20) + 8
  const r = await request(t, new Response(chunks([
    upstreamText.slice(0, split),
    upstreamText.slice(split),
  ]), { headers: { 'content-type': 'text/event-stream' } }), {
    input: 'https://api-ai.jd.com/v1/messages',
    payload: { model: 'Claude-Opus-5-hq', max_tokens: 8, messages: [{ role: 'user', content: 'OK' }], stream: true },
  })
  assert.equal(r.status, 200)
  assert.equal(await r.text(), [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
    'data: [DONE]\n\n',
  ].join(''))
})

test('standard Anthropic SSE is preserved byte for byte', async t => {
  const text = 'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'
  const r = await request(t, new Response(chunks([text.slice(0, 17), text.slice(17)]), {
    headers: { 'content-type': 'text/event-stream' },
  }), {
    input: 'https://api-ai.jd.com/v1/messages',
    payload: { model: 'Claude-Opus-5-hq', max_tokens: 8, messages: [{ role: 'user', content: 'OK' }], stream: true },
  })
  assert.equal(r.status, 200)
  assert.equal(await r.text(), text)
})

test('Responses double-wrapped SSE is normalized across chunk boundaries', async t => {
  const upstreamText = [
    'data: data: {"type":"response.created","sequence_number":0}\n\n',
    'data: data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: data: {"type":"response.completed","sequence_number":2}\n\n',
  ].join('')
  const split = upstreamText.indexOf('output_text') - 4
  const r = await request(t, new Response(chunks([
    upstreamText.slice(0, split),
    upstreamText.slice(split),
  ]), { headers: { 'content-type': 'text/event-stream' } }), {
    input: 'https://api-ai.jd.com/v1/responses',
    payload: { model: 'GPT-6 Astra', input: 'OK', stream: true },
  })
  assert.equal(r.status, 200)
  assert.equal(await r.text(), [
    'data: {"type":"response.created","sequence_number":0}\n\n',
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: {"type":"response.completed","sequence_number":2}\n\n',
  ].join(''))
})

test('Responses drops unstored reasoning ids but keeps inline reasoning and other ids', async t => {
  let sent
  const payload = {
    model: 'GPT-6 Astra',
    store: false,
    stream: true,
    input: [
      { type: 'message', role: 'user', content: 'OK' },
      { type: 'reasoning', id: 'rs_18e2e0b7486f2800000002e3', summary: [{ type: 'summary_text', text: 'notes' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '{}' },
    ],
  }
  const r = await request(t, new Response('data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), {
    input: 'https://api-ai.jd.com/v1/responses',
    payload,
    upstream(_url, init) { sent = JSON.parse(init.body) },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(sent.input, [
    { type: 'message', role: 'user', content: 'OK' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'notes' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '{}' },
  ])
  assert.equal(sent.store, false)
})

test('Responses keeps reasoning ids when the upstream stores the items', async t => {
  let sent
  const reasoning = { type: 'reasoning', id: 'rs_stored', summary: [] }
  const r = await request(t, new Response('data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }), {
    input: 'https://api-ai.jd.com/v1/responses',
    payload: { model: 'GPT-6 Astra', store: true, stream: true, input: [reasoning] },
    upstream(_url, init) { sent = JSON.parse(init.body) },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(sent.input, [reasoning])
})

test('Anthropic count_tokens returns 404 without contacting upstream', async t => {
  let fetchCalls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls++
    throw new Error('count_tokens must not call upstream')
  })
  const hooks = await plugin.server({})
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  const r = await loader.fetch('https://api-ai.jd.com/v1/messages/count_tokens', {
    method: 'POST',
    body: JSON.stringify({
      model: 'Claude-Opus-5-hq',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  assert.equal(r.status, 404)
  assert.equal(fetchCalls, 0)
  assert.equal((await r.json()).error.type, 'unsupported_endpoint')
})

for (const [name, input, payload, body] of [
  [
    'Responses',
    'https://api-ai.jd.com/v1/responses',
    { model: 'GPT-5.6 Sol', input: 'OK', stream: false },
    { id: 'resp_1', object: 'response', status: 'completed', output: [] },
  ],
  [
    'Anthropic Messages',
    'https://api-ai.jd.com/v1/messages',
    { model: 'Claude-Opus-5-hq', max_tokens: 8, messages: [{ role: 'user', content: 'OK' }] },
    { id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn' },
  ],
]) {
  test(`${name} non-streaming JSON is a valid success response`, async t => {
    const r = await request(t, Response.json(body), { input, payload })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), body)
  })
}

test('flatten applies only to Chat Completions, never Responses', async t => {
  let sent
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).searchParams.get('functionId') === 'joycode_userInfo') {
      return Response.json({ code: 0, data: { userId: 'test-user' } })
    }
    sent = JSON.parse(init.body)
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const hooks = await plugin.server({}, { flatten: true })
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-key' }))
  const r = await loader.fetch('https://api-ai.jd.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'GPT-5.6 Sol', input: 'OK', stream: true }),
  })
  await r.text()
  assert.equal(sent.input, 'OK')
  assert.equal(sent.messages, undefined)
})

test('HTTP 403 permission denial is not marked as expired credentials', async t => {
  const r = await request(t, Response.json({ error: { code: 'AI_GRAY_ACCESS_DENIED', message: 'denied' } }, { status: 403 }))
  assert.equal(r.status, 403)
  assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
})
