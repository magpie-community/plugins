import type { ModelInfo, ThinkingOption } from "../types.js";

const BASE_LEVELS = ["low", "medium", "high", "max"] as const;

/** Claude: infer levels from the model id (default high; newer model families add xhigh) */
export function claudeThinkingForModel(modelId: string | null | undefined): Pick<ModelInfo, "thinkingOptions" | "defaultThinking"> {
  const id = (modelId ?? "").toLowerCase();
  const options: ThinkingOption[] = BASE_LEVELS.map((x) => ({ id: x, label: x }));
  if (/opus|sonnet-4|fable|4\.5|4-5|5-|claude-4|haiku-4|xhigh/.test(id)) {
    if (!options.some((o) => o.id === "xhigh")) options.push({ id: "xhigh", label: "xhigh" });
  }
  return { thinkingOptions: options, defaultThinking: "high" };
}

export function attachClaudeThinking(models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => {
    const id = m.id && m.id !== "null" ? m.id : null;
    return { ...m, ...claudeThinkingForModel(id) };
  });
}
