import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textOf, modeFor, effortFor, renderTranscript, renderDelta, byteLen, capText, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'

test('textOf handles strings, parts arrays, and junk', () => {
  assert.equal(textOf('hi'), 'hi')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf(null), '')
  assert.equal(textOf([{ type: 'image_url', image_url: { url: 'x' } }]), '[image omitted]')
  assert.equal(textOf(42), '42')
})

test('textOf understands Anthropic/Responses-style content parts', () => {
  // Responses API spellings
  assert.equal(textOf([{ type: 'input_text', text: 'hello' }]), 'hello')
  assert.equal(textOf([{ type: 'output_text', text: 'world' }]), 'world')
  // Anthropic tool blocks inside content arrays
  assert.equal(textOf([{ type: 'tool_result', content: 'tool output' }]), 'tool output')
  assert.equal(
    textOf([{ type: 'tool_result', content: [{ type: 'text', text: 'nested' }] }]),
    'nested',
  )
  assert.equal(
    textOf([{ type: 'tool_use', name: 'Read', input: { path: '/a' } }]),
    '[called tool Read({"path":"/a"})]',
  )
  // reasoning blocks contribute nothing
  assert.equal(
    textOf([{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }]),
    'answer',
  )
})

test('modeFor maps model ids to agent modes', () => {
  assert.equal(modeFor('fast'), 'fast')
  assert.equal(modeFor('balanced'), 'balanced')
  assert.equal(modeFor('smart'), 'smart')
  assert.equal(modeFor('advanced'), 'advanced')
  assert.equal(modeFor('provider/fast'), 'fast')
  assert.equal(modeFor('AWS Quick Smart'), 'smart')
  assert.equal(modeFor('gpt-5'), 'smart') // unknown → default
  assert.equal(modeFor(undefined), 'smart')
  assert.equal(modeFor(''), 'smart')
})

test('effortFor maps header/body spellings to quick levels', () => {
  assert.equal(effortFor('high', {}), 'high')
  assert.equal(effortFor(undefined, { reasoning_effort: 'low' }), 'low')
  assert.equal(effortFor(undefined, { thinking_effort: 'max' }), 'high')
  assert.equal(effortFor('xhigh', {}), 'high')
  assert.equal(effortFor('none', {}), 'off')
  assert.equal(effortFor('bogus', {}), undefined)
  assert.equal(effortFor(undefined, {}), undefined)
})

test('renderTranscript: system + history + raw final user turn', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply one' },
    { role: 'user', content: 'second' },
  ]
  const out = renderTranscript(messages, 'be terse')
  assert.ok(out.includes('[system instructions]\nbe terse'))
  assert.ok(out.includes('[conversation so far]'))
  assert.ok(out.includes('user: first'))
  assert.ok(out.includes('assistant: reply one'))
  // last user message goes in raw, no role prefix
  assert.ok(out.endsWith('\n\nsecond'))
  assert.ok(!out.includes('user: second'))
})

test('renderTranscript without system/history is just the user text', () => {
  assert.equal(renderTranscript([{ role: 'user', content: 'hello' }], ''), 'hello')
})

test('renderDelta renders only new user/tool content', () => {
  const delta = [
    { role: 'user', content: 'next question' },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'file body' },
  ]
  const out = renderDelta(delta)
  assert.ok(out.includes('next question'))
  assert.ok(out.includes('[tool_result read c1]'))
  assert.ok(out.includes('file body'))
})

test('capText truncates by bytes with marker and respects budget', () => {
  const s = 'x'.repeat(10 * 1024)
  const out = capText(s, 4096)
  assert.ok(byteLen(out) <= 4096)
  assert.ok(out.endsWith('[truncated]'))
  assert.equal(capText('short', 4096), 'short')
  // multi-byte chars: byte budget must hold even for CJK
  const cjk = capText('汉'.repeat(5000), 4096)
  assert.ok(byteLen(cjk) <= 4096)
  assert.ok(cjk.includes('truncated'))
})

test('renderTranscript drops oldest history first, keeps final user turn', () => {
  const messages = [
    { role: 'user', content: 'OLD-QUESTION-' + 'a'.repeat(3000) },
    { role: 'assistant', content: 'OLD-ANSWER-' + 'b'.repeat(3000) },
    { role: 'user', content: 'RECENT-' + 'c'.repeat(2000) },
    { role: 'assistant', content: 'RECENT-ANSWER-' + 'd'.repeat(2000) },
    { role: 'user', content: 'FINAL-QUESTION' },
  ]
  const stats = {}
  const out = renderTranscript(messages, 'sys', { maxBytes: 8000, stats })
  assert.ok(stats.truncated)
  assert.ok(out.endsWith('FINAL-QUESTION')) // current turn never dropped
  assert.ok(!out.includes('OLD-QUESTION')) // oldest dropped
  assert.ok(out.includes('RECENT-QUESTION') || out.includes('RECENT-ANSWER') || out.includes('recent'))
  assert.ok(out.includes('earlier message(s) omitted'))
  assert.ok(byteLen(out) <= 8000)
})

test('renderTranscript caps oversized system prompt and user turn', () => {
  const messages = [{ role: 'user', content: 'u'.repeat(30 * 1024) }]
  const stats = {}
  const out = renderTranscript(messages, 's'.repeat(40 * 1024), { maxBytes: UPSTREAM_TEXT_LIMIT, stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes('[truncated]'))
  assert.ok(byteLen(out) <= UPSTREAM_TEXT_LIMIT)
  assert.ok(out.endsWith('[truncated]')) // user turn itself was capped
})

test('renderDelta caps oversized tool results per block', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'F'.repeat(30 * 1024) },
    { role: 'user', content: 'next' },
  ]
  const stats = {}
  const out = renderDelta(delta, { stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes('[tool_result read c1]'))
  assert.ok(out.includes('next'))
  assert.ok(byteLen(out) < 20 * 1024) // 16KB cap + small user msg
})

test('renderDelta enforces total byte budget across blocks', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'a', content: 'A'.repeat(10 * 1024) },
    { role: 'tool', tool_call_id: 'c2', name: 'b', content: 'B'.repeat(10 * 1024) },
    { role: 'tool', tool_call_id: 'c3', name: 'c', content: 'C'.repeat(10 * 1024) },
    { role: 'user', content: 'final question' },
  ]
  const stats = {}
  const out = renderDelta(delta, { maxBytes: 20 * 1024, stats })
  assert.ok(stats.truncated)
  assert.ok(byteLen(out) <= 20 * 1024 + 64) // + marker overhead
  assert.ok(out.includes('final question')) // newest block always kept
  assert.ok(out.includes('earlier message(s) omitted'))
  assert.ok(!out.includes('[tool_result a c1]')) // oldest dropped
})
