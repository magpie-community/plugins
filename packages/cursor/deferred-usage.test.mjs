// Legacy stateless-decoder regressions for reporting earlier Runs' usage as
// magpie_deferred. Production native owners instead retain one Run and count
// its final native totals once, with zero pending usage at each handoff.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { pb, decode, ledger, owed, misses, STEP_WAIT } = _internal
const real = globalThis.fetch
const wait = { ...STEP_WAIT }
afterEach(() => {
  globalThis.fetch = real
  Object.assign(STEP_WAIT, wait)
  owed.clear()
  misses.clear()
})

const update = (num, body) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
const listed = update(27, pb().varint(1, 1).done())
const call = {
  data: pb()
    .bytes(2, pb().varint(1, 7).str(15, "x1").bytes(11, pb().str(1, "magpie-bash").str(3, "call_1").str(5, "bash").done()).done())
    .done(),
}
async function step(book) {
  const out = []
  for await (const p of decode([listed, call], { send() {}, blobs: new Map(), tools: [], estimate: 1, stepUsage: book.own, owedUsage: book.owed })) out.push(p)
  book.done()
  return out.at(-1).usage
}

// the report's two tool steps of one pi session
const E1 = { inputTokens: 2, outputTokens: 1913, cacheReadTokens: 177533, cacheWriteTokens: 3735 } // 181270
const E2 = { inputTokens: 4, outputTokens: 2240, cacheReadTokens: 181266, cacheWriteTokens: 4400 } // 185670
const prompt = (e) => e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens

test("a step's prompt_tokens is its own Run's; what it collected of an earlier step is magpie_deferred", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 40, owedAt: 0 })
  const conv = "8a462df8-0000-4000-8000-000000000001"
  // step 1's Run began a while ago, as a tool step's did before its tool ran
  const since = Date.now() - 30_000
  const shown = []
  globalThis.fetch = async () => Response.json({ usageEventsDisplay: shown.map((e) => ({ ...e })) })

  // step 1: its event shows only after its wait, so it is owed and says 0
  const u1 = await step(ledger("tok", conv, since, undefined, true))
  expect(u1.prompt_tokens).toBe(0)
  expect(u1.magpie_deferred).toBeUndefined()

  // step 1's late event, then step 2's own
  // Cursor stamps a Run's event as the Run begins, a second or two in
  shown.push({ timestamp: String(since + 2000), conversationId: conv, tokenUsage: E1 })
  const since2 = Date.now()
  shown.push({ timestamp: String(since2 + 2000), conversationId: conv, tokenUsage: E2 })
  const u2 = await step(ledger("tok", conv, since2, undefined, true))

  // the context as it is: step 2's prompt alone (was 366940)
  expect(u2.prompt_tokens).toBe(prompt(E2))
  expect(u2.total_tokens).toBe(prompt(E2) + E2.outputTokens)
  expect(u2.prompt_tokens_details).toEqual({ cached_tokens: E2.cacheReadTokens, cache_write_tokens: E2.cacheWriteTokens })
  // and step 1's, which magpie still bills, apart
  expect(u2.magpie_deferred).toEqual({
    prompt_tokens: prompt(E1),
    completion_tokens: E1.outputTokens,
    cached_tokens: E1.cacheReadTokens,
    cache_write_tokens: E1.cacheWriteTokens,
  })
  // together, what Cursor counted
  expect(u1.prompt_tokens + u2.prompt_tokens + u2.magpie_deferred.prompt_tokens).toBe(prompt(E1) + prompt(E2))
})

test("a step that owed nothing has no magpie_deferred", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 200, owedAt: 0 })
  const conv = "8a462df8-0000-4000-8000-000000000002"
  const since = Date.now()
  globalThis.fetch = async () => Response.json({ usageEventsDisplay: [{ timestamp: String(since + 2000), conversationId: conv, tokenUsage: E1 }] })
  const u = await step(ledger("tok", conv, since, undefined, true))
  expect(u.prompt_tokens).toBe(prompt(E1))
  expect(u.magpie_deferred).toBeUndefined()
})
