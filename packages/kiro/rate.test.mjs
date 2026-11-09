import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

// Discord (01huadalang, 11-09): "kiro 加上积分倍率消耗". Kiro charges each
// model at its own credit rate and says it in List-Available-Models
// (rateMultiplier, rateUnit). The fixture is a Free account's answer on
// 11-09, byte for byte for claude-sonnet-4.5 and the default model; the
// other models keep only the fields this reads.
const SONNET = {"additionalModelRequestFieldsSchema":null,"availableOrigins":null,"consentDescription":null,"consentStatus":null,"description":"Claude Sonnet 4.5 model","disclaimers":null,"modelId":"claude-sonnet-4.5","modelName":"claude-sonnet-4.5","modelProvider":null,"promptCaching":{"maximumCacheCheckpointsPerRequest":4,"minimumTokensPerCacheCheckpoint":1024,"supportsPromptCaching":true},"rateMultiplier":1.3,"rateUnit":"Credit","refusalFallbackModels":null,"status":null,"supportedInputTypes":["TEXT","IMAGE"],"termsUrl":null,"tokenLimits":{"maxInputTokens":200000,"maxOutputTokens":64000}}
const DEFAULT = {"additionalModelRequestFieldsSchema":null,"availableOrigins":null,"consentDescription":null,"consentStatus":null,"description":null,"disclaimers":null,"modelId":"auto","modelName":null,"modelProvider":null,"promptCaching":null,"rateMultiplier":null,"rateUnit":null,"refusalFallbackModels":null,"status":null,"supportedInputTypes":null,"termsUrl":null,"tokenLimits":null}
const rated = (modelId, rateMultiplier, rateUnit = "Credit") => ({ modelId, modelName: modelId, rateMultiplier, rateUnit,
  tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } })
const MODELS = [rated("auto", 1), SONNET, rated("claude-haiku-4.5", 0.4), rated("deepseek-3.2", 0.25), rated("minimax-m2.5", 0.25),
  rated("minimax-m2.1", 0.15), rated("glm-5", 0.5), rated("qwen3-coder-next", 0.05)]

const listed = async (models) => {
  const was = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname !== "/List-Available-Models") throw new Error("no network in tests")
    return Response.json({ defaultModel: DEFAULT, models, nextToken: null })
  }
  try {
    return await _internal.listModels({ region: "us-east-1", token: "t", tokenType: "", profile: "arn:aws:codewhisperer:us-east-1:1:profile/P" })
  } finally {
    globalThis.fetch = was
  }
}

test("each model carries the credit multiplier Kiro lists for it", async () => {
  const list = await listed(MODELS)
  expect(Object.fromEntries(list.map((m) => [m.id, m.rate]))).toEqual({
    auto: 1, "claude-sonnet-4.5": 1.3, "claude-haiku-4.5": 0.4, "deepseek-3.2": 0.25, "minimax-m2.5": 0.25,
    "minimax-m2.1": 0.15, "glm-5": 0.5, "qwen3-coder-next": 0.05,
  })
  // magpie reads it as m.rate on the account's list and on the config's
  const sonnet = list.find((m) => m.id === "claude-sonnet-4.5")
  expect(_internal.runtimeModel(sonnet).rate).toBe(1.3)
  expect(_internal.configModel(sonnet).rate).toBe(1.3)
})

test("no rate is shown where Kiro gives none, or gives it in another unit", async () => {
  const list = await listed([{ ...SONNET, rateMultiplier: null, rateUnit: null }, rated("glm-5", 0.5, "Request"), rated("deepseek-3.2", "0.25"),
    rated("minimax-m2.1", 0), rated("qwen3-coder-next", -1), rated("claude-haiku-4.5", 0.4, "CREDIT")])
  for (const m of list) {
    if (m.id === "claude-haiku-4.5") continue
    expect(m.rate).toBeUndefined()
    expect("rate" in _internal.runtimeModel(m)).toBe(false)
    expect("rate" in _internal.configModel(m)).toBe(false)
  }
  // the unit's case is Kiro's to choose
  expect(list.find((m) => m.id === "claude-haiku-4.5").rate).toBe(0.4)
})
