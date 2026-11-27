// magpie's models as council uses them, read from the gateway's /v1/models each
// time (cached briefly), so whatever the user adds to magpie is there without
// any setting: every built-in provider, custom key and provider plugin.

import { getJSON } from "./gateway.mjs"

export const RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7 }
const NOT_CHAT = /embed|rerank|whisper|tts|transcri|moderation|speech/i
const TTL_MS = 30_000

let cache = { at: 0, base: "", models: [] }

// The API a request for the model goes on: the one it is passed straight
// through on (native_endpoints), so nothing is lost in translation. A model
// every request to which is translated anyway names none: Claude's go as
// Messages, the closest to what they speak, the rest as Chat.
export function protocolOf(m) {
  const eps = Array.isArray(m.native_endpoints) ? m.native_endpoints : []
  if (eps.includes("/v1/chat/completions")) return "chat"
  if (eps.includes("/v1/messages")) return "messages"
  if (eps.includes("/v1/responses")) return "responses"
  if (!eps.length && !String(m.id).startsWith("group/") && /claude|anthropic/i.test(String(m.owned_by || ""))) return "messages"
  return "chat"
}

// Versions and dates taken out: claude-opus-4-5-20251101 and claude-opus-5
// are both claude-opus, so a provider's picks differ in kind, not in number.
export function familyOf(name) {
  const f = String(name)
    .toLowerCase()
    .replace(/-\d{8}$/, "")
    .replace(/[-_.]?\d+(?:[.-]\d+)*/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return f || String(name).toLowerCase()
}

export function normalize(m, order) {
  const id = String(m.id)
  const slash = id.indexOf("/")
  const provider = slash > 0 ? id.slice(0, slash) : String(m.owned_by || "")
  const input = m.modalities?.input || ["text"]
  const output = m.modalities?.output || ["text"]
  const named = m.reasoning_levels?.length ? m.reasoning_levels : (m.supported_reasoning_levels || []).map((l) => l?.effort)
  const levels = named.filter((l) => l in RANK).sort((a, b) => RANK[a] - RANK[b])
  const price = Number(m.pricing?.prompt)
  return {
    id,
    provider,
    order,
    name: m.display_name || (slash > 0 ? id.slice(slash + 1) : id),
    protocol: protocolOf(m),
    group: id.startsWith("group/"),
    chat: output.includes("text") && !output.includes("image") && !NOT_CHAT.test(id),
    imageOut: output.includes("image"),
    vision: input.includes("image"),
    reasoning: !!m.reasoning && levels.some((l) => l !== "none"),
    levels,
    context: Number(m.context_length || m.max_input_tokens || m.context_window) || 0,
    price: Number.isFinite(price) && price > 0 ? price : null,
    family: familyOf(slash > 0 ? id.slice(slash + 1) : id),
  }
}

export async function catalog(o, fresh = false) {
  const now = Date.now()
  const key = o.gateway || process.env.MAGPIE_ADDR || ""
  if (!fresh && cache.base === key && now - cache.at < TTL_MS && cache.models.length) return cache.models
  let body
  try {
    body = await getJSON(o, "/v1/models")
  } catch {
    // magpie may be restarting its gateway: once more, then say so plainly
    await new Promise((r) => setTimeout(r, 1000))
    try {
      body = await getJSON(o, "/v1/models")
    } catch (e) {
      throw new Error(`can't read magpie's models (${e?.message || e}); is magpie running? / 读不到 magpie 的模型列表，magpie 开着吗？`)
    }
  }
  const models = (body?.data || []).filter((m) => m && m.id).map(normalize)
  cache = { at: now, base: key, models }
  return models
}

// The level to ask a model for: the one it has nearest to what was wanted
// (the lower on a tie), its top one for "max", none for "auto" or a model
// that doesn't think.
export function levelFor(m, want) {
  if (!want || want === "auto" || !m.reasoning) return null
  const ls = m.levels.filter((l) => l !== "none")
  if (!ls.length) return null
  if (want === "max") return ls[ls.length - 1]
  const target = RANK[want] ?? RANK.medium
  let best = ls[0]
  let d = Infinity
  for (const l of ls) {
    const x = Math.abs(RANK[l] - target)
    if (x < d) {
      d = x
      best = l
    }
  }
  return best
}
