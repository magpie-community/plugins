import * as mod from "./antigravity-guard.middleware.js"
import { check, checkStrategies } from "../../scripts/middleware.mjs"
import { expect, test } from "bun:test"

check(import.meta.dir, mod)
checkStrategies(import.meta.dir, mod)

test("deniedRefs makes onAccount skip only that account", () => {
  const options = { deniedRefs: ["acct-a"] }
  expect(mod.onAccount({ ref: "acct-a", kind: "antigravity" }, { options })).toEqual({ skip: true })
  expect(mod.onAccount({ ref: "acct-b", kind: "antigravity" }, { options })).toBeUndefined()
})

test("pauseUntil skips every account, so the gateway sends nothing", () => {
  const options = { pauseUntil: Date.now() + 60000 }
  expect(mod.onAccount({ ref: "acct-a" }, { options })).toEqual({ skip: true })
  expect(mod.onAccount({ ref: "acct-b" }, { options })).toEqual({ skip: true })
})

test("off never skips an account", () => {
  const options = { off: true, deniedRefs: ["acct-a"], pauseUntil: Date.now() + 60000 }
  expect(mod.onAccount({ ref: "acct-a" }, { options })).toBeUndefined()
})

test("two 403s block that account for onAccount", () => {
  const options = { suspension403: 2, cooldownMinutes: 60, deniedRefs: [] }
  const row = { key: "acct-suspended", provider: { account: "antigravity" } }
  mod.onUsage({ ...row, status: 200 }, options)
  mod.onUsage({ ...row, status: 403 }, options)
  expect(mod.onAccount({ ref: "acct-suspended" }, { options })).toBeUndefined()
  mod.onUsage({ ...row, status: 403 }, options)
  expect(mod.onAccount({ ref: "acct-suspended" }, { options })).toEqual({ skip: true })
  expect(mod.onAccount({ ref: "acct-healthy" }, { options })).toBeUndefined()
})

test("a 200 clears the consecutive-403 count", () => {
  const options = { suspension403: 2, cooldownMinutes: 60, deniedRefs: [] }
  const row = { key: "acct-flaky" }
  mod.onUsage({ ...row, status: 403 }, options)
  mod.onUsage({ ...row, status: 200 }, options)
  mod.onUsage({ ...row, status: 403 }, options)
  expect(mod.onAccount({ ref: "acct-flaky" }, { options })).toBeUndefined()
})
