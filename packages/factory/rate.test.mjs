// A model's price reaches magpie as its rate: droid's own picker shows a model
// by the token multiplier its entry keeps (cost.tokenMultiplier), and magpie
// shows the same beside the model, so a cheap one is picked without opening
// droid. A promotion running comes off it, with the multiplier before the
// discount as rateWas — magpie strikes that through beside the price, as it
// does for WorkBuddy's credits and Qoder's price factors. The cases are droid
// 0.241.1's registry costs and 0.251.0's 1017 entry, saved in testdata.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const DROID = ["droid-0.241.1-costs.txt", "droid-0.251.0-deepseek-1017.txt"]
  .map((name) => readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8")).join("\n")

// cost is a model's cost text, as its entry keeps it.
function cost(id) {
  const line = DROID.split("\n").find((l) => l.startsWith(`"${id}":`))
  if (!line) throw new Error(`${id} is not in the fixture`)
  return line.slice(line.indexOf("cost:"))
}

// multiplier is the token multiplier an entry lists.
function multiplier(id) {
  return Number(cost(id).match(/tokenMultiplier:([\d.]+)/)[1])
}

// promotions are the ones an entry names: droid keeps them apart from it, by a
// name, or inline in the entry itself.
function promotions(id) {
  const text = cost(id)
  const inline = text.match(/promotions:\[\{discount:([\d.]+),startsAt:new Date\("([^"]+)"\)(?:,expiresAt:new Date\("([^"]+)"\))?/)
  if (inline) return [{ discount: +inline[1], from: inline[2], to: inline[3] ?? null }]
  const named = text.match(/promotions:\[([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)\]/)
  if (!named) return []
  const defs = Object.fromEntries(
    [...DROID.matchAll(/^([A-Za-z_$][\w$]*)=\{discount:([\d.]+),startsAt:new Date\("([^"]+)"\)(?:,expiresAt:new Date\("([^"]+)"\))?/gm)].map((m) => [
      m[1],
      { discount: +m[2], from: m[3], to: m[4] ?? null },
    ]),
  )
  return named[1].split(",").map((n) => {
    const d = defs[n.trim()]
    if (!d) throw new Error(`promotion ${n} is not defined in the fixture`)
    return d
  })
}

// price is what magpie shows for a model at now: the multiplier less the first
// promotion running then, and the multiplier before it when one runs.
function price(id, now) {
  const base = multiplier(id)
  const p = promotions(id).find((p) => now >= Date.parse(p.from) && (!p.to || now < Date.parse(p.to)))
  if (!p) return { rate: base, rateWas: 0 }
  return { rate: Number((base * (1 - p.discount)).toFixed(4)), rateWas: base }
}

test("every model's rate is the token multiplier its droid registry entry lists", () => {
  for (const m of _internal.MODELS) {
    expect(m.rate).toBe(multiplier(m.id))
  }
})

test("a promotion running comes off the rate, the multiplier before it as rateWas", () => {
  const now = Date.parse("2026-10-14T21:30:00Z")
  const models = _internal.configModels(now)
  for (const m of _internal.MODELS) {
    expect(models[m.id].rate).toBe(price(m.id, now).rate)
    expect(models[m.id].rateWas).toBe(price(m.id, now).rateWas)
  }
  // the five droid 0.241.1 offers a price off on: Sol's 20%, Mistral Large 4's
  // launch discount, and Gemini 4 Argon's, 3.8 Flash's and 3.7 Flash's 50%
  const discounted = _internal.MODELS.filter((m) => models[m.id].rateWas > 0).map((m) => m.id)
  expect(discounted).toEqual(["gpt-5.6-sol", "mistral-large-4", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash"])
  expect(models["gemini-4-argon"].rate).toBe(0.8)
  expect(models["gemini-4-argon"].rateWas).toBe(1.6)
})

test("a promotion that has ended, or hasn't started, is no discount at all", () => {
  // Gemini 4 Argon's 50% off ends 2026-12-01T08:00Z; GLM-5.6 Sol's 20% starts
  // 2026-08-22T00:00Z. Either way the multiplier is the price.
  const after = _internal.configModels(Date.parse("2026-12-02T00:00:00Z"))
  expect(after["gemini-4-argon"].rate).toBe(1.6)
  expect(after["gemini-4-argon"].rateWas).toBe(0)
  const before = _internal.configModels(Date.parse("2026-08-01T00:00:00Z"))
  expect(before["gpt-5.6-sol"].rate).toBe(2)
  expect(before["gpt-5.6-sol"].rateWas).toBe(0)
})

// magpie reads a model's rate from a provider hook's models, not from a config
// hook's (host.js, providers()): a price given only in config never reaches the
// model list. So the same list is offered both ways.
test("the provider hook carries every model with its rate, as magpie reads it", async () => {
  const now = Date.parse("2026-10-14T21:30:00Z")
  const models = _internal.providerModels({ id: "factory" }, now)
  expect(Object.keys(models).sort()).toEqual(_internal.MODELS.map((m) => m.id).sort())
  for (const m of _internal.MODELS) {
    const got = models[m.id]
    expect(got.rate).toBe(price(m.id, now).rate)
    expect(got.rateWas).toBe(price(m.id, now).rateWas)
    // the fields magpie reads a provider's model list for
    expect(got.id).toBe(m.id)
    expect(got.name).toBe(m.name)
    expect(got.api).toEqual({ id: m.id, url: m.wire.api, npm: m.wire.npm })
    expect(got.limit).toEqual({ context: m.context, output: m.output })
    expect(got.capabilities.reasoning).toBe(m.efforts.length > 0)
    expect(got.capabilities.input.image).toBe(m.images)
    expect(Object.keys(got.variants)).toEqual([...m.efforts])
  }
  expect(models["gemini-4-argon"].rate).toBe(0.8)
  expect(models["gemini-4-argon"].rateWas).toBe(1.6)
})

test("the plugin answers a provider hook, which a config hook alone doesn't", async () => {
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  expect(hooks.provider?.id).toBe("factory")
  expect(typeof hooks.provider.models).toBe("function")
  const models = await hooks.provider.models({ id: "factory" }, {})
  expect(models["gpt-6.1-sol"].rate).toBeGreaterThan(0)
  expect(Object.keys(models)).toHaveLength(_internal.MODELS.length)
})
