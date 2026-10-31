import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG } from "../../daemon/src/providers/catalog.js";
import { initProviders, listProviders } from "../../daemon/src/providers/registry.js";
import { isProviderEnabled } from "../../daemon/src/providers/enabled.js";
import type { Settings } from "../../daemon/src/store/settings.js";

describe("provider catalog (phase one)", () => {
  it("fixed set of 8 Providers", () => {
    expect(PROVIDER_CATALOG.map((p) => p.id)).toEqual([
      "claude",
      "codex",
      "cursor",
      "copilot",
      "opencode",
      "pi",
      "devin",
      "dsh",
    ]);
    expect(PROVIDER_CATALOG.every((p) => p.status === "verified")).toBe(true);
  });

  it("initProviders registers every catalog entry", () => {
    delete process.env.AGENT_CONSOLE_MOCK;
    initProviders();
    expect(listProviders().map((p) => p.id)).toEqual(PROVIDER_CATALOG.map((p) => p.id));
  });

  it("default toggles: verified on; manual settings win; entries outside the catalog default on", () => {
    const none = {} as Settings;
    expect(isProviderEnabled(none, "claude")).toBe(true);
    expect(isProviderEnabled(none, "codex")).toBe(true);
    expect(isProviderEnabled(none, "cursor")).toBe(true);
    expect(isProviderEnabled(none, "devin")).toBe(true);
    expect(isProviderEnabled(none, "mock")).toBe(true);
    const s = { providerEnabled: { claude: false, devin: true } } as unknown as Settings;
    expect(isProviderEnabled(s, "claude")).toBe(false);
    expect(isProviderEnabled(s, "devin")).toBe(true);
  });
});
