import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textOf, modeFor, effortFor, renderTranscript, renderDelta, fairBlockCaps, byteLen, capText, UPSTREAM_TEXT_LIMIT } from '../lib/translate.mjs'

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

test('fairBlockCaps water-fills full frame budget across single and parallel tool results', () => {
  // Single 52KB file fits inside 58KB budget without any 48KB ceiling.
  const one = [{ role: 'tool', tool_call_id: 'c1', name: 'read', content: 'A'.repeat(52 * 1024) }]
  const capsOne = fairBlockCaps(one, 58 * 1024)
  assert.ok(capsOne.toolResultCap >= 52 * 1024)

  // Two parallel 25KB files both fit completely untruncated inside 58KB.
  const twoFit = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'A'.repeat(25 * 1024) },
    { role: 'tool', tool_call_id: 'c2', name: 'read', content: 'B'.repeat(25 * 1024) },
  ]
  const capsTwoFit = fairBlockCaps(twoFit, 58 * 1024)
  const outTwoFit = renderDelta(twoFit, { maxBytes: 58 * 1024, ...capsTwoFit })
  assert.ok(outTwoFit.includes('A'.repeat(25 * 1024)))
  assert.ok(outTwoFit.includes('B'.repeat(25 * 1024)))
  assert.ok(!outTwoFit.includes('[truncated]'))

  // One tiny 2KB + one huge 70KB: tiny keeps full 2KB, huge gets ~56KB instead of 29KB or 16KB.
  const skewed = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'S'.repeat(2 * 1024) },
    { role: 'tool', tool_call_id: 'c2', name: 'read', content: 'L'.repeat(70 * 1024) },
  ]
  const capsSkew = fairBlockCaps(skewed, 58 * 1024)
  assert.ok(capsSkew.toolResultCap > 54 * 1024 && capsSkew.toolResultCap < 57 * 1024)

  // Two parallel 35KB files inside 58KB: each gets ~29KB instead of 16KB, and both survive.
  const twoBig = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'X'.repeat(35 * 1024) },
    { role: 'tool', tool_call_id: 'c2', name: 'read', content: 'Y'.repeat(35 * 1024) },
  ]
  const capsTwoBig = fairBlockCaps(twoBig, 58 * 1024)
  assert.ok(capsTwoBig.toolResultCap > 28 * 1024 && capsTwoBig.toolResultCap < 30 * 1024)
  const stats = {}
  const outTwoBig = renderDelta(twoBig, { maxBytes: 58 * 1024, stats, ...capsTwoBig })
  assert.ok(stats.truncated)
  assert.ok(byteLen(outTwoBig) <= 58 * 1024)
  assert.ok(outTwoBig.includes('[tool_result read c1]'))
  assert.ok(outTwoBig.includes('[tool_result read c2]'))
})

test('fairBlockCaps prioritizes user question over earlier tool results and keeps dense parallel results', () => {
  // 30KB budget with 40KB tool_result + 20KB user question: user stays 100% intact,
  // earlier tool_result gets the remaining ~10KB instead of cutting both to ~15KB.
  const question = 'Q'.repeat(20 * 1024)
  const mixed = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'T'.repeat(40 * 1024) },
    { role: 'user', content: question },
  ]
  const capsMixed = fairBlockCaps(mixed, 30 * 1024)
  const mixedStats = {}
  const outMixed = renderDelta(mixed, { maxBytes: 30 * 1024, stats: mixedStats, ...capsMixed })
  assert.ok(mixedStats.truncated)
  assert.ok(byteLen(outMixed) <= 30 * 1024)
  assert.ok(outMixed.includes(question), 'user question must stay untruncated')
  assert.ok(outMixed.includes('[tool_result read c1]'), 'earlier tool_result keeps remaining ~10KB')
  assert.ok(capsMixed.toolResultCap > 9 * 1024 && capsMixed.toolResultCap < 11 * 1024)

  // 30 × 5KB tool results in 20KB budget: all 30 survive (~650B each) instead of dropping 11.
  const many = Array.from({ length: 30 }, (_, i) => ({
    role: 'tool', tool_call_id: `c${i}`, name: 'read', content: `R${i}_` + 'Z'.repeat(5 * 1024),
  }))
  const capsMany = fairBlockCaps(many, 20 * 1024)
  const manyStats = {}
  const outMany = renderDelta(many, { maxBytes: 20 * 1024, stats: manyStats, ...capsMany })
  assert.ok(manyStats.truncated)
  assert.ok(byteLen(outMany) <= 20 * 1024)
  assert.ok(!outMany.includes('earlier message(s) omitted'))
  for (let i = 0; i < 30; i++) {
    assert.ok(outMany.includes(`[tool_result read c${i}]`), `tool_result c${i} should be preserved`)
  }
})
