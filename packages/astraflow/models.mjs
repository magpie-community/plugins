const PROTOCOLS = {
  chat: { label: "Chat Completions (default)", npm: "@ai-sdk/openai-compatible" },
  responses: { label: "OpenAI Responses", npm: "@ai-sdk/openai" },
  anthropic: { label: "Anthropic Messages", npm: "@ai-sdk/anthropic" },
  gemini: { label: "Google Gemini", npm: "@ai-sdk/google" },
}

// Exact IDs only: the provider's documented switches differ even within
// DeepSeek. Do not apply the original vendor's defaults to hosted aliases.
// https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/thinking/deepseek.md
// https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/thinking/doubao.md
const SWITCHES = new Map([
  ["deepseek-ai/DeepSeek-V3.1", "type"],
  ["deepseek-ai/DeepSeek-V3.1-Terminus", "type"],
  ["deepseek-ai/DeepSeek-V3.2", "template"],
  ["ByteDance/doubao-seed-1.6", "auto"],
  ["ByteDance/doubao-1.5-thinking-vision-pro", "auto"],
])

// The examples demonstrate these exact model/protocol combinations.
// https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/claude_compatible.md
// https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/gemini-media-analysis.md
// https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/gemini_compatible.md
const INPUTS = {
  "claude-sonnet-4-5-20250929": { anthropic: ["text", "image"] },
  "gemini-3-flash-preview": { gemini: ["text", "image", "audio", "video", "pdf"] },
}

const str = (v) => typeof v === "string" ? v.trim() : ""
const tokens = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0
const firstTokens = (...vs) => vs.map(tokens).find(Boolean) ?? 0
const bool = (...vs) => vs.find((v) => typeof v === "boolean")

function priceKind(item) {
  const s = str(item).toLowerCase()
  if (/image|audio|video/.test(s)) return "other"
  if (/cache/.test(s)) {
    if (/storage/.test(s)) return "cache_storage"
    if (/write|create/.test(s)) return /1h|1_hour/.test(s) ? "cache_write_1h" : /5m|5_min/.test(s) ? "cache_write_5m" : "cache_write"
    if (s === "cache" || /read|hit/.test(s)) return "cache_read"
    return "other"
  }
  if (["input", "input_text_tokens", "input_tokens", "input_token"].includes(s)) return "input"
  if (["output", "output_text_tokens", "output_tokens", "output_token"].includes(s)) return "output"
  return "other"
}

function amount(v) {
  if (typeof v !== "number" && typeof v !== "string") return null
  if (typeof v === "string" && !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v.trim())) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Keep native-currency, tier and cache-TTL information out of SDK options.
// Schema: https://github.com/ucloud/ucloud-sdk-go/blob/master/services/uai_modelverse/models.go
export function catalogMetadata(row = {}) {
  const source = Array.isArray(row.pricing) ? row.pricing : Array.isArray(row.Tiers) ? row.Tiers : []
  const tiers = source.filter((x) => x && typeof x === "object" && Array.isArray(x.Rates)).map((tier) => ({
    condition: str(tier.Condition),
    description: str(tier.Description),
    descriptionEn: str(tier.DescriptionEn),
    rates: tier.Rates.filter((x) => x && typeof x === "object" && amount(x.Price) !== null && str(x.ChargeItem)).map((rate) => ({
      chargeItem: str(rate.ChargeItem),
      kind: priceKind(rate.ChargeItem),
      price: amount(rate.Price),
      // Preserve the original decimal string for display/accounting clients.
      priceText: String(rate.Price),
      currency: str(rate.Currency).toUpperCase(),
      unit: str(rate.Unit),
      unitEn: str(rate.UnitEn),
      description: str(rate.ChargeItemDescription),
      descriptionEn: str(rate.ChargeItemDescriptionEn),
      ...(typeof rate.PricingSkuId === "number" ? { skuId: rate.PricingSkuId } : {}),
      ...(str(rate.PricingSku) ? { sku: str(rate.PricingSku) } : {}),
    })),
  }))
  return {
    pricing: tiers,
    ...(Array.isArray(row.SupportedCapabilities) ? { supportedCapabilities: row.SupportedCapabilities.filter((s) => typeof s === "string") } : {}),
    ...(row.ApiProtocols && typeof row.ApiProtocols === "object" ? {
      protocols: Object.fromEntries(Object.entries({ chat: row.ApiProtocols.ChatCompletions, responses: row.ApiProtocols.Responses, anthropic: row.ApiProtocols.Anthropic, gemini: row.ApiProtocols.Gemini }).filter(([, v]) => typeof v === "boolean")),
    } : {}),
    ...(row.ModelCapabilities && typeof row.ModelCapabilities === "object" ? {
      features: Object.fromEntries(["FunctionCall", "StructuredOutput", "ContextCaching", "BatchInference", "WebSearch", "Mcp"].filter((k) => typeof row.ModelCapabilities[k] === "boolean").map((k) => [k, row.ModelCapabilities[k]])),
    } : {}),
  }
}

function millionUnit(rate) {
  const unit = (rate.unitEn || rate.unit).toLowerCase().replace(/\s+/g, " ").trim()
  if (["million tokens", "million token", "1m tokens", "百万 token", "百万token"].includes(unit)) return 1
  if (["thousand tokens", "thousand token", "1k tokens", "千 token", "千token"].includes(unit)) return 1000
  if (["tokens", "token"].includes(unit)) return 1_000_000
  return 0
}

function usdCost(metadata) {
  const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  const simple = metadata.pricing.filter((t) => !t.condition || /^(?:default|默认)$/i.test(t.condition))
  // A scalar cannot express multiple context tiers. Unknown costs remain 0
  // (the host's sentinel); they never imply a free model.
  if (metadata.pricing.length !== 1 || simple.length !== 1) return cost
  for (const kind of ["input", "output", "cache_read", "cache_write"]) {
    const rates = simple[0].rates.filter((r) => r.kind === kind || (kind === "cache_write" && r.kind.startsWith("cache_write_")))
    if (rates.length !== 1) continue
    const r = rates[0]
    const factor = millionUnit(r)
    if (r.currency !== "USD" || !factor || (kind === "cache_write" && r.kind !== "cache_write")) continue
    const value = r.price * factor
    if (!Number.isFinite(value)) continue
    if (kind === "input" || kind === "output") cost[kind] = value
    else cost.cache[kind === "cache_read" ? "read" : "write"] = value
  }
  return cost
}

// Join catalog information only onto inference models already returned by
// the selected endpoint. A square ID must not become an upstream model ID.
export function mergeCatalog(row, catalog = []) {
  const id = str(row?.id) || str(row?.baseModelId) || str(row?.name).replace(/^models\//, "")
  const square = catalog.find((s) => s && [s.Id, s.Name, ...(Array.isArray(s.Alias) ? s.Alias : []), ...(Array.isArray(s.Aliases) ? s.Aliases : [])].some((name) => str(name).toLowerCase() === id.toLowerCase()))
  if (!square) return { ...row }
  return {
    ...square, ...row, id,
    displayName: str(row.displayName) || str(row.display_name) || str(square.DisplayName) || str(square.Name) || id,
    // Zero in the public catalog means unknown, so use a positive live
    // square limit when available. Do not use vendor catalog defaults.
    MaxModelLen: firstTokens(row.MaxModelLen, square.MaxModelLen),
    pricing: Array.isArray(row.pricing) && row.pricing.length ? row.pricing : square.Tiers,
  }
}

export function buildModel(row, baseURL, protocol = "chat") {
  const p = PROTOCOLS[protocol]
  if (!p) throw new Error("AstraFlow: choose a supported API protocol")
  if (typeof row === "string") row = { id: row }
  const id = str(row?.id) || str(row?.baseModelId) || str(row?.name).replace(/^models\//, "")
  if (!id || ["__proto__", "prototype", "constructor"].includes(id)) throw new Error("AstraFlow: invalid model id")
  const c = row.capabilities ?? {}
  const inputs = Array.isArray(row.modalities?.input) ? row.modalities.input : INPUTS[id]?.[protocol] ?? ["text"]
  const input = { text: true }
  for (const k of ["image", "audio", "video", "pdf"]) {
    const value = bool(c.input?.[k], inputs.includes(k) ? true : undefined)
    if (value !== undefined) input[k] = value
  }
  const switchable = protocol === "chat" && SWITCHES.has(id)
  const reasoning = bool(c.reasoning, row.reasoning, row.supports_thinking, row.thinking) ?? switchable
  const name = str(row.displayName) || str(row.display_name) || str(row.Name) || id
  const variants = switchable && reasoning ? { none: { reasoningEffort: "none" }, high: { reasoningEffort: "high" } } : {}
  return {
    id: protocol === "chat" ? id : `${id}@${protocol}`,
    providerID: "astraflow",
    name: protocol === "chat" ? name : `${name} (${p.label})`,
    api: { id, url: baseURL, npm: p.npm },
    limit: {
      context: firstTokens(row.limit?.context, row.context_length, row.max_context_tokens, row.MaxModelLen),
      ...(firstTokens(row.limit?.input, row.inputTokenLimit) ? { input: firstTokens(row.limit?.input, row.inputTokenLimit) } : {}),
      output: firstTokens(row.limit?.output, row.max_output_tokens, row.outputTokenLimit),
    },
    cost: usdCost(catalogMetadata(row)),
    capabilities: {
      temperature: bool(c.temperature, row.temperature) ?? true,
      reasoning,
      attachment: bool(c.attachment, row.attachment) ?? Object.entries(input).some(([k, v]) => k !== "text" && v),
      toolcall: bool(c.toolcall, row.tool_call, row.ModelCapabilities?.FunctionCall) ?? true,
      input,
      output: c.output && typeof c.output === "object" ? Object.fromEntries(Object.entries(c.output).filter(([, v]) => typeof v === "boolean")) : { text: true },
    },
    status: "active",
    options: {},
    headers: {},
    variants,
  }
}

// The standard effort is an agent/SDK transport for Magpie's picker. Only
// the documented model switches translate it into ModelVerse parameters.
// Returns the original object when untouched; never rewrites explicit
// upstream switches or invents thinking support for new model names.
export function normalizeThinking(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const mode = SWITCHES.get(body.model)
  const effort = body.reasoning_effort ?? body.reasoningEffort
  if (!mode || !["none", "high", "auto"].includes(effort) || (effort === "auto" && mode !== "auto")) return body
  const out = { ...body }
  delete out.reasoning_effort
  delete out.reasoningEffort
  if (mode === "template") {
    if (body.chat_template_kwargs?.thinking === undefined) out.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), thinking: effort !== "none" }
  } else if (body.thinking === undefined) {
    out.thinking = { type: effort === "none" ? "disabled" : effort === "auto" ? "auto" : "enabled" }
  }
  return out
}
