import { describe, expect, test } from "bun:test"
import { OpenscalePlugin, _internal } from "./index.mjs"

const { createPlugin, row, rowFromCatalog, rowsFromCatalog, perMillion, display, BOOTSTRAP, BASE } = _internal

// Trimmed but otherwise faithful entries from a real GET /v1/models answer
// (2026-11): DeepSeek takes reasoning efforts none/low/high/max, GLM requires
// reasoning (no "none"), both take images and tools.
const CATALOG_DEEPSEEK = {
  id: "deepseek/deepseek-v4.1-flash",
  name: "DeepSeek: DeepSeek V4.1 Flash",
  is_ready: true,
  input_modalities: [
    {
      type: "text",
      supported_inputs: { max_context_length: { value: 1048568, unit: "token" } },
      pricing: [
        { type: "prompt", unit: "token", cost_usd: "0.00000006" },
        { type: "cached_prompt", unit: "token", cost_usd: "0.000000003" },
      ],
    },
    { type: "image" },
  ],
  output_modalities: [
    {
      type: "text",
      max_length: { value: 384000, unit: "token" },
      streaming: true,
      supported_parameters: {
        tools: { type: "boolean" },
        reasoning: { type: "boolean" },
        reasoning_effort: { type: "enum", values: ["none", "low", "high", "max"] },
      },
      pricing: [{ type: "completion", unit: "token", cost_usd: "0.00000024" }],
    },
  ],
}

const CATALOG_GLM = {
  id: "z-ai/glm-5.3-flash",
  name: "Z.ai: GLM 5.3 Flash",
  is_ready: true,
  input_modalities: [
    {
      type: "text",
      supported_inputs: { max_context_length: { value: 1048576, unit: "token" } },
      pricing: [
        { type: "prompt", unit: "token", cost_usd: "0.00000012" },
        { type: "cached_prompt", unit: "token", cost_usd: "0.000000024" },
      ],
    },
    { type: "image" },
  ],
  output_modalities: [
    {
      type: "text",
      max_length: { value: 131072, unit: "token" },
      streaming: true,
      supported_parameters: {
        tools: { type: "boolean" },
        reasoning: { type: "boolean", default: true },
        reasoning_effort: { type: "enum", values: ["low", "high", "max"] },
      },
      pricing: [{ type: "completion", unit: "token", cost_usd: "0.0000004" }],
    },
  ],
}

function jsonRes(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fakeFetch(calls, handler) {
  calls.handler = handler
  return async (input, init) => {
    calls.push({ input: String(input), init })
    return calls.handler(calls.length - 1, input, init)
  }
}

const auth = { type: "api", key: "sk-openscale-test" }

describe("config", () => {
  test("declares the openscale provider with bootstrap models and keeps a configured one", async () => {
    const plugin = await createPlugin()
    const cfg = { provider: { openscale: { name: "Mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider.openscale.name).toBe("Mine")
    const fresh = {}
    await plugin.config(fresh)
    const p = fresh.provider.openscale
    expect(p.name).toBe("OpenScale")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(BASE)
    expect(Object.keys(p.models)).toEqual(Object.keys(BOOTSTRAP))
    expect(p.models["deepseek/deepseek-v4.1-flash"].limit).toEqual({ context: 1048568, output: 384000 })
    expect(p.models["deepseek/deepseek-v4.1-flash:fast"].cost).toEqual({ input: 0.28, cache_read: 0.028, output: 1.1 })
  })
  test("clones the bootstrap table so callers cannot mutate it", async () => {
    const plugin = await createPlugin()
    const cfg = {}
    await plugin.config(cfg)
    cfg.provider.openscale.models["deepseek/deepseek-v4.1-flash"].limit.context = 1
    expect(BOOTSTRAP["deepseek/deepseek-v4.1-flash"].limit.context).toBe(1048568)
  })
})

describe("auth", () => {
  test("offers an api key sign-in", async () => {
    const plugin = await createPlugin()
    expect(plugin.auth.provider).toBe("openscale")
    expect(plugin.auth.methods).toEqual([{ type: "api", label: "OpenScale API key", placeholder: "sk-openscale-…" }])
  })
  test("maps an api account to the base URL and key", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => auth)).toEqual({ baseURL: BASE, apiKey: "sk-openscale-test" })
  })
  test("loads nothing without an account", async () => {
    const plugin = await createPlugin()
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })
})

describe("usage", () => {
  test("reports the sign-in state on success", async () => {
    const calls = []
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls, () => jsonRes(200, { object: "list", data: CATALOG_DEEPSEEK })) })
    const u = await plugin.auth.usage(async () => auth)
    expect(u).toEqual({ plan: "OpenScale", windows: [] })
    expect(calls[0].input).toBe(`${BASE}/models`)
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-openscale-test")
  })
  test("marks an expired key", async () => {
    const plugin = createPlugin({ fetchImpl: async () => jsonRes(401) })
    const u = await plugin.auth.usage(async () => auth)
    expect(u.signIn).toBe("expired")
    expect(u.error).toContain("401")
    expect(u.windows).toEqual([])
  })
  test("reports network failures without throwing", async () => {
    const plugin = createPlugin({ fetchImpl: async () => { throw new Error("no route") } })
    const u = await plugin.auth.usage(async () => auth)
    expect(u.error).toContain("OpenScale unreachable")
    expect(u.windows).toEqual([])
  })
})

describe("provider.models", () => {
  test("builds rows from the live catalog: limits, prices, images, tools and effort variants", async () => {
    const plugin = createPlugin({ fetchImpl: async () => jsonRes(200, { object: "list", data: [CATALOG_DEEPSEEK, CATALOG_GLM] }) })
    const models = await plugin.provider.models({ models: BOOTSTRAP }, { auth })
    expect(Object.keys(models).sort()).toEqual(["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash"])
    const ds = models["deepseek/deepseek-v4.1-flash"]
    expect(ds.name).toBe("DeepSeek V4.1 Flash")
    expect(ds.limit).toEqual({ context: 1048568, output: 384000 })
    expect(ds.cost).toEqual({ input: 0.06, cache_read: 0.003, output: 0.24 })
    expect(ds.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    expect(ds.tool_call).toBe(true)
    expect(ds.variants).toEqual({ none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } })
    const glm = models["z-ai/glm-5.3-flash"]
    expect(glm.variants).toEqual({ low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } })
    expect(glm.reasoning).toBe(true)
    expect(glm.limit).toEqual({ context: 1048576, output: 131072 })
  })
  test("keeps the previous list without an account, on server errors and on network failures", async () => {
    const previous = { models: BOOTSTRAP }
    const plugin = await createPlugin()
    expect(await plugin.provider.models(previous, {})).toBe(previous.models)
    expect(await plugin.provider.models(previous, { auth: { type: "oauth" } })).toBe(previous.models)
    const http500 = createPlugin({ fetchImpl: async () => jsonRes(500) })
    expect(await http500.provider.models(previous, { auth })).toBe(previous.models)
    const offline = createPlugin({ fetchImpl: async () => { throw new Error("no route") } })
    expect(await offline.provider.models(previous, { auth })).toBe(previous.models)
  })
  test("marks an expired key and keeps the previous list on malformed answers", async () => {
    const previous = { models: BOOTSTRAP }
    const refused = createPlugin({ fetchImpl: async () => jsonRes(403) })
    await expect(refused.provider.models(previous, { auth })).rejects.toMatchObject({ signIn: "expired" })
    const garbage = createPlugin({ fetchImpl: async () => jsonRes(200, { object: "list" }) })
    await expect(garbage.provider.models(previous, { auth })).rejects.toThrow("no model catalog")
    const broken = createPlugin({ fetchImpl: async () => jsonRes(200, { data: [{ id: "ok" }, {}] }) })
    await expect(broken.provider.models(previous, { auth })).rejects.toThrow("no model catalog")
    const empty = createPlugin({ fetchImpl: async () => jsonRes(200, { object: "list", data: [{ ...CATALOG_DEEPSEEK, is_ready: false }] }) })
    await expect(empty.provider.models(previous, { auth })).rejects.toThrow("no ready models")
  })
})

describe("internals", () => {
  test("perMillion converts per-token prices to per-million numbers", () => {
    expect(perMillion("0.00000006")).toBe(0.06)
    expect(perMillion("0.000000003")).toBe(0.003)
    expect(perMillion("0.0000011")).toBe(1.1)
    expect(perMillion("0")).toBeUndefined()
    expect(perMillion("abc")).toBeUndefined()
    expect(perMillion(undefined)).toBeUndefined()
  })
  test("display strips the vendor prefix and falls back to the id", () => {
    expect(display({ name: "DeepSeek: DeepSeek V4.1 Flash", id: "deepseek/deepseek-v4.1-flash" })).toBe("DeepSeek V4.1 Flash")
    expect(display({ id: "z-ai/glm-5.3-flash" })).toBe("z-ai/glm-5.3-flash")
  })
  test("rowFromCatalog reads a text-only model as text-only", () => {
    const textOnly = {
      id: "qwen/qwen3.8",
      name: "Qwen: Qwen 3.8",
      is_ready: true,
      input_modalities: [{ type: "text", supported_inputs: { max_context_length: { value: 262144 } }, pricing: [{ type: "prompt", cost_usd: "0.0000001" }] }],
      output_modalities: [{ type: "text", max_length: { value: 65536 }, supported_parameters: {}, pricing: [{ type: "completion", cost_usd: "0.0000005" }] }],
    }
    const r = rowFromCatalog(textOnly)
    expect(r).toEqual({
      id: "qwen/qwen3.8",
      name: "Qwen 3.8",
      limit: { context: 262144, output: 65536 },
      reasoning: false,
      tool_call: false,
      modalities: { input: ["text"], output: ["text"] },
      capabilities: { reasoning: false, toolcall: false, attachment: false, input: { text: true, image: false }, output: { text: true } },
      cost: { input: 0.1, output: 0.5 },
    })
  })
  test("rowsFromCatalog drops entries that are not ready and throws on malformed answers", () => {
    const rows = rowsFromCatalog({ object: "list", data: [CATALOG_DEEPSEEK, { ...CATALOG_GLM, is_ready: false }] })
    expect(Object.keys(rows)).toEqual(["deepseek/deepseek-v4.1-flash"])
    expect(() => rowsFromCatalog({ data: "nope" })).toThrow("no model catalog")
  })
  test("row omits empty variants and cost", () => {
    const r = row("x", "X", {})
    expect("variants" in r).toBe(false)
    expect("cost" in r).toBe(false)
    expect(r.limit).toEqual({ context: 0, output: 0 })
  })
})

describe("entry", () => {
  test("exports a single plugin function", async () => {
    expect(typeof OpenscalePlugin).toBe("function")
    const plugin = await OpenscalePlugin()
    expect(typeof plugin.config).toBe("function")
    expect(plugin.auth.provider).toBe("openscale")
    expect(plugin.provider.id).toBe("openscale")
  })
})
