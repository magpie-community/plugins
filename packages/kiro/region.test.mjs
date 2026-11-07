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
})
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
// of 2000 with overage on up to 10000, as Kiro answers it
const limits = (used, { overage = true } = {}) => ({
  subscriptionInfo: { subscriptionTitle: "KIRO POWER" }, userInfo: { email: "dev@corp.example" }, nextDateReset: RESET,
  overageConfiguration: { overageStatus: overage ? "ENABLED" : "DISABLED" },
  usageBreakdownList: [{ displayName: "Credit", displayNamePlural: "Credits", currentUsageWithPrecision: used, usageLimitWithPrecision: 2000,
    usageLimit: 2000, overageCap: 10000, overageCapWithPrecision: 10000, currentOverages: Math.max(0, used - 2000), nextDateReset: RESET }],
})
const USED_UP = { status: 402, body: { message: "You have reached the limit.", reason: "MONTHLY_REQUEST_COUNT" } }
const THROTTLED = { status: 429, body: { message: "Too many requests, please wait." } }
const STOP = { status: 500, body: { message: "stop here" } }

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
      seen.chat.push([region, JSON.parse(init.body).profileArn])
      const r = chat[region] ?? STOP
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    throw new Error("unexpected " + url)
  }
  return seen
}

const hooks = (saves = []) => plugin({ client: { auth: { set: async (r) => void saves.push(r.body) } } })
const ask = async (h, a) => {
  const l = await h.auth.loader(async () => a)
  const res = await l.fetch("https://kiro.invalid/v1/messages", { method: "POST",
    body: JSON.stringify({ model: "claude-sonnet-5.5", messages: [{ role: "user", content: "hi" }] }) })
  return { status: res.status, message: (await res.json())?.error?.message ?? "" }
}

test("overage on counts the month against the overage cap", () => {
  const u = _internal.usageOf(limits(4104.73))
  expect(u.windows[0]).toMatchObject({ name: "Credits", amount: 4104.73, limit: 10000, display: "4104.73 / 10000" })
  expect(u.windows[0].used).toBeCloseTo(41.0473)
  // and off, the plan's credits alone
  expect(_internal.usageOf(limits(1500, { overage: false })).windows[0]).toMatchObject({ limit: 2000, used: 75 })
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
  const [sum, us, eu] = u.windows
  expect(sum).toMatchObject({ name: "Credits", amount: 12500, limit: 20000, used: 62.5, resetsAt: new Date(RESET * 1000).toISOString() })
  expect(sum.aside).toBeUndefined()
  expect(us).toMatchObject({ name: "Credits (us-east-1)", used: 100, aside: true })
  expect(eu).toMatchObject({ name: "Credits (eu-central-1)", used: 25, aside: true })
})

test("a region used up per the usage read is skipped by the next request", async () => {
  const seen = kiro({ usage: { "us-east-1": limits(10000), "eu-central-1": limits(100) } })
  const h = await hooks()
  await h.auth.usage(async () => auth())
  await ask(h, auth())
  expect(seen.chat).toEqual([["eu-central-1", EU]])
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

test("both regions used up is a 429 that says so", async () => {
  const seen = kiro({ chat: { "us-east-1": USED_UP, "eu-central-1": USED_UP } })
  const r = await ask(await hooks(), auth())
  expect(r.status).toBe(429)
  expect(r.message).toContain("Kiro credits used up in us-east-1, eu-central-1")
  expect(seen.chat).toEqual([["us-east-1", US], ["eu-central-1", EU]])
})

test("a rate limit isn't taken for credits used up: no other region is asked", async () => {
  const seen = kiro({ chat: { "us-east-1": THROTTLED } })
  const r = await ask(await hooks(), auth())
  expect(r.status).toBe(429)
  expect(seen.chat).toEqual([["us-east-1", US]])
})

test("a region not enabled is shown so, pointed out near the end, and named when the other is used up", async () => {
  kiro({ profiles: { "us-east-1": [US] }, usage: { "us-east-1": limits(8500) } })
  const u = await (await hooks()).auth.usage(async () => auth())
  expect(u.windows[0]).toMatchObject({ amount: 8500, limit: 10000 })
  expect(u.windows[0].display).toContain("eu-central-1 not enabled: ask your admin to enable it")
  expect(u.windows[2]).toMatchObject({ name: "Credits (eu-central-1)", display: "not enabled", aside: true })

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
    ["Credits", "2744.89 / 10000"],
    ["Credits (eu-central-1)", "2744.89 / 10000"],
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
  expect(u.windows.map((w) => w.name)).toEqual(["Credits"])
})
