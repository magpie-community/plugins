// plugins#1365: Kiro ends one turn at about 16k output tokens. The effort
// budgets of 20k–50k spent that turn in thinking and stopped max_tokens
// with no text and no tool call. A catalog that omits maxOutputTokens made
// limit.output 0, and magpie then reported max_output_tokens 1048576.
import { test, expect, afterEach } from "bun:test"
import { _internal } from "./index.mjs"

const { thinking, buildKiro, configModel, runtimeModel, listModels } = _internal

// The cap the issue measured, and the room an answer and a tool call need
// inside it. Literals, not the plugin's own formula.
const TURN = 16384
const ROOM = 4096
const THINK = TURN - ROOM // 12288

const said = (body) => [...(body.conversationState.history ?? []).map((e) => e.userInputMessage?.content ?? e.assistantResponseMessage?.content),
  body.conversationState.currentMessage.userInputMessage.content].join("\n")
const injected = (req, model) => {
  const budget = thinking(req, model)
  return said(JSON.parse(buildKiro(req, model, "", budget)))
}
const lengthOf = (text) => {
  const m = text.match(/<max_thinking_length>(\d+)<\/max_thinking_length>/)
  return m ? Number(m[1]) : 0
}
const ask = (effort, extra = {}) => ({ thinking: { type: "enabled" }, ...(effort ? { output_config: { effort } } : {}), messages: [{ role: "user", content: "q" }], ...extra })

test("high, xhigh and max thinking stay inside one Kiro turn and leave room for the answer", () => {
  for (const effort of ["medium", "high", "xhigh", "max"]) {
    const req = ask(effort)
    const budget = thinking(req, "claude-opus-5.5")
    expect(budget).toBe(THINK)
    expect(budget).toBeLessThan(TURN)
    expect(TURN - budget).toBeGreaterThanOrEqual(ROOM)
    expect(lengthOf(injected(req, "claude-opus-5.5"))).toBe(THINK)
  }
  // low already fitted under the cap, and stays the level it was
  const low = ask("low")
  expect(thinking(low, "claude-opus-5.5")).toBe(10000)
  expect(lengthOf(injected(low, "claude-opus-5.5"))).toBe(10000)
  for (const got of [configModel({ id: "claude-opus-5.5", name: "Claude Opus 5.5" }), runtimeModel({ id: "claude-opus-5.5", name: "Claude Opus 5.5" })]) {
    expect(got.variants.low.thinking.budgetTokens).toBe(10000)
    expect(got.variants.medium.thinking.budgetTokens).toBe(THINK)
    expect(got.variants.high.thinking.budgetTokens).toBe(THINK)
    expect(got.variants.xhigh.thinking.budgetTokens).toBe(THINK)
    expect(got.variants.max.thinking.budgetTokens).toBe(THINK)
  }
})

test("a model that advertises an output cap keeps it, and one that doesn't is told Kiro's turn", () => {
  const advertised = { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", context: 200000, output: 64000 }
  expect(configModel(advertised).limit.output).toBe(64000)
  expect(runtimeModel(advertised).limit.output).toBe(64000)
  // a large advertised cap is not the per-turn cap: thinking still fits in one turn
  const req = ask("xhigh")
  expect(thinking(req, "claude-sonnet-4.5")).toBe(THINK)
  for (const missing of [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", context: 200000 },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", context: 200000, output: 0 },
    { id: "auto", name: "Auto" },
  ]) {
    expect(configModel(missing).limit.output).toBe(TURN)
    expect(runtimeModel(missing).limit.output).toBe(TURN)
  }
})

test("an explicit thinking budget under the cap is kept, and one past it is brought down to the room", () => {
  const under = { thinking: { type: "enabled", budget_tokens: 8000 }, messages: [{ role: "user", content: "q" }] }
  expect(thinking(under, "claude-opus-5.5")).toBe(8000)
  expect(lengthOf(injected(under, "claude-opus-5.5"))).toBe(8000)
  const over = { thinking: { type: "enabled", budget_tokens: 50000 }, messages: [{ role: "user", content: "q" }] }
  expect(thinking(over, "claude-opus-5.5")).toBe(THINK)
  expect(lengthOf(injected(over, "claude-opus-5.5"))).toBe(THINK)
  // a level still names its own budget, not the caller's budget_tokens
  const level = ask("low", { thinking: { type: "enabled", budget_tokens: 8000 } })
  expect(thinking(level, "claude-opus-5.5")).toBe(10000)
})

const was = globalThis.fetch
afterEach(() => {
  globalThis.fetch = was
})

test("a model whose catalog names a smaller output cap keeps that cap and thinks inside it", async () => {
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname !== "/List-Available-Models") throw new Error("no network in tests")
    return Response.json({ models: [{ modelId: "claude-haiku-4.5", modelName: "Haiku", tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 8192 } }] })
  }
  const [listed] = await listModels({ region: "us-east-1", token: "t", tokenType: "", profile: "arn:aws:codewhisperer:us-east-1:123456789012:profile/P" })
  expect(listed.output).toBe(8192)
  expect(runtimeModel(listed).limit.output).toBe(8192)
  expect(configModel(listed).limit.output).toBe(8192)
  // half of 8192 is left for the answer: 4096
  const budget = thinking(ask("xhigh"), "claude-haiku-4.5")
  expect(budget).toBe(4096)
  expect(budget).toBeLessThan(8192)
  expect(runtimeModel(listed).variants.xhigh.thinking.budgetTokens).toBe(4096)
  expect(runtimeModel(listed).variants.low.thinking.budgetTokens).toBe(4096)
})
