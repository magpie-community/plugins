// auth.usage tells what magpie's built-in Kiro usage told for the same
// answer (internal/provider/kiro_test.go TestKiroLimits).
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin, _internal
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin, _internal } = await import("./index.mjs"))
})
// nothing leaves the machine; the fetch this file found is put back when
// it is done, so the next test file (bun runs them all in one process)
// doesn't inherit offline: qoder's cn.test.mjs, taking it as the real
// fetch, sent its stand-in's requests nowhere and its sign-in polled on
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = offline))

const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const auth = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000, method: "social",
  region: "us-east-1", profileArn: PROFILE }
const FREE = { subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: "me@example.com" },
  usageBreakdownList: [{ displayName: "Credit", displayNamePlural: "Credits", currentUsageWithPrecision: 12.5, usageLimitWithPrecision: 50,
    nextDateReset: 1790000000, freeTrialInfo: { freeTrialStatus: "ACTIVE", currentUsageWithPrecision: 100, usageLimitWithPrecision: 500,
      freeTrialExpiry: 1791000000 } }] }

function answer(status, body) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }
  return calls
}
const usage = async (a = auth) => (await plugin({ client: { auth: { set: async () => {} } } })).auth.usage(async () => a)

test("a free account's credits and trial", async () => {
  const calls = answer(200, FREE)
  expect(await usage()).toEqual({
    plan: "Kiro Free",
    user: "me@example.com",
    windows: [
      { name: "Free trial", used: 20, resetsAt: new Date(1791000000_000).toISOString(), display: "100 / 500",
        amount: 100, limit: 500, unit: "credits" },
      { name: "Credits", used: 25, resetsAt: new Date(1790000000_000).toISOString(), display: "12.5 / 50",
        amount: 12.5, limit: 50, unit: "credits", span: 30 * 24 * 3600 },
    ],
    signIn: "renewed",
  })
  const u = new URL(calls[0].url)
  expect(u.pathname).toEndWith("/Get-Usage-Limits")
  expect(Object.fromEntries(u.searchParams)).toEqual({ origin: "KIRO_CLI", profileArn: PROFILE, resourceType: "CREDIT", isEmailRequired: "true" })
  expect(calls[0].init.headers.Authorization).toBe("Bearer test-access")
})

test("names, resets and counts as Go says them", () => {
  const { windows, plan } = _internal.usageOf({ subscriptionInfo: { subscriptionTitle: "kiro  pro plus" }, nextDateReset: 1800000000,
    usageBreakdownList: [
      { displayName: "Vibe", currentUsageWithPrecision: 1.005, usageLimitWithPrecision: 1000000 },
      { currentUsageWithPrecision: 3, usageLimitWithPrecision: 0 }, // no limit: skipped
      { currentUsageWithPrecision: 150.1, usageLimitWithPrecision: 100, nextDateReset: 0,
        freeTrialInfo: { freeTrialStatus: "EXPIRED", usageLimitWithPrecision: 10 } },
    ] })
  expect(plan).toBe("Kiro Pro Plus")
  expect(windows.map((w) => [w.name, w.display, w.resetsAt])).toEqual([
    ["Vibe", "1 / 1e+06", new Date(1800000000_000).toISOString()], // Go's %.2f of 1.005 is 1.00
    ["Credits", "150.1 / 100", new Date(1800000000_000).toISOString()],
  ])
  expect(windows[1].used).toBeCloseTo(150.1) // the host clamps it to 100; Go's built-in didn't
  // #408: the count goes along, so magpie's "left" shows 0 / 100, not the used text
  expect(windows.map((w) => [w.amount, w.limit, w.unit])).toEqual([[1.005, 1000000, "credits"], [150.1, 100, "credits"]])
})

// A Pro account's answer with bonus credits, as Get-Usage-Limits gave it
// (account details replaced): the first upgrade's trial credits in
// bonuses, and the Free trial before it expired.
const BONUS_EXPIRES = 4100000000.5 // far off: the first test reads the real clock
const trialCredits = (over = {}) => ({ bonusCode: "TESTBONUS#0", bonusType: "FIRST_UPGRADE_TRIAL", currentUsage: 0.0,
  description: "Trial credits from your first upgrade", displayName: "Trial credits", expiresAt: BONUS_EXPIRES,
  redeemedAt: 1793000000.25, status: "ACTIVE", usageLimit: 500.0, ...over })
const PRO = { nextDateReset: 1796083200.0, overageConfiguration: { overageStatus: "DISABLED" },
  subscriptionInfo: { subscriptionTitle: "KIRO PRO", type: "Q_DEVELOPER_STANDALONE_PRO" },
  userInfo: { email: "me@example.com", userId: "d-0000000000.test" },
  usageBreakdownList: [{ addOnMetadata: null, bonuses: [trialCredits()], currency: "USD", currentUsage: 48, currentUsageWithPrecision: 48.97,
    displayName: "Credit", displayNamePlural: "Credits",
    freeTrialInfo: { currentUsage: 24, currentUsageWithPrecision: 24.26, freeTrialExpiry: 1769846399.708, freeTrialStatus: "EXPIRED",
      usageLimit: 500, usageLimitWithPrecision: 500.0 },
    nextDateReset: 1796083200.0, overageCredits: [], resourceType: "CREDIT", unit: "INVOCATIONS", usageLimit: 984, usageLimitWithPrecision: 984.0 }] }
const withBreakdown = (l, over) => ({ ...l, usageBreakdownList: [{ ...l.usageBreakdownList[0], ...over }] })
const MONTH = { name: "Credits", used: (100 * 48.97) / 984, resetsAt: new Date(1796083200_000).toISOString(), display: "48.97 / 984",
  amount: 48.97, limit: 984, unit: "credits", span: 30 * 24 * 3600 }
const BONUS = { name: "Trial credits", used: 0, display: "0 / 500", amount: 0, limit: 500, unit: "credits",
  runsOutAt: new Date(4100000000_000).toISOString(), runsOut: 500, aside: true }

test("bonus credits are a window of their own after the month's, with when they lapse", async () => {
  answer(200, PRO)
  expect(await usage()).toEqual({ plan: "Kiro Pro", user: "me@example.com", windows: [MONTH, BONUS], signIn: "renewed" })
  // part spent: what is left lapses
  const { windows } = _internal.usageOf(withBreakdown(PRO, { bonuses: [trialCredits({ currentUsage: 120.5 })] }), 1800000000_000)
  expect(windows[1]).toEqual({ ...BONUS, used: 24.1, display: "120.5 / 500", amount: 120.5, runsOut: 379.5 })
})

test("no bonuses: the windows are what they were", () => {
  const before = _internal.usageOf(withBreakdown(PRO, { bonuses: undefined }))
  expect(before.windows).toEqual([MONTH])
  for (const bonuses of [[], null, "none", [null, {}, { status: "ACTIVE" }]])
    expect(_internal.usageOf(withBreakdown(PRO, { bonuses }))).toEqual(before)
  // the free account's answer has none either
  expect(_internal.usageOf(FREE).windows.map((w) => w.name)).toEqual(["Free trial", "Credits"])
})

test("a bonus expired, or not active, is no window and keeps nothing aside", () => {
  const now = 1800000000_000
  for (const b of [trialCredits({ expiresAt: 1799999999 }), trialCredits({ status: "EXPIRED" }), trialCredits({ usageLimit: 0 })]) {
    expect(_internal.usageOf(withBreakdown(PRO, { bonuses: [b] }), now).windows).toEqual([MONTH])
    // a month used up stops the account as before
    const spent = _internal.usageOf(withBreakdown(PRO, { bonuses: [b], currentUsageWithPrecision: 984 }), now).windows
    expect(spent).toHaveLength(1)
    expect(spent[0].aside).toBeUndefined()
  }
  // one with no expiry is kept, with no lapse told
  const open = _internal.usageOf(withBreakdown(PRO, { bonuses: [trialCredits({ expiresAt: undefined })] }), now).windows[1]
  expect(open.runsOutAt).toBeUndefined()
  expect(open.aside).toBe(true)
})

test("a free trial and bonus credits together, and a spent month set aside while a bonus has credits left", () => {
  const now = 1790500000_000
  const l = withBreakdown(FREE, { bonuses: [trialCredits({ displayName: "Bonus credits", currentUsage: 10, usageLimit: 100 })] })
  const { windows } = _internal.usageOf(l, now)
  expect(windows.map((w) => [w.name, w.display, w.aside])).toEqual([
    ["Free trial", "100 / 500", undefined], ["Credits", "12.5 / 50", undefined], ["Bonus credits", "10 / 100", true]])
  expect(windows[2].runsOut).toBe(90)
  // the month used up: Kiro goes on to the bonus, so the month is shown only
  const spent = _internal.usageOf(withBreakdown(l, { currentUsageWithPrecision: 50 }), now).windows
  expect(spent.find((w) => w.name === "Credits").aside).toBe(true)
  expect(spent.find((w) => w.name === "Free trial").aside).toBeUndefined()
  // and the bonus used up too: the month stops the account again
  const all = _internal.usageOf(withBreakdown(l, { currentUsageWithPrecision: 50,
    bonuses: [trialCredits({ displayName: "Bonus credits", currentUsage: 100, usageLimit: 100 })] }), now).windows
  expect(all.find((w) => w.name === "Credits").aside).toBeUndefined()
  expect(all.find((w) => w.name === "Bonus credits")).toMatchObject({ used: 100, aside: true })
  expect(all.find((w) => w.name === "Bonus credits").runsOutAt).toBeUndefined()
})

test("Kiro's refusal is the card's error", async () => {
  answer(403, { message: "The bearer token included in the request is invalid." })
  expect(await usage()).toEqual({ error: "Kiro: The bearer token included in the request is invalid. (403)", signIn: "kept" })
  answer(500, "")
  expect(await usage()).toEqual({ error: "Kiro: Internal Server Error", signIn: "kept" })
})

test("no account, no usage", async () => {
  const calls = answer(200, FREE)
  expect(await usage(null)).toEqual({ error: "not signed in", signIn: "kept" })
  expect(calls).toEqual([])
})

// the loader's fetch answering a Messages request, and what it says of the
// sign-in (X-Magpie-Sign-In)
async function ask(a) {
  const hooks = await plugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => a)
  const res = await l.fetch("https://kiro.invalid/v1/messages", { method: "POST", body: JSON.stringify({ model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) })
  const out = { status: res.status, message: (await res.json()).error.message }
  const said = res.headers.get("X-Magpie-Sign-In")
  return said ? { ...out, signIn: said } : out
}
const stale = { ...auth, expires: Date.now() - 60_000 }

// the built-in answered any credentials it couldn't get with a 401 and
// marked nothing, not even for a refresh Kiro refused
test("a refresh that failed, or that Kiro refused, is the built-in's 401, the account kept", async () => {
  answer(500, "")
  expect(await ask(stale)).toEqual({ status: 401, message: "refreshing Kiro's sign-in: 500 Internal Server Error", signIn: "kept" })
  globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND") }
  expect(await ask(stale)).toEqual({ status: 401, message: "refreshing Kiro's sign-in: getaddrinfo ENOTFOUND", signIn: "kept" })
  answer(401, { error: "invalid_grant" })
  const refused = "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE"
  expect(await ask(stale)).toEqual({ status: 401, message: refused, signIn: "kept" })
  expect(await ask({ ...stale, refresh: "" })).toEqual({ status: 401, message: refused, signIn: "kept" })
})

test("errors don't name Kiro, which magpie adds", async () => {
  answer(500, { message: "boom" })
  expect(await ask(auth)).toEqual({ status: 500, message: "boom", signIn: "kept" })
})

// A sign-in Kiro refuses marks the account signed out, so magpie passes
// over it and its row offers Sign in again (blue12345655 on Discord: a
// signed-out plugin account had no Sign in again on its list row). A
// refresh that fails another way keeps it.
test("a usage read that finds the sign-in refused marks the account signed out", async () => {
  answer(401, { error: "invalid_grant" })
  expect(await usage({ ...auth, expires: Date.now() - 60_000 })).toEqual({
    error: "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE", signIn: "expired" })
  answer(500, "")
  expect((await usage({ ...auth, expires: Date.now() - 60_000 })).signIn).toBe("kept")
})
