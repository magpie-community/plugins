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
  const plugin = await DevinAuthPlugin()
  await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "key-free-usage" } })
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "key-free-usage" }))
  expect(u.windows.map((w) => [w.name, w.used])).toEqual([["1 day", 100], ["7 days", 100]])
  for (const w of u.windows) expect([...w.notModels].sort()).toEqual(SWE2)
})

test("a slow model list doesn't hold up quota usage", async () => {
  const key = "slow-model-config-key"
  let finishConfigs
  serve(status(), () => new Promise((resolve) => (finishConfigs = resolve)))
  const plugin = await DevinAuthPlugin()
  const usage = plugin.auth.usage(async () => ({ type: "api", key }))
  let timeout
  let u
  try {
    u = await Promise.race([
      usage,
      new Promise((_, reject) => (timeout = setTimeout(() => reject(new Error("usage waited for GetCliModelConfigs")), 1_000))),
    ])
  } finally {
    clearTimeout(timeout)
  }
  expect(u.windows.map((w) => [w.name, w.used])).toEqual([["1 day", 100], ["7 days", 100]])
  expect(u.windows.map((w) => w.notModels)).toEqual([undefined, undefined])

  finishConfigs(new Response(realConfigs))
  await _internal.freeIDs(key, "https://server.codeium.com")
  const refreshed = await plugin.auth.usage(async () => ({ type: "api", key }))
  for (const w of refreshed.windows) expect([...w.notModels].sort()).toEqual(SWE2)
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

// zws13579 on magpie's Discord (devin 0.1.26): a Free plan account couldn't
// get SWE-2 through the plugin. No Free plan response has been captured;
// these hold the paths that would hide SWE-2 whatever its shape.

const swe2 = (ids) => ({ uid: "swe-2", label: "SWE-2", aliases: ["swe"], models: ids.map((id) => ({ id, name: id, context: 262000, output: 128000 })) })

test("SWE-2 with no effort goes as a free variant, not a -lightning one Devin lists first", () => {
  const fams = [swe2(["swe-2-medium-lightning", "swe-2-high", "swe-2-medium", "swe-2-max"])]
  expect(_internal.variantFor(fams, "swe-2", "")).toBe("swe-2-high")
  expect(_internal.variantFor(fams, "swe-2", "medium")).toBe("swe-2-medium")
  const free = new Set(["swe-2-high", "swe-2-medium", "swe-2-max"])
  expect(_internal.listed(fams, [], {}, free).find((m) => m.id === "swe-2").free).toBe(true)
})

test("Devin's own list (2026-10-15, with -lightning variants) sends SWE-2 as swe-2-high", () => {
  const fams = _internal.parseConfigFamilies(new Uint8Array(readFileSync(join(import.meta.dir, "testdata", "model-configs-1015.bin"))))
  expect(_internal.variantFor(fams, "swe-2", "")).toBe("swe-2-high")
})

test("SWE-2 the account's list leaves out goes as SNAPSHOT's variant, not the bare family id", () => {
  const fams = [{ uid: "kimi-k3", label: "Kimi K3", aliases: [], models: [{ id: "kimi-k3-high", name: "Kimi K3 High", context: 0, output: 0 }] }]
  expect(_internal.variantFor(fams, "swe-2", "")).toBe("swe-2-high")
  expect(_internal.variantFor(fams, "swe-2", "max")).toBe("swe-2-max")
  expect(_internal.variantFor(fams, "swe-2-medium", "")).toBe("swe-2-medium")
  expect(_internal.variantFor(fams, "kimi-k3", "")).toBe("kimi-k3-high")
})

test("a model list Devin won't give is said in usage and logged once, not swallowed", async () => {
  const key = "key-free-error"
  let failConfigs
  serve(status(), () => new Promise((resolve) => (failConfigs = () => resolve(new Response("no", { status: 503 })))))
  const logged = []
  const was = console.error
  console.error = (...a) => logged.push(a.join(" "))
  try {
    const plugin = await DevinAuthPlugin()
    const first = await plugin.auth.usage(async () => ({ type: "api", key }))
    expect(first.windows.slice(0, 2).map((w) => w.notModels)).toEqual([undefined, undefined])
    expect(first.windows.find((w) => w.name === "Free models")).toBeUndefined()
    failConfigs()
    await _internal.freeIDs(key, "https://server.codeium.com")
    const second = await plugin.auth.usage(async () => ({ type: "api", key }))
    const note = second.windows.find((w) => w.name === "Free models")
    expect(note?.aside).toBe(true)
    expect(note.display).toContain("503")
    await plugin.auth.usage(async () => ({ type: "api", key }))
  } finally {
    console.error = was
  }
  expect(logged.filter((l) => l.includes("GetCliModelConfigs")).length).toBe(1)
})

test("a plan with no quota window shows none and no free-models row", async () => {
  const s = status({ dailyQuotaResetAtUnix: undefined, weeklyQuotaResetAtUnix: undefined })
  s.userStatus.planStatus.planInfo = { planName: "Free", billingStrategy: "BILLING_STRATEGY_CREDITS" }
  serve(s, () => new Response("no", { status: 503 }))
  const u = await (await DevinAuthPlugin()).auth.usage(async () => ({ type: "api", key: "key-free-none" }))
  expect(u.error).toBeUndefined()
  expect(u.windows).toEqual([])
})
