import { test } from "node:test"
import assert from "node:assert/strict"

import { MODELS, modelCatalog, thinkingPref, tierOf } from "../models.mjs"

test("every model declares the window of the model underneath", () => {
  for (const [id, m] of Object.entries(MODELS)) {
    assert.ok(Number.isInteger(m.ctx) && m.ctx >= 100_000, `${id} context`)
    assert.ok(Number.isInteger(m.out) && m.out > 0, `${id} output`)
    assert.ok(m.out <= m.ctx, `${id} output fits context`)
    assert.ok(m.name && m.pref, `${id} name/pref`)
  }
})

test("the catalog is not one uniform window", () => {
  const catalog = modelCatalog("max")
  const contexts = new Set(Object.values(catalog).map((m) => m.limit.context))
  assert.ok(contexts.size >= 4, `expected several windows, got ${[...contexts]}`)
  assert.equal(catalog.gemini.limit.context, 1_000_000)
  assert.equal(catalog.gpt.limit.context, 400_000)
  assert.equal(catalog.sonnet.limit.context, 200_000)
  assert.equal(catalog.grok.limit.context, 256_000)
  assert.equal(catalog.sonar.limit.context, 128_000)
})

test("a window is published as a flagged upstream figure", () => {
  const sonnet = modelCatalog("pro").sonnet
  assert.deepEqual(sonnet.limit, { context: 200_000, output: 64_000 })
  assert.equal(sonnet.limitEstimated, true)
})

test("tiers gate the catalog: 1 free, 19 pro, 23 max", () => {
  assert.equal(Object.keys(modelCatalog("free")).length, 1)
  assert.equal(Object.keys(modelCatalog("pro")).length, 19)
  assert.equal(Object.keys(modelCatalog("max")).length, 23)
  assert.equal(modelCatalog("pro").opus, undefined)
  assert.ok(modelCatalog("max").opus)
})

test("an unknown tier falls back to pro", () => {
  assert.equal(tierOf("nonsense"), "pro")
  assert.equal(Object.keys(modelCatalog("nonsense")).length, 19)
})

test("reasoning variants map preference to the thinking preference", () => {
  assert.equal(thinkingPref("claude50sonnet"), "claude50sonnetthinking")
  assert.equal(thinkingPref("gpt5_nano"), null)
  assert.equal(modelCatalog("pro").sonnet.capabilities.reasoning, true)
  assert.equal(modelCatalog("pro")["gpt-nano"].capabilities.reasoning, false)
})

test("no model claims function calling", () => {
  for (const m of Object.values(modelCatalog("max"))) {
    assert.equal(m.capabilities.toolcall, false)
    assert.equal(m.tool_call, false)
  }
})
