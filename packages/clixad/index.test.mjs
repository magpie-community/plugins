import test from "node:test"
import assert from "node:assert/strict"
import { ClixadAuthPlugin, _internal } from "./index.mjs"

const { usageOf, modelOf, normalizeBase, nextUtcMidnight, staticModelTable } = _internal

test("normalizeBase adds /v1 once", () => {
  assert.equal(normalizeBase("https://clixad.onrender.com"), "https://clixad.onrender.com/v1")
  assert.equal(normalizeBase("https://clixad.onrender.com/v1/"), "https://clixad.onrender.com/v1")
  assert.equal(normalizeBase(""), "https://clixad.onrender.com/v1")
})

test("static catalog has 15 models and marks the free ones", () => {
  const table = staticModelTable()
  assert.equal(Object.keys(table).length, 15)
  assert.equal(table["gpt-5-nano"].free, true)
  assert.equal(table["claude-opus-5.5"].free, undefined)
  assert.equal(table["gpt-5-nano"].limit.context, 400000)
})

test("modelOf keeps the account's context and free flag", () => {
  const m = modelOf({ tool_call: true, limit: {} }, { id: "x", name: "X", context: 1234, free: true, efforts: ["low", "high"] })
  assert.equal(m.limit.context, 1234)
  assert.equal(m.free, true)
  assert.deepEqual(Object.keys(m.variants), ["low", "high"])
})

test("usageOf turns the wallet into a daily window and a balance", () => {
  const u = usageOf({ user: "a@b.c", balance: 1200, free_tier: { daily_credits: 100, extra_credits: 20, credits_left: 60, models: ["gpt-5-nano"] } })
  assert.equal(u.plan, "Free + credits")
  assert.equal(u.balance, "1,200 credits")
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].limit, 120)
  assert.equal(u.windows[0].amount, 60)
  assert.equal(u.windows[0].used, 50)
  assert.deepEqual(u.windows[0].models, ["gpt-5-nano"])
})

test("usageOf survives a wallet without a free tier", () => {
  const u = usageOf({ balance: 0 })
  assert.deepEqual(u.windows, [])
  assert.equal(u.balance, "0 credits")
})

test("nextUtcMidnight is the next UTC midnight", () => {
  const t = new Date(nextUtcMidnight())
  assert.equal(t.getUTCHours(), 0)
  assert.equal(t.getUTCMinutes(), 0)
  assert.ok(t.getTime() > Date.now())
})

test("the plugin exposes a provider, two sign-in methods and a loader", async () => {
  const hooks = await ClixadAuthPlugin({ directory: process.cwd() })
  assert.equal(hooks.auth.provider, "clixad")
  assert.equal(hooks.auth.methods.length, 2)
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.equal(hooks.provider.id, "clixad")
  const cfg = { provider: {} }
  await hooks.config(cfg)
  assert.equal(cfg.provider.clixad.npm, "@ai-sdk/openai-compatible")
  assert.equal(Object.keys(cfg.provider.clixad.models).length, 15)
})
