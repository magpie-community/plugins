// Provider benchmark — issue controlled requests through the local magpie
// gateway and report per-provider reliability and latency. Credentials live in
// magpie; nothing here reads them. Results are persisted as one JSON line per
// run so a single provider's failure cannot corrupt the report.
//
// The gateway is OpenAI-compatible at MAGPIE_GATEWAY_URL (default
// 127.0.0.1:3425). /v1/models lists the real, currently-routed model ids as
// `provider/name`, so routing is enumerated rather than guessed.
import { readFileSync, appendFileSync } from "node:fs"

export const GATEWAY = () => String(process.env.MAGPIE_GATEWAY_URL || "http://127.0.0.1:3425").trim().replace(/\/+$/, "")

const MAX_OUT = Number(process.env.HARNESSWEIGHT_BENCH_MAX_OUTPUT || 96)

// Short prompts and a small max_tokens keep a benchmark run honest about
// latency (a blank request returns templated answers and underestimates it) and
// cheap enough to run against real paid providers.
const PROMPTS = {
  text: { system: "You are a terse, accurate assistant. Answer in one sentence.", user: "Explain HTTP caching in one sentence." },
  code: { system: "You are a concise coding assistant.", user: "Write a one-line JavaScript function that returns the current timestamp." },
  reasoning: { system: "You are a precise reasoner. Answer in one sentence.", user: "Is 27 a prime number? Answer yes or no and why." },
}

export const DEFAULT_MODELS = {
  claude: "claude/claude-fable-5.2", codex: "codex/gpt-6.1-sol", deepseek: "deepseek/deepseek-flash",
  gemini: "gemini/gemini-3.8-flash", antigravity: "antigravity/gemini-3.8-flash", grok: "grok/grok-4.7",
  "minimax-code": "minimax-code/MiniMax-M3.1-Flash", mimo: "mimo/mimo-v2-6-flash",
  zcode: "zcode/glm-5.3", kimi: "kimi/kimi-k3", glm: "glm/glm-5.3",
}

// Fall back to a pair from DEFAULT_MODELS so a model that is not currently
// routed does not silently empty the batch.
const FALLBACK = ["deepseek/deepseek-flash", "codex/gpt-6.1-sol", "antigravity/gemini-3.8-flash"]

// Parse /v1/models into a provider->model selection: one model per provider.
// Every provider the gateway routes is eligible — a provider missing from
// DEFAULT_MODELS is still benchmarked, otherwise the sweep would silently
// cover only the handful of suppliers someone hardcoded. Within a provider
// the known-good id from DEFAULT_MODELS wins when the gateway lists it.
// `fallback` is used when the live listing is empty or unreachable.
export function parseModels(listing, { fallback = FALLBACK, maxProviders = 64 } = {}) {
  const providers = new Map()
  for (const m of listing ?? []) {
    const id = m?.id
    if (typeof id !== "string" || !id.includes("/") || id.startsWith("group/")) continue
    const provider = id.slice(0, id.indexOf("/"))
    if (!provider) continue
    if (!providers.has(provider)) providers.set(provider, id)
  }
  const chosen = {}
  // Prefer a known-good id per provider when the gateway lists it.
  for (const [provider, id] of providers) {
    const preferred = DEFAULT_MODELS[provider]
    if (preferred && preferredIsListed(preferred, listing)) chosen[provider] = preferred
  }
  // Every routed provider gets a model; the listing order decides the rest.
  for (const [provider, id] of providers) {
    if (!chosen[provider]) chosen[provider] = id
  }
  // Fall back to a pair from DEFAULT_MODELS so a model that is not currently
  // routed does not silently empty the batch.
  if (!Object.keys(chosen).length) {
    for (const id of fallback) {
      const provider = id.slice(0, id.indexOf("/"))
      if (providers.has(provider)) chosen[provider] = id
    }
  }
  if (!Object.keys(chosen).length) {
    const first = providers.values().next().value
    if (first) chosen[first.slice(0, first.indexOf("/"))] = first
  }
  const keys = Object.keys(chosen)
  if (keys.length > maxProviders) {
    const kept = {}
    for (const k of keys.slice(0, maxProviders)) kept[k] = chosen[k]
    return kept
  }
  return chosen
}

function preferredIsListed(preferred, listing) {
  for (const m of listing ?? []) {
    if (m?.id === preferred) return true
  }
  return false
}

export async function discoverModels({ gateway = GATEWAY(), signal, timeoutMs = 8000, maxProviders = 64 } = {}) {
  const ctl = new AbortController()
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener("abort", () => ctl.abort(), { once: true })
  }
  try {
    const res = await fetch(`${gateway}/v1/models`, { signal: ctl.signal })
    if (!res.ok) throw new Error(`models listing HTTP ${res.status}`)
    const body = await res.json()
    return parseModels(body?.data, { maxProviders })
  } catch (e) {
    return parseModels(null, { maxProviders })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function callOnce({ gateway, model, prompt, maxOutput = MAX_OUT, perRequestMs = 120e3 }) {
  const t0 = Date.now()
  let ttft = null, status = 0, timedOut = false, outTok = 0, totalTok = 0
  const { signal, done } = timeoutSignal(perRequestMs)
  try {
    const res = await fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxOutput, stream: false, messages: [
        { role: "system", content: prompt.system }, { role: "user", content: prompt.user },
      ] }),
      signal,
    })
    const text = await res.text()
    ttft = Date.now() - t0
    status = res.status
    const parsed = JSON.parse(text)
    const content = parsed?.choices?.[0]?.message?.content ?? ""
    outTok = parsed?.usage?.completion_tokens ?? 0
    totalTok = parsed?.usage?.total_tokens ?? 0
    const error = parsed?.error?.message ?? (status >= 400 ? text.slice(0, 500) : "")
    return { status, ttft, latency: Date.now() - t0, outTok, totalTok, contentLen: content.length, error: error || null, timedOut: false }
  } catch (e) {
    timedOut = /abort/i.test(String(e?.name || ""))
    const message = String(e?.message || "")
    return { status, ttft, latency: Date.now() - t0, outTok, totalTok, contentLen: 0, error: message.slice(0, 500), timedOut }
  } finally { done() }
}

function timeoutSignal(ms) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(), ms)
  return { signal: ctl.signal, done: () => clearTimeout(id) }
}

// Aggregate run records into one row per provider/model: samples, failure
// count, error rate, timeouts, TTFT, p50/p95 latency and the top error texts.
export function summarizeRuns(runs, _opts = {}) {
  const by = new Map()
  for (const r of runs) {
    const key = r.model
    let e = by.get(key)
    if (!e) {
      e = { model: key, provider: r.provider, fail: 0, ok: 0, timeout: 0, timeoutShare: 0, ms: [], ttft: [], errors: [], errorRate: 0, p50: 0, p95: 0, samples: 0, topErrors: [] }
      by.set(key, e)
    }
    const ok = r.status >= 200 && r.status < 400
    e.ok += ok ? 1 : 0
    e.fail += ok ? 0 : 1
    e.timeout += r.timedOut ? 1 : 0
    if (ok) { e.ms.push(r.latency); if (Number.isFinite(r.ttft)) e.ttft.push(r.ttft ?? 0) }
    else e.errors.push(r.error?.slice(0, 160) || `HTTP ${r.status}`)
  }
  const q = (arr, p) => {
    if (!arr.length) return 0
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.max(0, Math.min(s.length - 1, Math.ceil(s.length * p) - 1))]
  }
  return [...by.values()].map(e => {
    const n = e.ok + e.fail
    e.samples = n
    e.errorRate = n ? e.fail / n : 0
    e.timeoutShare = e.fail ? e.timeout / e.fail : 0
    e.p50 = q(e.ms, 0.5)
    e.p95 = q(e.ms, 0.95)
    e.ttftP50 = q(e.ttft, 0.5)
    e.topErrors = e.errors.slice(0, 3)
    return e
  }).sort((a, b) => a.errorRate - b.errorRate || a.p95 - b.p95 || a.model.localeCompare(b.model))
}

export function readRuns(file) {
  if (!file) return []
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

export function writeRun(file, record) {
  if (!file) return
  appendFileSync(file, JSON.stringify(record) + "\n")
}

// Run one benchmark once: for each selected provider, issue one controlled
// request and append the record. Returns the new rows (not the whole history)
// and a summary of just this run.
export async function runBenchmark({
  gateway = GATEWAY(), file = null, models = DEFAULT_MODELS, perProvider = null, task = "text", maxOutput = MAX_OUT, perRequestMs = 120e3, samples = 1,
}) {
  const providerList = Array.isArray(perProvider) && perProvider.length ? perProvider : Object.keys(models)
  const prompt = PROMPTS[task] || PROMPTS.text
  const rounds = Math.max(1, Math.floor(Number(samples) || 1))
  const rows = []
  for (const provider of providerList) {
    const model = models[provider]
    if (!model) continue
    for (let i = 0; i < rounds; i++) {
      const res = await callOnce({ gateway, model, prompt, maxOutput, perRequestMs })
      const record = { t: Date.now(), provider, model, task, ...res }
      writeRun(file, record)
      rows.push(record)
    }
  }
  return { rows, summary: summarizeRuns(rows, {}) }
}