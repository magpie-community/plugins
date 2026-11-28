import { describe, expect, test } from "bun:test"
import { AtlasCloudPlugin, _internal } from "./index.mjs"

const { createPlugin, row, pretty, costOf, fromApi, VARIANTS, BOOT, BASE } = _internal

function jsonRes(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fakeFetch(calls) {
  return async (input, init) => {
    calls.push({ input: String(input), init })
    return calls.handler(calls.length - 1, input, init)
  }
}

const auth = { type: "api", key: "test-key" }

const flash = {
  id: "deepseek-ai/deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  input_modalities: [
    {
      type: "text",
      supported_inputs: { max_context_length: { value: 1048576, unit: "token" } },
      pricing: [
        { type: "prompt", unit: "token", cost_usd: "0.00000014" },
        { type: "cached_prompt", unit: "token", cost_usd: "0.000000028" },
      ],
    },
  ],
  output_modalities: [
    {
      type: "text",
      supported_parameters: { max_tokens: { max: 393216 }, tools: { type: "boolean" }, reasoning: { type: "boolean" } },
      max_length: { value: 393216, unit: "token" },
      pricing: [{ type: "completion", unit: "token", cost_usd: "0.00000028" }],
    },
  ],
}
const vision = {
  id: "vendor/vision-model",
  input_modalities: [{ type: "text" }, { type: "image" }],
  output_modalities: [{ type: "text" }],
}

describe("config", () => {
  test("declares the atlascloud provider with bootstrap models and keeps a configured one", async () => {
    const plugin = await createPlugin()
    const cfg = { provider: { atlascloud: { name: "Mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider.atlascloud.name).toBe("Mine")
    const fresh = {}
    await plugin.config(fresh)
    const p = fresh.provider.atlascloud
    expect(p.name).toBe("Atlas Cloud")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(BASE)
    expect(Object.keys(p.models)).toEqual(BOOT.map((m) => m.id))
  })
})

describe("loader", () => {
  test("maps an api account to the base URL and key", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => auth)).toEqual({ baseURL: BASE, apiKey: "test-key" })
  })
  test("loads nothing without an account", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })
  test("offers an api key sign-in", async () => {
    const plugin = await createPlugin()
    expect(plugin.auth.provider).toBe("atlascloud")
    expect(plugin.auth.methods).toEqual([{ type: "api", label: "Atlas Cloud API key", placeholder: "apikey-…" }])
  })
})

describe("provider.models", () => {
  test("lists the account's models with limits, prices, images and reasoning from /v1/models", async () => {
    const calls = []
    calls.handler = () => jsonRes(200, { object: "list", data: [flash, vision] })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    const models = await plugin.provider.models({ models: {} }, { auth })
    expect(Object.keys(models)).toEqual([flash.id, vision.id])
    expect(calls[0].input).toBe(`${BASE}/models`)
    expect(calls[0].init.headers.authorization).toBe("Bearer test-key")
    const m = models[flash.id]
    expect(m.name).toBe("DeepSeek V4 Flash")
    expect(m.limit).toEqual({ context: 1048576, output: 393216 })
    expect(m.cost).toEqual({ input: 0.14, output: 0.28, cache_read: 0.028 })
    expect(m.reasoning).toBe(true)
    expect(Object.keys(m.variants)).toEqual(["high", "xhigh"])
    expect(m.modalities.input).toEqual(["text"])
    expect(models[vision.id].modalities.input).toEqual(["text", "image"])
    expect(models[vision.id].reasoning).toBe(false)
    expect(models[vision.id].variants).toBeUndefined()
    expect(models[vision.id].name).toBe("vision model")
  })
  test("a healthy empty list is the account's list and replaces the bootstrap", async () => {
    const calls = []
    calls.handler = () => jsonRes(200, { object: "list", data: [] })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    expect(await plugin.provider.models({ models: { x: { name: "kept" } } }, { auth })).toEqual({})
  })
  test("keeps the previous list when Atlas Cloud errs or the network fails, without marking the sign-in", async () => {
    for (const answer of [jsonRes(500, "boom"), jsonRes(502, "")]) {
      const calls = []
      calls.handler = () => answer
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      const kept = { models: { x: { name: "kept" } } }
      expect(await plugin.provider.models(kept, { auth })).toBe(kept.models)
    }
    const plugin = createPlugin({
      fetchImpl: async () => {
        throw new Error("offline")
      },
    })
    const kept = { models: { x: { name: "kept" } } }
    expect(await plugin.provider.models(kept, { auth })).toBe(kept.models)
  })
  test("throws on a malformed answer, so the host keeps the previous list as a fallback", async () => {
    for (const answer of [jsonRes(200, "<html>"), jsonRes(200, { data: "x" }), jsonRes(200, { data: [{ id: 42 }] })]) {
      const calls = []
      calls.handler = () => answer
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow("Atlas Cloud sent no model list")
    }
  })
  test("marks the account expired when Atlas Cloud refuses the key", async () => {
    for (const status of [401, 403]) {
      const calls = []
      calls.handler = () => jsonRes(status, { code: status, msg: "invalid token" })
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toMatchObject({ signIn: "expired" })
    }
  })
  test("lists nothing per-account without an account", async () => {
    const plugin = await createPlugin()
    const kept = { models: { x: { name: "x" } } }
    expect(await plugin.provider.models(kept, {})).toBe(kept.models)
  })
})

describe("auth.usage", () => {
  test("reports the pay-as-you-go plan on a healthy key", async () => {
    const calls = []
    calls.handler = () => jsonRes(200, { data: [flash] })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    expect(await plugin.auth.usage(async () => auth)).toMatchObject({ plan: "Pay as you go" })
  })
  test("marks a refused key as expired", async () => {
    const calls = []
    calls.handler = () => jsonRes(401, {})
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    expect(await plugin.auth.usage(async () => auth)).toMatchObject({ signIn: "expired" })
  })
  test("reports other statuses and network failures as errors", async () => {
    const calls = []
    calls.handler = () => jsonRes(503, {})
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    const busy = await plugin.auth.usage(async () => auth)
    expect(busy.error).toContain("503")
    expect(busy.signIn).toBeUndefined()
    const down = createPlugin({
      fetchImpl: async () => {
        throw new Error("offline")
      },
    })
    const card = await down.auth.usage(async () => auth)
    expect(card.error).toContain("offline")
    expect(card.signIn).toBeUndefined()
  })
  test("says nothing without an account", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.usage(async () => undefined)).toEqual({})
  })
})

describe("helpers", () => {
  test("pretty names an id", () => {
    expect(pretty("deepseek-ai/deepseek-v4-flash")).toBe("deepseek v4 flash")
    expect(pretty("plain")).toBe("plain")
  })
  test("costOf converts per-token prices to per million and ignores bad ones", () => {
    expect(costOf(flash)).toEqual({ input: 0.14, output: 0.28, cache_read: 0.028 })
    expect(costOf({})).toBeUndefined()
    expect(costOf({ output_modalities: [{ type: "text", pricing: [{ type: "completion", cost_usd: "x" }] }] })).toBeUndefined()
  })
  test("fromApi leaves unstated limits at 0 and takes tools unless the entry says otherwise", () => {
    expect(fromApi(vision).limit).toEqual({ context: 0, output: 0 })
    expect(fromApi(vision).tool_call).toBe(true)
    const no = { ...flash, output_modalities: [{ type: "text", supported_parameters: { tools: { type: "unknown" } } }] }
    expect(fromApi(no).tool_call).toBe(false)
  })
  test("rows carry image input, tools and reasoning in both shapes", () => {
    const r = row({ id: "a/b", name: "B", image: true, reasoning: true })
    expect(r.capabilities).toEqual({
      reasoning: true,
      toolcall: true,
      attachment: true,
      input: { text: true, image: true },
      output: { text: true },
    })
    expect(r.variants).toBe(VARIANTS)
    const t = row({ id: "a/c", name: "C" })
    expect(t.modalities.input).toEqual(["text"])
    expect(t.capabilities.attachment).toBe(false)
  })
  test("each variant's options carry its reasoningEffort", () => {
    for (const [effort, options] of Object.entries(VARIANTS)) expect(options).toEqual({ reasoningEffort: effort })
  })
})

test("the package exports one plugin function", async () => {
  expect(typeof AtlasCloudPlugin).toBe("function")
  const hooks = await AtlasCloudPlugin()
  expect(typeof hooks.config).toBe("function")
  expect(hooks.auth.provider).toBe("atlascloud")
  expect(hooks.provider.id).toBe("atlascloud")
})
