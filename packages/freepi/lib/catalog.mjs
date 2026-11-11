// Model catalog: /client-version parsing plus a static fallback for when the
// upstream catalog is unreachable, so magpie always has a usable model list.

// Ids observed live on GET /client-version (anonymous), 2026-11-10 — currently
// available ones only (unavailable entries are filtered out at parse time too).
export const FALLBACK_MODEL_IDS = [
  "particle", "deepseek-v4.1-flash", "glm-5.3-flash", "deepseek-v4-flash",
  "abliterated-large-flash", "abliterated-large-v2",
  "deepseek-v4.1-flash-1017-ultrafast", "deepseek-v4.1-flash-abliterated",
  "deepseek-v4-pro", "gemma-4-uncensored", "glm-4.7-flash-heretic", "kimi-k3.1-pro",
  "mimo-v2.6-flash", "qwen3.5-35b-darkbloom", "qwen3.6-plus-uncensored",
  "solar-pro-4", "uncensored-1.2",
]

// Per-model context/output limits, looked up 2026-11-07 on models.dev via each
// entry's stats_id (openrouter slug). Entries absent here keep the conservative
// default in index.mjs; the upstream applies its own per-request caps regardless.
export const MODEL_LIMITS = {
  "deepseek-v4.1-flash": { context: 1048576, output: 131072 },
  "deepseek-v4.1-flash-1017-ultrafast": { context: 1048576, output: 131072 },
  "glm-5.3-flash": { context: 1048576, output: 131072 },
  "deepseek-v4-flash": { context: 1048576, output: 943718 },
  "claude-haiku-5.5": { context: 1000000, output: 50000 },
  "deepseek-v4-pro": { context: 1048576, output: 384000 },
  "gpt-6.1-sol-flex": { context: 1050000, output: 128000 },
  "gpt-6.1-terra": { context: 1050000, output: 128000 },
  "gpt-6.1-terra-flex": { context: 1050000, output: 128000 },
  "gpt-6-luna": { context: 1050000, output: 128000 },
  "gpt-6-luna-flex": { context: 1050000, output: 128000 },
  "gpt-oss-120b-speed": { context: 32768, output: 32768 },
  "kimi-k3.1-pro": { context: 1048576, output: 943718 },
  "mimo-v2.6-flash": { context: 1048576, output: 50000 },
  "muse-spark-1.3-contributor": { context: 1048576, output: 943718 },
  "muse-spark-open": { context: 1048576, output: 943718 },
  "solar-pro-4": { context: 524288, output: 131072 },
}

// Catalog entry shape (observed): { id, name, stats_id?, section?, unavailable? }.
// The name carries display info the upstream does not structure separately:
// "Claude Haiku 5.5 · ~2.0x usage", "DeepSeek V4 Flash · 1x usage" (tilde optional),
// "X · 🔥 Free Unlimited: limited time" (free promotions come and go).
export function parseCatalog(body) {
  const list = Array.isArray(body?.models) ? body.models : []
  const out = []
  for (const m of list) {
    if (!m || typeof m.id !== "string" || !m.id) continue
    if (m.unavailable) continue
    const raw = typeof m.name === "string" && m.name ? m.name : m.id
    const rate = /~?(\d+(?:\.\d+)?)x\s*usage/.exec(raw)
    out.push({
      id: m.id,
      name: raw.split(" · ")[0] || m.id,
      rate: rate ? rate[1] : null,
      free: raw.includes("Free Unlimited"),
    })
  }
  return out
}
