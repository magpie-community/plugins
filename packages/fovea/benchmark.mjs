// A reproducible, offline A/B on the same request. No prompt body is
// written to the report: only counts and prefix comparisons leave here.
//
//   bun packages/fovea/benchmark.mjs
//   bun packages/fovea/benchmark.mjs /path/to/request.json
//   bun packages/fovea/benchmark.mjs /path/to/request.json '{"saccade":"auto"}'
//
// The report is read by this package's page. It is not a cost claim:
// actual provider input/cache tokens and cost need a controlled live A/B.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { onRequest } from "./fovea.middleware.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULTS = {
  threshold: 0, keep_recent: 4, keep_recent_tokens: 0, cut_step: 4,
  tool_head: 80, tool_tail: 40, text_head: 120, text_tail: 60,
  saccade: "off",
}
const clone = (v) => JSON.parse(JSON.stringify(v))
const chars = (v) => JSON.stringify(v).length

function fixture(rounds = 16, question = "Finish the module and explain the result") {
  const messages = [{ role: "user", content: "Implement a parser and check every test" }]
  for (let n = 0; n < rounds; n++) {
    messages.push({ role: "assistant", content: "Read the next file", tool_calls: [
      { id: `read_${n}`, type: "function", function: { name: "read_file", arguments: "{}" } },
    ] })
    messages.push({ role: "tool", tool_call_id: `read_${n}`, content: `FILE ${n}\n` + `line ${n}: parser trace and test result\n`.repeat(72) })
  }
  messages.push({ role: "user", content: question })
  return { model: "example-model", messages }
}

function transform(raw, options) {
  const body = clone(raw)
  onRequest(body, { options })
  return body
}

function commonPrefix(a, b) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function messages(body) {
  return Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
}

function compare(raw, options) {
  const result = transform(raw, options)
  const a = messages(raw)
  const b = messages(result)
  return {
    before: chars(raw), after: chars(result),
    saved: chars(raw) - chars(result),
    changed: a.reduce((n, item, i) => n + (JSON.stringify(item) !== JSON.stringify(b[i]) ? 1 : 0), 0),
    messages: a.length,
  }
}

export function benchmark(raw = fixture(), options = DEFAULTS, source = "synthetic") {
  if (!raw || (!Array.isArray(raw.messages) && !Array.isArray(raw.input))) throw new Error("request must have messages or input array")
  const fixed = { ...DEFAULTS, ...options }
  const before = compare(raw, { ...fixed, threshold: 1_000_000_000 })
  const after = compare(raw, fixed)
  const pairA = fixture(15)
  const pairB = fixture(16)
  const baselineA = JSON.stringify(pairA)
  const baselineB = JSON.stringify(pairB)
  const transformedA = transform(pairA, fixed)
  const transformedB = transform(pairB, fixed)
  const processedA = JSON.stringify(transformedA)
  const processedB = JSON.stringify(transformedB)
  const baselinePrefix = commonPrefix(baselineA, baselineB)
  const processedPrefix = commonPrefix(processedA, processedB)
  const oldA = messages(pairA)
  const slimA = messages(transformedA)
  const slimB = messages(transformedB)
  let cutEnd = 0
  for (let i = 0; i < oldA.length; i++) {
    if (JSON.stringify(oldA[i]) !== JSON.stringify(slimA[i])) cutEnd = i + 1
  }
  const stablePrefix = cutEnd > 0 && JSON.stringify(slimA.slice(0, cutEnd)) === JSON.stringify(slimB.slice(0, cutEnd))
  return {
    version: 1, source, options: fixed,
    request: { before: before.before, after: after.after, saved: after.saved, changed: after.changed, messages: after.messages },
    consecutive: {
      first_messages: oldA.length, second_messages: messages(pairB).length,
      baseline_prefix_chars: baselinePrefix, fovea_prefix_chars: processedPrefix,
      baseline_prefix_share: baselinePrefix / baselineA.length,
      fovea_prefix_share: processedPrefix / processedA.length,
      stable_cut_messages: cutEnd,
      stable_cut_prefix: stablePrefix,
    },
    limits: "字符数与共同前缀占比是确定性的代理指标，不是计费 token、缓存命中、延迟或实际美元；system/developer 与最近窗口里的摘要仍会发送。",
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2]
  const raw = arg ? JSON.parse(readFileSync(arg, "utf8")) : fixture()
  const options = process.argv[3] ? JSON.parse(process.argv[3]) : DEFAULTS
  const report = benchmark(raw, options, arg ? "local request (content omitted)" : "synthetic")
  const out = join(HERE, "page", "report.js")
  writeFileSync(out, `globalThis.FoveaReport = ${JSON.stringify(report, null, 2)};\n`)
  console.log(JSON.stringify({ report: out, ...report.request, consecutive: report.consecutive }, null, 2))
}
