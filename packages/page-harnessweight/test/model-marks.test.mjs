import test from 'node:test'
import assert from 'node:assert/strict'
import { modelIdentity, rankedModels } from '../app/model-marks.js'

test('model brands follow the model leaf, not the gateway or harness', () => {
  assert.equal(modelIdentity('codex/MiniMax-M3.1-Flash').family, 'minimax')
  assert.equal(modelIdentity('antigravity/claude-opus-5-5').family, 'claude')
  assert.equal(modelIdentity('openrouter/google/gemini-3.8-flash:free').family, 'gemini')
  assert.equal(modelIdentity('GLM-5.3-Flash').family, 'glm')
  assert.equal(modelIdentity('gpt-6.1-sol').family, 'openai')
  assert.equal(modelIdentity('xiaomi/mimo-v2-flash').family, 'mimo')
  for (const alias of ['hy4free', 'auto', 'unknown', 'codex', 'gpt-proxy/auto', 'claude-wrapper/custom']) {
    assert.deepEqual(modelIdentity(alias), { family: null, icon: null }, alias)
  }
})

test('model strip sorts request counts descending without changing the source or merging versions', () => {
  const input = [{name:'gpt-6.1-sol',count:20},{name:'MiniMax-M3.1-Flash',count:300},{name:'gpt-6.1-terra',count:40},{name:'unknown',count:2},{name:'absent',count:0}]
  const original = structuredClone(input)
  const ranked = rankedModels(input)
  assert.deepEqual(ranked.map(m=>[m.name,m.count]), [['MiniMax-M3.1-Flash',300],['gpt-6.1-terra',40],['gpt-6.1-sol',20],['unknown',2]])
  assert.deepEqual(input, original)
  assert.equal(ranked.at(-1).icon, null)
  assert.ok(ranked.slice(0,3).every(m=>m.icon.startsWith('data:image/svg+xml;base64,')))
  assert.deepEqual(rankedModels(), [])
})
