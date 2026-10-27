import { expect, test } from "bun:test"
import * as mod from "./circuit-breaker.middleware.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)

// A rest grows on the clock, and the window slides on it, which cases.json
// cannot wait for. These two tests sleep the second they need — the rest and
// the window are set to one second for them — and use models of their own, so
// they neither read nor leave anything the cases above are counting.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ctxFor is a ctx shaped as the gateway's: one per request, reject recording.
function ctxFor(options) {
  const refused = []
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "",
    options, state: {}, reject: (status, message) => refused.push({ status, message }),
  }
  return { ctx, refused }
}

test("the probe after a rest that fails again rests twice as long", async () => {
  mod._reset()
  const { ctx, refused } = ctxFor({ failures: 1, cooldown: 1, max: 600 })
  const body = { model: "cb-sleep-doubling" }

  await mod.onRequest(body, ctx)
  await mod.onResponse(body, { ...ctx, status: 500 })
  await mod.onRequest(body, ctx)
  expect(refused.at(-1)).toEqual({ status: 429, message: expect.stringContaining("1s left") })

  await sleep(1100)
  await mod.onRequest(body, ctx) // the rest is over: this request is the probe
  expect(refused.length).toBe(1)

  await mod.onResponse(body, { ...ctx, status: 500 }) // the probe failed
  await mod.onRequest(body, ctx)
  expect(refused.at(-1)).toEqual({ status: 429, message: expect.stringContaining("2s left") })
})

test("a failure older than the window does not count towards the rest", async () => {
  mod._reset()
  const { ctx, refused } = ctxFor({ failures: 2, window: 1, cooldown: 60 })
  const body = { model: "cb-sleep-window" }

  await mod.onRequest(body, ctx)
  await mod.onResponse(body, { ...ctx, status: 500 })
  await sleep(1100)
  await mod.onRequest(body, ctx)
  await mod.onResponse(body, { ...ctx, status: 500 })
  await mod.onRequest(body, ctx)

  expect(refused).toEqual([]) // the first one slid out of the window
})
