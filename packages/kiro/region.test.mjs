// An Identity Center account's two credit regions: a profile and a month's
// credits in each of us-east-1 and eu-central-1, each with its own overage
// cap. A request goes on in the other region once one is used up; only both
// used up is a 429 for magpie. A region with no profile is not enabled.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin, _internal
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin, _internal } = await import("./index.mjs"))
  // a throttle's pauses (paced) are counted, not waited
  sleep = _internal.timing.sleep
  _internal.timing.sleep = async (ms) => void pauses.push(ms)
})
let sleep
const pauses = []
afterAll(() => (_internal.timing.sleep = sleep))
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = offline))

const US = "arn:aws:codewhisperer:us-east-1:333333333333:profile/US"
const EU = "arn:aws:codewhisperer:eu-central-1:333333333333:profile/EU"
const RESET = 1796083200
const later = () => Date.now() + 60 * 60_000
const auth = () => ({ type: "oauth", access: "t", refresh: "r", expires: later(), method: "idc", loginProvider: "Enterprise",
  region: "us-east-1", profileArn: "", clientId: "c", clientSecret: "s", accountId: "dev@corp.example (IAM Identity Center)" })

// limits is Get-Usage-Limits' answer for a month of used credits, a plan
// of 2000 with overage on up to 10000 more, as Kiro answers it
const limits = (used, { overage = true } = {}) => ({
  subscriptionInfo: { subscriptionTitle: "KIRO POWER" }, userInfo: { email: "dev@corp.example" }, nextDateReset: RESET,
  overageConfiguration: { overageStatus: overage ? "ENABLED" : "DISABLED" },
  usageBreakdownList: [{ displayName: "Credit", displayNamePlural: "Credits", currentUsageWithPrecision: used, usageLimitWithPrecision: 2000,
    usageLimit: 2000, overageCap: 10000, overageCapWithPrecision: 10000, currentOverages: Math.max(0, used - 2000), nextDateReset: RESET }],
})
const USED_UP = { status: 402, body: { message: "You have reached the limit.", reason: "MONTHLY_REQUEST_COUNT" } }
const THROTTLED = { status: 429, body: { message: "Too many requests, please wait." }, headers: { "x-amzn-kiro-ratelimit-retry-after": "12500" } }
const STOP = { status: 500, body: { message: "stop here" } }
const MAX_ASKS = 6

// kiro is Kiro's API with the profiles each region lists, each region's
// credits, and how each region's runtime answers a chat
function kiro({ profiles = { "us-east-1": [US], "eu-central-1": [EU] }, usage = {}, chat = {} } = {}) {
  const seen = { profiles: 0, usage: [], chat: [] }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const region = url.host.split(".")[1]
    if (url.pathname === "/List-Available-Profiles") {
      seen.profiles++
      return Response.json({ profiles: (profiles[region] ?? []).map((arn) => ({ arn })) })
    }
    if (url.pathname === "/Get-Usage-Limits") {
      seen.usage.push([region, url.searchParams.get("profileArn")])
      return Response.json(usage[region] ?? limits(0))
    }
    if (url.pathname === "/generateAssistantResponse") {
      // a region loop that doesn't end fails here, not on a timeout
      if (seen.chat.length >= MAX_ASKS) throw new Error(`Kiro asked more than ${MAX_ASKS} times for one request`)
      seen.chat.push([region, JSON.parse(init.body).profileArn])
      const r = chat[region] ?? STOP
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers })
    }
    throw new Error("unexpected " + url)
  }
  return seen
}

// switches are the provider's "<region>-only" switches as the user has them
// in magpie, read live: changing the object changes the next request
const hooks = (saves = [], switches = {}) =>
  plugin({ client: { auth: { set: async (r) => void saves.push(r.body) } }, magpie: { option: (id, key) => (id === "kiro" ? switches[key] : undefined) } })
const ask = async (h, a) => {
  const l = await h.auth.loader(async () => a)
  const res = await l.fetch("https://kiro.invalid/v1/messages", { method: "POST",
    body: JSON.stringify({ model: "claude-sonnet-5.5", messages: [{ role: "user", content: "hi" }] }) })
  return { status: res.status, wait: res.headers.get("Retry-After"), message: (await res.json())?.error?.message ?? "" }
}

// wizcheu on X: a Kiro Power account (10000 credits) that used 12589.24
// this month, 2589.24 of them post-paid, as the Kiro IDE shows it ("10000
// used / 10000 covered in plan", "2589.24 used"), under an overage cap of
// 37500. magpie showed 12589.24 / 37500, the cap taken for the month.
const POWER = { subscriptionInfo: { subscriptionTitle: "KIRO POWER" }, nextDateReset: RESET, overageConfiguration: { overageStatus: "ENABLED" },
  usageBreakdownList: [{ displayName: "Credit", displayNamePlural: "Credits", currentUsage: 12589, currentUsageWithPrecision: 12589.24,
    usageLimit: 10000, usageLimitWithPrecision: 10000.0, overageCap: 37500, overageCapWithPrecision: 37500.0, currentOverages: 2589,
    currentOveragesWithPrecision: 2589.24, overageRate: 0.04, overageCharges: 103.57, nextDateReset: RESET }] }

test("overage on: the plan's credits, shown only, then the overage against its cap", () => {
  const u = _internal.usageOf(POWER)
  const month = { resetsAt: new Date(RESET * 1000).toISOString(), unit: "credits", span: 30 * 24 * 3600 }
  expect(u.windows).toEqual([
    { name: "Credits", used: 100, display: "10000 / 10000", amount: 10000, limit: 10000, ...month, aside: true },
    { name: "Overage", used: (100 * 2589.24) / 37500, display: "2589.24 / 37500", amount: 2589.24, limit: 37500, ...month },
  ])
  // Kiro's integer count when it sends no precise one, and what is past the plan when it sends neither
  const breakdown = (over) => ({ ...POWER, usageBreakdownList: [{ ...POWER.usageBreakdownList[0], ...over }] })
  expect(_internal.usageOf(breakdown({ currentOveragesWithPrecision: undefined })).windows[1]).toMatchObject({ amount: 2589 })
  expect(_internal.usageOf(breakdown({ currentOveragesWithPrecision: undefined, currentOverages: undefined })).windows[1].amount).toBeCloseTo(2589.24)
  // within the plan, the overage is none yet
  expect(_internal.usageOf(limits(1500)).windows.map((w) => [w.name, w.display, w.aside])).toEqual([["Credits", "1500 / 2000", true], ["Overage", "0 / 10000", undefined]])
  // and off, the plan's credits alone
  expect(_internal.usageOf(limits(1500, { overage: false })).windows).toEqual([expect.objectContaining({ limit: 2000, used: 75 })])
  expect(_internal.usageOf(limits(1500, { overage: false })).windows[0].aside).toBeUndefined()
})

test("both regions' profiles are found and kept with the account", async () => {
  const seen = kiro()
  const saves = []
  const h = await hooks(saves)
  await h.auth.usage(async () => auth())
  expect(seen.profiles).toBe(2)
  expect(saves.at(-1)).toMatchObject({ profileArn: US, profiles: { "us-east-1": US, "eu-central-1": EU } })
  // kept, they aren't asked for again
  seen.profiles = 0
  const kept = { ...auth(), profileArn: US, profiles: { "us-east-1": US, "eu-central-1": EU } }
  await (await hooks()).auth.usage(async () => kept)
  expect(seen.profiles).toBe(0)
})

test("each region's credits are shown, and their sum is the account's", async () => {
  const seen = kiro({ usage: { "us-east-1": limits(10000), "eu-central-1": limits(2500) } })
  const u = await (await hooks()).auth.usage(async () => auth())
  expect(seen.usage).toEqual(expect.arrayContaining([["us-east-1", US], ["eu-central-1", EU]]))
  expect(u.user).toBe("dev@corp.example (IAM Identity Center)")
  const [plans, sum, ...each] = u.windows
  expect(plans).toMatchObject({ name: "Credits", amount: 4000, limit: 4000, used: 100, aside: true })
  expect(sum).toMatchObject({ name: "Overage", amount: 8500, limit: 20000, used: 42.5, resetsAt: new Date(RESET * 1000).toISOString() })
  expect(sum.aside).toBeUndefined()
  expect(each.map((w) => [w.name, w.display, w.aside])).toEqual([
    ["Credits (us-east-1)", "2000 / 2000", true], ["Overage (us-east-1)", "8000 / 10000", true],
    ["Credits (eu-central-1)", "2000 / 2000", true], ["Overage (eu-central-1)", "500 / 10000", true],
  ])
  // with overage off, the plans' sum is the account's
  kiro({ usage: { "us-east-1": limits(2000, { overage: false }), "eu-central-1": limits(500, { overage: false }) } })
  const off = await (await hooks()).auth.usage(async () => auth())
  expect(off.windows.map((w) => [w.name, w.display, w.aside])).toEqual([
    ["Credits", "2500 / 4000", undefined], ["Credits (us-east-1)", "2000 / 2000", true], ["Credits (eu-central-1)", "500 / 2000", true],
  ])
})

test("a region used up per the usage read is skipped by the next request", async () => {
  const seen = kiro({ usage: { "us-east-1": limits(12000), "eu-central-1": limits(100) } })
  const h = await hooks()
  await h.auth.usage(async () => auth())
  await ask(h, auth())
  expect(seen.chat).toEqual([["eu-central-1", EU]])
})

test("a region past its plan with overage left is still used", async () => {
  const seen = kiro({ usage: { "us-east-1": limits(10000), "eu-central-1": limits(100) } })
  const h = await hooks()
  await h.auth.usage(async () => auth())
  await ask(h, auth())
  expect(seen.chat).toEqual([["us-east-1", US]])
})

test("a region Kiro says is used up goes on in the other, and stays there", async () => {
  const seen = kiro({ chat: { "us-east-1": USED_UP } })
  const h = await hooks()
  const r = await ask(h, auth())
  expect(r.status).toBe(500) // the other region's own answer
  expect(seen.chat).toEqual([["us-east-1", US], ["eu-central-1", EU]])
  seen.chat.length = 0
  await ask(h, auth())
  expect(seen.chat).toEqual([["eu-central-1", EU]])
})

test("both regions used up is a 429 that says so, with Kiro's wait", async () => {
  const seen = kiro({ chat: { "us-east-1": USED_UP, "eu-central-1": { ...USED_UP, headers: { "retry-after": "60" } } } })
  const r = await ask(await hooks(), auth())
  expect(r.status).toBe(429)
  expect(r.wait).toBe("60")
  expect(r.message).toContain("Kiro credits used up in us-east-1, eu-central-1")
  expect(seen.chat).toEqual([["us-east-1", US], ["eu-central-1", EU]])
})

test("every region used up ends the request at once, however often it is asked", async () => {
  const seen = kiro({ chat: { "us-east-1": USED_UP, "eu-central-1": USED_UP } })
  const h = await hooks()
  for (let i = 0; i < 3; i++) {
    seen.chat.length = 0
    const r = await ask(h, auth())
    expect(r.status).toBe(429)
    expect(seen.chat.length).toBeLessThanOrEqual(2)
  }
})

test("a region not enabled is asked for again only after PROBE_MS", async () => {
  const seen = kiro({ profiles: { "us-east-1": [US] } })
  const h = await hooks()
  await ask(h, auth())
  expect(seen.profiles).toBe(2)
  await ask(h, auth())
  await ask(h, auth())
  expect(seen.profiles).toBe(2)
})

test("a rate limit isn't taken for credits used up: no other region is asked", async () => {
  const seen = kiro({ chat: { "us-east-1": THROTTLED } })
  pauses.length = 0
  const r = await ask(await hooks(), auth())
  expect(r.status).toBe(429)
  expect(r.wait).toBe("13") // Kiro's wait goes on as Retry-After
  // waited out and tried again in the same region, as the Kiro IDE does
  expect(seen.chat).toEqual([["us-east-1", US], ["us-east-1", US], ["us-east-1", US]])
  expect(pauses).toEqual([12500, 12500])
})

test("a region not enabled is shown so, pointed out near the end, and named when the other is used up", async () => {
  kiro({ profiles: { "us-east-1": [US] }, usage: { "us-east-1": limits(10500) } })
  const u = await (await hooks()).auth.usage(async () => auth())
  expect(u.windows[1]).toMatchObject({ amount: 8500, limit: 10000 })
  expect(u.windows[1].display).toContain("eu-central-1 not enabled: ask your admin to enable it")
  expect(u.windows[4]).toMatchObject({ name: "Credits (eu-central-1)", display: "not enabled", aside: true })

  const seen = kiro({ profiles: { "us-east-1": [US] }, chat: { "us-east-1": USED_UP } })
  const r = await ask(await hooks(), auth())
  expect(r.status).toBe(429)
  expect(r.message).toContain("Kiro credits used up in us-east-1; eu-central-1 not enabled: ask your admin to enable it")
  expect(seen.chat).toEqual([["us-east-1", US]])
})

test("the region enabled comes before the one not enabled, whichever it is", async () => {
  kiro({ profiles: { "eu-central-1": [EU] }, usage: { "eu-central-1": limits(2744.89) } })
  const u = await (await hooks()).auth.usage(async () => auth())
  expect(u.windows.map((w) => [w.name, w.display])).toEqual([
    ["Credits", "2000 / 2000"],
    ["Overage", "744.89 / 10000"],
    ["Credits (eu-central-1)", "2000 / 2000"],
    ["Overage (eu-central-1)", "744.89 / 10000"],
    ["Credits (us-east-1)", "not enabled"],
  ])
})

test("a region enabled later is found and used", async () => {
  const seen = kiro({ profiles: { "us-east-1": [US] } })
  const saves = []
  const h = await hooks(saves)
  await h.auth.usage(async () => auth())
  expect(saves.at(-1).profiles).toEqual({ "us-east-1": US })
  // enabled by the admin; a new plugin asks again at once
  kiro()
  await (await hooks(saves)).auth.usage(async () => ({ ...auth(), profileArn: US, profiles: { "us-east-1": US } }))
  expect(saves.at(-1).profiles).toEqual({ "us-east-1": US, "eu-central-1": EU })
})

test("a social sign-in keeps one region", async () => {
  const seen = kiro()
  const a = { type: "oauth", access: "t", refresh: "r", expires: later(), method: "social", loginProvider: "Github", region: "us-east-1",
    profileArn: US, accountId: "me@example.com (GitHub)" }
  const u = await (await hooks()).auth.usage(async () => a)
  expect(seen.profiles).toBe(0)
  expect(seen.usage).toEqual([["us-east-1", US]])
  expect(u.windows.map((w) => w.name)).toEqual(["Credits", "Overage"])
})

// The "<region>-only" switches: an account uses the one region its switch
// names and never the other.
test("each region's switch sends every request to that region alone", async () => {
  for (const [key, region, arn] of [["us-east-1-only", "us-east-1", US], ["eu-central-1-only", "eu-central-1", EU]]) {
    const seen = kiro()
    const h = await hooks([], { [key]: true })
    await ask(h, auth())
    await ask(h, auth())
    expect(seen.chat).toEqual([[region, arn], [region, arn]])
  }
})

test("both switches off, or both on, is the regions in turn", async () => {
  for (const sw of [{}, { "us-east-1-only": true, "eu-central-1-only": true }]) {
    const seen = kiro({ chat: { "us-east-1": USED_UP } })
    await ask(await hooks([], sw), auth())
    expect(seen.chat).toEqual([["us-east-1", US], ["eu-central-1", EU]])
  }
})

test("a switch changed between two requests applies to the next, with no restart", async () => {
  const seen = kiro()
  const sw = {}
  const h = await hooks([], sw)
  await ask(h, auth())
  sw["eu-central-1-only"] = true
  await ask(h, auth())
  sw["eu-central-1-only"] = false
  sw["us-east-1-only"] = true
  await ask(h, auth())
  expect(seen.chat).toEqual([["us-east-1", US], ["eu-central-1", EU], ["us-east-1", US]])
})

test("a region used up under its switch is a 429, and the other region is not asked", async () => {
  const seen = kiro({ chat: { "us-east-1": USED_UP } })
  const r = await ask(await hooks([], { "us-east-1-only": true }), auth())
  expect(r.status).toBe(429)
  expect(r.message).toContain("used up in us-east-1")
  expect(r.message).toContain("us-east-1-only")
  expect(seen.chat).toEqual([["us-east-1", US]])
})

test("a region not enabled under its switch is a 429 with nothing sent to the other", async () => {
  const seen = kiro({ profiles: { "us-east-1": [US] } })
  const r = await ask(await hooks([], { "eu-central-1-only": true }), auth())
  expect(r.status).toBe(429)
  expect(r.message).toContain("eu-central-1 is not enabled")
  expect(seen.chat).toEqual([])
})

test("an account set to one region counts that region alone, the other shown only", async () => {
  // the window magpie weighs the account by is the one not shown only
  const weighed = (u) => u.windows.find((w) => !w.aside && w.span)
  // the plan is 2000 credits and the overage cap 10000: eu-central-1 has used
  // 5000 of its overage, us-east-1 all of it
  kiro({ usage: { "us-east-1": limits(2000 + 10000), "eu-central-1": limits(2000 + 5000) } })
  const u = await (await hooks([], { "eu-central-1-only": true })).auth.usage(async () => auth())
  expect(weighed(u)).toMatchObject({ name: "Overage", amount: 5000, limit: 10000, used: 50 })
  const us = u.windows.filter((w) => /us-east-1/.test(w.name))
  expect(us.length).toBeGreaterThan(0)
  expect(us.every((w) => w.aside)).toBe(true)
  // without the switch both regions are counted
  kiro({ usage: { "us-east-1": limits(2000 + 10000), "eu-central-1": limits(2000 + 5000) } })
  const both = await (await hooks()).auth.usage(async () => auth())
  expect(weighed(both)).toMatchObject({ amount: 15000, limit: 20000, used: 75 })
  // the pinned region used up makes the account used up, however much the other has
  kiro({ usage: { "us-east-1": limits(2000), "eu-central-1": limits(2000 + 10000) } }) // us-east-1 has all its overage left
  const v = await (await hooks([], { "eu-central-1-only": true })).auth.usage(async () => auth())
  expect(weighed(v).used).toBe(100)
})

test("a social sign-in, one region only, ignores the switches", async () => {
  const seen = kiro()
  const a = { type: "oauth", access: "t", refresh: "r", expires: later(), method: "social", loginProvider: "Github", region: "us-east-1",
    profileArn: US, accountId: "me@example.com (GitHub)" }
  await ask(await hooks([], { "eu-central-1-only": true }), a)
  expect(seen.chat).toEqual([["us-east-1", US]])
})
