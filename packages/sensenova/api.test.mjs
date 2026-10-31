// The API key side: the catalogue it reads, the models magpie lists for the
// account (its own plan's coverage ∩ what the key serves ∩ what answers a chat
// request), the reasoning effort levels each declares, and the chat loader.
// Everything runs against the local fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { SenseNovaAuthPlugin, _internal } from "./index.mjs"
import { fakeSenseNova, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

// the account one sign-in leaves behind: the console JWT for the pools, the
// API key (kept beside it) for the models and chat
const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "yiheng13", apiKey: "sk-test" }

// the catalogue the key is served: two models the plan covers and chat
// answers, one the plan doesn't cover (the vendor 403s it), one that draws
// (a chat endpoint 404s it)
const CATALOGUE = {
  data: [
    { id: "glm-5.2", name: "glm-5.2", context_length: 1048576, max_output_length: 131072, input_modalities: ["text"], output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
    { id: "sensenova-6.8-flash-lite", name: "sensenova-6.8-flash-lite", context_length: 262144, max_output_length: 65536, input_modalities: ["text", "image"], output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
    { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", context_length: 1048576, max_output_length: 65536, input_modalities: ["text"], output_modalities: ["text"], supported_features: ["reasoning"] },
    { id: "sensenova-u1.5-lite", name: "sensenova-u1.5-lite", context_length: 262144, max_output_length: 65536, input_modalities: ["text"], output_modalities: ["image"], supported_features: ["tools"] },
  ],
}

// the plan this account's pools cover
const PLAN = (ids) => ({ plan: { name: "Free Plan" }, pools: [{ name: "通用积分池", pool_type: "default", model_ids: ids }] })

// routes for a listing: the pools the console shows and the catalogue the key
// is served. Both are counted so a test can say what was asked for.
function serve(list = CATALOGUE, planIds = ["glm-5.2", "sensenova-6.8-flash-lite", "sensenova-u1.5-lite"]) {
  f.route("GET /models", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer sk-test")
    return json(list)
  })
  f.route("GET /lite/console/v1/tokenplan/pool-usage", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer tok")
    return json(PLAN(planIds))
  })
}

async function plugin() {
  return SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
}

// the host's own default for a lead it isn't told (host.js RENEW_LEAD)
const HOST_DEFAULT_LEAD = 5 * 60 * 1000

test("a cold listing gives the plan's models, not the raw catalogue", async () => {
  // no usage() read first: this is a fresh host process, or the first listing
  // after a sign-in. What the plan covers is read here, from this account.
  f = fakeSenseNova()
  serve()
  const p = await plugin()
  const models = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth })
  // deepseek-v4.1-flash is in the catalogue but not the plan (403 from the
  // vendor); sensenova-u1.5-lite is in the plan but draws (404 at chat)
  expect(Object.keys(models).sort()).toEqual(["glm-5.2", "sensenova-6.8-flash-lite"])
})

test("the listing carries each model's limits, input kinds and effort tiers", async () => {
  f = fakeSenseNova()
  serve()
  const p = await plugin()
  const models = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth })
  expect(models["glm-5.2"].limit).toEqual({ context: 1048576, output: 131072 })
  // the tiers are the same for every model: the platform publishes no per-model
  // list, so nothing narrower than "these are offered" is claimed
  expect(Object.keys(models["glm-5.2"].variants)).toEqual(["none", "low", "high"])
  expect(Object.keys(models["sensenova-6.8-flash-lite"].variants)).toEqual(["none", "low", "high"])
  // what is claimed is checkable from the reply itself: whether it takes images
  expect(models["sensenova-6.8-flash-lite"].capabilities.input.image).toBe(true)
  expect(models["glm-5.2"].capabilities.input.image).toBe(false)
})

test("a model the catalogue says doesn't reason gets no effort tiers", () => {
  // the gate is the catalogue's own supported_features, not a hand-kept table:
  // a model that stops reasoning stops offering tiers, with nothing to update
  const flat = _internal.modelOf({ id: "x", name: "x", context: 1000, output: 100, reasoning: false })
  expect(flat.reasoning).toBe(false)
  expect(flat.variants).toBeUndefined()
  const deep = _internal.modelOf({ id: "y", name: "y", context: 1000, output: 100, reasoning: true })
  expect(Object.keys(deep.variants)).toEqual(["none", "low", "high"])
})

test("two accounts on different plans list different models", async () => {
  // nothing about the plan is kept between calls: a module global would let
  // the first account's plan filter the second's list
  f = fakeSenseNova()
  const p = await plugin()
  const wide = { ...auth, access: "tok-wide", apiKey: "sk-wide" }
  const narrow = { ...auth, access: "tok-narrow", apiKey: "sk-narrow" }
  f.route("GET /models", (r) => {
    const want = r.headers.get("authorization") === "Bearer sk-wide" ? CATALOGUE : { data: CATALOGUE.data.slice(0, 1) }
    return json(want)
  })
  f.route("GET /lite/console/v1/tokenplan/pool-usage", (r) => {
    const ids = r.headers.get("authorization") === "Bearer tok-wide"
      ? ["glm-5.2", "sensenova-6.8-flash-lite"]
      : ["glm-5.2"]
    return json(PLAN(ids))
  })
  const a = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth: wide })
  const b = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth: narrow })
  expect(Object.keys(a).sort()).toEqual(["glm-5.2", "sensenova-6.8-flash-lite"])
  expect(Object.keys(b)).toEqual(["glm-5.2"])
})

test("a plan read that fails keeps the bootstrap list rather than the catalogue", async () => {
  // the vendor refusing the pools says nothing about what the key can call,
  // so the raw catalogue (which holds a model that 403s) must not be listed
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json({ error: "no" }, 500))
  f.route("GET /models", () => json(CATALOGUE))
  const p = await plugin()
  const given = { "glm-5.2": {} }
  expect(await p.provider.models({ id: "sensenova-token-plan", models: given }, { auth })).toEqual(given)
})

test("a key the platform refuses keeps the list the provider started with", async () => {
  f = fakeSenseNova()
  serve()
  f.route("GET /models", () => json({ error: "unauthorized" }, 401))
  const p = await plugin()
  const given = { "glm-5.2": {} }
  expect(await p.provider.models({ id: "sensenova-token-plan", models: given }, { auth })).toEqual(given)
})

test("an account with no API key advertises no models and serves no chat", async () => {
  // the five models in the provider's config belong to an account that has a
  // key; without one, listing them would offer models whose requests go out
  // with no auth at all
  f = fakeSenseNova()
  const p = await plugin()
  const noKey = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "yiheng13" }
  expect(await p.provider.models({ id: "sensenova-token-plan", models: { "glm-5.2": {} } }, { auth: noKey })).toEqual({})
  expect(await p.auth.loader(async () => noKey)).toEqual({})
})

test("the loader serves the models with the key, at the platform's base URL", async () => {
  f = fakeSenseNova()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  // magpie sends "Authorization: Bearer <apiKey>" for @ai-sdk/openai-compatible
  // itself (host.js sdkHeaders), so the loader only says where and with what
  expect(loader.apiKey).toBe("sk-test")
  expect(loader.baseURL).toBe(f.origin)
  expect(loader.fetch).toBeUndefined()
})

test("the renewal lead is where the host reads it", async () => {
  // host.js takes the lead from auth (leadOf(a), a = auth), not from the
  // hooks object: on the wrong side of auth it is silently the host's default
  const p = await plugin()
  expect(p.refreshLead).toBeUndefined()
  expect(p.auth.refreshLead).toBe(_internal.EARLY_MS)
  expect(p.auth.refreshLead).toBeGreaterThan(HOST_DEFAULT_LEAD)
})

test("the sign-in asks for the account, its password and an optional key", async () => {
  const p = await plugin()
  const m = p.auth.methods[0]
  expect(m.prompts.map((x) => x.key)).toEqual(["username", "password", "apiKey"])
  // the key is optional: an empty one passes, a non-sk- one doesn't
  expect(m.prompts[2].validate("")).toBeUndefined()
  expect(m.prompts[2].validate("sk-abc")).toBeUndefined()
  expect(m.prompts[2].validate("nope")).toContain("sk-")
  // the sign-in runs in the background: a url would open the console for nothing
  expect(m.authorize({ username: "u", password: "p", apiKey: "" }).url).toBe("")
})

test("a plan that names no models lists none, rather than the bootstrap set", async () => {
  // an empty plan is an answer, not a failed read: falling back to the
  // bootstrap list would offer models the vendor then refuses
  f = fakeSenseNova()
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () => json({ plan: { name: "Free Plan" }, pools: [] }))
  f.route("GET /models", () => json({ data: [] }))
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const models = await p.provider.models({ id: "sensenova-token-plan", models: { "glm-5.2": {} } }, {
    type: "oauth", access: "tok", apiKey: "sk-test",
  })
  expect(models).toEqual({})
})
