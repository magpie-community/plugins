// JL on magpie's Discord (droid 0.240.0, plugin 0.1.24): droid and Factory
// desktop offer Haiku 5.5, droid through magpie didn't. The cases are droid
// 0.240.0's own registry entries, saved byte for byte in testdata.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const DROID = readFileSync(new URL("./testdata/droid-0.240.0-models.txt", import.meta.url), "utf8")

// entry is a model's registry text in the fixture.
function entry(id) {
  const line = DROID.split("\n").find((l) => l.startsWith(`"${id}":{id:"${id}",`))
  if (!line) throw new Error(`${id} is not in the fixture`)
  return line
}

// limits reads an entry's context and output as the plugin states them: a
// total context for P(context, output), the input for R({…}) and te({…}).
function limits(text) {
  let m = text.match(/contextLimits:P\((\d+),(\d+)\)/)
  if (m) return { context: +m[1], output: +m[2] }
  m = text.match(/contextLimits:R\(\{maxInputTokens:(\d+),maxOutputTokens:(\d+)\}\)/)
  if (m) return { context: +m[1], output: +m[2] }
  m = text.match(/contextLimits:(\w+),/)
  const def = DROID.match(new RegExp(`^${m[1]}=te\\(\\{[^}]*maxInputTokens:(\\d+),maxOutputTokens:(\\d+)\\}\\)`, "m"))
  return { context: +def[1], output: +def[2] }
}

async function models() {
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  return cfg.provider.factory.models
}

test("Haiku 5.5 and Mistral Large 4 are offered as droid 0.240.0 has them", async () => {
  const got = await models()
  for (const id of ["claude-haiku-5-5", "mistral-large-4"]) {
    const text = entry(id)
    const m = got[id]
    expect(m).toBeDefined()
    expect(m.name).toBe(text.match(/,name:"([^"]+)"/)[1])
    expect(m.limit).toEqual(limits(text))
    // droid's "off" is the request without a level; the rest are variants
    const efforts = JSON.parse(text.match(/reasoningEffort:\{supported:(\[[^\]]*\])/)[1]).filter((e) => e !== "off")
    expect(Object.keys(m.variants)).toEqual(efforts)
  }
  expect(got["claude-haiku-5-5"].provider.npm).toBe("@ai-sdk/anthropic")
  expect(got["claude-haiku-5-5"].provider.api).toBe("https://api.factory.ai/api/llm/a/v1")
  expect(got["claude-haiku-5-5"].variants.medium).toEqual({ effort: "medium" })
  // Mistral Large 4 is on droid's generic chat completions, images on
  expect(entry("mistral-large-4")).toContain('apiModelProvider:"generic-chat-completion-api"')
  expect(entry("mistral-large-4")).toContain("images:!0")
  expect(got["mistral-large-4"].provider.npm).toBe("@ai-sdk/openai-compatible")
  expect(got["mistral-large-4"].attachment).toBe(true)
})

test("every model in droid 0.240.0's picker is offered, or left out for a reason", async () => {
  const got = await models()
  const picker = JSON.parse(DROID.match(/^var y=(\[[^\]]*\]);/m)[1])
  const reason = {
    // droid picks these itself, client side
    auto: "router", "auto-fast": "router",
    // not released (unreleased:!0) or not in the registry
    "garnet-07-15": "unreleased", "atlas-07-21": "unreleased", "aster-07-15": "unreleased",
    // asks the user to accept Factory's high-cost terms first
    "gpt-6-astra-ultrafast": "opt-in",
    // older generations the plugin has never offered, as before
    "claude-opus-4-7": "older", "claude-opus-4-6": "older", "claude-opus-4-5-20251101": "older",
    "claude-sonnet-4-5-20250929": "older", "gpt-5.5-pro": "older", "gpt-5.4-mini": "older", "gpt-5.2": "older",
    "gpt-5.2-codex": "older", "gpt-5.1-codex-max": "older", "grok-4.5": "older", "kimi-k2.5": "older",
    "glm-5.1": "older", "glm-5": "older", "glm-4.7": "older",
    "deepseek-v4-flash-0731": "older", "deepseek-v4-pro": "older",
    // Fast Mode models whose base model isn't offered (fast.test.mjs)
    "claude-opus-4-7-fast": "older", "claude-opus-4-6-fast": "older", "gpt-5.4-mini-fast": "older",
  }
  const missing = picker.filter((id) => !got[id] && !reason[id])
  expect(missing).toEqual([])
  expect(entry("gpt-6-astra-ultrafast")).toContain('explicitOptInRequirement:{kind:"high_cost"')
  expect(got["gpt-6-astra-ultrafast"]).toBeUndefined()
})

// droid 1.7.0 offers models the plugin didn't: Fable 5.2, Kimi K3.1 Pro,
// MiniMax M3.1 Flash, Beam 1.0 and more. The cases are 1.7.0's entries.
const DROID_170 = readFileSync(new URL("./testdata/droid-1.7.0-models.txt", import.meta.url), "utf8")

// entry170 is a model's 1.7.0 entry; Inkling's key is unquoted there.
function entry170(id) {
  const line = DROID_170.split("\n").find((l) => l.startsWith(`"${id}":{id:"${id}",`) || l.startsWith(`${id}:{id:"${id}",`))
  if (!line) throw new Error(`${id} is not in the fixture`)
  return line
}

const NEW_170 = ["claude-fable-5.2", "kimi-k3.1-pro", "nemotron-3.5-super", "minimax-m3.1-flash", "inkling", "muse-spark-1.2", "beam-1.0", "gpt-6-sol-fast", "gpt-6-luna-fast", "gpt-5.6-sol-fast", "glm-5.2-fast"]

test("droid 1.7.0's new models are offered as droid has them", async () => {
  const got = await models()
  for (const id of NEW_170) {
    const text = entry170(id)
    const m = got[id]
    const row = _internal.MODELS.find((r) => r.id === id)
    expect(m).toBeDefined()
    expect(m.name).toBe(text.match(/,name:"([^"]+)"/)[1])
    // Factory routes a request to the entry's first upstream
    // (x-provider-routing-source: registry_default)
    expect(row.upstream).toBe(JSON.parse(text.match(/apiProviders:(\[[^\]]*\])/)[1])[0])
    const chat = text.includes('apiModelProvider:"generic-chat-completion-api"')
    expect(m.provider.npm).toBe(chat ? "@ai-sdk/openai-compatible" : text.includes('provider:"anthropic"') ? "@ai-sdk/anthropic" : "@ai-sdk/openai")
    const g = text.match(/contextLimits:g\((\d+e\d+|\d+),(\d+)\)/)
    if (g) expect(m.limit).toEqual({ context: Number(g[1]), output: Number(g[2]) })
    // droid takes images unless an entry says images:!1
    expect(m.attachment).toBe(!text.includes("images:!1"))
    // droid's "off" is none where a model's base takes it (GLM-5.2's), else left out
    const efforts = JSON.parse(text.match(/reasoningEffort:\{supported:(\[[^\]]*\])/)[1])
    expect(Object.keys(m.variants).filter((e) => e !== "none")).toEqual(efforts.filter((e) => e !== "off" && e !== "none"))
    if (!efforts.includes("off") && !efforts.includes("none")) expect(m.variants.none).toBeUndefined()
  }
  // Fable 5.2's opt-in is the data retention terms Fable 5.1, offered, asks too
  expect(DROID_170).toContain('So={kind:"data_retention",modelFamily:"Fable",tosVersion:e4H}')
  expect(entry170("claude-fable-5.2")).toContain("explicitOptInRequirement:So,")
  expect(entry170("claude-fable-5.1")).toContain("explicitOptInRequirement:So,")
  expect(DROID_170).toContain("b=Ee({thinkingConsumesContext:!1,maxInputTokens:867000,maxOutputTokens:128000})")
  expect(entry170("claude-fable-5.2")).toContain("contextLimits:b,")
  expect(got["claude-fable-5.2"].limit).toEqual({ context: 867000, output: 128000 })
})

test("Droid Core's windows count droid 1.7.0's core pool, not Muse Spark 1.2", () => {
  for (const id of NEW_170) {
    expect(_internal.CORE.includes(id)).toBe(entry170(id).includes('billingPool:"core"'))
  }
  expect(_internal.MODELS.find((m) => m.id === "muse-spark-1.2").upstream).toBe("fireworks")
})

test("every model in droid 1.7.0's picker is offered, or left out for a reason", async () => {
  const got = await models()
  const picker = JSON.parse(DROID_170.match(/^var ee=(\[[^\]]*\]);/m)[1])
  const reason = {
    auto: "router", "auto-fast": "router",
    "garnet-07-15": "unreleased", "atlas-07-21": "unreleased", "aster-07-15": "unreleased",
    "gpt-6-astra-ultrafast": "opt-in", "gpt-6.1-sol-ultrafast": "opt-in",
    // listed only once their feature flag is on for an account
    "gpt-6.1-terra": "flag", "muse-spark-open": "flag",
    // Responses on Google: no wire of the plugin's goes there
    "muse-spark-1.3": "wire",
    "claude-opus-4-7": "older", "claude-opus-4-6": "older", "claude-opus-4-5-20251101": "older",
    "claude-sonnet-4-5-20250929": "older", "gpt-5.5-pro": "older", "gpt-5.4-mini": "older", "gpt-5.2": "older",
    "gpt-5.2-codex": "older", "gpt-5.1-codex-max": "older", "grok-4.5": "older", "kimi-k2.5": "older",
    "glm-5.1": "older", "glm-5": "older", "glm-4.7": "older",
    "deepseek-v4-flash-0731": "older", "deepseek-v4-pro": "older",
    "claude-opus-4-7-fast": "older", "claude-opus-4-6-fast": "older", "gpt-5.4-mini-fast": "older",
  }
  expect(picker.filter((id) => !got[id] && !reason[id])).toEqual([])
  expect(Object.keys(reason).filter((id) => got[id])).toEqual([])
  expect(entry170("gpt-6.1-sol-ultrafast")).toContain('explicitOptInRequirement:{kind:"high_cost"')
  expect(entry170("gpt-6.1-terra")).toContain("featureFlag:k.Gpt61Terra,")
  expect(entry170("muse-spark-open")).toContain("featureFlag:k.MuseSparkOpen,")
  expect(entry170("muse-spark-1.3")).toContain('apiEndpoint:"responses",apiProviders:["google"]')
})

// yetone/magpie#2080: droid 0.241.1 offers Gemini 4 Argon; the plugin
// offered no Gemini at all. The cases are droid 0.241.1's entries.
const DROID_241 = readFileSync(new URL("./testdata/droid-0.241.1-gemini.txt", import.meta.url), "utf8")

test("droid 0.241.1's Gemini models are offered on Factory's Gemini route, as droid has them", async () => {
  const got = await models()
  const picker = JSON.parse(DROID_241.match(/^var y=(\[[^\]]*\]);/m)[1])
  const gemini = picker.filter((id) => id.startsWith("gemini-"))
  expect(gemini).toEqual(["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview"])
  // I(total, output) states the total context, as P does in 0.240.0
  expect(DROID_241).toContain("function I(o,t){return O({maxInputTokens:o-t,maxOutputTokens:t})}")
  for (const id of gemini) {
    const text = DROID_241.split("\n").find((l) => l.startsWith(`"${id}":{id:"${id}",`))
    const m = got[id]
    expect(m).toBeDefined()
    expect(text).toContain('provider:"google"')
    expect(m.name).toBe(text.match(/,name:"([^"]+)"/)[1])
    const [, context, output] = text.match(/contextLimits:[Ik]\((\d+e\d+|\d+),(\d+)\)/)
    expect(m.limit).toEqual({ context: Number(context), output: Number(output) })
    expect(Object.keys(m.variants)).toEqual(JSON.parse(text.match(/reasoningEffort:\{supported:(\[[^\]]*\])/)[1]))
    // droid takes images unless an entry says images:!1
    expect(text).not.toContain("images:!1")
    expect(m.attachment).toBe(true)
    expect(m.provider).toEqual({ npm: "@ai-sdk/google", api: "https://api.factory.ai/api/llm/g/v1" })
  }
  expect(got["gemini-4-argon"].variants.high).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } })
})

const DROID_251 = readFileSync(new URL("./testdata/droid-0.251.0-deepseek-1017.txt", import.meta.url), "utf8")

test("DeepSeek V4.1 Flash 1017 reaches both model hooks as droid 0.251.0 has it", async () => {
  const id = "deepseek-v4.1-flash-1017"
  const text = DROID_251.split("\n").find((l) => l.startsWith(`"${id}":{id:"${id}",`))
  expect(text).toContain('apiModelProvider:"generic-chat-completion-api"')
  expect(text).toContain('apiProviders:["fireworks","baseten","databricks"]')
  expect(text).toContain("images:!0")
  expect(DROID_251).toContain("function c(o,t){return R({maxInputTokens:o-t,maxOutputTokens:t})}")
  const [, context, output] = text.match(/contextLimits:c\((\d+),(\d+)\)/)
  const efforts = JSON.parse(text.match(/reasoningEffort:\{supported:(\[[^\]]*\])/)[1]).map((e) => e === "off" ? "none" : e)
  const variants = Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }]))
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const config = (await models())[id]
  const provider = (await hooks.provider.models({ id: "factory" }, {}))[id]
  for (const m of [config, provider]) {
    expect(m).toBeDefined()
    expect(m.id).toBe(id)
    expect(m.name).toBe(text.match(/,name:"([^"]+)"/)[1])
    expect(m.limit).toEqual({ context: Number(context), output: Number(output) })
    expect(m.variants).toEqual(variants)
    expect(m.rate).toBe(Number(text.match(/cost:\{tokenMultiplier:([\d.]+)/)[1]))
    expect(m.rateWas).toBe(0)
  }
  expect(config.provider).toEqual({ npm: "@ai-sdk/openai-compatible", api: "https://api.factory.ai/api/llm/o/v1" })
  expect(config.attachment).toBe(true)
  expect(config.modalities.input).toEqual(["text", "image"])
  expect(provider.providerID).toBe("factory")
  expect(provider.api).toEqual({ id, url: config.provider.api, npm: config.provider.npm })
  expect(provider.capabilities.attachment).toBe(true)
  expect(provider.capabilities.input.image).toBe(true)
})
