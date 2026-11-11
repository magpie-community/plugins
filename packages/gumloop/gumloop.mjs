// Gumloop's API: what an account can use, what a call costs, and what this
// plugin has spent. Nothing here signs in or holds a key; index.mjs does.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const API = "https://api.gumloop.com/api/v1"
export const WS = "https://ws.gumloop.com/api/v1"
export const OPENROUTER = "https://openrouter.ai/api/v1"

// Gumloop bills $0.005 per credit and rounds every call up to a whole credit.
export const USD_PER_CREDIT = 0.005
export const PRICES_TTL = 12 * 60 * 60 * 1000
// A credit-limit refusal keeps the account shown as out of credits this long.
export const EXHAUSTED_FOR = 12 * 60 * 60 * 1000

// USD per million tokens [input, output, cacheRead, cacheWrite], used until
// (or when) OpenRouter's list cannot be read. cacheWrite null = billed as input.
// From vwfactory-dsh (2026-10), supplemented with OpenRouter provider rates
// checked on 2026-11-11. These are estimates, not a Gumloop balance API.
export const FALLBACK_PRICES = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "gpt-6-astra": [10, 50, 1, 12.5],
  "gpt-6.1-sol": [2, 10, 0.1, 2.5],
  "gpt-6.1-terra": [1, 5, 0.05, 1.25],
  "gpt-6-sol": [2, 10, 0.2, 2.5],
  "gpt-6-luna": [0.1, 0.5, 0.01, 0.125],
  "grok-4.7": [2, 6, 0.5, null],
  "grok-4.6": [2, 6, 0.5, null],
  "meta/muse-spark-1.3": [1.25, 4.25, 0.15, null],
  "meta/muse-wonder-1.0": [4, 20, 0.2, null],
  "minimax/minimax-m3.1-flash": [0.15, 0.6, 0.015, null],
  "accounts/fireworks/models/glm-5p3": [1.4, 4.4, 0.26, null],
  "z-ai/glm-5.3-flash": [0.15, 0.5, 0.03, null],
  "accounts/fireworks/routers/kimi-k3-us": [3, 15, 0.3, null],
  "accounts/fireworks/models/kimi-k2p7-code": [0.95, 4, 0.19, null],
  "gemini-4-argon": [2, 10, 0.1, 0.1875],
  "gemini-3.1-pro-preview": [2, 12, 0.2, 0.375],
  "gemini-3.8-flash": [0.825, 4.125, 0.0825, 0.04166666667],
  "gemini-3.7-flash": [0.75, 3.75, 0.075, 0.04166666667],
  "google/gemma-4-26b-a4b-it": [0.15, 0.6, null, null],
  "accounts/fireworks/models/deepseek-v4p1-flash": [0.3, 1.2, 0.006, null],
  "accounts/fireworks/models/deepseek-v4-pro-0813": [1.32, 3.96, 0.044, null],
  "accounts/fireworks/models/minimax-m3": [0.3, 1.2, 0.06, null],
}

// /models uses catalog names; /chat/completions still requires these routes.
// Verified against both Gumloop endpoints on 2026-11-11.
export const MODEL_ROUTES = {
  "glm-5.3": "accounts/fireworks/models/glm-5p3",
  "glm-5.3-flash": "z-ai/glm-5.3-flash",
  "kimi-k3": "accounts/fireworks/routers/kimi-k3-us",
  "deepseek-v4.1-flash": "accounts/fireworks/models/deepseek-v4p1-flash",
  "gemma-4-26b-a4b-it": "google/gemma-4-26b-a4b-it",
  "muse-spark-1.3": "meta/muse-spark-1.3",
  "muse-wonder-1.0": "meta/muse-wonder-1.0",
  "minimax-m3": "accounts/fireworks/models/minimax-m3",
  "minimax-m3.1-flash": "minimax/minimax-m3.1-flash",
}
export const wireModel = (id) => Object.hasOwn(MODEL_ROUTES, id) ? MODEL_ROUTES[id] : id
// Gumloop currently injects an unsupported `provider` field for this route.
// Keep it out of offered models until the upstream route is repaired.
export const availableModel = (id) => wireModel(id) !== "accounts/fireworks/models/minimax-m3"

const VENDORS = [
  [/^claude-/, "anthropic", "Anthropic"],
  [/^(gpt-|o\d)/, "openai", "OpenAI"],
  [/^(gemini-|gemma-)/, "google", "Google"],
  [/^grok-/, "x-ai", "xAI"],
  [/^deepseek/, "deepseek", "DeepSeek"],
  [/^glm-/, "z-ai", "Z.AI"],
  [/^kimi-/, "moonshotai", "Moonshot AI"],
  [/^minimax-/, "minimax", "Minimax"],
  [/^qwen/, "qwen", "Alibaba"],
  [/^muse-/, "meta", "Meta"],
]

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function gumloopHeaders(key, userId) {
  return { authorization: `Bearer ${key}`, "x-auth-key": userId }
}

// parseModels reads GET /models ({model_groups: [{groupLabel, options: [...]}]})
// into the chat models an agent can drive: active, not restricted, able to
// call tools, and not an image, voice, transcription or classifier model.
// gumloop-chew is Gumloop's own router, which bills unpredictably.
export function parseModels(body) {
  if (!isObj(body) || !Array.isArray(body.model_groups)) throw new Error("Gumloop sent no model list")
  const out = []
  for (const g of body.model_groups) {
    for (const o of Array.isArray(g?.options) ? g.options : []) {
      if (!isObj(o) || typeof o.value !== "string" || !o.value) continue
      const caps = Array.isArray(o.metadata?.capabilities) ? o.metadata.capabilities : []
      if (o.status !== "active" || o.restricted || o.is_classifier_model || o.is_image_generation || o.is_voice || o.is_transcription) continue
      if (!caps.includes("functions") || o.value === "gumloop-chew") continue
      if (!availableModel(o.value)) continue
      out.push({
        id: o.value,
        name: typeof o.label === "string" && o.label ? o.label : o.value,
        vision: caps.includes("vision"),
        reasoning: caps.includes("reasoning") || /^claude-(opus|fable)/.test(o.value),
        // Every call bills the whole context, so the short window keeps one
        // long conversation from spending thousands of credits per turn.
        context: Number(o.metadata?.short_context_window) || Number(o.metadata?.context_window) || 0,
      })
    }
  }
  if (!out.length) throw new Error("Gumloop listed no usable chat models")
  return out
}

// priceRef maps a Gumloop model id to the OpenRouter ids that may price it.
// Fireworks-hosted ones ("accounts/fireworks/models/glm-5p3") are priced at
// Fireworks' endpoint, which is what Gumloop pays, not OpenRouter's cheapest.
export function priceRef(id) {
  id = wireModel(id)
  const fireworks = /^accounts\/fireworks\//.test(id)
  let bare = id.replace(/^accounts\/fireworks\/(models|routers)\//, "")
  if (bare.includes("/")) {
    const provider = bare.startsWith("z-ai/") ? "Z.AI" : bare.startsWith("google/gemma-") ? "Google Vertex" : undefined
    return { orIds: [...new Set([bare, bare.replace(/-\d+(\.\d+)*$/, "")])], fireworks: false, provider }
  }
  bare = bare.replace(/(\d)p(\d)/g, "$1.$2").replace(/-us$/, "")
  const dotted = bare.replace(/(\d)-(\d)/g, "$1.$2")
  const v = VENDORS.find(([re]) => re.test(bare))
  const orIds = v ? [`${v[1]}/${dotted}`, `${v[1]}/${bare}`] : [dotted, bare]
  return { orIds: [...new Set(orIds)], fireworks, vendorName: v?.[2], provider: fireworks ? "Fireworks" : undefined }
}

function perMillion(p) {
  const n = (x) => (x === undefined || x === null || x === "" ? null : Number((Number(x) * 1e6).toPrecision(10)))
  const out = [n(p.prompt), n(p.completion), n(p.input_cache_read), n(p.input_cache_write)]
  return out[0] === null || out[1] === null || out.some((x) => x !== null && (!Number.isFinite(x) || x < 0)) ? undefined : out
}

// priceEntry reads one OpenRouter pricing block, with its long-context tier.
export function priceEntry(pricing) {
  if (!isObj(pricing)) return undefined
  const base = perMillion(pricing)
  if (!base) return undefined
  const entry = { p: base }
  const ov = Array.isArray(pricing.overrides) ? pricing.overrides.find((o) => Number(o?.min_prompt_tokens) > 0) : undefined
  const long = ov ? perMillion({ ...pricing, ...ov }) : undefined
  if (long) Object.assign(entry, { longAt: Number(ov.min_prompt_tokens), long })
  return entry
}

// fetchPrices prices the given Gumloop ids from OpenRouter's public list.
export async function fetchPrices(fetchImpl, ids) {
  const r = await fetchImpl(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`OpenRouter price list: HTTP ${r.status}`)
  const data = (await r.json())?.data ?? []
  const byId = new Map(data.filter((m) => typeof m?.id === "string").map((m) => [m.id, m]))
  const table = {}
  for (const id of ids) {
    const ref = priceRef(id)
    const orId = ref.orIds.find((x) => byId.has(x))
    if (!orId) continue
    let entry
    if (ref.provider) {
      try {
        const er = await fetchImpl(`${OPENROUTER}/models/${orId}/endpoints`, { signal: AbortSignal.timeout(20000) })
        const eps = er.ok ? ((await er.json())?.data?.endpoints ?? []) : []
        const ep = eps.find((e) => e?.provider_name === ref.provider && priceEntry(e.pricing) &&
          (ref.provider !== "Fireworks" || !e.tag || e.tag === "fireworks"))
        if (ep) entry = priceEntry(ep.pricing)
      } catch {
        // Keep the known route's fallback, not another host's headline price.
      }
      if (!entry) continue
    }
    entry ??= priceEntry(byId.get(orId).pricing)
    if (entry) table[id] = { ...entry, ref: orId }
  }
  return table
}

// usageCost prices one completion from its OpenAI-style usage block.
export function usageCost(entry, usage) {
  const prompt = Number(usage?.prompt_tokens) || 0
  const out = Number(usage?.completion_tokens) || 0
  const det = isObj(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const read = Number(det.cached_tokens) || 0
  const write = Number(det.cache_write_tokens ?? det.cache_creation_tokens) || 0
  const fresh = Math.max(0, prompt - read - write)
  const [pin, pout, pread, pwrite] = entry.long && prompt >= entry.longAt ? entry.long : entry.p
  const usd = (fresh * pin + read * (pread ?? pin) + write * (pwrite ?? pin) + out * pout) / 1e6
  return { usd, prompt, out, read, write }
}

export const creditsFor = (usd) => (usd > 0 ? Math.ceil(usd / USD_PER_CREDIT - 1e-9) : 0)

export function monthKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

// Store keeps the ledger (calibrated balance and spend per account) and the
// price table in one JSON file in magpie's config directory. Every terminal
// `magpie` command runs its own plugin host beside the app's, so each change
// re-reads the file first rather than trusting what this process holds.
export class Store {
  constructor(file, now = Date.now) {
    this.file = file
    this.now = now
    this.mem = {}
  }

  read() {
    let d = this.mem
    if (this.file) {
      try {
        d = JSON.parse(readFileSync(this.file, "utf8"))
      } catch {
        d = {}
      }
    }
    if (!isObj(d)) d = {}
    if (!isObj(d.accounts)) d.accounts = {}
    return d
  }

  write(d) {
    this.mem = d
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(d, null, 2))
      renameSync(tmp, this.file)
    } catch {
      // the ledger is an estimate; losing one write must not fail a request
    }
  }

  static account(d, uid, now) {
    const a = isObj(d.accounts[uid]) ? d.accounts[uid] : (d.accounts[uid] = {})
    if (typeof a.spent !== "number") a.spent = 0
    if (!Array.isArray(a.applied)) a.applied = []
    const key = monthKey(now)
    if (!isObj(a.month) || a.month.key !== key) a.month = { key, credits: 0, calls: 0, usd: 0 }
    return a
  }

  change(uid, fn) {
    const d = this.read()
    const a = Store.account(d, uid, this.now())
    const result = fn(a, d)
    this.write(d)
    return result
  }

  account(uid) {
    return Store.account(this.read(), uid, this.now())
  }

  // anchor sets the balance read off gumloop.com at time `at`. Each source (a
  // sign-in, an options value) is applied once, so a reload doesn't erase what
  // was spent since. A balance may be applied after calls were made past `at`
  // (magpie reads usage after the first requests), so those still count.
  anchor(uid, balance, source, at = this.now()) {
    const b = Number(balance)
    if (!Number.isFinite(b) || b < 0) return false
    if (this.account(uid).applied.includes(source)) return false
    return this.change(uid, (a) => {
      a.anchor = { balance: Math.round(b), at }
      a.charges = (a.charges ?? []).filter(([t]) => t > at)
      a.spent = a.charges.reduce((s, [, c]) => s + c, 0)
      // an out-of-credits refusal after the balance was read still stands
      if (!(a.exhaustedAt > at)) delete a.exhaustedAt
      delete a.unbilledStops
      a.applied = [...a.applied, source].slice(-20)
      return true
    })
  }

  // spend counts credits against the balance, remembering when for anchor.
  static spend(a, credits, at) {
    a.spent += credits
    a.charges = [...(a.charges ?? []), [at, credits]].slice(-500)
  }

  remaining(uid) {
    const a = this.account(uid)
    return a.anchor ? Math.max(0, Math.floor(a.anchor.balance - a.spent + 1e-9)) : undefined
  }

  prices() {
    const p = this.read().prices
    return isObj(p) && isObj(p.table) ? p : { at: 0, table: {} }
  }

  setPrices(table, ids = Object.keys(table)) {
    const d = this.read()
    d.prices = { at: this.now(), table, ids, version: 2 }
    this.write(d)
  }

  // price is the live entry for a model, else the built-in one.
  price(model) {
    model = wireModel(model)
    const live = this.prices().table[model]
    if (live?.p) return live
    const fb = FALLBACK_PRICES[model]
    return fb ? { p: fb } : undefined
  }
}
