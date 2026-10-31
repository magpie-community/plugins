/**
 * Local CLI probe: detect + listModels (needs a real PATH).
 * Run: set AGENT_CONSOLE_INTEGRATION=1 && npm test -- providers-integration
 */
import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG } from "../../daemon/src/providers/catalog.js";
import { initProviders, getProvider } from "../../daemon/src/providers/registry.js";

const run = process.env.AGENT_CONSOLE_INTEGRATION === "1";

describe.runIf(run)("providers integration (local CLIs)", () => {
  initProviders("test");

  for (const entry of PROVIDER_CATALOG) {
    it(`${entry.id}: detect`, async () => {
      const p = getProvider(entry.id);
      expect(p).toBeTruthy();
      const det = await p!.detect();
      expect(det.available, det.reason ?? "unavailable").toBe(true);
    });

    it(`${entry.id}: listModels`, async () => {
      const p = getProvider(entry.id)!;
      const det = await p.detect();
      if (!det.available) return;
      const models = await p.listModels();
      expect(models.length).toBeGreaterThan(0);
      if (entry.id === "devin") expect(models.length).toBeGreaterThan(10);
      if (entry.id === "opencode") expect(models.length).toBeGreaterThan(3);
    });
  }
});

describe("providers integration skip hint", () => {
  it.runIf(!run)("skipped without AGENT_CONSOLE_INTEGRATION=1", () => {
    expect(true).toBe(true);
  });
});
