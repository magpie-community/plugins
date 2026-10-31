import { afterEach, expect, test } from 'bun:test'
import { flush, onRequest, onResponse, reset } from './aelios.hooks.mjs'
const realFetch = globalThis.fetch
const fixtures = [
  ['anthropic', { messages: [{ role: 'user', content: 'An ordinary question' }] }, {
    model: 'test', stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'OPENAI_API_KEY=sk-proj-syntheticSecret123456', signature: 'OPAQUE_SIGNATURE' },
      { type: 'redacted_thinking', data: 'OPAQUE_REDACTED' },
      { type: 'text', text: 'Ordinary answer', signature: 'OPAQUE_TEXT_SIGNATURE' },
      { type: 'tool_use', id: 't', name: 'lookup', input: { query: 'ordinary' } },
    ],
  }],
  ['responses', { input: 'An ordinary question' }, {
    model: 'test', status: 'completed', output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'ghp_syntheticSecretToken1234567890' }], encrypted_content: 'OPAQUE_ENCRYPTED' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ordinary answer', annotations: [{ text: 'OPAQUE_ANNOTATION' }] }] },
      { type: 'function_call', name: 'lookup', arguments: '{"query":"ordinary"}' },
      { type: 'custom_tool_call', name: 'lookup', input: 'ordinary' },
    ],
  }],
  ['chat', { messages: [{ role: 'user', content: 'An ordinary question' }] }, {
    model: 'test', choices: [{ index: 0, finish_reason: 'stop', message: {
      role: 'assistant', content: 'Ordinary answer', reasoning_content: 'password=syntheticSecret123',
      reasoning: 'OPAQUE_REASONING', signature: 'OPAQUE_SIGNATURE', encrypted_content: 'OPAQUE_ENCRYPTED',
      tool_calls: [{ type: 'function', function: { name: 'lookup', arguments: '{"query":"ordinary"}' } }],
    } }],
  }],
]
afterEach(() => { globalThis.fetch = realFetch; reset() })
for (const [protocol, request, reply] of fixtures) {
  test(`${protocol}: reasoning credentials and opaque fields never leave the response hook`, async () => {
    reset()
    const calls = []
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/identities')) return Response.json({ identities: [{ slug: 'test', name: 'Test', mainModels: ['*'] }] })
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return Response.json(String(url).endsWith('/recall') ? { memory: 'empty' } : { recorded: true })
    }
    const ctx = { protocol, model: 'test', origin: 'local', success: true, state: {},
      options: { serverUrl: 'https://example.test', apiKey: 'synthetic-key', record: true } }
    const before = structuredClone(reply)
    await onRequest(request, ctx)
    onResponse(reply, ctx)
    await flush()
    const record = calls.find(call => call.url.endsWith('/record'))
    expect(record).toBeDefined()
    const sent = JSON.stringify(record.body.reply)
    expect(sent).toContain('Ordinary answer')
    expect(sent).toContain('lookup')
    for (const omitted of ['syntheticSecret', 'OPAQUE_', 'thinking', 'reasoning', 'signature', 'encrypted_content']) expect(sent).not.toContain(omitted)
    expect(reply).toEqual(before)
    // A credential in retained visible speech must still block the whole record.
    const unsafe = structuredClone(reply)
    if (protocol === 'anthropic') unsafe.content.push({ type: 'text', text: 'password=visibleSecret' })
    else if (protocol === 'responses') unsafe.output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'password=visibleSecret' }] })
    else unsafe.choices[0].message.content = 'password=visibleSecret'
    onResponse(unsafe, ctx); await flush()
    expect(calls.filter(call => call.url.endsWith('/record'))).toHaveLength(1)
  })
}
