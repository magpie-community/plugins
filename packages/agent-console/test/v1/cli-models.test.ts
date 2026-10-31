import { describe, it, expect } from "vitest";
import { parseDevinModelsList, parseOpencodeModels } from "../../daemon/src/providers/acp/cliModels.js";

describe("CLI model parsers", () => {
  it("parseDevinModelsList", () => {
    const sample = `
Available models (2 families)
  swe-2-high                                                                 SWE-2 High  [262K context, Free]
  adaptive                                                                   Adaptive  [$0.5 / 1M Input]
`;
    const m = parseDevinModelsList(sample);
    expect(m.some((x) => x.id === "swe-2-high")).toBe(true);
    expect(m.find((x) => x.id === "adaptive")?.isDefault).toBe(true);
  });

  it("parseOpencodeModels", () => {
    const m = parseOpencodeModels("opencode/beam-free\nopencode/big-pickle\n");
    expect(m.map((x) => x.id)).toEqual(["opencode/beam-free", "opencode/big-pickle"]);
  });
});
