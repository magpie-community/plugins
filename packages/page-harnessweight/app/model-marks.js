import { MODEL_ICONS } from "./model-icons.js"

// Match the actual model leaf, never the gateway, provider route or harness.
// Aliases such as auto/hy4free deliberately remain unidentified.
const FAMILIES = [
  [/^(?:gpt(?:-|\d)|o[134](?:-|$)|chatgpt(?:-|$))/i, "openai"],
  [/^claude(?:-|$)/i, "claude"],
  [/^gemini(?:-|$)/i, "gemini"],
  [/^deepseek(?:-|$)/i, "deepseek"],
  [/^minimax(?:-|$)/i, "minimax"],
  [/^(?:glm|chatglm)(?:-|\d|$)/i, "glm"],
  [/^qwen(?:-|\d|$)/i, "qwen"],
  [/^kimi(?:-|$)/i, "kimi"],
  [/^grok(?:-|$)/i, "grok"],
  [/^mimo(?:-|$)/i, "mimo"],
  [/^(?:nemotron|nvidia-nemotron)(?:-|$)/i, "nvidia"],
  [/^mercury(?:-|$)/i, "inception"],
  [/^llama(?:-|\d|$)/i, "meta"],
  [/^step(?:-|\d|$)/i, "stepfun"],
]

export function modelIdentity(name) {
  const leaf = String(name).split("/").at(-1).replace(/:.*$/, "")
  const family = FAMILIES.find(([pattern]) => pattern.test(leaf))?.[1]
  return { family: family || null, icon: family ? MODEL_ICONS[family] : null }
}

export function rankedModels(models = []) {
  return models.filter(m => typeof m.name === "string" && Number.isFinite(m.count) && m.count > 0)
    .map(m => ({ ...m, ...modelIdentity(m.name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
