// The model list: MiniMax Code's live config when it answers, MiniMax
// Code's built-in four when it doesn't.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, _internal } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 }

async function given(hooks) {
  const cfg = { provider: {} }
  await hooks.config(cfg)
  // as the host hands provider.models what the config declared
  const p = cfg.provider["minimax-code"]
  return { id: "minimax-code", models: Object.fromEntries(Object.entries(p.models).map(([id, m]) => [id, { id, ...m }])) }
}

test("the config declares MiniMax Code's four models on the Anthropic API", async () => {
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["minimax-code"]
  expect(p.npm).toBe("@ai-sdk/anthropic")
  expect(p.api).toBe(_internal.SITES["minimax-code"].llm + "/mavis/api/v1/llm/v1")
  expect(Object.keys(p.models).sort()).toEqual(["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3", "MiniMax-M3.1-Flash-Preview"])
  expect(p.models["MiniMax-M3"].variants).toEqual({ none: { thinking: { type: "disabled" } }, high: { thinking: { type: "adaptive" } } })
  expect(Object.keys(p.models["MiniMax-M3.1-Flash-Preview"].variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(p.models["MiniMax-M3.1-Flash-Preview"].variants.xhigh).toEqual({ thinking: { type: "adaptive" }, effort: "xhigh" })
  expect(p.models["MiniMax-M3"].modalities.input).toEqual(["text", "image"])
  expect(p.models["MiniMax-M2.7"].modalities.input).toEqual(["text"])
  expect(p.models["MiniMax-M3"].limit).toEqual({ context: 1048576, output: 524288 })
  expect(p.models["MiniMax-M3.1-Flash-Preview"].limit).toEqual({ context: 1048576, output: 524288 })
  expect(p.models["MiniMax-M2.7"].limit).toEqual({ context: 200000, output: 128000 })
})

test("a model whose advertised limits are under the real ones gets the real ones", async () => {
  f = fakeMiniMax()
  f.route("GET /mavis/api/v1/models", () => json({
    version: "7", ttlSeconds: 300,
    providers: [
      { providerId: "minimax", config: {
        model_order: ["MiniMax-M3.1-Flash", "MiniMax-M2.7"],
        models: {
          // what MiniMax Code's own list says today
          "MiniMax-M3.1-Flash": { name: "M3.1-Flash", limit: { context: 512000, output: 128000 }, modalities: { input: ["text", "image"] }, reasoning: true, thinking_config: { mode: "forced_on" } },
          "MiniMax-M2.7": { name: "MiniMax-M2.7", limit: { context: 200000, output: 128000 }, modalities: { input: ["text"] }, reasoning: true },
        },
      } },
    ],
  }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const ms = await hooks.provider.models(await given(hooks), { auth })
  // the endpoint allows 1,048,576 input and 524,288 output tokens for it
  expect(ms["MiniMax-M3.1-Flash"].limit).toEqual({ context: 1048576, output: 524288 })
  // a model with no verified limits keeps the ones the list gave
  expect(ms["MiniMax-M2.7"].limit).toEqual({ context: 200000, output: 128000 })
})

test("the live list is MiniMax Code's model config", async () => {
  f = fakeMiniMax()
  f.route("GET /mavis/api/v1/models", () => json({
    version: "7", ttlSeconds: 300,
    providers: [
      { providerId: "other", config: { models: { x: {} } } },
      { providerId: "minimax", config: {
        model_order: ["MiniMax-M4", "MiniMax-M3"],
        models: {
          "MiniMax-M3": { name: "MiniMax-M3", limit: { context: 512000, output: 128000 }, modalities: { input: ["text", "image", "video"] }, reasoning: true, thinking_config: { mode: "switchable", default_value: "true" } },
          "MiniMax-M4": { name: "M4", limit: { context: 1000000, output: 128000 }, modalities: { input: ["text"] }, reasoning: true, thinking_config: { mode: "forced_on" }, thinking: { effortOptions: ["default", "low", "high"], defaultEffort: "default" } },
          "MiniMax-M2.7": { name: "MiniMax-M2.7", limit: { context: 200000, output: 128000 }, modalities: { input: ["text"] }, reasoning: true },
        },
      } },
    ],
  }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const p = await given(hooks)
  const ms = await hooks.provider.models(p, { auth })
  expect(Object.keys(ms)).toEqual(["MiniMax-M4", "MiniMax-M3", "MiniMax-M2.7"])
  expect(ms["MiniMax-M4"]).toMatchObject({ id: "MiniMax-M4", providerID: "minimax-code", name: "M4", api: { id: "MiniMax-M4", npm: "@ai-sdk/anthropic" }, limit: { context: 1000000, output: 128000 } })
  expect(ms["MiniMax-M4"].variants).toEqual({ low: { thinking: { type: "adaptive" }, effort: "low" }, high: { thinking: { type: "adaptive" }, effort: "high" } })
  expect(ms["MiniMax-M3"].capabilities.input.image).toBe(true)
  expect(ms["MiniMax-M3"].variants.none).toEqual({ thinking: { type: "disabled" } })
  expect(ms["MiniMax-M2.7"].variants).toEqual({})
  const r = f.seen[0]
  expect(r.query.get("region")).toBe("cn")
  expect(r.query.get("buildEnv")).toBe("prod")
  expect(r.headers.get("authorization")).toBe("Bearer tok")
})

test("a list refused with the account is asked again without it", async () => {
  f = fakeMiniMax()
  f.route("GET /mavis/api/v1/models", (r) => (r.headers.get("authorization")
    ? json({}, 401)
    : json({ providers: [{ providerId: "minimax", config: { models: { "MiniMax-M3": { name: "MiniMax-M3" } } } }] })))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const ms = await hooks.provider.models(await given(hooks), { auth })
  expect(Object.keys(ms)).toEqual(["MiniMax-M3"])
  expect(f.seen.length).toBe(2)
})

test("when the list can't be had, the built-in one is given back as it came", async () => {
  for (const reply of [() => json({ error: "down" }, 500), () => new Response("not json"), () => json({ providers: [] })]) {
    f = fakeMiniMax()
    f.route("GET /mavis/api/v1/models", reply)
    const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
    const p = await given(hooks)
    // the very object it was given, which magpie reads as a fallback
    expect(await hooks.provider.models(p, { auth })).toBe(p.models)
    f.close()
    f = null
  }
  // signed out: not asked at all
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(await hooks.provider.models(p, { auth: undefined })).toBe(p.models)
})
