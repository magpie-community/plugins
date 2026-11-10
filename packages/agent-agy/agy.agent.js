// Antigravity CLI (agy) keeps its model in
// ~/.gemini/antigravity-cli/settings.json, and the models it can pick in
// customModelsConfig.customModels, each {apiProvider, modelName}. It takes
// the address and key of a Gemini endpoint only from how it is started,
// so magpie starts it: the function agy magpie puts in your shells runs
// `magpie agy run`, which gives agy GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL
// and --model while its model is one of magpie's.
export const agent = {
  id: "agy",
  name: "Antigravity CLI",
  icon: "antigravity-color",
  aliases: ["antigravity-cli"],
  bin: "agy",
  dir: "~/.gemini/antigravity-cli",
  config: "~/.gemini/antigravity-cli/settings.json",
  format: "json",
  model: "model",
  prefix: "magpie/",
  launch: {
    env: { GEMINI_API_KEY: "{key}", GOOGLE_GEMINI_BASE_URL: "{url}" },
    model: "--model",
  },
  // magpie's models go in beside the user's own
  merge: ["customModelsConfig.customModels"],
  effort: true,
  wsl: true,
}

const GEMINI = "API_PROVIDER_GOOGLE_GEMINI"

export function connect({ models }) {
  const custom = {}
  for (const m of models) custom[`magpie/${m.id}`] = { apiProvider: GEMINI, modelName: m.id }
  return { modelProvider: "gemini", "customModelsConfig.customModels": custom }
}

// the user's own models, which go to their provider rather than through
// magpie, and the one agy is on when it isn't listed
export function own({ config, model }) {
  const custom = config?.customModelsConfig?.customModels ?? {}
  const out = []
  for (const [k, v] of Object.entries(custom)) {
    if (k.startsWith("magpie/")) continue
    const p = String(v?.apiProvider ?? "")
    const direct = p.includes("ANTHROPIC") ? "Anthropic" : p.includes("OPENAI") ? "OpenAI" : "Google"
    out.push({ value: k, model: String(v?.modelName ?? k), direct })
  }
  out.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  if (model && !(model in custom)) out.unshift({ value: model, model, direct: "Google" })
  return out
}
