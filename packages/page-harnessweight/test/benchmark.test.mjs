import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { reportHtml } from "../lib/bench-report.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { parseModels, summarizeRuns, runBenchmark, DEFAULT_MODELS } from "../lib/benchmark.mjs"

const okRun = (over = {}) => ({
  model: "alpha/a1", provider: "alpha", task: "text", status: 200, ttft: 100, latency: 500,
  outTok: 20, totalTok: 25, contentLen: 40, error: null, timedOut: false, ...over,
})

test("summarizeRuns sorts by error rate then p95 and computes per-provider reliability", () => {
  const runs = [
    okRun({ model: "beta/b1", provider: "beta", status: 502, error: "HTTP 502", latency: 200, ttft: null }),
    okRun({ model: "alpha/a1", provider: "alpha", latency: 100, ttft: 90 }),
    okRun({ model: "alpha/a1", provider: "alpha", latency: 300, ttft: 290 }),
    okRun({ model: "alpha/a1", provider: "alpha", status: 429, error: "rate limit", latency: 50, ttft: 40 }),
    okRun({ model: "gamma/g1", provider: "gamma", status: 0, timedOut: true, latency: 120000, error: "aborted", ttft: null }),
  ]
  const s = summarizeRuns(runs)
  assert.equal(s.length, 3)
  // alpha: 1 fail / 3 => err 1/3; beta: 1/1 => err 1; gamma: 1/1 => err 1 (tie with beta by err, breaks on p95)
  assert.equal(s[0].provider, "alpha")
  assert.equal(s[0].samples, 3)
  assert.equal(s[0].ok, 2)
  assert.equal(s[0].fail, 1)
  assert.equal(s[0].errorRate, 1 / 3)
  assert.equal(s[0].p50, 100)
  assert.equal(s[0].p95, 300)
  assert.equal(s[0].ttftP50, 90)
  assert.equal(s[0].topErrors.length, 1)
  // alpha's sorted order has ok before fail; 429's latency 50 fits into ms pool
  // gamma routes below beta because both err=1 but gamma p95(120000) > beta p95(200)
  assert.equal(s[1].provider, "beta")
  assert.equal(s[2].provider, "gamma")
  const g = s[2]
  assert.equal(g.timeout, 1)
  assert.equal(g.fail, 1)
  assert.equal(g.timeoutShare, 1)
  // ok pools only include successful runs
  assert.equal(g.ms.length, 0)
})

test("summarizeRuns rejects non-2xx/3xx and computes error rates over all sampled requests", () => {
  const s = summarizeRuns([
    okRun({ status: 403, error: "disabled" }),
    okRun({ status: 200 }),
    okRun({ status: 500, error: "boom" }),
  ])
  assert.equal(s[0].samples, 3)
  assert.equal(s[0].ok, 1)
  assert.equal(s[0].fail, 2)
  assert.equal(s[0].errorRate, 2 / 3)
  assert.deepEqual(s[0].topErrors.map(e => e.split(" ")[0]), ["disabled", "boom"])
})

test("parseModels keeps one model per provider and prefers the known-good id", () => {
  const models = parseModels([
    { id: "deepseek/deepseek-v4.1-flash" },
    { id: "deepseek/deepseek-flash" },
    { id: "codex/gpt-6.1-sol" },
    { id: "group/team-a" },
    { id: "plain-id" },
    { id: 7 },
    {},
  ])
  assert.equal(models.deepseek, "deepseek/deepseek-flash")
  assert.equal(models.codex, "codex/gpt-6.1-sol")
  assert.equal("plain-id" in models, false)
  assert.equal("group" in models, false)
  assert.deepEqual(Object.keys(models).sort(), ["codex", "deepseek"])
})

test("parseModels covers every routed provider, not only the hardcoded table", () => {
  // A supplier the tool has never heard of must still be benchmarked;
  // otherwise the sweep silently covers only a handful of providers.
  const models = parseModels([
    { id: "alpha/a1" },
    { id: "bravo/b1" },
    { id: "charlie/c1" },
  ])
  assert.deepEqual(models, { alpha: "alpha/a1", bravo: "bravo/b1", charlie: "charlie/c1" })
})

test("parseModels caps the number of providers but keeps the first ones", () => {
  const listing = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}/m${i}` }))
  const models = parseModels(listing, { maxProviders: 3 })
  assert.deepEqual(Object.keys(models), ["p0", "p1", "p2"])
})

test("parseModels falls back to the known ids when the listing is unusable", () => {
  assert.deepEqual(parseModels([]), {})
  assert.deepEqual(parseModels(null), {})
  assert.deepEqual(parseModels([{ id: "plain-id" }]), {})
})

test("runBenchmark issues one request per provider through the gateway and writes JSONL records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hw-bench-"))
  let modelsHit = 0
  let chatHit = 0
  const gateway = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        modelsHit++
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ data: [{ id: "alpha/a1" }, { id: "boxer/b1" }] }))
        return
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        chatHit++
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          const payload = JSON.parse(body)
          if (payload.model === "boxer/b1") {
            res.writeHead(429, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: { message: "rate limited" } }))
            return
          }
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { completion_tokens: 3, total_tokens: 9 },
          }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
  const file = join(dir, "bench.jsonl")
  try {
    const { rows, summary } = await runBenchmark({
      gateway: gateway.url,
      file,
      models: { alpha: "alpha/a1", boxer: "boxer/b1", ghost: "" },
      perRequestMs: 5000,
    })
    assert.equal(rows.length, 2) // ghost has no model mapping, skipped
    assert.equal(summary.length, 2)
    const alpha = summary.find((s) => s.provider === "alpha")
    const boxer = summary.find((s) => s.provider === "boxer")
    assert.equal(alpha.errorRate, 0)
    assert.equal(boxer.errorRate, 1)
    assert.equal(alpha.ttftP50 > 0, true)
    // JSONL persisted with one record per sample incl. the failing one
    const lines = (await readFile(file, "utf8")).trim().split("\n")
    assert.equal(lines.length, 2)
    const boxerLine = JSON.parse(lines.find((l) => l.includes("boxer/b1")))
    assert.equal(boxerLine.status, 429)
    assert.equal(boxerLine.error.includes("rate limited"), true)
    const sysCalls = [modelsHit, chatHit]
    assert.deepEqual(sysCalls, [0, 2]) // discovery is not called by runBenchmark itself
  } finally {
    await new Promise((r) => gateway.server.close(r))
    await rm(dir, { recursive: true, force: true })
  }
})

test("runBenchmark classifies and persists an aborted HTTP request as a timeout", { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-bench-abort-"))
  const received = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body) })
      // Leave headers and body unsent so the shipped request deadline aborts fetch.
    })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const file = join(dir, "bench.jsonl")
  const model = "stall/waiting"
  const { rows, summary } = await runBenchmark({
    gateway: `http://127.0.0.1:${server.address().port}`,
    file,
    models: { stall: model },
    perRequestMs: 300,
  })

  assert.equal(received.length, 1)
  assert.equal(received[0].method, "POST")
  assert.equal(received[0].url, "/v1/chat/completions")
  assert.equal(received[0].body.model, model)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 0)
  assert.equal(rows[0].timedOut, true)
  assert.ok(rows[0].error)
  const persisted = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].status, 0)
  assert.equal(persisted[0].timedOut, true)
  assert.deepEqual(persisted, rows)
  assert.equal(summary[0].samples, 1)
  assert.equal(summary[0].ok, 0)
  assert.equal(summary[0].fail, 1)
  assert.equal(summary[0].timeout, 1)
  assert.equal(summary[0].errorRate, 1)
  t.diagnostic(JSON.stringify({ requestsReceived: received.length, record: persisted[0], timeoutCount: summary[0].timeout }))
})

test("runBenchmark repeats each provider the requested number of samples", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hw-bench-"))
  let chatHit = 0
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return }
    chatHit++
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens: 3, total_tokens: 9 } }))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const gateway = `http://127.0.0.1:${server.address().port}`
  const file = join(dir, "bench.jsonl")
  try {
    const { rows, summary } = await runBenchmark({ gateway, file, models: { alpha: "alpha/a1" }, samples: 3, perRequestMs: 5000 })
    assert.equal(rows.length, 3)
    assert.equal(chatHit, 3)
    assert.equal(summary.length, 1)
    assert.equal(summary[0].samples, 3)
    assert.equal(summary[0].errorRate, 0)
    const lines = (await readFile(file, "utf8")).trim().split("\n")
    assert.equal(lines.length, 3)
  } finally {
    await new Promise((r) => server.close(r))
    await rm(dir, { recursive: true, force: true })
  }
})

test("DEFAULT_MODELS maps known suppliers to gateway-format ids with a provider prefix", () => {
  const ids = Object.values(DEFAULT_MODELS)
  for (const id of ids) assert.equal(id.includes("/") && !id.startsWith("group/"), true, id)
})

test("saved reports escape labels, omit raw errors and share metric extrema without inventing missing latency", () => {
  const rows = [
    okRun({ provider: '<unsafe>', model: '<unsafe>/a1' }),
    okRun({ provider: 'beta', model: 'beta/b1' }),
    okRun({ provider: 'failed', model: 'failed/c1', status: 403, ttft: null, error: 'secret upstream body' }),
  ]
  const summary = summarizeRuns(rows)
  const before = structuredClone(summary)
  const html = reportHtml({ summary, rows, task: '<text>', file: '/private/path/run.jsonl', generatedAt: 0 }, '/* shared tokens */')
  assert.match(html, /&lt;unsafe&gt;/)
  assert.match(html, /&lt;text&gt;/)
  assert.doesNotMatch(html, /secret upstream body|private\/path|<unsafe>/)
  assert.match(html, /Authentication \/ permission · HTTP 403/)
  assert.match(html, /<details class="bench-errors">/)
  assert.match(html, /not first-token latency/)
  assert.match(html, /shared tokens/)
  const body = html.match(/<tbody>(.*?)<\/tbody>/s)[1]
  assert.equal((body.match(/metric-best/g) || []).length, 2)
  assert.equal((body.match(/metric-worst/g) || []).length, 1)
  assert.equal((body.match(/<td class="n">—<\/td>/g) || []).length, 3)
  assert.deepEqual(summary, before)
})

test("saved summary-only and empty reports render without network data", () => {
  const summary = summarizeRuns([okRun({ status: 429, error: 'rate limit: raw private payload' })])
  const html = reportHtml({ summary, task: 'text', generatedAt: 0 }, '')
  assert.match(html, /Rate limit/)
  assert.doesNotMatch(html, /raw private payload/)
  assert.match(reportHtml({ summary: [], task: 'text', generatedAt: 0 }, ''), /No recorded samples/)
})

test("bench CLI retains report, JSONL, JSON output and failure exit code against a local mock gateway", async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hw-bench-cli-'))
  let calls = 0
  const server = createServer((req, res) => {
    calls++
    req.resume()
    res.writeHead(calls === 1 ? 200 : 429, { 'content-type': 'application/json' })
    res.end(JSON.stringify(calls === 1 ? { choices: [{ message: { content: 'ok' } }] } : { error: { message: 'rate limited' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  const file = join(dir, 'runs.jsonl'), report = join(dir, 'report.html')
  let result
  try {
    await promisify(execFile)(process.execPath, [new URL('../bin/bench.js', import.meta.url).pathname, '--gateway', 'http://127.0.0.1:' + server.address().port, '--providers', 'deepseek', '--samples', '2', '--file', file, '--report', report, '--json'])
    assert.fail('A 50% failure rate must exit with code 2')
  } catch (error) { assert.equal(error.code, 2); result = error.stdout }
  assert.equal(calls, 2)
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2)
  const data = JSON.parse(await readFile(join(dir, 'bench-data.json'), 'utf8'))
  assert.equal(data.summary[0].errorRate, 0.5)
  assert.equal(data.samples, 2)
  assert.equal(JSON.parse(result.slice(result.indexOf('{'))).summary[0].samples, 2)
  const html = await readFile(report, 'utf8')
  assert.match(html, /--teal:/)
  assert.match(html, /HTTP 429/)
  assert.doesNotMatch(html, /undefined|http:\/\/127\.0\.0\.1/)
})

test("bench CLI prints help without any request, file write or report", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hw-bench-help-"))
  let calls = 0
  const server = createServer((req, res) => { calls++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  const gateway = 'http://127.0.0.1:' + server.address().port
  const file = join(dir, 'runs.jsonl'), report = join(dir, 'report.html')
  for (const flag of ['--help', '-h']) {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL('../bin/bench.js', import.meta.url).pathname, flag, '--gateway', gateway, '--file', file, '--report', report])
    assert.match(stdout, /Usage: bench \[options\]/)
    assert.match(stdout, /--providers a,b/)
    assert.doesNotMatch(stdout, /Gateway:/)
  }
  assert.equal(calls, 0)
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(report), false)
  assert.equal(existsSync(join(dir, 'bench-data.json')), false)
  assert.deepEqual(await readdir(dir), [])
})

test("bench CLI rejects unknown flags and missing values without starting a benchmark", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hw-bench-usage-"))
  let calls = 0
  const server = createServer((req, res) => { calls++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  const gateway = 'http://127.0.0.1:' + server.address().port
  const file = join(dir, 'runs.jsonl'), report = join(dir, 'report.html')
  const cli = new URL('../bin/bench.js', import.meta.url).pathname
  const cases = [
    { args: ['--unknown-flag'], match: /Unknown flag "--unknown-flag"/ },
    { args: ['--gateway'], match: /Flag "--gateway" needs a value/ },
    { args: ['--samples'], match: /Flag "--samples" needs a value/ },
    { args: ['--report'], match: /Flag "--report" needs a value/ },
    { args: ['--file'], match: /Flag "--file" needs a value/ },
    { args: ['positional'], match: /Unexpected argument "positional"/ },
  ]
  for (const { args, match } of cases) {
    let failure
    try {
      await promisify(execFile)(process.execPath, [cli, ...args, '--gateway', gateway, '--file', file, '--report', report])
      assert.fail('Expected a usage error for ' + args.join(' '))
    } catch (error) { failure = error }
    assert.equal(failure.code, 1)
    assert.match(failure.stderr, match)
    assert.match(failure.stderr, /No benchmark was started/)
  }
  assert.equal(calls, 0)
  assert.deepEqual(await readdir(dir), [])
})
