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
    signIn: "kept",
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

// The built-in's usage read neither marked nor cleared the account: a
// refusal that says to sign in again is kept too, not read by magpie's words.
test("a usage read that finds the sign-in refused keeps the account", async () => {
  answer(401, { error: "invalid_grant" })
  expect(await usage({ ...auth, expires: Date.now() - 60_000 })).toEqual({
    error: "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE", signIn: "kept" })
})
