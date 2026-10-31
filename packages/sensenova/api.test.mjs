// The API key: the model catalogue it reads, the models magpie lists from
// it (with the reasoning effort levels each takes), and the chat loader
// that serves them. The console account holds the key on itself, so a
// single sign-in gives both — this is that side of it. Everything runs
// against the local fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { SenseNovaAuthPlugin, _internal } from "./index.mjs"
import { fakeSenseNova, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

// the account magpie stores for the one sign-in: the console JWT for the
// quota, the API key (kept beside it) for the models and chat
const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "yiheng13", apiKey: "sk-test" }

const catalogue = () => ({
  data: [
    { id: "glm-5.2", name: "glm-5.2", context_length: 1048576, max_output_length: 131072, input_modalities: ["text"], output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
    { id: "sensenova-6.8-flash-lite", name: "sensenova-6.8-flash-lite", context_length: 262144, max_output_length: 65536, input_modalities: ["text", "image"], output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
    { id: "sensenova-u1.5-lite", name: "sensenova-u1.5-lite", context_length: 262144, max_output_length: 65536, input_modalities: ["text"], output_modalities: ["image"], supported_features: ["tools"] },
    { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", context_length: 1048576, max_output_length: 65536, input_modalities: ["text"], output_modalities: ["text"], supported_features: ["reasoning"] },
  ],
})

async function plugin() {
  return SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
}

test("the catalogue is the models, each with its limits and effort levels", async () => {
  f = fakeSenseNova()
  f.route("GET /models", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer sk-test")
    return json(catalogue())
  })
  // the console account's pools say what the plan covers
  f.route("GET /lite/console/v1/tokenplan/pool-usage", () =>
    json({ plan: { name: "Free Plan" }, pools: [{ name: "通用积分池", model_ids: ["glm-5.2", "sensenova-6.8-flash-lite"] }] }),
  )
  const p = await plugin()
  await p.auth.usage(async () => auth) // warm the plan's model ids
  const models = await p.provider.models({ id: "sensenova-token-plan", models: {} }, { auth })
  // a model that draws (u1.5-lite) and one outside the plan (v4.1-flash)
  // stay unlisted; the two the plan covers and chat are the list
  expect(Object.keys(models).sort()).toEqual(["glm-5.2", "sensenova-6.8-flash-lite"])
  expect(models["glm-5.2"].limit).toEqual({ context: 1048576, output: 131072 })
  // the reasoning effort levels each takes, as the platform's docs say
  expect(Object.keys(models["glm-5.2"].variants)).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  expect(models["sensenova-6.8-flash-lite"].variants).toHaveProperty("none")
  // a model that takes images in says so
  expect(models["sensenova-6.8-flash-lite"].capabilities.input.image).toBe(true)
})

test("a key the platform refuses keeps the list the provider started with", async () => {
  f = fakeSenseNova()
  f.route("GET /models", () => json({ error: "unauthorized" }, 401))
  const p = await plugin()
  const models = await p.provider.models({ id: "sensenova-token-plan", models: { "glm-5.2": {} } }, { auth })
  expect(models).toEqual({ "glm-5.2": {} }) // the bootstrap list, not an empty card
})

test("the loader serves the models with the key, at the platform's base URL", async () => {
  f = fakeSenseNova()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  // magpie sends "Authorization: Bearer <apiKey>" for @ai-sdk/openai-compatible
  // itself, so the loader only says where to and with what
  expect(loader.apiKey).toBe("sk-test")
  expect(loader.baseURL).toBe(f.origin)
  expect(loader.fetch).toBeUndefined()
})

test("an account with no API key serves no models and no chat", async () => {
  f = fakeSenseNova()
  const p = await plugin()
  const noKey = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "yiheng13" }
  expect(await p.provider.models({ id: "sensenova-token-plan", models: { "glm-5.2": {} } }, { auth: noKey })).toEqual({ "glm-5.2": {} })
  expect(await p.auth.loader(async () => noKey)).toEqual({})
})

test("the sign-in keeps the API key on the account beside the tokens", async () => {
  // passwordLogin and the fake's JWKS are exercised in signin.test; here
  // only the authorize callback's result shape is checked, that the key
  // rides along on it
  const p = await plugin()
  const m = p.auth.methods[0]
  const prompts = m.prompts.map((x) => x.key)
  expect(prompts).toEqual(["username", "password", "apiKey"])
  // the key is optional: an empty one is accepted
  expect(m.prompts[2].validate("")).toBeUndefined()
  expect(m.prompts[2].validate("sk-abc")).toBeUndefined()
  expect(m.prompts[2].validate("nope")).toContain("sk-")
})
