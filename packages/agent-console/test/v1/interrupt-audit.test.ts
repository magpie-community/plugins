// Transport matrix: which of the 8 catalog agents share ACP session/cancel vs a custom interrupt path.
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../../daemon/src/providers/catalog.js";
import { isAcpCatalogId, acpConfigForEntry } from "../../daemon/src/providers/acp/specs.js";

describe("interrupt transport audit", () => {
  it("catalog has the 8 supported agents", () => {
    expect(PROVIDER_CATALOG.map((e) => e.id)).toEqual([
      "claude", "codex", "cursor", "copilot", "opencode", "pi", "devin", "dsh",
    ]);
  });

  it("Claude and Codex are custom; the other six share ACP AcpSession", () => {
    const byId = Object.fromEntries(PROVIDER_CATALOG.map((e) => [e.id, e]));
    expect(isAcpCatalogId("claude")).toBe(false);
    expect(isAcpCatalogId("codex")).toBe(false);
    for (const id of ["cursor", "copilot", "opencode", "pi", "devin", "dsh"]) {
      expect(isAcpCatalogId(id)).toBe(true);
      expect(acpConfigForEntry(byId[id], "test")).not.toBeNull();
    }
    expect(acpConfigForEntry(byId.claude, "test")).toBeNull();
    expect(acpConfigForEntry(byId.codex, "test")).toBeNull();
  });
});
