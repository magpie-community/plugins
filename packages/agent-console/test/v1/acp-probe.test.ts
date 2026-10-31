import { describe, it, expect } from "vitest";
import { parseAcpSession, probeToModels, cursorCatalogToModels } from "../../daemon/src/providers/acp/probe.js";

describe("Cursor model catalog (cursor/list_available_models)", () => {
  it("each model has its own level parameter; the current model is the default; models without levels get no dropdown", () => {
    const models = cursorCatalogToModels({
      models: [
        { value: "grok-4.6[effort=high,fast=true]", name: "Grok 4.6", configOptions: [
          { id: "effort", category: "thought_level", type: "select", currentValue: "high", options: [
            { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra High" },
          ] },
          { id: "fast", category: "model_config", type: "select", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
        ] },
        { value: "gpt-5.6-sol[reasoning=medium]", name: "GPT-5.6 Sol", configOptions: [
          { id: "reasoning", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "none" }, { value: "max" }] },
        ] },
        { value: "composer-2.5[fast=true]", name: "Composer 2.5", configOptions: [
          { id: "fast", category: "model_config", type: "select", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
        ] },
      ],
    }, "grok-4.6[effort=high,fast=true]");
    expect(models.map((m) => m.id)).toEqual(["grok-4.6", "gpt-5.6-sol", "composer-2.5"]);
    expect(models[0]).toMatchObject({ isDefault: true, defaultThinking: "high", thinkingParam: "effort" });
    expect(models[0].thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[1]).toMatchObject({ thinkingParam: "reasoning" });
    expect(models[2].thinkingOptions).toBeUndefined();
  });
});

describe("ACP probe parsing", () => {
  it("Devin: model + thought_level config options", () => {
    const r = parseAcpSession({
      configOptions: [
        { id: "mode", category: "mode", type: "select", currentValue: "accept-edits", options: [{ value: "accept-edits", name: "Code" }] },
        { id: "model", category: "model", type: "select", currentValue: "swe-2-high", options: [
          { value: "adaptive", name: "Adaptive" }, { value: "swe-2-high", name: "SWE-2" },
        ] },
        { id: "thought_level", category: "thought_level", type: "select", currentValue: "high", options: [
          { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "max", name: "Max" },
        ] },
      ],
    });
    expect(r.models.map((m) => m.id)).toEqual(["adaptive", "swe-2-high"]);
    expect(r.currentModel).toBe("swe-2-high");
    const models = probeToModels(r);
    expect(models.find((m) => m.isDefault)?.id).toBe("swe-2-high");
    expect(models[1].thinkingOptions?.map((t) => t.id)).toEqual(["medium", "high", "max"]);
    expect(models[1].defaultThinking).toBe("high");
  });

  it("Copilot: duplicate auto is deduped", () => {
    const r = parseAcpSession({
      configOptions: [{ id: "model", category: "model", type: "select", currentValue: "auto", options: [
        { value: "auto", name: "Auto" }, { value: "auto", name: "Auto" },
      ] }],
    });
    expect(r.models).toEqual([{ id: "auto", name: "Auto" }]);
  });

  it("grouped options are flattened; falls back to the models field without configOptions", () => {
    const grouped = parseAcpSession({
      configOptions: [{ id: "model", category: "model", type: "select", currentValue: "b", options: [
        { name: "G", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] },
      ] }],
    });
    expect(grouped.models.map((m) => m.id)).toEqual(["a", "b"]);
    const legacy = parseAcpSession({ models: { currentModelId: "x", availableModels: [{ modelId: "x", name: "X" }] } });
    expect(legacy).toMatchObject({ currentModel: "x", models: [{ id: "x", name: "X" }] });
  });
});
