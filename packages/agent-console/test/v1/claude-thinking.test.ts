import { describe, it, expect } from "vitest";
import { claudeThinkingForModel } from "../../daemon/src/providers/claude/thinking.js";

describe("claudeThinkingForModel", () => {
  it("base levels with high as default", () => {
    const t = claudeThinkingForModel("claude-sonnet-4-20250514");
    expect(t.defaultThinking).toBe("high");
    expect(t.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high", "max", "xhigh"]);
  });

  it("ordinary models have no xhigh", () => {
    const t = claudeThinkingForModel("claude-3-haiku");
    expect(t.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high", "max"]);
  });
});
