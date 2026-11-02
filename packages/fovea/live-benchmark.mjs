// Controlled live A/B through the same local magpie gateway and same model.
// Temporarily switches only this plugin's options, restores them in finally.
// The request is synthetic. The report stores usage and timing, never keys
// or prompt bodies. Run when other agents are idle: options are global.
//
//   FOVEA_GATEWAY_KEY=<temporary gateway key> bun packages/fovea/live-benchmark.mjs
//   FOVEA_GATEWAY_KEY=<...> FOVEA_MODEL=deepseek/deepseek-flash bun packages/fovea/live-benchmark.mjs
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC = process.env.FOVEA_PLUGIN_SPEC || HERE
const URL = process.env.FOVEA_GATEWAY_URL || "http://127.0.0.1:3425/v1/chat/completions"
const MODEL = process.env.FOVEA_MODEL || "deepseek/deepseek-flash"
const KEY = process.env.FOVEA_GATEWAY_KEY
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cli = (...args) => execFileSync("magpie", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

function request() {
  const messages = [{ role: "system", content: "Reply with OK. No other words." }]
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "user", content: `Read log part ${i}. ` + "The parser found a row and a test result. ".repeat(20) })
    messages.push({ role: "assistant", content: "Recorded part " + i + "." })
  }
  messages.push({ role: "user", content: "Reply with OK." })
  return { model: MODEL, max_tokens: 128, messages }
}

async function call(mode, sequence) {
  const started = Date.now()
  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(request()),
    signal: AbortSignal.timeout(90_000),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${mode} request ${res.status}: ${JSON.stringify(body).slice(0, 180)}`)
  const usage = body.usage || {}
  return {
    mode, sequence, model: body.model || MODEL, status: res.status,
    elapsed_ms: Date.now() - started,
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    cache_read_tokens: usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? null,
    cache_write_tokens: usage.prompt_cache_miss_tokens ?? usage.cache_creation_input_tokens ?? null,
    answer: String(body.choices?.[0]?.message?.content || "").slice(0, 32),
  }
}

async function main() {
  if (!KEY) throw new Error("FOVEA_GATEWAY_KEY must hold a temporary local gateway key")
  const saved = JSON.parse(cli("plugin", "options", SPEC))
  const raw = { ...saved, threshold: 1_000_000_000 }
  const slim = { ...saved, threshold: 0, keep_recent: 4, keep_recent_tokens: 0, cut_step: 4, saccade: "off", text_head: 80, text_tail: 40 }
  const results = []
  try {
    for (const [mode, options, sequence] of [["raw", raw, 1], ["fovea", slim, 1], ["fovea", slim, 2], ["raw", raw, 2]]) {
      cli("plugin", "options", SPEC, JSON.stringify(options))
      await pause(1500) // gateway reloads middleware config within a second
      results.push(await call(mode, sequence))
    }
  } finally {
    cli("plugin", "options", SPEC, JSON.stringify(saved))
  }
  const sameModel = new Set(results.map((r) => r.model)).size === 1
  const report = {
    version: 1, source: "local gateway controlled A/B", model: MODEL,
    measured_at: new Date().toISOString(),
    same_model: sameModel,
    samples: results,
    limits: "Same synthetic request, same model, ABBA order. Provider caches and routing can still differ; use the warm second call and Magpie usage CSV for billed cost. This report stores no prompt or key.",
  }
  const out = join(HERE, "page", "live.js")
  writeFileSync(out, `globalThis.FoveaLive = ${JSON.stringify(report, null, 2)};\n`)
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => { console.error(err.message); process.exitCode = 1 })
