#!/usr/bin/env node
// HarnessWeight benchmark CLI. Runs a provider benchmark through the local
// magpie gateway, persists one JSON line per run, and prints a plain-text
// summary to stdout.
//
//   --gateway <url>   default MAGPIE_GATEWAY_URL or http://127.0.0.1:3425
//   --file <path>     JSONL append target (default: scratch or ./bench.jsonl)
//   --providers a,b   comma list of provider keys to run (default: discover)
//   --max-providers n cap on discovered providers (default 64)
//   --task text|code|reasoning
//   --samples <n>     requests per provider (default 1)
//   --once            run one request per selected provider (default)
//   --json            print the summary as JSON instead of a table
//   --report <path>   also write a self-contained HTML report page
//   --help, -h        print this help and exit without any request or file write
import { env, argv, stdout, exit } from "node:process"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { readFile, writeFile } from "node:fs/promises"
import { reportHtml } from "../lib/bench-report.mjs"
import { runBenchmark, discoverModels, DEFAULT_MODELS, GATEWAY } from "../lib/benchmark.mjs"

const VALUE_FLAGS = ["gateway", "file", "providers", "max-providers", "task", "samples", "report"]
const BOOL_FLAGS = ["once", "json"]

const HELP = `Usage: bench [options]

Runs a provider benchmark against the local magpie gateway and appends one
JSON line per request to --file.

Options:
  --gateway <url>      gateway base URL (default: MAGPIE_GATEWAY_URL or http://127.0.0.1:3425)
  --file <path>        JSONL append target (default: <data dir>/bench.jsonl)
  --providers a,b      comma separated provider keys (default: discover from the gateway)
  --max-providers <n>  cap on discovered providers (default: 64)
  --task <name>        text | code | reasoning (default: text)
  --samples <n>        requests per provider (default: 1)
  --once               run one request per selected provider (default)
  --json               print the summary as JSON instead of a table
  --report <path>      also write a self-contained HTML report page
  --help, -h           print this help and exit

Exit codes: 0 success, 1 usage or runtime error, 2 a sampled model failed at
least half of its requests.
`

class UsageError extends Error {}

function parseArgs(args) {
  const values = {}
  const flags = new Set()
  if (args.includes("--help") || args.includes("-h")) return { help: true }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument "${arg}". Only flags are accepted; see --help.`)
    const name = arg.slice(2)
    if (BOOL_FLAGS.includes(name)) { flags.add(name); continue }
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`Unknown flag "--${name}". Supported flags: ${[...VALUE_FLAGS, ...BOOL_FLAGS].map(f => "--" + f).join(", ")}.`)
    const value = args[i + 1]
    if (value === undefined || value.startsWith("--")) throw new UsageError(`Flag "--${name}" needs a value.`)
    values[name] = value
    i++
  }
  return { values, flags }
}

function defaultFile() {
  const base = env.HARNESSWEIGHT_BENCH_FILE
  if (base) return base
  return join(env.HARNESSWEIGHT_DATA_DIR || hookDataDir(), "bench.jsonl")
}
function hookDataDir() {
  // The service data dir on this host; a single stable place for the bench log.
  return env.HARNESSWEIGHT_BENCH_DIR || join(homedir(), ".config", "magpie", "harnessweight")
}

function table(rows) {
  const hdrs = ["provider", "model", "samples", "err%", "p50ms", "p95ms", "ttftP50ms", "timeouts"]
  const pad = (s, w) => String(s).padEnd(w)
  const widths = hdrs.map((h, i) => Math.max(h.length, ...rows.map((r) => String([r.provider, r.model, r.samples, (r.errorRate * 100).toFixed(1), r.p50, r.p95, r.ttftP50 ?? 0, r.timeout][i] || "").length)))
  const line = hdrs.map((h, i) => pad(h, widths[i])).join("  ")
  const out = [line, hdrs.map((h, i) => "-".repeat(widths[i])).join("  ")]
  for (const r of rows) {
    out.push(hdrs.map((h, i) => pad([r.provider, r.model, r.samples, (r.errorRate * 100).toFixed(1), r.p50, r.p95, r.ttftP50 ?? 0, r.timeout][i], widths[i])).join("  "))
  }
  return out.join("\n")
}

let exitCode = 0

async function main() {
  const parsed = parseArgs(argv.slice(2))
  if (parsed.help) { stdout.write(HELP); return }
  const values = parsed.values
  const gateway = values.gateway ?? GATEWAY()
  const file = values.file ?? defaultFile()
  const task = values.task ?? "text"
  const asJson = parsed.flags.has("json")
  const selected = values.providers ?? ""

  let models
  if (selected) {
    models = {}
    for (const p of selected.split(",")) {
      const k = p.trim()
      if (DEFAULT_MODELS[k]) models[k] = DEFAULT_MODELS[k]
    }
    if (!Object.keys(models).length) {
      throw new Error(`No known provider in "--providers ${selected}". Known: ${Object.keys(DEFAULT_MODELS).join(", ")}`)
    }
  } else {
    const maxProviders = Math.max(1, Number(values["max-providers"] ?? "64") || 64)
    models = await discoverModels({ gateway, maxProviders })
    if (!Object.keys(models).length) models = DEFAULT_MODELS
  }

  const report = values.report ?? ""
  const samples = Math.max(1, Number(values.samples ?? "1") || 1)
  const { summary, rows } = await runBenchmark({ gateway, file, models, task, samples })
  if (report) {
    const styles = await readFile(new URL("../app/style.css", import.meta.url), "utf8")
    const html = reportHtml({ file, task, generatedAt: Date.now(), summary, rows }, styles)
    await writeFile(report, html, "utf8")
    await writeFile(join(dirname(report), "bench-data.json"), JSON.stringify({ gateway, file, task, samples, generatedAt: Date.now(), summary }, null, 2), "utf8")
    stdout.write(`Report written to ${report}\n`)
  }
  if (asJson) {
    stdout.write(JSON.stringify({ gateway, file, task, generatedAt: Date.now(), summary }, null, 2) + "\n")
  } else {
    stdout.write(`Gateway: ${gateway}\nTask: ${task}\nFile: ${file}\nGenerated at ${new Date().toISOString()}\n\n`)
    stdout.write(table(summary) + "\n")
  }
  if (summary.some((r) => r.errorRate >= 0.5)) exitCode = 2
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(`[bench] ${e.message}`)
    console.error("[bench] No benchmark was started. Run with --help for usage.")
  } else {
    console.error("[bench] " + (e?.message || e))
  }
  exit(1)
}).then(() => exit(exitCode))
