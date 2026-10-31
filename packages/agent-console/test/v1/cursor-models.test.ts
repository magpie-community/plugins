import { describe, it, expect } from "vitest";
import { parseCursorListModels, cursorWireModel } from "../../daemon/src/providers/acp/cursorModels.js";

describe("cursor list-models parsing", () => {
  it("parses id and display name", () => {
    const text = `Available models

auto - Auto (default)
composer-2.5 - Composer 2.5 (current)
grok-4.7-high - Grok 4.7  High
Tip: use --model`;
    const m = parseCursorListModels(text);
    expect(m.find((x) => x.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(m.find((x) => x.id === "auto")?.isDefault).toBe(true);
  });

  it("Fast toggle appends the model parameter", () => {
    expect(cursorWireModel("composer-2.5", false)).toBe("composer-2.5");
    expect(cursorWireModel("composer-2.5", true)).toBe("composer-2.5[fast=true]");
    // Parameterized values reported over ACP: sent unchanged without Fast; with Fast only fast changes
    const v = "claude-opus-5-5[context=300k,effort=medium,fast=false]";
    expect(cursorWireModel(v, false)).toBe(v);
    expect(cursorWireModel(v, true)).toBe("claude-opus-5-5[context=300k,effort=medium,fast=true]");
    // A thinking level is chosen: written as that model's own level parameter
    expect(cursorWireModel("grok-4.6", false, { param: "effort", value: "xhigh" })).toBe("grok-4.6[effort=xhigh]");
    expect(cursorWireModel("gpt-5.6-sol", true, { param: "reasoning", value: "max" })).toBe("gpt-5.6-sol[reasoning=max,fast=true]");
    expect(cursorWireModel(v, false, { param: "effort", value: "high" })).toBe("claude-opus-5-5[context=300k,fast=false,effort=high]");
  });
});
