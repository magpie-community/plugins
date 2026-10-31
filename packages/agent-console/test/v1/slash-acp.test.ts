import { describe, expect, it } from "vitest";
import { mapAcpAvailableCommands } from "../../daemon/src/providers/slash.js";

describe("mapAcpAvailableCommands", () => {
  it("maps ACP command list to slash entries", () => {
    const out = mapAcpAvailableCommands([
      { name: "plan", description: "Plan mode", input: { hint: "<topic>" } },
    ]);
    expect(out).toEqual([
      {
        name: "plan",
        description: "Plan mode",
        argumentHint: "<topic>",
        kind: "skill",
      },
    ]);
  });
});
