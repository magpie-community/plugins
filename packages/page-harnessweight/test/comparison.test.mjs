import { test } from "node:test"
import assert from "node:assert/strict"
import { DIRECTIONS, extrema, extremum, metricValue } from "../app/comparison.js"

test("favorable directions reverse for cache hit ratio versus failure rate, with tied extremes", () => {
  const rows = [
    { calls: 10, prompt: 100, cacheRate: .9, errorRate: 0 },
    { calls: 10, prompt: 100, cacheRate: .1, errorRate: .2 },
    { calls: 10, prompt: 100, cacheRate: .9, errorRate: .1 },
  ]
  const ranges = extrema(rows)
  assert.deepEqual(extremum(.9, ranges.cacheRate, "high"), { edge: "max", quality: "best" })
  assert.deepEqual(extremum(.1, ranges.cacheRate, "high"), { edge: "min", quality: "worst" })
  assert.equal(extremum(0, ranges.errorRate, "low").quality, "best")
  assert.equal(extremum(.2, ranges.errorRate, "low").quality, "worst")
  assert.equal(extremum(.1, ranges.errorRate, "low"), null)
  assert.equal(extremum(10, ranges.calls), null)
  assert.equal(rows.filter(r => extremum(r.cacheRate, ranges.cacheRate, "high")?.quality === "best").length, 2)
})

test("missing latency, tools, sessions and cache denominators cannot win; single samples have no extremes", () => {
  const missing = { calls: 0, prompt: 0, cacheRate: 0, p50ms: 0, p50ttft: 0, tools: null, session: { measured: 0, median: null } }
  for (const key of ["cacheRate", "p50ms", "p50ttft", "toolTokens", "session"]) assert.equal(metricValue(missing, key), null)
  const rows = [missing, { calls: 2, prompt: 10, cacheRate: .8, p50ms: 200, tools: { avgTokens: 0 } }]
  assert.equal(extrema(rows).cacheRate, null)
  assert.equal(extremum(null, { min: 0, max: 100 }), null)
  assert.equal(extremum(NaN, { min: 0, max: 100 }), null)
  assert.equal(metricValue(rows[1], "toolTokens"), 0)
  assert.equal(extremum(20, { min: 10, max: 20 }).quality, "max")
  assert.equal(extremum(10, { min: 10, max: 20 }).quality, "min")
})


test("task duration ranks valid completions even without requests and excludes empty or invalid samples", () => {
  const measured = (averageMs, samples = 1) => ({ calls: 0, taskDuration: { available: true, averageMs, samples } })
  const rows = [measured(60_000), measured(180_000, 2), measured(600_000, 2),
    measured(0, 0), measured(-1), measured(NaN), { calls: 20 },
    { calls: 10, taskDuration: { available: false, averageMs: 0, samples: 0 } }]
  const ranges = extrema(rows)
  assert.equal(metricValue(rows[0], "taskDuration"), 60_000)
  assert.deepEqual(ranges.taskDuration, { min: 60_000, max: 600_000 })
  assert.deepEqual(extremum(60_000, ranges.taskDuration, DIRECTIONS.taskDuration), { edge: "min", quality: "best" })
  assert.deepEqual(extremum(600_000, ranges.taskDuration, DIRECTIONS.taskDuration), { edge: "max", quality: "worst" })
  for (const r of rows.slice(3)) assert.equal(metricValue(r, "taskDuration"), null)
  assert.equal(metricValue(measured(0), "taskDuration"), 0)
  assert.equal(extremum(60_000, extrema([rows[0]]).taskDuration, DIRECTIONS.taskDuration), null)
})
