// The three tiers Quick's chat serves, and the parameters each request
// names. The wire only knows agent_mode + thinking_effort; which concrete
// model answers is the server's call, reported per turn in turn_usage's
// resolved_model_id — the plugin reads that back as the model fingerprint
// and never guesses from style.
//
// Tier copy (from the production UI): fast = "Haiku, GPT Luna, or
// similar", balanced = "Sonnet, GPT Terra, or similar", smart = "Opus,
// GPT Sol, or similar". A fourth tier, "advanced" ("Fable, GPT Astra"),
// exists in the copy but the UI does not offer it and this account's chat
// channel does not take it, so it is not listed.
//
// thinking_effort: the protocol's enum is off/low/medium/high/max (max
// exists in the production config schema, hidden from the UI). The server
// defaults a fresh session to off and smart to medium, so the plugin sends
// the value explicitly on every request.

export const PROVIDER = "quick"

const MODE = { "quick-fast": "fast", "quick-balanced": "balanced", "quick-smart": "smart" }

export const THINKING = ["off", "low", "medium", "high", "max"]

const CONTEXT = 1_000_000 // turn_usage.context_window, measured
const OUTPUT = 128_000 // not reported by the wire; a working ceiling

function model(id, name) {
  return {
    id,
    name,
    provider: { npm: "@ai-sdk/openai-compatible", api: "https://quick.aws.com" },
    reasoning: true,
    attachment: false, // attachments need another capture pass
    tool_call: false, // the chat channel takes no client tools
    temperature: false, // the wire has no temperature field
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 0, output: 0 },
    limit: { context: CONTEXT, output: OUTPUT },
  }
}

// modelsOf: the catalog as OpenCode's config wants it (variants mapping an
// effort to nothing — the tier and the effort both go out on the wire per
// request, not as model ids)
export function modelsOf() {
  return {
    "quick-fast": { ...model("quick-fast", "Quick Fast"), variants: { off: {}, low: {}, medium: {}, high: {}, max: {} } },
    "quick-balanced": { ...model("quick-balanced", "Quick Balanced"), variants: { off: {}, low: {}, medium: {}, high: {}, max: {} } },
    "quick-smart": { ...model("quick-smart", "Quick Smart"), variants: { off: {}, low: {}, medium: {}, high: {}, max: {} } },
  }
}

// modeOf maps a model id to its agent_mode; unknown ids fall to balanced
export function modeOf(id) {
  return MODE[id] ?? "balanced"
}

// effortOf normalizes a thinking parameter: a bare true means the high the
// account is set to, a bare false/undefined means off, a string must be one
// of the protocol's values. Returns null for a value the protocol refuses.
export function effortOf(thinking) {
  if (thinking === undefined || thinking === null || thinking === false) return "off"
  if (thinking === true) return "high"
  if (typeof thinking === "string") {
    const e = thinking.toLowerCase()
    return THINKING.includes(e) ? e : null
  }
  return null
}
