// 太陽と向日葵 on magpie's Discord: SWE-2 is free, but with the account's
// quota used up magpie said the quota was used up and didn't send SWE-2 to
// it, while a test of the model worked. Devin marks SWE-2's variants Free
// (model_cost_tier 4) in GetCliModelConfigs; the day and the week leave them
// out, and the list says they're free.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.forgetSaid()
})

// Devin's own response to GetCliModelConfigs (2026-10-14), cut to a few
// configs; SWE-2's three variants are its only Free ones
const realConfigs = readFileSync(join(import.meta.dir, "testdata", "model-configs.bin"))

const status = (plan = {}) => ({
  userStatus: {
    planStatus: {
      planInfo: { planName: "Teams", teamsTier: "TEAMS_TIER_DEVIN_TEAMS", billingStrategy: "BILLING_STRATEGY_QUOTA", monthlyPromptCredits: -1, isDevin: true },
      planEnd: "2026-10-26T21:45:55Z",
      dailyQuotaResetAtUnix: "1790841600",
      weeklyQuotaResetAtUnix: "1791100800",
      ...plan,
    },
  },
})

function serve(s, configs = () => new Response(realConfigs)) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/GetUserStatus")) return Response.json(s)
    if (String(url).endsWith("/GetCliModelConfigs")) return configs()
    throw new Error("unexpected fetch " + url)
  }
}

const SWE2 = ["swe-2", "swe-2-high", "swe-2-max", "swe-2-medium"]

test("Devin's Free tier is read from its model configs", () => {
  expect([..._internal.parseFree(new Uint8Array(realConfigs))].sort()).toEqual(["swe-2-high", "swe-2-max", "swe-2-medium"])
})

test("a used-up day and week don't count SWE-2", async () => {
  // both used up: JSON leaves the 0% left out
  serve(status())
  const u = await (await DevinAuthPlugin()).auth.usage(async () => ({ type: "api", key: "key-free-usage" }))
  expect(u.windows.map((w) => [w.name, w.used])).toEqual([["1 day", 100], ["7 days", 100]])
  for (const w of u.windows) expect([...w.notModels].sort()).toEqual(SWE2)
})

test("with no word from Devin on its models, the day and week count every model", async () => {
  serve(status(), () => new Response("no", { status: 503 }))
  const u = await (await DevinAuthPlugin()).auth.usage(async () => ({ type: "api", key: "key-free-unknown" }))
  expect(u.windows.map((w) => w.notModels)).toEqual([undefined, undefined])
})

test("the list marks SWE-2 free and nothing else", async () => {
  serve(status())
  const got = await (await DevinAuthPlugin()).provider.models({ models: {} }, { auth: { type: "api", key: "key-free-list" } })
  expect(Object.keys(got).filter((id) => got[id].free).sort()).toEqual(SWE2.filter((id) => id in got).sort())
  expect(got["swe-2"].free).toBe(true)
  expect(got["gemini-4-argon"].free).toBeUndefined()
})
