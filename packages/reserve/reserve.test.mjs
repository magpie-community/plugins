import { expect, test } from "bun:test"
import * as mod from "./reserve.gateway.js"
import { checkStrategies, order } from "../../scripts/middleware.mjs"

checkStrategies(import.meta.dir, mod)

test("gives the two routings, and no hook it doesn't use", () => {
  expect(Object.keys(mod.strategies).sort()).toEqual(["accounts-first", "ceiling"])
  expect(mod.onRequest).toBeUndefined()
  expect(mod.onUsage).toBeUndefined()
})

test("every answer is an order of the seats, whatever they hold", () => {
  for (const name of Object.keys(mod.strategies)) {
    for (let n = 2; n < 9; n++) {
      const seats = Array.from({ length: n }, (_, i) => ({
        account: i % 2 === 0, known: i % 3 !== 0, used: (i * 37) % 101, resting: i === 4, weight: (i % 3) + 1, tokens: i * 1000,
      }))
      expect(order(mod, name, "group/fast", seats, { ceiling: 50 }).failed).toBeUndefined()
    }
  }
})
