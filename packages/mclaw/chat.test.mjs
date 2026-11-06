// normalizeChatResponse：网关以 HTTP 200 包裸 JSON 错误、正常 JSON、SSE 流、
// 空响应、超过旧 1MB 截断的大回复——全部本地构造，不碰网络。
import './nonet.mjs'
import { expect, test } from 'bun:test'
import { _internal } from './index.mjs'

const { normalizeChatResponse } = _internal

const sseResponse = (chunks) => new Response(
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
)

test('HTTP 200 + 裸 JSON 错误 01000002 → 401，标记登录失效', async () => {
  const out = await normalizeChatResponse(Response.json({ error: { code: '01000002', message: '无效的ApiKey' } }))
  expect(out.status).toBe(401)
  expect(out.headers.get('x-magpie-sign-in')).toBe('expired')
  const body = await out.json()
  expect(body.error.code).toBe('01000002')
  expect(body.error.message).toBe('无效的ApiKey')
})

test('HTTP 200 + 裸 JSON 错误（其他 code）→ 502，登录保持', async () => {
  const out = await normalizeChatResponse(Response.json({ error: { code: '01000005', message: '资源不存在' } }))
  expect(out.status).toBe(502)
  expect(out.headers.get('x-magpie-sign-in')).toBe('kept')
})

test('HTTP 200 + success:false → 502', async () => {
  const out = await normalizeChatResponse(Response.json({ success: false, code: 'X', message: 'nope' }))
  expect(out.status).toBe(502)
  expect((await out.json()).error.message).toBe('nope')
})

test('正常 JSON 回复原样透出', async () => {
  const payload = { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { total_tokens: 1 } }
  const out = await normalizeChatResponse(Response.json(payload))
  expect(out.status).toBe(200)
  expect(await out.json()).toEqual(payload)
})

test('超过 1MB 的合法 JSON 回复不再被截断成 502', async () => {
  const payload = { choices: [{ message: { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) } }] }
  const out = await normalizeChatResponse(Response.json(payload))
  expect(out.status).toBe(200)
  const body = await out.json()
  expect(body.choices[0].message.content.length).toBe(2 * 1024 * 1024)
})

test('SSE 流透传：检查过的首字节重放，其余照序', async () => {
  const chunks = ['data: {"id":"1","cho', 'ices":[{"delta":{"content":"你"}}]}\n\n', 'data: [DONE]\n\n']
  const out = await normalizeChatResponse(sseResponse(chunks))
  expect(out.status).toBe(200)
  expect(out.headers.get('content-type')).toBe('text/event-stream')
  const text = await out.text()
  expect(text).toBe(chunks.join(''))
})

test('空响应体 → 502 empty_response', async () => {
  const out = await normalizeChatResponse(new Response('', { status: 200 }))
  expect(out.status).toBe(502)
  expect((await out.json()).error.code).toBe('empty_response')
})

test('JSON 但既非错误也非对话响应 → 502 invalid_response', async () => {
  const out = await normalizeChatResponse(Response.json({ foo: 'bar' }))
  expect(out.status).toBe(502)
  expect((await out.json()).error.code).toBe('invalid_response')
})
