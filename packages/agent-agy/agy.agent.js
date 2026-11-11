// Antigravity CLI (agy) keeps its settings in
// ~/.gemini/antigravity-cli/settings.json, and the models it can pick in
// customModelsConfig.customModels, each {apiProvider, modelName}. It takes
// the address and key of a Gemini endpoint only from how it is started,
// so magpie starts it: the function agy magpie puts in your shells runs
// `magpie agy run`, which gives agy GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL,
// --settings magpie-settings.json and --model while its model is one of
// magpie's.
//
// magpie writes only magpie-settings.json, a file of its own beside
// settings.json, which agy reads for the one session started with
// --settings: "modelProvider": "gemini" in settings.json would make every
// agy an API-key session, with no Google account and so no remote
// control. agy takes customModels whole from that file, so the user's own
// custom models are carried into it beside magpie's. remote-control runs
// as agy is, on the user's sign-in.
export const agent = {
  id: "agy",
  name: "Antigravity CLI",
  icon: "antigravity-color",
  aliases: ["antigravity-cli"],
  bin: "agy",
  dir: "~/.gemini/antigravity-cli",
  config: "~/.gemini/antigravity-cli/magpie-settings.json",
  base: "~/.gemini/antigravity-cli/settings.json",
  format: "json",
  model: "model",
  prefix: "magpie/",
  launch: {
    env: { GEMINI_API_KEY: "{key}", GOOGLE_GEMINI_BASE_URL: "{url}" },
    model: "--model",
    args: { "--settings": "{config}" },
    plain: ["remote-control", "--remote-control", "-remote-control"],
  },
  effort: true,
  wsl: true,
}

const GEMINI = "API_PROVIDER_GOOGLE_GEMINI"

// the user's own custom models, from settings.json
const ownModels = (base) => {
  const out = {}
  for (const [k, v] of Object.entries(base?.customModelsConfig?.customModels ?? {})) {
    if (!k.startsWith("magpie/")) out[k] = v
  }
  return out
}

export function connect({ models, base }) {
  const custom = ownModels(base)
  for (const m of models) custom[`magpie/${m.id}`] = { apiProvider: GEMINI, modelName: m.id }
  return { modelProvider: "gemini", "customModelsConfig.customModels": custom }
}

// the user's own models, which go to their provider rather than through
// magpie, and the one agy is on when it isn't listed
export function own({ base, model }) {
  const custom = base?.customModelsConfig?.customModels ?? {}
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
