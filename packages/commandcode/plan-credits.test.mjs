// The month of credits each plan's card says (plugins #556). On Go, GOAT
// and Pro a credit is a usage-value unit, not a dollar: Command Code's
// usage limits page (2026-10-31) says GOAT's 14 credits in 5 hours and 35
// in 7 days are "worth up to $20 / $50 of usage on a $100 model like Ling
// 3.1 Flash, or $14 / $35 on a $70 model like GLM-5.2", and Pro's 16 and
// 40 "up to $22 / $55 ... on a $110 model, or $16 / $40 on an $80 model".
// So the month is 70 credits on GOAT (up to $100) and 80 on Pro (up to
// $110), in the units billing/credits counts in, and the card says
// credits. Provider is pay as you go, with no credits in its $15.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
})

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dir, "testdata", name), "utf8"))

async function usage(sub, credits) {
  _internal.subsSeen.clear() // a plan read is kept ten minutes
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return Response.json(sub)
    if (path === "/alpha/billing/credits") return Response.json(credits)
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  return hooks.auth.usage(async () => ({ type: "api", key: "k" }))
}

const plan = (planId) => ({ success: true, data: { planId, status: "active" } })

test("a real GOAT reply: its month is 70 credits, the units its windows count in, not a dollar pool", async () => {
  const credits = fixture("credits-goat.json")
  const sub = fixture("subscriptions-goat.json")
  const u = await usage(sub, credits)
  const month = u.windows.find((w) => w.name === "Credits")
  expect(month).toEqual({ name: "Credits", used: (100 * (70 - 69.8033399)) / 70, display: "0.20 / 70.00 credits", amount: 0.2, limit: 70, unit: "credits", resetsAt: "2026-10-28T16:16:42.000Z" })
  // the docs' GOAT windows: 14 and 35 credits for up to $20 and $50, and
  // the month up to $100: 70 credits, the same units
  expect(credits.windowLimits.fiveHour.cap).toBe(14)
  expect(credits.windowLimits.weekly.cap).toBe(35)
  expect((35 * 100) / 50).toBe(70)
  expect(month.display).not.toContain("$")
})

test("Pro, Go and the old Pro say credits; Max, Ultra and Teams Pro, whose credit is a dollar, say dollars", async () => {
  const shown = async (id, monthly) => (await usage(plan(id), { credits: { monthlyCredits: monthly } })).windows[0]?.display
  expect(await shown("individual-pro-v1", 40)).toBe("40.00 / 80.00 credits")
  expect(await shown("individual-go-v1", 4)).toBe("6.00 / 10.00 credits")
  expect(await shown("individual-goat", 7)).toBe("63.00 / 70.00 credits")
  expect(await shown("individual-max-monthly", 50)).toBe("$100.00 / $150.00")
  expect(await shown("individual-ultra", 300)).toBe("$0.00 / $300.00")
  expect(await shown("teams-pro", 10)).toBe("$30.00 / $40.00")
})

test("GOAT: bought and free credits, dollars at model cost, are the balance beside the month, not added to it", async () => {
  const u = await usage(plan("individual-goat"), { credits: { monthlyCredits: 35, purchasedCredits: 4, freeCredits: 1 } })
  expect(u.windows).toEqual([{ name: "Credits", used: 50, display: "35.00 / 70.00 credits", amount: 35, limit: 70, unit: "credits" }])
  expect(u.balance).toBe("$5.00")
})

test("Max keeps the CLI's pool, the month and the bought credits together, in dollars", async () => {
  const u = await usage(plan("individual-max"), { credits: { monthlyCredits: 100, purchasedCredits: 10 } })
  expect(u.windows).toEqual([{ name: "Credits", used: (100 * 50) / 160, display: "$50.00 / $160.00" }])
})

test("Provider is pay as you go: its card is the balance, not a $15 month", async () => {
  const u = await usage(plan("individual-provider"), { credits: { monthlyCredits: 0, purchasedCredits: 7.25, freeCredits: 0 } })
  expect(u).toEqual({ signIn: "renewed", plan: "Provider", balance: "$7.25", windows: [] })
})
