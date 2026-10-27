import { describe, expect, test } from "bun:test"
import { RiverPlugin, _internal } from "./index.mjs"

const { createPlugin, row, pretty, costOf, rowsFor, LIMITS, VARIANTS, BOOT_PRICES, BASE } = _internal

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

const auth = { type: "api", key: "rv_test" }

describe("config", () => {
  test("declares the river provider with bootstrap models and keeps a configured one", async () => {
    const plugin = await createPlugin()
    const cfg = { provider: { river: { name: "Mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider.river.name).toBe("Mine")
    const fresh = {}
    await plugin.config(fresh)
    const p = fresh.provider.river
    expect(p.name).toBe("River")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(BASE)
    expect(Object.keys(p.models)).toEqual(Object.keys(BOOT_PRICES))
    expect(p.models["deepseek-ai/DeepSeek-V4.1-Flash"].limit).toEqual(LIMITS["deepseek-ai/DeepSeek-V4.1-Flash"])
    expect(p.models["zai-org/GLM-5.3-Flash"].cost.input).toBe(0.12)
  })
})

describe("loader", () => {
  test("maps an api account to the base URL and key", async () => {
    const plugin = await createPlugin()
    const loaded = await plugin.auth.loader(async () => auth)
    expect(loaded).toEqual({ baseURL: BASE, apiKey: "rv_test" })
  })
  test("loads nothing without an account", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })
  test("offers an api key sign-in", async () => {
    const plugin = await createPlugin()
    expect(plugin.auth.provider).toBe("river")
    expect(plugin.auth.methods).toEqual([{ type: "api", label: "River API key", placeholder: "rv_…" }])
  })
})

describe("provider.models", () => {
  test("merges the account's models with docs limits and live prices, caching the pricing list", async () => {
    const calls = []
    calls.handler = (_i, input) =>
      String(input).includes("/models")
        ? jsonRes(200, { object: "list", data: [{ id: "zai-org/GLM-5.3-Flash" }, { id: "moonshotai/Kimi-K3" }] })
        : jsonRes(200, { inference: [{ model: "moonshotai/Kimi-K3", input: 3.0, cached_input: 0.3, output: 15.0 }] })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    const models = await plugin.provider.models({ models: {} }, { auth })
    expect(Object.keys(models)).toEqual(["zai-org/GLM-5.3-Flash", "moonshotai/Kimi-K3"])
    expect(models["zai-org/GLM-5.3-Flash"].limit).toEqual(LIMITS["zai-org/GLM-5.3-Flash"])
    expect(models["zai-org/GLM-5.3-Flash"].cost).toEqual({ input: 0.12, output: 0.4, cache_read: 0.024 })
    expect(models["moonshotai/Kimi-K3"].reasoning).toBe(true)
    expect(models["moonshotai/Kimi-K3"].modalities.input).toEqual(["text", "image"])
    expect(calls[0].init.headers.authorization).toBe("Bearer rv_test")
    // the pricing answer is cached: the second call still asks /v1/models
    // but no longer asks the pricing endpoint
    const before = calls.length
    await plugin.provider.models({ models: {} }, { auth })
    expect(calls.length - before).toBe(1)
    expect(calls[before].input).toContain("/models")
  })
  test("a healthy empty list is the account's list and replaces the bootstrap", async () => {
    const calls = []
    calls.handler = () => jsonRes(200, { object: "list", data: [] })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    expect(await plugin.provider.models({ models: { "zai-org/GLM-5.3-Flash": { name: "kept" } } }, { auth })).toEqual({})
  })
  test("keeps the previous list when River errs or the network fails, without marking the sign-in", async () => {
    for (const answer of [jsonRes(500, "boom"), jsonRes(502, "")]) {
      const calls = []
      calls.handler = () => answer
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      const kept = { models: { "zai-org/GLM-5.3-Flash": { name: "kept" } } }
      expect(await plugin.provider.models(kept, { auth })).toBe(kept.models)
    }
    const plugin = createPlugin({
      fetchImpl: async () => {
        throw new Error("offline")
      },
    })
    const kept = { models: { "zai-org/GLM-5.3-Flash": { name: "kept" } } }
    expect(await plugin.provider.models(kept, { auth })).toBe(kept.models)
  })
  test("throws on a malformed answer, so the host keeps the previous list as a fallback", async () => {
    for (const answer of [jsonRes(200, "<html>"), jsonRes(200, { data: "x" }), jsonRes(200, { data: [{ id: 42 }] })]) {
      const calls = []
      calls.handler = () => answer
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow("River sent no model list")
    }
  })
  test("marks the account expired when River refuses the key", async () => {
    for (const status of [401, 403]) {
      const calls = []
      calls.handler = () => jsonRes(status, { error: { message: "bad key" } })
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      expect(plugin.provider.models({ models: {} }, { auth })).rejects.toMatchObject({ signIn: "expired" })
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
    calls.handler = () => jsonRes(200, { data: [{ id: "zai-org/GLM-5.3-Flash" }] })
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
    expect(await plugin.auth.usage(async () => auth).error).toBeUndefined()
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
    expect(pretty("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("DeepSeek V4.1 Flash 1017")
    expect(pretty("Qwen/Qwen3.8-27B-FP8")).toBe("Qwen3.8 27B FP8")
    expect(pretty("plain")).toBe("plain")
  })
  test("costOf keeps numbers only", () => {
    expect(costOf({ input: 1, output: 2, cached_input: 0.5 })).toEqual({ input: 1, output: 2, cache_read: 0.5 })
    expect(costOf({})).toBeUndefined()
    expect(costOf(null)).toBeUndefined()
  })
  test("rows carry image input, tools and reasoning in both shapes for a documented image model", () => {
    const r = row("moonshotai/Kimi-K3", "Kimi K3", undefined, undefined)
    expect(r.limit).toEqual({ context: 0, output: 0 })
    expect(r.modalities.input).toEqual(["text", "image"])
    expect(r.reasoning && r.tool_call).toBe(true)
    expect(r.capabilities).toEqual({
      reasoning: true,
      toolcall: true,
      attachment: true,
      input: { text: true, image: true },
      output: { text: true },
    })
  })
  test("a text-only model takes no images and no attachments", () => {
    const r = row("zai-org/GLM-5.3", "GLM 5.3", undefined, undefined)
    expect(r.modalities.input).toEqual(["text"])
    expect(r.capabilities.attachment).toBe(false)
    expect(r.capabilities.input).toEqual({ text: true, image: false })
  })
  test("rowsFor keeps an id the docs don't list text-only rather than assuming it sees images", () => {
    const rows = rowsFor(["moonshotai/Kimi-K3", "river/new-model"], null)
    expect(rows["moonshotai/Kimi-K3"].capabilities.input.image).toBe(true)
    expect(rows["river/new-model"].capabilities.input.image).toBe(false)
    expect(rows["river/new-model"].modalities.input).toEqual(["text"])
  })
  test("image capability matches the docs per model — only the listed ids take images", () => {
    const documented = {
      "moonshotai/Kimi-K3": true,
      "deepseek-ai/DeepSeek-V4.1-Flash": true,
      "deepseek-ai/DeepSeek-V4.1-Flash-1017": true,
      "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": true,
      "zai-org/GLM-5.3-Flash": true,
      "Qwen/Qwen3.8-27B-FP8": true,
      "zai-org/GLM-5.3": false, // docs: GLM-5.3 (text only)
    }
    for (const [id, image] of Object.entries(documented)) {
      const r = rowsFor([id], null)[id]
      expect(r.capabilities.input.image).toBe(image)
      expect(r.modalities.input.includes("image")).toBe(image)
    }
  })
  test("rowsFor falls back to boot prices without a live list", () => {
    const rows = rowsFor(["zai-org/GLM-5.3-Flash"], null)
    expect(rows["zai-org/GLM-5.3-Flash"].cost).toEqual(costOf(BOOT_PRICES["zai-org/GLM-5.3-Flash"]))
  })
  test("rows carry the documented reasoning efforts", () => {
    const rows = rowsFor(["deepseek-ai/DeepSeek-V4.1-Flash", "moonshotai/Kimi-K3", "Qwen/Qwen3.8-27B-FP8"], null)
    expect(Object.keys(rows["deepseek-ai/DeepSeek-V4.1-Flash"].variants)).toEqual(["none", "low", "high", "max"])
    expect(Object.keys(rows["moonshotai/Kimi-K3"].variants)).toEqual(["none", "max"])
    expect(Object.keys(rows["Qwen/Qwen3.8-27B-FP8"].variants)).toEqual(["none", "low", "medium", "xhigh"])
    expect(Object.keys(VARIANTS)).toHaveLength(6)
  })
  test("each variant's options carry its reasoningEffort — what OpenCode merges into the request", () => {
    for (const variants of Object.values(VARIANTS)) {
      for (const [effort, options] of Object.entries(variants)) {
        expect(options).toEqual({ reasoningEffort: effort })
      }
    }
  })
  test("documented limits ride the rows", () => {
    const rows = rowsFor(["moonshotai/Kimi-K3", "zai-org/GLM-5.3-Flash"], null)
    expect(rows["moonshotai/Kimi-K3"].limit).toEqual({ context: 1048576, output: 32768 })
    expect(rows["zai-org/GLM-5.3-Flash"].limit).toEqual({ context: 1048576, output: 131072 })
  })
})

test("the package exports one plugin function", async () => {
  expect(typeof RiverPlugin).toBe("function")
  const hooks = await RiverPlugin()
  expect(typeof hooks.config).toBe("function")
  expect(hooks.auth.provider).toBe("river")
  expect(hooks.provider.id).toBe("river")
})
