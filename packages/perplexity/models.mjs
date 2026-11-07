// Model catalog: agent-facing ids -> Perplexity `model_preference` ids.
//
// `ctx` / `out` are the window of the model Perplexity runs underneath (GPT-5.x
// 400k/128k, Gemini 3.x 1M, Claude 200k, Grok 256k, …). Perplexity's web
// endpoint publishes no window of its own and may truncate earlier, so the
// catalog flags every limit as an upstream-model figure rather than a promise.

export const PROVIDER = "perplexity"

export const MODELS = {
  auto:               { pref: "pplx_pro",            tier: "free", name: "Perplexity Best (auto)",      ctx: 128_000,   out: 16_000 },
  sonar:              { pref: "experimental",        tier: "pro",  name: "Sonar 2",                     ctx: 128_000,   out: 16_000 },
  gpt:                { pref: "gpt56_terra",         tier: "pro",  name: "GPT-5.6 Terra", thinking: "gpt56_terra_thinking",         ctx: 400_000,   out: 128_000 },
  "gpt-5.5":          { pref: "gpt55",               tier: "pro",  name: "GPT-5.5",       thinking: "gpt55_thinking",               ctx: 400_000,   out: 128_000 },
  "gpt-mini":         { pref: "gpt5_mini",           tier: "pro",  name: "GPT-5 Mini",                                                              ctx: 400_000,   out: 128_000 },
  "gpt-nano":         { pref: "gpt5_nano",           tier: "pro",  name: "GPT-5 Nano",                                                              ctx: 400_000,   out: 128_000 },
  gemini:             { pref: "gemini31pro_high",    tier: "pro",  name: "Gemini 3.1 Pro",                                                          ctx: 1_000_000, out: 65_536 },
  "gemini-flash":     { pref: "gemini35flash",       tier: "pro",  name: "Gemini 3.5 Flash",                                                        ctx: 1_000_000, out: 65_536 },
  sonnet:             { pref: "claude50sonnet",      tier: "pro",  name: "Claude Sonnet 5",   thinking: "claude50sonnetthinking",       ctx: 200_000,   out: 64_000 },
  "sonnet-4.6":       { pref: "claude46sonnet",      tier: "pro",  name: "Claude Sonnet 4.6", thinking: "claude46sonnetthinking",       ctx: 200_000,   out: 64_000 },
  grok:               { pref: "grok46low",           tier: "pro",  name: "Grok 4.6",                                                                ctx: 256_000,   out: 64_000 },
  "grok-4.5":         { pref: "grok45low",           tier: "pro",  name: "Grok 4.5",      thinking: "grok45medium",                 ctx: 256_000,   out: 64_000 },
  "grok-reasoning":   { pref: "grok420reasoning",    tier: "pro",  name: "Grok 4.20 Reasoning",                                                     ctx: 256_000,   out: 64_000 },
  "grok-4":           { pref: "grok4",               tier: "pro",  name: "Grok 4",                                                                  ctx: 256_000,   out: 64_000 },
  nemotron:           { pref: "nv_nemotron_3_ultra", tier: "pro",  name: "Nemotron 3 Ultra",                                                        ctx: 128_000,   out: 32_000 },
  "nemotron-3-super": { pref: "nv_nemotron_3_super", tier: "pro",  name: "Nemotron 3 Super",                                                        ctx: 128_000,   out: 32_000 },
  "glm-5.2":          { pref: "glm_5_2",             tier: "pro",  name: "GLM-5.2",                                                                 ctx: 200_000,   out: 128_000 },
  "kimi-k2.6":        { pref: "kimik26instant",      tier: "pro",  name: "Kimi K2.6",     thinking: "kimik26thinking",              ctx: 256_000,   out: 32_000 },
  "kimi-k3":          { pref: "kimik3",              tier: "pro",  name: "Kimi K3",                                                                 ctx: 256_000,   out: 32_000 },
  "gpt-5.6-sol":      { pref: "gpt56_sol",           tier: "max",  name: "GPT-5.6 Sol (Max)", thinking: "gpt56_sol_thinking",         ctx: 400_000,   out: 128_000 },
  opus:               { pref: "claude48opus",        tier: "max",  name: "Claude Opus 4.8 (Max)", thinking: "claude48opusthinking",    ctx: 200_000,   out: 32_000 },
  "opus-4.7":         { pref: "claude47opus",        tier: "max",  name: "Claude Opus 4.7 (Max)", thinking: "claude47opusthinking",    ctx: 200_000,   out: 32_000 },
  "opus-4.6":         { pref: "claude46opus",        tier: "max",  name: "Claude Opus 4.6 (Max)", thinking: "claude46opusthinking",    ctx: 200_000,   out: 32_000 },
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
      // The upstream model's window; flagged because Perplexity's web layer
      // publishes none and can truncate before it.
      limit: { context: m.ctx, output: m.out },
      limitEstimated: true,
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
