import { describe, it, expect } from "vitest";
import { parseCapabilities } from "../../daemon/src/providers/magpieGateway.js";

describe("magpie gateway capability table", () => {
  it("effort / xhigh_effort / max_effort become levels", () => {
    const m = parseCapabilities("devin/swe-2=effort,xhigh_effort,max_effort;cursor/auto=effort;cursor/grok-4.7@256k=effort,xhigh_effort;x/no=foo");
    expect(m.get("devin/swe-2")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(m.get("cursor/auto")).toEqual(["low", "medium", "high"]);
    expect(m.get("cursor/grok-4.7@256k")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(m.has("x/no")).toBe(false);
  });

  it("empty or missing returns an empty table", () => {
    expect(parseCapabilities(undefined).size).toBe(0);
    expect(parseCapabilities("").size).toBe(0);
  });
});
