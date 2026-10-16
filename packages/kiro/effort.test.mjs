import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

// Claude Code's levels are low, medium, high, xhigh and max: a thinking
// model offers each, so xhigh isn't routed as max (#120)
test("a thinking model offers xhigh as its own level", () => {
  const m = { id: "claude-opus-5.5", name: "Claude Opus 5.5", context: 200000 }
  for (const got of [_internal.configModel(m), _internal.runtimeModel(m)]) {
    expect(Object.keys(got.variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(got.variants.xhigh).toEqual({ thinking: { type: "enabled", budgetTokens: 50000 } })
  }
  expect(_internal.thinking({ output_config: { effort: "xhigh" } }, "claude-opus-5.5")).toBe(50000)
  // a model that doesn't think offers none
  expect(_internal.configModel({ id: "deepseek-3.2", name: "DeepSeek" }).variants).toBeUndefined()
})
