// JL on magpie's Discord (droid 0.240.0, plugin 0.1.24): droid and Factory
// desktop offer Haiku 5.5, droid through magpie didn't. The cases are droid
// 0.240.0's own registry entries, saved byte for byte in testdata.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin } from "./index.mjs"

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
    "garnet-07-15": "unreleased", "atlas-07-21": "unreleased", "aster-07-15": "unreleased", inkling: "unreleased",
    // asks the user to accept Factory's high-cost terms first
    "gpt-6-astra-ultrafast": "opt-in",
    // older generations the plugin has never offered, as before
    "claude-opus-4-7": "older", "claude-opus-4-6": "older", "claude-opus-4-5-20251101": "older",
    "claude-sonnet-4-5-20250929": "older", "gpt-5.5-pro": "older", "gpt-5.4-mini": "older", "gpt-5.2": "older",
    "gpt-5.2-codex": "older", "gpt-5.1-codex-max": "older", "grok-4.5": "older", "kimi-k2.5": "older",
    "glm-5.1": "older", "glm-5": "older", "glm-4.7": "older",
    "deepseek-v4-flash-0731": "older", "deepseek-v4-pro": "older",
    // Fast Mode models whose base model isn't offered, unreleased, or
    // behind a feature flag (fast.test.mjs)
    "claude-opus-4-7-fast": "older", "claude-opus-4-6-fast": "older", "gpt-5.4-mini-fast": "older",
    "gpt-5.6-sol-fast": "unreleased", "glm-5.2-fast": "flag",
  }
  const missing = picker.filter((id) => !got[id] && !reason[id])
  expect(missing).toEqual([])
  expect(entry("gpt-6-astra-ultrafast")).toContain('explicitOptInRequirement:{kind:"high_cost"')
  expect(got["gpt-6-astra-ultrafast"]).toBeUndefined()
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
