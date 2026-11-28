import assert from "node:assert/strict"
import { test } from "node:test"
import { _internal } from "./index.mjs"

const { estimateCached, tokensOf } = _internal

// The estimate is opt-in and only fills a silence (#1266): a figure the
// vendor gave always wins, and nothing is invented when no rate is set.
test("estimateCached fills only a cache the vendor was silent about", () => {
  const silent = { prompt_tokens: 1000, completion_tokens: 10, magpie_cache_unknown: true }
  const got = estimateCached(silent, 0.5)
  assert.equal(got.prompt_tokens_details.cached_tokens, 500)
  assert.equal(got.magpie_cache_estimated, 0.5)
  assert.equal(got.prompt_tokens, 1000, "prompt_tokens stays whole")

  const known = { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 200 } }
  const kept = estimateCached(known, 0.5)
  assert.equal(kept.prompt_tokens_details.cached_tokens, 200, "a real figure was overridden")
  assert.equal(kept.magpie_cache_estimated, undefined)
})

test("estimateCached does nothing without a usable rate", () => {
  const silent = { prompt_tokens: 1000, completion_tokens: 10, magpie_cache_unknown: true }
  for (const rate of [0, undefined, null, -1, 2, "x"]) {
    assert.equal(estimateCached(silent, rate).prompt_tokens_details, undefined, `rate ${rate} invented a figure`)
  }
})

test("tokensOf takes the rate only when asked", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 5 }
  const plain = tokensOf(usage)
  assert.equal(plain.magpie_cache_unknown, true)
  assert.equal(plain.prompt_tokens_details, undefined)

  const estimated = tokensOf(usage, 0.25)
  assert.equal(estimated.prompt_tokens_details.cached_tokens, 250)
  assert.equal(estimated.magpie_cache_estimated, 0.25)

  // a figure the vendor did send is left alone even with a rate
  const real = tokensOf({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 900 }, 0.25)
  assert.equal(real.prompt_tokens_details.cached_tokens, 900)
  assert.equal(real.magpie_cache_estimated, undefined)
})
