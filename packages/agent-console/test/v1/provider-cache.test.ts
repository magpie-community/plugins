import { describe, it, expect, beforeEach } from "vitest";
import { cachedDetect, cachedModels, clearProviderCache, dropPlaceholder } from "../../daemon/src/providers/infoCache.js";
import type { Provider } from "../../daemon/src/providers/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slowProvider(id: string, counter: { detect: number; models: number }): Provider {
  return {
    id,
    name: id,
    capabilities: { resume: false, interrupt: true, steer: false, images: false, plan: false, questions: false, cost: false, effort: [], modes: ["default"] },
    async detect() { counter.detect++; await sleep(200); return { available: true }; },
    async listModels() { counter.models++; await sleep(200); return [{ id: "m1", name: "M1" }]; },
    async createSession() { throw new Error("unused"); },
  } as Provider;
}

beforeEach(() => clearProviderCache());

describe("Provider info cache", () => {
  it("second detection/model fetch hits the cache", async () => {
    const c = { detect: 0, models: 0 };
    const p = slowProvider("slow", c);
    await cachedDetect(p);
    await cachedModels(p);
    const t0 = Date.now();
    await cachedDetect(p);
    await cachedModels(p);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(c).toEqual({ detect: 1, models: 1 });
  });

  it("concurrent requests run only once", async () => {
    const c = { detect: 0, models: 0 };
    const p = slowProvider("conc", c);
    await Promise.all([cachedModels(p), cachedModels(p), cachedModels(p)]);
    expect(c.models).toBe(1);
  });

  it("detects again after clearProviderCache", async () => {
    const c = { detect: 0, models: 0 };
    const p = slowProvider("clr", c);
    await cachedDetect(p);
    clearProviderCache();
    await cachedDetect(p);
    expect(c.detect).toBe(2);
  });

  it("a model list with only a default placeholder counts as empty", () => {
    expect(dropPlaceholder([{ id: "default", name: "默认", isDefault: true }])).toEqual([]);
    expect(dropPlaceholder([{ id: "gpt", name: "GPT" }])).toHaveLength(1);
  });
});
