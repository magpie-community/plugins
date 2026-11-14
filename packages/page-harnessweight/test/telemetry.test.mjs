import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeTaskDurations } from '../lib/task-duration.mjs'
import { taskSource, taskEmptyKey, compareTaskSources } from '../app/telemetry.js'

const now = Date.now()
const key = ch => ch.repeat(64)
const row = (source, taskKey, event, t, extra = {}) => ({ v: 1, agent: 'codex', source, taskKey, event, t, clock: 'event', ...extra })

test('mixed lifecycle sources are never published as a combined mean', () => {
  const events = [row('task-events-v1', key('a'), 'started', now - 4000), row('task-events-v1', key('a'), 'completed', now), row('codex-rollout', key('b'), 'completed', now, { durationMs: 5000, precision: 'millisecond' })]
  const result = summarizeTaskDurations(events, { since: now - 60_000, now }).get('codex')
  assert.deepEqual(result.sources, ['codex-rollout', 'task-events-v1'])
  assert.equal(result.samples, 2)
  assert.equal(result.available, false)
  assert.equal(result.reason, 'mixed-sources')
  assert.equal(result.averageMs, null)
  assert.equal(result.totalMs, null)
  assert.equal(taskEmptyKey({ agent: 'codex', taskDuration: result }), 'task.mixedSources')
  const failedOnly = [row('task-events-v1', key('a'), 'started', now - 4000), row('task-events-v1', key('a'), 'failed', now), row('codex-rollout', key('b'), 'completed', now, { durationMs: 5000, precision: 'millisecond' })]
  const single = summarizeTaskDurations(failedOnly, { since: now - 60_000, now }).get('codex')
  assert.equal(single.averageMs, 5000)
  assert.equal(single.metricSource, 'codex-rollout')
  assert.equal(taskSource({ agent: 'codex', taskDuration: single }), 'codex')
})

test('empty states describe evidence and supported adapters without asserting installation', () => {
  const agent = (id, timing = {}) => ({ agent: id, taskDuration: { sources: [], coverage: 'unavailable', ...timing } })
  assert.equal(taskSource(agent('codex')), 'codex')
  assert.equal(taskEmptyKey(agent('codex')), 'task.codexNoData')
  assert.equal(taskEmptyKey(agent('cursor')), 'task.cursorNoData')
  assert.equal(taskEmptyKey(agent('claude')), 'task.protocolNoData')
  assert.equal(taskEmptyKey(agent('claude', { coverage: 'observed' })), 'task.noCompleted')
  assert.equal(taskEmptyKey(agent('claude', { reason: 'read-error' })), 'task.readError')
  const cursor = agent('cursor', { sources: ['cursor-hooks'] }), codex = agent('codex', { sources: ['codex-rollout'] })
  assert.notEqual(compareTaskSources(cursor, codex), 0)
  assert.equal(compareTaskSources(codex, agent('codex', { sources: ['codex-rollout'] })), 0)
})

test('latest source records ignore future timestamps and do not depend on append order', async () => {
  const { summarize } = await import('../lib/summarize.mjs')
  const usage = [{ t: now - 1000, agent: 'codex', in: 1, out: 0, credits: 0 }, ...Array.from({ length: 60 }, () => ({ t: now - 10_000, agent: 'codex', in: 1, out: 0, credits: 0 })), { t: now + 1000, agent: 'codex', in: 1, out: 0, credits: 0 }]
  const tools = [{ t: now - 2000, agent: 'codex', tools: 1 }, { t: now + 2000, agent: 'codex', tools: 1 }]
  const result = summarize({ usage, tools, now, period: '7d' })
  assert.equal(result.lastUsage, now - 1000)
  assert.equal(result.lastTool, now - 2000)
  assert.equal(result.totals.calls, 61)
  assert.equal(result.toolSamples, 1)
})

test('a broken Codex reader does not erase valid lifecycle samples from another source', async () => {
  const { summarize } = await import('../lib/summarize.mjs')
  const events = [row('task-events-v1', key('c'), 'started', now - 4000), row('task-events-v1', key('c'), 'completed', now)]
  const result = summarize({ now, period: '7d', tasks: events, codexReadError: true })
  const codex = result.agents.find(a => a.agent === 'codex').taskDuration
  assert.equal(codex.averageMs, 4000)
  assert.equal(codex.metricSource, 'task-events-v1')
  assert.equal(result.taskTiming.readError, true)
})
