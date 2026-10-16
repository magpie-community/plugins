import { expect, test } from "bun:test"
import { buildModel, catalogMetadata, mergeCatalog, normalizeThinking } from "./models.mjs"

const BASE = "https://api.modelverse.cn/v1"
const rate = (item, price, currency = "CNY", unit = "Million Tokens") => ({ ChargeItem: item, Price: price, Currency: currency, Unit: "百万 Token", UnitEn: unit })
const row = (rates, condition = "默认") => ({ id: "fixture-model", pricing: [{ Condition: condition, Description: "默认", DescriptionEn: "Default", Rates: rates }] })

test("isolates public protocol IDs while preserving the upstream ID and SDK", () => {
  for (const [protocol, npm] of Object.entries({ chat: "@ai-sdk/openai-compatible", responses: "@ai-sdk/openai", anthropic: "@ai-sdk/anthropic", gemini: "@ai-sdk/google" })) {
    const model = buildModel({ id: "fixture", displayName: "Fixture" }, BASE, protocol)
    expect(model.id).toBe(protocol === "chat" ? "fixture" : `fixture@${protocol}`)
    expect(model.api).toEqual({ id: "fixture", url: BASE, npm })
    expect(model.name).toStartWith("Fixture")
  }
  expect(() => buildModel({ id: "__proto__" }, BASE)).toThrow("invalid model")
  expect(() => buildModel({ id: "fixture" }, BASE, "invalid")).toThrow("supported API")
})

test("unknown vendor or future IDs do not inherit vision, reasoning or context", () => {
  for (const id of ["deepseek-v4.1-flash", "gemini-future", "claude-future", "zai-org/glm-4.6v", "custom-vision"]) {
    const model = buildModel({ id }, BASE)
    expect(model.limit).toEqual({ context: 0, output: 0 })
    expect(model.capabilities.input).toEqual({ text: true })
    expect(model.capabilities.reasoning).toBe(false)
    expect(model.variants).toEqual({})
    expect(model.free).toBeUndefined()
  }
})

test("live capabilities and valid numeric limits take precedence over examples", () => {
  const model = buildModel({ id: "claude-sonnet-4-5-20250929", limit: { context: 64000, output: 4096 }, modalities: { input: ["text", "image"] }, capabilities: { input: { image: false }, reasoning: true, toolcall: false, temperature: false } }, BASE, "anthropic")
  expect(model.limit).toEqual({ context: 64000, output: 4096 })
  expect(model.capabilities).toMatchObject({ input: { text: true, image: false }, reasoning: true, toolcall: false, temperature: false, attachment: false })
  const invalid = buildModel({ id: "fixture", MaxModelLen: -1, max_output_tokens: "100", limit: { context: Infinity, output: 1.5 } }, BASE)
  expect(invalid.limit).toEqual({ context: 0, output: 0 })
})

test("Gemini native rows preserve input/output limits and documented media support", () => {
  const model = buildModel({ name: "models/gemini-3-flash-preview", baseModelId: "gemini-3-flash-preview", displayName: "Gemini 3 Flash", inputTokenLimit: 128000, outputTokenLimit: 8192 }, "https://api.modelverse.cn/v1beta", "gemini")
  expect(model.api.id).toBe("gemini-3-flash-preview")
  expect(model.limit).toEqual({ context: 0, input: 128000, output: 8192 })
  expect(model.capabilities.input).toEqual({ text: true, image: true, audio: true, video: true, pdf: true })
  expect(buildModel({ id: "gemini-3-flash-preview" }, BASE, "chat").capabilities.input).toEqual({ text: true })
  expect(buildModel({ id: "gemini-future", thinking: true }, BASE, "gemini").capabilities.reasoning).toBe(true)
  expect(buildModel({ id: "gemini-future", thinking: "true" }, BASE, "gemini").capabilities.reasoning).toBe(false)
})

test("only documented chat models expose the portable thinking picker", () => {
  for (const id of ["deepseek-ai/DeepSeek-V3.1", "deepseek-ai/DeepSeek-V3.1-Terminus", "deepseek-ai/DeepSeek-V3.2", "ByteDance/doubao-seed-1.6"]) {
    const model = buildModel({ id }, BASE)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.variants).toEqual({ none: { reasoningEffort: "none" }, high: { reasoningEffort: "high" } })
    expect(buildModel({ id }, BASE, "responses").variants).toEqual({})
  }
  expect(buildModel({ id: "deepseek-ai/DeepSeek-V3.2", reasoning: false }, BASE).variants).toEqual({})
})

test("thinking translation preserves tools, messages and explicit upstream switches", () => {
  const original = { model: "deepseek-ai/DeepSeek-V3.2", reasoning_effort: "high", messages: [], tools: [{ type: "function" }], chat_template_kwargs: { other: 123 } }
  const changed = normalizeThinking(original)
  expect(changed).toEqual({ model: original.model, messages: [], tools: original.tools, chat_template_kwargs: { other: 123, thinking: true } })
  expect(changed.tools).toBe(original.tools)
  expect(original.reasoning_effort).toBe("high")
  expect(normalizeThinking({ ...original, reasoning_effort: "none", chat_template_kwargs: { thinking: true } }).chat_template_kwargs).toEqual({ thinking: true })
  expect(normalizeThinking({ model: "deepseek-ai/DeepSeek-V3.1", reasoningEffort: "none" }).thinking).toEqual({ type: "disabled" })
  expect(normalizeThinking({ model: "ByteDance/doubao-seed-1.6", reasoning_effort: "auto" }).thinking).toEqual({ type: "auto" })
  expect(normalizeThinking({ model: "ByteDance/doubao-seed-1.6", reasoning_effort: "high", thinking: { type: "disabled" } }).thinking).toEqual({ type: "disabled" })
  for (const body of [{ model: "future", reasoning_effort: "high" }, { model: original.model, reasoning_effort: "unsupported" }, null, []]) expect(normalizeThinking(body)).toBe(body)
})

test("preserves CNY tiers, cache TTLs, storage and audio prices outside request options", () => {
  const data = row([rate("input", "1.25"), rate("cache_read_tokens", 0.1), rate("cache_create_5m_tokens", 2), rate("cache_create_1h_tokens", 3), rate("cache_storage", 0.5, "CNY", "Million Tokens / Hour"), rate("input_audio_tokens", 12)])
  data.pricing.push({ Condition: "context>200k", Rates: [rate("input", 2.5)] })
  const metadata = catalogMetadata(data)
  expect(metadata.pricing).toHaveLength(2)
  expect(metadata.pricing[0].rates.map((r) => r.kind)).toEqual(["input", "cache_read", "cache_write_5m", "cache_write_1h", "cache_storage", "other"])
  expect(metadata.pricing[0].rates[0]).toMatchObject({ currency: "CNY", price: 1.25, priceText: "1.25", unit: "百万 Token", unitEn: "Million Tokens" })
  expect(metadata.pricing[1].condition).toBe("context>200k")
  const model = buildModel(data, BASE)
  expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  expect(model.options).toEqual({})
  expect(model.headers).toEqual({})
  expect(model.free).toBeUndefined()
})

test("maps only unambiguous USD token rates into USD per million costs", () => {
  const model = buildModel(row([rate("input", "0.001", "USD", "Thousand Tokens"), rate("output", 2, "USD"), rate("cache_read", 0.05, "USD"), rate("cache_write", 1, "USD")]), BASE)
  expect(model.cost).toEqual({ input: 1, output: 2, cache: { read: 0.05, write: 1 } })
  const tiered = row([rate("input", 1, "USD")], "context <= 32k")
  expect(buildModel(tiered, BASE).cost.input).toBe(0)
  expect(buildModel(row([rate("input", 1, "USD", "Requests")]), BASE).cost.input).toBe(0)
  expect(buildModel(row([rate("input", 1, "USD"), rate("input_text_tokens", 2, "USD")]), BASE).cost.input).toBe(0)
  expect(buildModel(row([rate("cache_create_5m_tokens", 1, "USD")]), BASE).cost.cache.write).toBe(0)
})

test("malformed pricing does not become zero-price or enter SDK parameters", () => {
  const data = row([rate("input", ""), rate("output", null), rate("input", -2), rate("input", "NaN"), rate("output", Infinity), rate("output", 0, "USD")])
  expect(catalogMetadata(data).pricing[0].rates).toHaveLength(1)
  expect(catalogMetadata({ pricing: [null, { Rates: null }, { Rates: [null] }] }).pricing).toEqual([{ condition: "", description: "", descriptionEn: "", rates: [] }])
  expect(catalogMetadata({}).pricing).toEqual([])
})

test("joins live square metadata without replacing inference IDs or primary values", () => {
  const list = [{ Id: "umodel-square", Name: "Actual", Aliases: ["alias"], MaxModelLen: 128000, ApiProtocols: { ChatCompletions: true, Gemini: false }, ModelCapabilities: { FunctionCall: false, StructuredOutput: true }, SupportedCapabilities: ["unknown-feature"], Tiers: [{ Condition: "Default", Rates: [rate("input", 1)] }] }]
  const merged = mergeCatalog({ id: "alias", limit: { context: 32000, output: 4096 } }, list)
  expect(merged.id).toBe("alias")
  expect(buildModel(merged, BASE).api.id).toBe("alias")
  expect(buildModel(merged, BASE).limit).toEqual({ context: 32000, output: 4096 })
  expect(buildModel(merged, BASE).capabilities.toolcall).toBe(false)
  expect(catalogMetadata(merged)).toMatchObject({ protocols: { chat: true, gemini: false }, features: { FunctionCall: false, StructuredOutput: true }, supportedCapabilities: ["unknown-feature"] })
  expect(mergeCatalog({ id: "unlisted" }, list)).toEqual({ id: "unlisted" })
  expect(buildModel(mergeCatalog({ id: "Actual" }, list), BASE).limit.context).toBe(128000)
  const primary = row([rate("input", 3, "USD")])
  primary.id = "alias"
  expect(buildModel(mergeCatalog(primary, list), BASE).cost.input).toBe(3)
})
