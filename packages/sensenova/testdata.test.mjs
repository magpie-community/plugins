// The parsers against the platform's literal bytes. testdata/ holds one
// real /v1/models reply and one real pool-usage reply from a free Token Plan
// account (only the account's pool ids are replaced), so what the fake serves
// is what the console actually sent — including its numbers as strings.
import "./nonet.mjs"
import { readFileSync } from "node:fs"
import { afterEach, expect, test } from "bun:test"
import { SenseNovaAuthPlugin, _internal } from "./index.mjs"
import { fakeSenseNova, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const load = (name) => JSON.parse(readFileSync(new URL("./testdata/" + name, import.meta.url), "utf8"))
const POOLS = load("pool-usage.json")
const MODELS = load("models.json")

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "acct", apiKey: "sk-test" }

test("the real pools become one window per pool per span, with the models each covers", () => {
  const u = _internal.usageOf(POOLS.pools)
  // two pools × (5h, 7d): the console's own numbers, which arrive as strings
  expect(u.windows.map((w) => w.name)).toEqual([
    "通用积分池 · 5 hours",
    "通用积分池 · 7 days",
    "Flash-Lite积分池 · 5 hours",
    "Flash-Lite积分池 · 7 days",
  ])
  // the default pool leads, so its meters show whatever groups by model
  expect(u.windows[0].models).toContain("glm-5.2")
  expect(u.windows[0].models.length).toBe(18)
  expect(u.windows[2].models).toEqual(["sensenova-6.7-flash-lite", "sensenova-6.8-flash-lite"])
  // the counts are the console's, the share is computed from them
  expect(u.windows[0].display).toBe("120000 / 120000")
  expect(u.windows[0].used).toBe(100)
  expect(u.windows[1].display).toBe("438285.55 / 1200000")
  // reset_at is epoch seconds, turned into a time the GUI can count down to
  expect(new Date(u.windows[0].resetsAt).getTime()).toBe(1793483140 * 1000)
  // a grant of 0 is no balance to show
  expect(u.balance).toBeUndefined()
})

test("the real catalogue is filtered to what this account's plan can chat with", async () => {
  f = fakeSenseNova()
  f.route("GET /models", () => json(MODELS))
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json(POOLS))
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const models = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth })
  // the catalogue serves seven, all of them marked "tokenplan"; the plan's
  // pools cover six of those, and one of the six only draws images
  expect(MODELS.data.length).toBe(7)
  expect(Object.keys(models).sort()).toEqual([
    "deepseek-flash",
    "deepseek-v4-flash",
    "glm-5.2",
    "kimi-k3",
    "sensenova-6.8-flash-lite",
  ])
  // the one the plan doesn't cover is left out: the vendor answers 403 to it
  expect(models["deepseek-v4.1-flash"]).toBeUndefined()
  // the one that draws is left out: a chat endpoint answers 404 to it
  expect(models["sensenova-u1.5-lite"]).toBeUndefined()
})

test("the real catalogue's own fields are what the models declare", async () => {
  f = fakeSenseNova()
  f.route("GET /models", () => json(MODELS))
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json(POOLS))
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const models = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth })
  const byId = Object.fromEntries(MODELS.data.map((m) => [m.id, m]))
  for (const id of Object.keys(models)) {
    expect(models[id].limit).toEqual({ context: byId[id].context_length, output: byId[id].max_output_length })
    const takesImage = byId[id].input_modalities.includes("image")
    expect(models[id].capabilities.input.image).toBe(takesImage)
    expect(models[id].modalities.input).toEqual(takesImage ? ["text", "image"] : ["text"])
  }
})

test("the bootstrap list is a subset of what the plan and catalogue agree on", async () => {
  // config() declares models before any account is read: those ids must be
  // ones a free Token Plan account can actually call, or a cold host would
  // offer a model the vendor refuses
  f = fakeSenseNova()
  f.route("GET /models", () => json(MODELS))
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json(POOLS))
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = {}
  await p.config(cfg)
  const declared = Object.keys(cfg.provider["sensenova-token-plan"].models)
  const listed = Object.keys(await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth }))
  expect(declared.sort()).toEqual(listed.sort())
})
