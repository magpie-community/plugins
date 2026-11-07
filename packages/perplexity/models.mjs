// Model catalog: agent-facing ids -> Perplexity `model_preference` ids.

export const PROVIDER = "perplexity"

export const MODELS = {
  auto:             { pref: "pplx_pro",                tier: "free", name: "Perplexity Best (auto)" },
  sonar:            { pref: "experimental",            tier: "pro",  name: "Sonar 2" },
  gpt:              { pref: "gpt56_terra",             tier: "pro",  name: "GPT-5.6 Terra",        thinking: "gpt56_terra_thinking" },
  "gpt-5.5":        { pref: "gpt55",                   tier: "pro",  name: "GPT-5.5",              thinking: "gpt55_thinking" },
  "gpt-mini":       { pref: "gpt5_mini",               tier: "pro",  name: "GPT-5 Mini" },
  "gpt-nano":       { pref: "gpt5_nano",               tier: "pro",  name: "GPT-5 Nano" },
  gemini:           { pref: "gemini31pro_high",        tier: "pro",  name: "Gemini 3.1 Pro" },
  "gemini-flash":   { pref: "gemini35flash",           tier: "pro",  name: "Gemini 3.5 Flash" },
  sonnet:           { pref: "claude50sonnet",          tier: "pro",  name: "Claude Sonnet 5",      thinking: "claude50sonnetthinking" },
  "sonnet-4.6":     { pref: "claude46sonnet",          tier: "pro",  name: "Claude Sonnet 4.6",    thinking: "claude46sonnetthinking" },
  grok:             { pref: "grok46low",               tier: "pro",  name: "Grok 4.6" },
  "grok-4.5":       { pref: "grok45low",               tier: "pro",  name: "Grok 4.5",             thinking: "grok45medium" },
  "grok-reasoning": { pref: "grok420reasoning",        tier: "pro",  name: "Grok 4.20 Reasoning" },
  "grok-4":         { pref: "grok4",                   tier: "pro",  name: "Grok 4" },
  nemotron:         { pref: "nv_nemotron_3_ultra",     tier: "pro",  name: "Nemotron 3 Ultra" },
  "nemotron-3-super": { pref: "nv_nemotron_3_super",   tier: "pro",  name: "Nemotron 3 Super" },
  "glm-5.2":        { pref: "glm_5_2",                 tier: "pro",  name: "GLM-5.2" },
  "kimi-k2.6":      { pref: "kimik26instant",          tier: "pro",  name: "Kimi K2.6",            thinking: "kimik26thinking" },
  "kimi-k3":        { pref: "kimik3",                  tier: "pro",  name: "Kimi K3" },
  "gpt-5.6-sol":    { pref: "gpt56_sol",               tier: "max",  name: "GPT-5.6 Sol (Max)",    thinking: "gpt56_sol_thinking" },
  opus:             { pref: "claude48opus",            tier: "max",  name: "Claude Opus 4.8 (Max)", thinking: "claude48opusthinking" },
  "opus-4.7":       { pref: "claude47opus",            tier: "max",  name: "Claude Opus 4.7 (Max)", thinking: "claude47opusthinking" },
  "opus-4.6":       { pref: "claude46opus",            tier: "max",  name: "Claude Opus 4.6 (Max)", thinking: "claude46opusthinking" },
}

const RANK = { free: 0, pro: 1, max: 2 }

export function tierOf(t) {
  const v = String(t || "pro").toLowerCase()
  return v in RANK ? v : "pro"
}

export function modelCatalog(tier) {
  const rank = RANK[tierOf(tier)]
  const out = {}
  for (const [id, m] of Object.entries(MODELS)) {
    if (RANK[m.tier] > rank) continue
    out[id] = {
      id: m.pref,
      name: m.name,
      limit: { context: 128000, output: 16000 },
      // Perplexity's web endpoint has no native function calling.
      capabilities: {
        reasoning: Boolean(m.thinking),
        toolcall: false,
        attachment: false,
        input: { text: true, image: false },
      },
      tool_call: false,
      reasoning: Boolean(m.thinking),
      modalities: { input: ["text"], output: ["text"] },
      ...(m.thinking ? { variants: { low: {}, medium: {}, high: {} } } : {}),
      // "auto" is free tier: it does not spend Pro Search quota.
      free: m.tier === "free",
    }
  }
  return out
}

export function thinkingPref(pref) {
  for (const m of Object.values(MODELS)) {
    if (m.pref === pref && m.thinking) return m.thinking
  }
  return null
}
