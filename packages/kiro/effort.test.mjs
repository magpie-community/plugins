import { test, expect, afterEach } from "bun:test"
import { _internal } from "./index.mjs"

// Claude Code's levels are low, medium, high, xhigh and max: a thinking
// model offers each, so xhigh isn't routed as max (#120)
test("a thinking model offers xhigh as its own level", () => {
  const m = { id: "claude-opus-5.5", name: "Claude Opus 5.5", context: 200000 }
  for (const got of [_internal.configModel(m), _internal.runtimeModel(m)]) {
    expect(Object.keys(got.variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(got.variants.xhigh).toEqual({ thinking: { type: "enabled", budgetTokens: 50000 } })
  }
  expect(_internal.thinking({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } }, "claude-opus-5.5")).toBe(50000)
  // a model that doesn't think offers none
  expect(_internal.configModel({ id: "deepseek-3.2", name: "DeepSeek" }).variants).toBeUndefined()
})

// #538 (zengxiaosong): Claude Code sends adaptive thinking with its level
// in output_config.effort, and xhigh and max both became one 50000
// <max_thinking_length>. A model whose Kiro list says it takes the effort
// as a field (additionalModelRequestFieldsSchema, read as Kiro IDE reads
// it) is sent each level there instead, and no budget; any other model is
// sent the budget as before.
const OPUS_SCHEMA = {
  type: "object",
  properties: {
    thinking: { type: "object", properties: { type: { type: "string", enum: ["adaptive", "disabled"] } } },
    output_config: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] } } },
  },
}
const listed = (models) => {
  const was = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname !== "/List-Available-Models") throw new Error("no network in tests")
    return Response.json({ defaultModel: { modelId: "auto" }, models })
  }
  return _internal.listModels({ region: "us-east-1", token: "t", tokenType: "", profile: "arn:aws:codewhisperer:us-east-1:1:profile/P" })
    .finally(() => (globalThis.fetch = was))
}
const model = (modelId, schema) => ({ modelId, modelName: modelId, tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 },
  additionalModelRequestFieldsSchema: schema })
afterEach(() => listed([model("claude-opus-5.5", null), model("claude-sonnet-4.5", null)]))

// the reporter's repro, as written in #538
const repro = (model, effort) => {
  const req = {
    model, system: "SESSION_INSTRUCTIONS",
    thinking: { type: "adaptive" }, output_config: { effort },
    messages: [
      { role: "user", content: "USER_QUESTION" },
      { role: "system", content: "ENV_CONTEXT", output_config: { effort } },
    ],
  }
  return JSON.parse(_internal.buildKiro(req, model, "", _internal.thinking(req, model)))
}
const said = (body) => [...(body.conversationState.history ?? []).map((e) => e.userInputMessage?.content ?? e.assistantResponseMessage?.content),
  body.conversationState.currentMessage.userInputMessage.content].join("\n")

test("a model Kiro lists with effort fields is sent xhigh and max as two levels, with no budget", async () => {
  await listed([model("claude-opus-5.5", OPUS_SCHEMA), model("claude-sonnet-4.5", null)])
  const bodies = {}
  for (const effort of ["xhigh", "max"]) {
    const body = repro("claude-opus-5.5", effort)
    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, output_config: { effort } })
    expect(said(body)).not.toContain("max_thinking_length")
    expect(said(body)).not.toContain("thinking_mode")
    delete body.conversationState.conversationId
    bodies[effort] = JSON.stringify(body)
  }
  expect(bodies.xhigh).not.toBe(bodies.max)
  // a level the model doesn't list keeps the budget
  const req = { thinking: { type: "adaptive" }, output_config: { effort: "ultra" }, messages: [{ role: "user", content: "q" }] }
  const odd = JSON.parse(_internal.buildKiro(req, "claude-opus-5.5", "", _internal.thinking(req, "claude-opus-5.5")))
  expect(odd.additionalModelRequestFields).toBeUndefined()
  expect(said(odd)).toContain("<max_thinking_length>20000</max_thinking_length>")
  // thinking not asked for: no fields
  const off = { output_config: { effort: "low" }, messages: [{ role: "user", content: "q" }] }
  expect(JSON.parse(_internal.buildKiro(off, "claude-opus-5.5", "", _internal.thinking(off, "claude-opus-5.5"))).additionalModelRequestFields).toBeUndefined()
})

test("a model Kiro lists without effort fields keeps its budget", async () => {
  // the list a Free account got on 2026-10-31: the field there, null
  await listed([model("claude-opus-5.5", OPUS_SCHEMA), model("claude-sonnet-4.5", null)])
  for (const effort of ["xhigh", "max"]) {
    const body = repro("claude-sonnet-4.5", effort)
    expect(body.additionalModelRequestFields).toBeUndefined()
    expect(said(body)).toContain("<thinking_mode>enabled</thinking_mode><max_thinking_length>50000</max_thinking_length>")
  }
  // a schema with effort levels but no adaptive thinking isn't taken as one
  const noAdaptive = { properties: { output_config: OPUS_SCHEMA.properties.output_config } }
  await listed([model("claude-opus-5.5", noAdaptive)])
  expect(repro("claude-opus-5.5", "max").additionalModelRequestFields).toBeUndefined()
  // reasoning.effort, the schema's other place for it, as the IDE reads it
  await listed([model("claude-opus-5.5", { properties: { thinking: OPUS_SCHEMA.properties.thinking, reasoning: OPUS_SCHEMA.properties.output_config } })])
  expect(repro("claude-opus-5.5", "max").additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, reasoning: { effort: "max" } })
})

// #538 (zengxiaosong): thinking is asked for by the thinking object alone.
// An effort with no thinking (Claude Code's title requests, or its turn with
// thinking off), or with thinking disabled, was sent a budget, or adaptive
// thinking at that level, for every effort above low.
test("an effort without thinking asked for is sent no thinking, at every level", async () => {
  for (const schema of [OPUS_SCHEMA, null]) {
    await listed([model("claude-opus-5.5", schema)])
    for (const effort of ["low", "medium", "high", "xhigh", "max"])
      for (const th of [undefined, { type: "disabled" }, { type: "between_tools" }]) {
        const req = { ...(th ? { thinking: th } : {}), output_config: { effort }, messages: [{ role: "user", content: "q" }] }
        expect(_internal.thinking(req, "claude-opus-5.5")).toBe(0)
        const body = JSON.parse(_internal.buildKiro(req, "claude-opus-5.5", "", _internal.thinking(req, "claude-opus-5.5")))
        expect(body.additionalModelRequestFields).toBeUndefined()
        expect(said(body)).not.toContain("thinking_mode")
      }
  }
})

// with thinking asked for, every level, low included, reaches Kiro as itself
// when the model lists it, and as the budget otherwise
test("each level with thinking on is the field Kiro lists, or its budget", async () => {
  const budgets = { low: 10000, medium: 20000, high: 30000, xhigh: 50000, max: 50000 }
  for (const th of [{ type: "adaptive" }, { type: "enabled", budget_tokens: 12345 }])
    for (const [effort, b] of Object.entries(budgets)) {
      const req = { thinking: th, output_config: { effort }, messages: [{ role: "user", content: "q" }] }
      await listed([model("claude-opus-5.5", OPUS_SCHEMA)])
      let body = JSON.parse(_internal.buildKiro(req, "claude-opus-5.5", "", _internal.thinking(req, "claude-opus-5.5")))
      expect(body.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, output_config: { effort } })
      expect(said(body)).not.toContain("max_thinking_length")
      await listed([model("claude-opus-5.5", null)])
      body = JSON.parse(_internal.buildKiro(req, "claude-opus-5.5", "", _internal.thinking(req, "claude-opus-5.5")))
      expect(body.additionalModelRequestFields).toBeUndefined()
      expect(said(body)).toContain(`<thinking_mode>enabled</thinking_mode><max_thinking_length>${b}</max_thinking_length>`)
    }
})

test("GPT and Grok expose and send their catalog's native reasoning levels", async () => {
  for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "grok-4.7"]) {
    const levels = id.startsWith("gpt-") ? ["none", "low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh"]
    await listed([model(id, { type: "object", properties: { reasoning: { type: "object", properties: { effort: { type: "string", enum: levels, default: "high" } } } }, additionalProperties: false })])
    for (const m of [_internal.configModel({ id }), _internal.runtimeModel({ id })]) expect(Object.keys(m.variants)).toEqual(levels)
    for (const effort of levels) {
      const body = repro(id, effort)
      expect(body.additionalModelRequestFields).toEqual({ reasoning: { effort } })
      expect(_internal.responsesBody(body).reasoning).toEqual({ effort })
    }
    if (id.startsWith("gpt-")) {
      const req = { thinking: { type: "disabled" }, output_config: { effort: "high" }, messages: [{ role: "user", content: "q" }] }
      expect(JSON.parse(_internal.buildKiro(req, id, "", 0)).additionalModelRequestFields).toEqual({ reasoning: { effort: "none" } })
    }
  }
})
