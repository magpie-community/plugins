import assert from "node:assert/strict"
import childProcess, { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { agyRefusal, createUsageReader, fetchUsage, parseUsageReport, quotaUserAgent, readQuotaDirect, verifyLinkIn } from "../usage.mjs"
import http from "node:http"
import { modelsInGroup, storeCatalogRows } from "../model-ids.mjs"
import { forgetStoredSignIn } from "../signin.mjs"

// Live data captured from `agy -p /usage --output-format json` (agy 1.5.9,
// 2026-11-15), group descriptions pasted verbatim.
const LIVE_REPORT = {
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-22T11:19:33Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-15T16:19:33Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", description: "You have used some of your weekly limit, it will fully refresh in 4 days, 21 hours.", window: "weekly", remaining_fraction: 0.3360503911972046, reset_time: "2026-11-20T09:01:10Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-15T16:19:33Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-22T11:19:33Z" },
          ],
        },
      ],
    },
  },
}

// The rows `agy models` listed for the same account, verbatim.
const LIVE_MODEL_ROWS = [
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", effort: "low" },
  { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", effort: "high" },
  { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)", effort: "xhigh" },
  { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)", effort: "medium" },
  { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)", effort: "low" },
  { id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", effort: "low" },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", effort: "low" },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", effort: "medium" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", effort: "high" },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", effort: "low" },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", effort: "medium" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", effort: "high" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", effort: "medium" },
]

test("a live report names on each window the ids the listed catalog serves", () => {
  storeCatalogRows(LIVE_MODEL_ROWS)
  const result = parseUsageReport(structuredClone(LIVE_REPORT))
  assert.deepEqual(result.windows.map(w => w.models), [
    ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-4-hydrogen", "gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh"],
    ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-4-hydrogen", "gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh"],
    ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "gpt-oss-120b", "gpt-oss-120b-medium"],
    ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "gpt-oss-120b", "gpt-oss-120b-medium"],
    // Argon's description names no model; its group name is a catalog name.
    ["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-argon-medium"],
  ])
  assert.deepEqual(result.windows.map(w => w.used), [0, 0, 66.394961, 0, 0])
  // agy names a family in the description even though it lists no bare id.
  assert.ok(result.windows[2].models.includes("gpt-oss-120b"))
  storeCatalogRows(null)
})

test("ids on windows follow the catalog, and names agy adds match nothing until it lists them", () => {
  storeCatalogRows(LIVE_MODEL_ROWS)
  // A renamed model: the description keeps the old name, the catalog the new.
  assert.deepEqual(modelsInGroup({ description: "Models within this group: Claude Opus 5.5", name: "x" }),
    ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium"])
  assert.deepEqual(modelsInGroup({ description: "Models within this group: Claude Opus 6", name: "x" }), [])
  assert.deepEqual(modelsInGroup({ description: "Models within this group: Claude Opus 5.5 and Claude Opus 6", name: "x" }),
    ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium"])
  // A group whose name matches no catalog name gets no ids, not guesses.
  assert.deepEqual(modelsInGroup({ name: "Veo models" }), [])
  // No catalog yet: no ids at all, windows stay account-level.
  storeCatalogRows(null)
  assert.deepEqual(modelsInGroup({ description: "Models within this group: Claude Opus 5.5" }), [])
  // The separator list "A, B and C" also splits with no comma before "and".
  storeCatalogRows([{ id: "m1", name: "Model One" }, { id: "m2", name: "Model Two" }])
  assert.deepEqual(modelsInGroup({ description: "Models within this group: Model One and Model Two" }), ["m1", "m2"])
  // One display name used by two families matches neither.
  storeCatalogRows([{ id: "a-high", name: "Twin (High)", effort: "high" }, { id: "b", name: "Twin" }, { id: "c", name: "Solo" }])
  assert.deepEqual(modelsInGroup({ description: "Models within this group: Twin, Solo" }), ["c"])
  storeCatalogRows(null)
})

const report = groups => ({ status: "SUCCESS", command: { name: "usage", data: { groups } } })
const group = (buckets, name = "Gemini Models", description = "For paid Pro plans, Argon quota is separate.") => ({ name, description, buckets })
const bucket = (overrides = {}) => ({ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.75, ...overrides })

test("maps all groups/cadences to display-only Magpie windows, without invented identity", () => {
  const result = parseUsageReport(report([
    group([bucket(), bucket({ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 })]),
    group([bucket({ id: "3p-5h", remaining_fraction: 0 }), bucket({ id: "3p-weekly", window: "weekly", remaining_fraction: 1 })], "Claude and GPT models"),
    group([bucket({ id: "gemini-argon-weekly", window: "weekly", remaining_fraction: 0.53 })], "Gemini 4 Argon"),
  ]))
  assert.equal(result.windows.length, 5)
  assert.deepEqual(result.windows.map(w => w.name), ["Gemini · 5 hours", "Gemini · 7 days", "Claude & GPT · 5 hours", "Claude & GPT · 7 days", "Gemini 4 Argon · 7 days"])
  assert.deepEqual(result.windows.map(w => w.used), [25, 50, 100, 0, 47])
  assert.deepEqual(result.windows.map(w => w.span), [18000, 604800, 18000, 604800, 604800])
  assert.ok(result.windows.every(w => w.aside === true))
  assert.equal(result.plan, undefined)
  assert.equal(result.user, undefined)
})

test("accepts camel case and nested/oneof fractions plus ISO and epoch-second resets", () => {
  const result = parseUsageReport(JSON.stringify(report([{
    displayName: "Gemini Models",
    buckets: [
      { bucketId: "gemini-5h", displayName: "Session", window: "5h", remaining: { remainingFraction: 0.4 }, resetTime: "2026-10-27T02:00:00+02:00" },
      { bucketId: "gemini-weekly", remaining: { case: "remainingFraction", value: 0.8 }, resetTime: "1793059200" },
    ],
  }])))
  assert.equal(result.windows[0].used, 60)
  assert.equal(result.windows[0].resetsAt, "2026-10-27T00:00:00.000Z")
  assert.equal(result.windows[1].used, 20)
  assert.equal(result.windows[1].resetsAt, "2026-10-27T00:00:00.000Z")
  assert.equal(result.windows[1].span, 604800)
})

test("unknown, invalid and disabled quotas are never reported as zero/full usage", () => {
  const result = parseUsageReport(report([group([
    bucket(),
    ...[null, undefined, "0.5", true, -0.1, 1.1, NaN, Infinity].map((remaining_fraction, i) => bucket({ id: `unknown-${i}`, remaining_fraction, reset_time: "2026-10-27T00:00:00Z" })),
    bucket({ id: "disabled", disabled: true }),
    bucket({ id: "other-oneof", remaining_fraction: undefined, remaining: { case: "unlimited", value: 1 } }),
  ])]))
  assert.equal(result.windows.length, 10)
  assert.ok(result.windows.slice(1).every(w => w.used === undefined && w.display === "Limits not available" && w.aside))
  assert.equal(result.windows[1].resetsAt, "2026-10-27T00:00:00.000Z")
})

test("weekly-only reports stay weekly; explicit unknown cadence never becomes five hours", () => {
  const result = parseUsageReport(report([group([
    bucket({ id: "gemini-weekly", window: undefined, name: "Weekly Limit Remaining" }),
    bucket({ id: "gemini-5h", window: "custom", name: "Special limit", reset_time: "bad" }),
    bucket({ id: "other", window: undefined, name: "Other", reset_time: "2026-10-27T00:00:00Z" }),
  ])]))
  assert.equal(result.windows[0].span, 604800)
  assert.equal(result.windows[1].span, undefined)
  assert.equal(result.windows[1].resetsAt, undefined)
  assert.equal(result.windows[2].span, undefined)
})

test("requires a successful usage command with at least one enabled measured bucket", () => {
  for (const value of [
    "invalid-json", {}, { status: "ERROR", error: "secret@example.com" },
    { ...report([group([bucket()])]), command: { name: "models", data: {} } },
    report([]), report([group([bucket({ disabled: true })])]),
    report([group([bucket({ remaining_fraction: undefined })])]),
    report([group([{ remaining_fraction: 0.5 }])]),
  ]) {
    assert.throws(() => parseUsageReport(value), error => !error.message.includes("secret@example.com"))
  }
})

// Polls until the pid is gone. The bound is generous: a SIGKILLed child is
// reaped only when the kernel and this event loop get to it, which takes
// longer on a loaded machine.
async function waitForPidExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if (err?.code === "ESRCH") return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
}

// Polls until a descendant that was killed no longer runs code. A dead orphan
// can stay a zombie on Linux until its new parent reaps it.
async function waitForNotRunning(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
    if (!state || state.startsWith("Z")) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`descendant ${pid} still runs (${state})`)
}

// Runs fetchUsage against a hanging fixture and returns the children it
// spawned. The timeout covers both children, and a loaded machine can spend
// all of it starting the version child, so the budget doubles until the
// timeout lands while the child under test runs (the report child, or with
// version: true the version child). With onTaskkill, taskkill calls are
// recorded and handed to it instead of being run.
async function timedOut(f, { version = false, onTaskkill } = {}) {
  const originalSpawn = childProcess.spawn
  const initialTimeoutMs = process.platform === "win32" ? 1200 : 600
  for (let timeoutMs = initialTimeoutMs; ; timeoutMs *= 2) {
    const children = []
    const kills = []
    try {
      childProcess.spawn = (file, args, options) => {
        if (file === "taskkill" && onTaskkill) {
          kills.push({ args, options })
          onTaskkill(args)
          return { unref() {} }
        }
        const child = originalSpawn(file, args, options)
        if (file !== "taskkill") children.push({ pid: child.pid })
        return child
      }
      syncBuiltinESMExports()
      await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs }), /timed out/)
    } finally {
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
    }
    // The version child is spawned first, the report child second.
    const target = children[version ? 0 : 1]
    if (target || timeoutMs >= 20_000) {
      assert.ok(target, `the ${version ? "version" : "report"} child never started within ${timeoutMs}ms`)
      return { children, kills, target }
    }
    for (const pid of await f.pids(children)) await waitForPidExit(pid)
  }
}

function killPidBestEffort(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try { process.kill(pid, 0) } catch { return }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
  }
  try { process.kill(pid, "SIGKILL") } catch {}
}

async function fixture(t, extraEnv = {}) {
  const isWin = process.platform === "win32"
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-test-"))
  const script = path.join(directory, "fake.mjs")
  const executable = path.join(directory, isWin ? "agy.cmd" : "agy")
  const logPath = path.join(directory, "calls.jsonl")
  const descendantPath = path.join(directory, "descendant")
  t.after(async () => {
    for (const file of [logPath, descendantPath]) {
      try {
        const raw = await fs.readFile(file, "utf8")
        if (file === descendantPath) {
          killPidBestEffort(Number(raw.trim()))
        } else {
          for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue
            try { killPidBestEffort(JSON.parse(line).pid) } catch {}
          }
        }
      } catch {}
    }
    for (let i = 0; i < 6; i++) {
      try { await fs.rm(directory, { recursive: true, force: true }); return }
      catch { await new Promise(r => setTimeout(r, 50)) }
    }
    if (isWin) {
      const escaped = directory.replace(/'/g, "''")
      spawnSync("powershell.exe", [
        "-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: "ignore", windowsHide: true })
      for (let i = 0; i < 6; i++) {
        try { await fs.rm(directory, { recursive: true, force: true }); return }
        catch { await new Promise(r => setTimeout(r, 100)) }
      }
    }
  })
  await fs.writeFile(script, String.raw`
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
// A slow start on a loaded machine; set TEST_START_DELAY_MS to reproduce one.
const startDelay = Number(process.env.TEST_START_DELAY_MS) || 0
if (startDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startDelay)
const version = args[0] === "--version"
const guardRun = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "\"" + process.env.BROWSER + "\""], { windowsHide: true })
  : spawnSync(process.env.BROWSER)
const record = {
  args, cwd: process.cwd(), pid: process.pid,
  update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  path: process.env.PATH, browser: process.env.BROWSER,
  browserContent: (() => { try { return fs.readFileSync(process.env.BROWSER, "utf8") } catch { return null } })(),
  agent: fs.readFileSync(path.join(process.cwd(), ".agents/agents/magpie-usage/agent.md"), "utf8"),
  mode: fs.statSync(process.cwd()).mode & 0o777,
  guard: guardRun.status,
}
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(record) + "\n")
const mode = process.env.TEST_MODE
if (mode === "version-hang" && version || mode === "hang" && !version) {
  if (process.env.TEST_ERROR) console.error(process.env.TEST_ERROR)
  setInterval(() => {}, 1000)
}
else if (version) {
  console.log(process.env.TEST_VERSION || "1.3.5")
} else if (mode === "fail") {
  console.error(process.env.TEST_ERROR || "oops secret@example.com https://secret.invalid/token")
  if (process.env.TEST_FAILURE_REPORT) console.log(process.env.TEST_FAILURE_REPORT)
  process.exitCode = 1
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(1024 * 1024 + 1))
} else if (mode === "combined-output") {
  process.stdout.write("x".repeat(600))
  process.stderr.write("y".repeat(600))
} else if (mode === "malformed") {
  console.log("invalid secret@example.com")
} else if (mode === "descendant") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", windowsHide: true })
  fs.writeFileSync(process.env.TEST_DESCENDANT, String(child.pid))
  child.unref()
  console.log(process.env.TEST_REPORT)
} else {
  if (mode === "delay") await new Promise(resolve => setTimeout(resolve, 150))
  console.log(process.env.TEST_REPORT)
}
`)
  if (isWin) {
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    await fs.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 })
  }
  const env = { ...process.env, TEST_LOG: logPath, TEST_REPORT: JSON.stringify(report([group([bucket()])])), TEST_DESCENDANT: path.join(directory, "descendant"), ...extraEnv }
  return {
    executable, env,
    // agy's stored sign-in can't be read here (signin.mjs is tested on its own)
    options: { env, tempRoot: directory, signIn: async () => ({ state: "unknown" }) },
    async logs() { return (await fs.readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)) },
    // Every pid to see gone after a kill: the spawned children, and the agy
    // each one ran that got as far as logging (on Windows a grandchild under
    // cmd.exe).
    async pids(children) {
      let logs = []
      try { logs = await this.logs() } catch (error) { if (error?.code !== "ENOENT") throw error }
      return [...new Set([...children.map(child => child.pid), ...logs.map(log => log.pid)])]
    },
    async assertClean() { assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith("magpie-agy-usage-")), []) },
  }
}

test("queries only the structured command in a private, restricted workspace and cleans up", async t => {
  const f = await fixture(t, { AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
  const originalSpawn = childProcess.spawn
  const spawns = []
  let result
  try {
    childProcess.spawn = (file, args, options) => {
      spawns.push({ file, args, options })
      return originalSpawn(file, args, options)
    }
    syncBuiltinESMExports()
    result = await fetchUsage(f.executable, f.options)
  } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs.length, 2)
  assert.equal(spawns.length, 2)
  for (const [index, actual] of spawns.entries()) {
    if (actual.file === "taskkill") continue
    if (process.platform !== "win32") {
      assert.equal(actual.file, f.executable)
      assert.deepEqual(actual.args, logs[index].args)
      assert.equal(actual.options.detached, true)
    } else {
      assert.equal(actual.options.detached, false)
    }
    assert.equal(actual.options.windowsHide, true, "usage must hide both version and report child windows")
    assert.deepEqual(actual.options.stdio, ["ignore", "pipe", "pipe"])
    assert.equal(path.basename(actual.options.cwd), path.basename(logs[index].cwd))
    assert.equal(actual.options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "false", "a value the user set is passed on as written")
    assert.equal(actual.options.env.TEST_LOG, f.env.TEST_LOG)
    assert.notEqual(actual.options.env, f.env)
  }
  assert.deepEqual(logs[0].args, ["--version"])
  assert.deepEqual(logs[1].args.slice(0, 6), ["-p", "/usage", "--output-format", "json", "--agent", "magpie-usage"])
  assert.equal(logs[1].args[6], "--print-timeout")
  assert.match(logs[1].args[7], /^\d+s$/)
  for (const log of logs) {
    if (process.platform !== "win32") assert.equal(log.mode, 0o700)
    assert.equal(log.update, "false")
    assert.ok(log.agent.includes("tools: []\nmcpServers: []"))
    assert.equal(log.guard, 1)
    // macOS process.cwd() canonicalizes /var to /private/var.
    assert.equal(path.basename(log.path.split(path.delimiter)[0]), path.basename(log.cwd))
    assert.equal(path.dirname(log.browser), log.path.split(path.delimiter)[0])
    assert.equal(path.basename(log.browser), process.platform === "win32" ? "open.cmd" : "open")
    await assert.rejects(fs.stat(log.cwd), { code: "ENOENT" })
  }
  assert.equal(f.env.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
  await f.assertClean()
})

test("with nothing set, usage children run with auto-update off", async t => {
  const f = await fixture(t)
  const env = { ...f.env }
  for (const key of Object.keys(env)) if (/^agy_cli_disable_auto_update$/i.test(key)) delete env[key]
  const result = await fetchUsage(f.executable, { ...f.options, env })
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs.length, 2)
  for (const log of logs) assert.equal(log.update, "true")
  assert.equal("AGY_CLI_DISABLE_AUTO_UPDATE" in env, false)
})

test("simulated Windows fetches usage with hidden, attached children and a cmd browser guard", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { PATH: "/usr/bin:/bin", Path: "C:\\Windows\\System32" })
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  const originalSpawn = childProcess.spawn
  const spawns = []
  let taskkills = 0
  let result
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" })
    childProcess.spawn = (file, args, options) => {
      if (file === "taskkill") {
        taskkills++
        return { unref() {} }
      }
      spawns.push({ file, args, options })
      return originalSpawn(file, args, options)
    }
    syncBuiltinESMExports()
    result = await fetchUsage(f.executable, f.options)
  } finally {
    Object.defineProperty(process, "platform", descriptor)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs.length, 2)
  assert.equal(spawns.length, 2)
  assert.equal(taskkills, 0, "a clean Windows run must never launch taskkill")
  for (const [index, actual] of spawns.entries()) {
    assert.equal(actual.file, f.executable)
    assert.deepEqual(actual.args, logs[index].args)
    assert.equal(path.basename(actual.options.cwd), path.basename(logs[index].cwd))
    assert.equal(actual.options.detached, false, "Windows children stay attached to the runner")
    assert.equal(actual.options.windowsHide, true)
    assert.equal(actual.options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true")
    assert.ok(!("Path" in actual.options.env), "mixed-case Path must be folded into PATH")
    assert.equal(actual.options.env.PATH, actual.options.cwd + path.delimiter + "/usr/bin:/bin")
  }
  for (const log of logs) {
    assert.equal(log.update, "true")
    assert.equal(path.basename(path.dirname(log.browser)), path.basename(log.cwd))
    assert.equal(path.basename(log.browser), "open.cmd")
    assert.equal(log.browserContent, "@exit /b 1\r\n")
    await assert.rejects(fs.stat(log.cwd), { code: "ENOENT" })
  }
  await f.assertClean()
})

test("simulated Windows timeouts kill the whole tree via taskkill /T /F /PID", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { TEST_MODE: "hang" })
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  let run
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" })
    run = await timedOut(f, {
      // Emulate taskkill termination so the killed child releases its pipes on this POSIX host.
      onTaskkill(args) { try { process.kill(Number(args[3]), "SIGKILL") } catch {} },
    })
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
  const treeKills = run.kills.filter(kill => kill.args[3] === String(run.target.pid))
  assert.equal(treeKills.length, 1)
  assert.deepEqual(treeKills[0].args, ["/T", "/F", "/PID", String(run.target.pid)])
  assert.equal(treeKills[0].options.windowsHide, true)
  // The runner must actually stop both children, not just stop waiting for them.
  for (const pid of await f.pids(run.children)) await waitForPidExit(pid)
  await f.assertClean()
})

test("simulated Windows tree-kills pipe-holding descendants after the CLI parent exits", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { TEST_MODE: "descendant" })
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  const originalSpawn = childProcess.spawn
  const kills = []
  let result
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" })
    childProcess.spawn = (file, args, options) => {
      if (file === "taskkill") {
        kills.push({ args, options })
        // Emulate /T tree termination so the inherited pipe closes on this POSIX host.
        try { process.kill(Number(readFileSync(f.env.TEST_DESCENDANT, "utf8")), "SIGKILL") } catch {}
        try { process.kill(Number(args[3]), "SIGKILL") } catch {}
        return { unref() {} }
      }
      return originalSpawn(file, args, options)
    }
    syncBuiltinESMExports()
    result = await fetchUsage(f.executable, f.options)
  } finally {
    Object.defineProperty(process, "platform", descriptor)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  const treeKills = kills.filter(kill => kill.args[3] === String(logs[1].pid))
  assert.equal(treeKills.length, 1)
  assert.deepEqual(treeKills[0].args, ["/T", "/F", "/PID", String(logs[1].pid)])
  await waitForNotRunning(Number(await fs.readFile(f.env.TEST_DESCENDANT, "utf8")))
  await f.assertClean()
})

test("retries locked-directory removal (EBUSY) until it succeeds", async t => {
  const f = await fixture(t)
  const originalRm = fs.rm
  const attempts = []
  let result
  try {
    fs.rm = async (target, options) => {
      attempts.push(target)
      if (attempts.length <= 2) {
        const error = new Error("EBUSY: directory is locked")
        error.code = "EBUSY"
        throw error
      }
      return originalRm(target, options)
    }
    syncBuiltinESMExports()
    result = await fetchUsage(f.executable, f.options)
  } finally {
    fs.rm = originalRm
    syncBuiltinESMExports()
  }
  assert.equal(result.windows[0].used, 25)
  assert.equal(attempts.length, 3)
  for (const target of attempts) assert.ok(path.basename(target).startsWith("magpie-agy-usage-"))
  await f.assertClean()
})

test("stops retrying locked-directory removal after four attempts without failing the query", async t => {
  const f = await fixture(t)
  const originalRm = fs.rm
  let attempts = 0
  try {
    fs.rm = async () => {
      attempts++
      const error = new Error("EBUSY: directory is locked")
      error.code = "EBUSY"
      throw error
    }
    syncBuiltinESMExports()
    assert.equal((await fetchUsage(f.executable, f.options)).windows[0].used, 25)
  } finally {
    fs.rm = originalRm
    syncBuiltinESMExports()
  }
  assert.equal(attempts, 4)
  const root = path.dirname(f.env.TEST_LOG)
  for (const name of (await fs.readdir(root)).filter(name => name.startsWith("magpie-agy-usage-"))) {
    await fs.rm(path.join(root, name), { recursive: true, force: true })
  }
  await f.assertClean()
})

test("rejects old/unverified versions before any possible model prompt", async t => {
  for (const version of ["1.1.10", "0.9.0", "garbage", "1.3", "1.3.5-beta"]) {
    const f = await fixture(t, { TEST_VERSION: version })
    await assert.rejects(fetchUsage(f.executable, f.options), /1\.1\.11 or later/)
    assert.equal((await f.logs()).length, 1)
    await f.assertClean()
  }
  for (const version of ["1.1.11", "1.2.0", "2.0.0"]) {
    const f = await fixture(t, { TEST_VERSION: version })
    assert.equal((await fetchUsage(f.executable, f.options)).windows.length, 1)
    await f.assertClean()
  }
})

test("only concurrent refreshes share work, and callers cannot mutate each other's data", async t => {
  const f = await fixture(t, { TEST_MODE: "delay" })
  const read = createUsageReader(() => f.executable, f.options)
  const results = await Promise.all([read(), read(), read()])
  assert.equal((await f.logs()).length, 2)
  assert.equal(results[0].signIn, "kept")
  results[0].windows[0].used = 99
  assert.equal(results[1].windows[0].used, 25)
  await read()
  assert.equal((await f.logs()).length, 4)
  await f.assertClean()
})

test("reports sanitized failures and preserves the bridge sign-in; failures back off, then are retried", async t => {
  for (const [message, expected, signIn] of [
    ["Not logged in secret@example.com https://secret.invalid/token", /sign in again/, "expired"],
    ["Eligibility check failed: EOF secret@example.com", /eligibility check failed on a network/, "kept"],
    ["not eligible secret@example.com", /not eligible/, "kept"],
    // Google's 403 #3501 (agy 1.5.9's words, three people on X on 11-16):
    // the account, with what to do about it, not "not eligible"
    ["Eligibility check failed: PERMISSION_DENIED (code 403): You do not have a valid license of this product. Please contact your administrator to request a license. If you are not an enterprise user and believe you are receiving this message as an error, please try using the latest version and logging in again. (#3501). Please log out (/logout) and log back in (/login). secret@example.com", /#3501[\s\S]*\/logout[\s\S]*AGY_ADC_AUTH/, "kept"],
    ["connection refused: secret@example.com https://secret.invalid", /network or proxy/, "kept"],
    ["unrecognized secret@example.com", /could not read usage/, "kept"],
  ]) {
    const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: message })
    let clock = 1_000_000
    const read = createUsageReader(() => f.executable, { ...f.options, now: () => clock })
    const result = await read()
    assert.deepEqual(result.windows, [])
    assert.equal(result.signIn, signIn)
    assert.match(result.error, expected)
    assert.doesNotMatch(result.error, /secret|https:/)
    const runs = (await f.logs()).length
    f.env.TEST_MODE = ""
    // held: agy isn't run again until the backoff ends
    const again = await read()
    assert.deepEqual(again.windows, [])
    assert.equal(again.error, result.error)
    assert.equal((await f.logs()).length, runs)
    clock += 10 * 60 * 1000
    const ok = await read()
    assert.equal(ok.windows.length, 1)
    assert.equal(ok.signIn, signIn === "expired" ? "renewed" : "kept")
    await f.assertClean()
  }
})

const startupAuthLogs = [
  "W1115 15:13:30.249469      10 cache.go:157] error getting token source: You are not logged into Antigravity.",
  "I1115 15:13:30.317328       1 server_oauth.go:226] OAuth: authenticated successfully",
  "I1115 15:13:32.684688       1 printmode.go:411] Print mode: silent auth succeeded",
].join("\n")

test("startup auth diagnostics cannot invalidate a usable sign-in on command failure", async t => {
  for (const [stderr, finalError] of [
    [startupAuthLogs + "\nconnection reset by peer", undefined],
    [startupAuthLogs, "quota request timed out"],
    [startupAuthLogs, undefined],
  ]) {
    forgetStoredSignIn({ dead: true })
    t.after(() => forgetStoredSignIn({ dead: true }))
    const f = await fixture(t, {
      TEST_MODE: "fail", TEST_ERROR: stderr,
      ...(finalError ? { TEST_FAILURE_REPORT: JSON.stringify({ status: "ERROR", error: finalError }) } : {}),
    })
    const stored = { state: "present", fp: "healthy", canRenew: true, expired: false }
    let clock = 0
    const read = createUsageReader(() => f.executable, { ...f.options, signIn: async () => stored, now: () => clock })
    const result = await read()
    assert.equal(result.signIn, "kept")
    f.env.TEST_MODE = ""
    clock += 10 * 60 * 1000
    assert.equal((await read()).windows.length, 1, "same credential must recover without logging in")
  }
})

test("a final structured error takes precedence over contradictory diagnostics", async t => {
  for (const [stderr, error, signIn] of [
    ["Authentication required", "connection reset", "kept"],
    [startupAuthLogs + "\nconnection reset", "Authentication required", "expired"],
    [startupAuthLogs, "invalid_grant: Token has been expired or revoked", "expired"],
  ]) {
    const f = await fixture(t, {
      TEST_MODE: "fail", TEST_ERROR: stderr,
      TEST_FAILURE_REPORT: JSON.stringify({ status: "ERROR", error }),
    })
    assert.equal((await createUsageReader(() => f.executable, f.options)()).signIn, signIn)
  }
  assert.throws(() => parseUsageReport({ status: "ERROR", error: "connection reset", response: "Authentication required" }), e => e.kind !== "auth")
})

test("a timeout with only OAuth diagnostics backs off and recovers with the same sign-in", async t => {
  forgetStoredSignIn({ dead: true })
  t.after(() => forgetStoredSignIn({ dead: true }))
  const f = await fixture(t, { TEST_MODE: "hang", TEST_ERROR: startupAuthLogs })
  const stored = { state: "present", fp: "refreshing", canRenew: true, expired: true }
  let clock = 0
  const read = createUsageReader(() => f.executable, { ...f.options, timeoutMs: process.platform === "win32" ? 10000 : 3000, now: () => clock, signIn: async () => stored })
  assert.equal((await read()).signIn, "kept")
  const runs = (await f.logs()).length
  assert.equal(runs, 2, "the report child must have started")
  assert.equal((await read()).signIn, "kept")
  assert.equal((await f.logs()).length, runs)
  f.env.TEST_MODE = ""
  clock += 10 * 60 * 1000
  assert.equal((await read()).windows.length, 1)
  await f.assertClean()
})

test("backoff doubles per failure up to six hours", async t => {
  const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "unrecognized" })
  let clock = 0
  const read = createUsageReader(() => f.executable, { ...f.options, now: () => clock })
  const minute = 60 * 1000
  const runs = async () => (await f.logs()).filter(l => l.args[0] !== "--version").length
  await read()
  for (const wait of [10, 20, 40, 80, 160, 320, 360, 360]) {
    const before = await runs()
    clock += (wait - 1) * minute
    await read()
    assert.equal(await runs(), before, `run again before ${wait} minutes`)
    clock += minute
    await read()
    assert.equal(await runs(), before + 1, `not run again after ${wait} minutes`)
  }
  await f.assertClean()
})

test("never runs agy while it has no stored sign-in, or one that ended with nothing to renew it", async t => {
  const f = await fixture(t)
  const ended = { state: "present", fp: "a", canRenew: false, expiresAt: 1, expired: true }
  for (const stored of [{ state: "missing" }, ended]) {
    let reads = 0
    const read = createUsageReader(() => f.executable, { ...f.options, signIn: async () => { reads++; return stored } })
    for (let i = 0; i < 3; i++) {
      const result = await read()
      assert.deepEqual(result.windows, [])
      assert.equal(result.signIn, "expired")
      assert.match(result.error, /sign in again|Sign in again/i)
    }
    assert.equal(reads, 3)
  }
  await assert.rejects(f.logs(), { code: "ENOENT" })
  // signing in again: agy runs, and the sign-in reads as renewed
  let stored = { state: "missing" }
  const read = createUsageReader(() => f.executable, { ...f.options, signIn: async () => stored })
  assert.equal((await read()).signIn, "expired")
  stored = { state: "present", fp: "b", canRenew: true, expiresAt: 0, expired: false }
  const back = await read()
  assert.equal(back.windows.length, 1)
  assert.equal(back.signIn, "renewed")
  assert.equal((await read()).signIn, "kept")
  await f.assertClean()
})

test("a sign-in agy failed on isn't run again in the background until another is stored", async t => {
  forgetStoredSignIn({ dead: true })
  t.after(() => forgetStoredSignIn({ dead: true }))
  const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "You are not logged in. Please sign in." })
  let clock = 0
  let stored = { state: "present", fp: "old", canRenew: true, expiresAt: 0, expired: false }
  const read = createUsageReader(() => f.executable, { ...f.options, now: () => clock, signIn: async () => stored })
  assert.equal((await read()).signIn, "expired")
  const runs = (await f.logs()).length
  f.env.TEST_MODE = ""
  clock += 7 * 60 * 60 * 1000
  const held = await read()
  assert.equal(held.signIn, "expired")
  assert.equal((await f.logs()).length, runs)
  stored = { ...stored, fp: "new", expired: false }
  const back = await read()
  assert.equal(back.windows.length, 1)
  assert.equal(back.signIn, "renewed")
  await f.assertClean()
})

test("a hung sign-in with an ended token is never restarted until the credential changes", async t => {
  for (const output of ["", "Open https://accounts.google.com/ to sign in", startupAuthLogs + "\nWaiting for browser authentication"]) {
    forgetStoredSignIn({ dead: true })
    t.after(() => forgetStoredSignIn({ dead: true }))
    const f = await fixture(t, { TEST_MODE: "hang", TEST_ERROR: output })
    let stored = { state: "present", fp: "hung", canRenew: true, expired: true }
    let clock = 0
    const read = createUsageReader(() => f.executable, { ...f.options, timeoutMs: process.platform === "win32" ? 10000 : 3000, now: () => clock, signIn: async () => stored })
    assert.equal((await read()).signIn, "expired")
    const runs = (await f.logs()).length
    assert.equal(runs, 2, "the report child must have started")
    f.env.TEST_MODE = ""
    for (const hours of [0, 7, 24]) {
      clock = hours * 60 * 60 * 1000
      assert.equal((await read()).signIn, "expired")
      assert.equal((await f.logs()).length, runs, "background polling must not reopen the browser")
    }
    stored = { ...stored, fp: "signed-in-again", expired: false }
    const result = await read()
    assert.equal(result.signIn, "renewed")
    assert.equal(result.windows.length, 1)
    await f.assertClean()
  }
})

test("a timeout with a live access token preserves the sign-in", async t => {
  const f = await fixture(t, { TEST_MODE: "hang", TEST_ERROR: "Waiting for browser authentication" })
  const live = { state: "present", fp: "live", canRenew: true, expiresAt: Date.now() + 3600_000, expired: false }
  const result = await createUsageReader(() => f.executable, { ...f.options, timeoutMs: process.platform === "win32" ? 10000 : 3000, signIn: async () => live })()
  assert.equal(result.signIn, "kept")
  await f.assertClean()
})

test("invalid and oversized stdout/stderr reports fail within the output budget", async t => {
  for (const [mode, expected, maxOutputBytes] of [
    ["malformed", /invalid usage report/, undefined],
    ["oversize", /size limit/, undefined],
    ["combined-output", /size limit/, 1000],
  ]) {
    const f = await fixture(t, { TEST_MODE: mode })
    await assert.rejects(fetchUsage(f.executable, { ...f.options, ...(maxOutputBytes ? { maxOutputBytes } : {}) }), expected)
    await f.assertClean()
  }
})

test("version/report hangs time out, terminate the process, and leave no workspace", async t => {
  for (const mode of ["version-hang", "hang"]) {
    const f = await fixture(t, { TEST_MODE: mode })
    const run = await timedOut(f, { version: mode === "version-hang" })
    // The runner must actually stop the child, not just stop waiting for it.
    for (const pid of await f.pids(run.children)) await waitForPidExit(pid)
    await f.assertClean()
  }
})

test("cancellation stops a running report and cleans its private workspace", async t => {
  const f = await fixture(t, { TEST_MODE: "hang" })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), process.platform === "win32" ? 1500 : 600)
  try {
    await assert.rejects(fetchUsage(f.executable, { ...f.options, signal: controller.signal }), /cancelled/)
  } finally { clearTimeout(timer) }
  await f.assertClean()
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(fetchUsage(f.executable, { ...f.options, signal: alreadyAborted.signal }), /cancelled/)
  await f.assertClean()
})

test("terminates owned pipe-inheriting descendants even when the CLI parent already exited", async t => {
  const f = await fixture(t, { TEST_MODE: "descendant" })
  await fetchUsage(f.executable, f.options)
  const pid = Number(await fs.readFile(f.env.TEST_DESCENDANT, "utf8"))
  if (process.platform === "win32") {
    await waitForPidExit(pid)
  } else {
    await waitForNotRunning(pid)
  }
  await f.assertClean()
})

test("missing executables and filesystem failures do not leak local paths", async t => {
  const f = await fixture(t)
  for (const executable of [null, path.join(f.env.TEST_LOG, "missing")]) {
    const result = await createUsageReader(() => executable, f.options)()
    assert.equal(result.windows.length, 0)
    assert.ok(result.error)
    assert.doesNotMatch(result.error, /agy-usage-test-/)
    await f.assertClean()
  }
  const result = await createUsageReader(() => f.executable, { ...f.options, tempRoot: f.executable })()
  assert.ok(result.error)
  assert.doesNotMatch(result.error, /agy-usage-test-/)
})

// ---- an account agy refuses for its region (01dadada on X) -----------------
//
// agy 1.5.9's own answer when loadCodeAssist names an ineligible tier
// (UNSUPPORTED_LOCATION) and no current one, captured 2026-11-16 through
// CLOUD_CODE_URL; its own retrieveUserQuotaSummary had answered 200.
const REFUSED = JSON.stringify({
  conversation_id: "", status: "ERROR", response: "",
  error: "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.",
  duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, thinking_tokens: 0 },
  finished_reason: "error",
})
// Its loadCodeAssist and retrieveUserQuotaSummary replies (trimmed).
const LOAD = {
  allowedTiers: [{ id: "free-tier", name: "Antigravity", isDefault: true }],
  ineligibleTiers: [{ reasonCode: "UNSUPPORTED_LOCATION", reasonMessage: "Your current account is not eligible for Antigravity, because it is not currently available in your location." }],
  cloudaicompanionProject: "aicode-consumers",
}
const SUMMARY = {
  groups: [{
    displayName: "Gemini Models",
    description: "Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash",
    buckets: [
      { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-22T11:19:33Z", remainingFraction: 0.75 },
      { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-11-16T16:19:33Z", remainingFraction: 0.5 },
    ],
  }],
}
const STORED = { token: { access_token: "ya29.live", refresh_token: "1//refresh", expiry: "0001-01-01T00:00:00Z", token_type: "Bearer" }, auth_method: "consumer", id_token_email: "secret@example.com" }

async function codeAssist(t, answer = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", c => { body += c })
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || "null") })
      const name = req.url.replace(/^\/v1internal:/, "")
      const [status, reply] = answer[name] ?? [200, name === "loadCodeAssist" ? LOAD : SUMMARY]
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise(r => server.listen(0, "127.0.0.1", r))
  t.after(() => new Promise(r => server.close(r)))
  return { url: `http://127.0.0.1:${server.address().port}`, calls }
}

test("an account agy refuses for its region has its quota read the way agy reads it", async t => {
  const api = await codeAssist(t)
  const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "", TEST_FAILURE_REPORT: REFUSED, TEST_VERSION: "1.5.9", CLOUD_CODE_URL: api.url })
  const quota = o => readQuotaDirect({ ...o, stored: async () => STORED })
  const result = await createUsageReader(() => f.executable, { ...f.options, quota })()
  assert.equal(result.error, undefined)
  assert.equal(result.signIn, "kept")
  assert.deepEqual(result.windows.map(w => [w.name, w.used, w.resetsAt]), [
    ["Gemini · 7 days", 25, "2026-11-22T11:19:33.000Z"],
    ["Gemini · 5 hours", 50, "2026-11-16T16:19:33.000Z"],
  ])
  // the two requests agy makes, as it makes them
  assert.deepEqual(api.calls.map(c => [c.method, c.url, c.body]), [
    ["POST", "/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }],
    ["POST", "/v1internal:retrieveUserQuotaSummary", { project: "aicode-consumers" }],
  ])
  for (const c of api.calls) {
    assert.equal(c.headers.authorization, "Bearer ya29.live")
    assert.equal(c.headers["content-type"], "application/json")
    assert.equal(c.headers["user-agent"], quotaUserAgent("1.5.9", "consumer"))
  }
  await f.assertClean()
})

test("the direct read's User-Agent is agy's", () => {
  assert.equal(quotaUserAgent("1.5.9", "consumer", "darwin", "arm64"),
    "antigravity/cli/1.5.9 (aidev_client; os_type=darwin; arch=arm64; cl=1021519450; auth_method=consumer)")
  assert.match(quotaUserAgent("1.6.0", "", "win32", "x64"), /^antigravity\/cli\/1\.6\.0 \(aidev_client; os_type=windows; arch=amd64; cl=\d+; auth_method=consumer\)$/)
})

test("an access token about to end is renewed in memory for the direct read, never stored", async t => {
  const api = await codeAssist(t)
  const renewals = []
  const fetchFn = async (url, init) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      renewals.push(Object.fromEntries(new URLSearchParams(init.body)))
      return new Response(JSON.stringify({ access_token: "ya29.fresh", expires_in: 3599 }), { status: 200 })
    }
    return fetch(url, init)
  }
  const ending = structuredClone(STORED)
  ending.token.expiry = new Date(Date.now() + 30_000).toISOString()
  const data = await readQuotaDirect({ env: { CLOUD_CODE_URL: api.url }, version: "1.5.9", deadline: Date.now() + 5000, stored: async () => ending, fetch: fetchFn })
  assert.deepEqual(data, SUMMARY)
  assert.equal(renewals.length, 1)
  assert.equal(renewals[0].grant_type, "refresh_token")
  assert.equal(renewals[0].refresh_token, "1//refresh")
  assert.ok(api.calls.every(c => c.headers.authorization === "Bearer ya29.fresh"))
  assert.equal(ending.token.access_token, "ya29.live")
})

test("a direct read that fails leaves the region refusal standing: unknown, never zero or full", async t => {
  for (const [answer, stored] of [
    [{ retrieveUserQuotaSummary: [403, { error: { code: 403, message: "secret@example.com" } }] }, STORED],
    [{ loadCodeAssist: [200, { ...LOAD, cloudaicompanionProject: undefined }] }, STORED],
    [{ retrieveUserQuotaSummary: [200, { groups: [] }] }, STORED],
    [{}, null],
  ]) {
    const api = await codeAssist(t, answer)
    const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "", TEST_FAILURE_REPORT: REFUSED, TEST_VERSION: "1.5.9", CLOUD_CODE_URL: api.url })
    const quota = o => readQuotaDirect({ ...o, stored: async () => stored })
    const result = await createUsageReader(() => f.executable, { ...f.options, quota })()
    assert.deepEqual(result.windows, [])
    assert.equal(result.signIn, "kept")
    assert.match(result.error, /not eligible/)
    assert.doesNotMatch(result.error, /secret/)
  }
})

// plugins#1234 (qiankun229): agy run for usage with an ended access token
// renews it first, and when that failed for a moment (a DNS miss at
// Windows startup, a 10s keyring timeout) it opened Google's sign-in in the
// browser. With such a token agy -p isn't run: the quota is read directly.
test("an ended or ending access token with a refresh token is read without running agy -p", async t => {
  for (const ends of [1, 1_000_000 + 60_000]) {
    const f = await fixture(t, { TEST_VERSION: "1.5.9" })
    const asked = []
    const quota = async o => { asked.push(o.version); return SUMMARY }
    const stored = { state: "present", fp: "ended", canRenew: true, expiresAt: ends, expired: ends === 1 }
    const read = createUsageReader(() => f.executable, { ...f.options, quota, now: () => 1_000_000, signIn: async () => stored })
    const result = await read()
    assert.equal(result.error, undefined)
    assert.equal(result.signIn, "kept")
    assert.equal(result.windows.length, 2)
    assert.deepEqual(asked, ["1.5.9"])
    assert.deepEqual((await f.logs()).map(l => l.args[0]), ["--version"])
    await f.assertClean()
  }
  // a token with time left still goes through agy
  const f = await fixture(t)
  let asked = 0
  const stored = { state: "present", fp: "live", canRenew: true, expiresAt: 1_000_000 + 10 * 60_000, expired: false }
  const read = createUsageReader(() => f.executable, { ...f.options, quota: async () => { asked++; return SUMMARY }, now: () => 1_000_000, signIn: async () => stored })
  assert.equal((await read()).windows.length, 1)
  assert.equal(asked, 0)
  assert.deepEqual((await f.logs()).map(l => l.args[0]), ["--version", "-p"])
})

test("a renewal that fails for a moment backs off and keeps the sign-in; one Google refuses asks for a new sign-in", async t => {
  forgetStoredSignIn({ dead: true })
  t.after(() => forgetStoredSignIn({ dead: true }))
  const f = await fixture(t)
  let clock = 1_000_000
  let fail = () => { throw new TypeError("fetch failed: getaddrinfo ENOTFOUND oauth2.googleapis.com") }
  let asked = 0
  const quota = async () => { asked++; return fail() }
  const stored = { state: "present", fp: "blip", canRenew: true, expiresAt: 1, expired: true }
  const read = createUsageReader(() => f.executable, { ...f.options, quota, now: () => clock, signIn: async () => stored })
  const first = await read()
  assert.equal(first.signIn, "kept")
  assert.match(first.error, /network or proxy/)
  assert.equal((await read()).signIn, "kept")
  assert.equal(asked, 1, "held until the backoff ends")
  clock += 10 * 60 * 1000
  fail = () => SUMMARY
  const back = await read()
  assert.equal(back.windows.length, 2)
  assert.equal(back.signIn, "kept")
  assert.ok((await f.logs()).every(l => l.args[0] === "--version"), "agy -p never ran")
  // Google refusing the refresh token: the sign-in is over, and nothing runs for it again
  const refused = { ...stored, fp: "revoked" }
  const api = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 })
  const ended = structuredClone(STORED)
  ended.token.expiry = new Date(Date.now() - 60_000).toISOString()
  const read2 = createUsageReader(() => f.executable, {
    ...f.options, now: () => clock, signIn: async () => refused,
    quota: o => readQuotaDirect({ ...o, stored: async () => ended, fetch: api }),
  })
  const over = await read2()
  assert.equal(over.signIn, "expired")
  assert.match(over.error, /Sign in again/)
  clock += 7 * 60 * 60 * 1000
  assert.equal((await read2()).signIn, "expired")
  await f.assertClean()
})

test("the direct read's renewal: invalid_grant is a sign-in that no longer works, anything else a failed read", async t => {
  const ended = structuredClone(STORED)
  ended.token.expiry = new Date(Date.now() - 60_000).toISOString()
  for (const [status, body, kind] of [
    [400, { error: "invalid_grant" }, "auth"],
    [401, { error: "invalid_grant" }, "auth"],
    [400, { error: "invalid_request" }, ""],
    [503, { error: "backendError" }, ""],
    [500, "not json", ""],
  ]) {
    const fetchFn = async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
    await assert.rejects(readQuotaDirect({ env: {}, version: "1.5.9", deadline: Date.now() + 5000, stored: async () => ended, fetch: fetchFn }),
      e => e.kind === kind && /sign-in/.test(e.message), `${status} ${JSON.stringify(body)}`)
  }
})

test("only a region refusal reads the quota directly", async t => {
  for (const error of [
    "Eligibility check failed: EOF",
    "Authentication required",
    "quota request timed out",
  ]) {
    let asked = 0
    const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "", TEST_FAILURE_REPORT: JSON.stringify({ status: "ERROR", error }) })
    const result = await createUsageReader(() => f.executable, { ...f.options, quota: async () => { asked++; return SUMMARY } })()
    assert.deepEqual(result.windows, [])
    assert.equal(asked, 0, error)
  }
})

test("agyRefusal: Google turning the account away, never a network failure or agy's own log lines", () => {
  const license = "Error: Eligibility check failed: PERMISSION_DENIED (code 403): You do not have a valid license of this product. ... (#3501). Please log out (/logout) and log back in (/login)."
  const disabled = "PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."
  assert.match(agyRefusal(license), /#3501/)
  assert.match(agyRefusal("error: something (#3501)"), /#3501/)
  assert.match(agyRefusal(disabled), /disabled this account's access[\s\S]*Terms of Service[\s\S]*appeal/)
  assert.match(agyRefusal(disabled.replace(" This service", "\nThis service")), /disabled this account's access/)
  assert.match(agyRefusal("Error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location."), /not currently available in your location[\s\S]*VPN/)
  for (const other of [
    "",
    "Error: Eligibility check failed: EOF",
    "Error: Eligibility check failed: dial tcp: lookup cloudcode-pa.googleapis.com: no such host",
    "Error: You are not logged into Antigravity.",
    // a background poll agy logged failing, while the command itself failed otherwise
    "E1116 10:34:12.084405     248 errorreport.go:307] Failed to poll ListExperiments: PERMISSION_DENIED (code 403): You do not have a valid license of this product. (#3501)\nError: something else",
    "PERMISSION_DENIED (code 403): Request had invalid credentials.",
    "This service has been disabled in this account for violation of Terms of Service.",
  ]) assert.equal(agyRefusal(other), "", other)
})

// Google's VALIDATION_REQUIRED at agy's eligibility check, in agy 1.5.9's
// words (AuthStatus.EligibilityError, IneligibilityFromResult): the link
// agy prints goes to the user whole, in the words magpie's gateway reads as
// a verification (provider.verifyAdvice, verifyLink), never the VPN advice.
test("agyRefusal: an account Google wants verified gets the link agy printed, or where to verify", () => {
  const link = "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsbv"
  const linked = `Error: Eligibility check failed: Verify your account to continue.\n\nPlease verify your account in your browser to continue:\n${link}\n`
  const said = agyRefusal(linked)
  assert.ok(said.includes(`this Google account needs to be verified: open ${link} in a browser`), said)
  assert.doesNotMatch(said, /VPN/)
  assert.equal(verifyLinkIn(linked.replace(/\n/g, "\r\n")), link)
  for (const bare of [
    "Error: Eligibility check failed: Verification required. Please complete verification in your browser to continue.",
    "Error: Eligibility check failed: Verify your account to continue.",
  ]) {
    const why = agyRefusal(bare)
    assert.match(why, /this Google account needs to be verified: open the Antigravity app, or run `agy` in a terminal/, bare)
    assert.doesNotMatch(why, /https:/)
  }
})

test("verifyLinkIn: Google's validation link from a logged error, validation_link first, https only", () => {
  const body = '{"error":{"code":403,"message":"Verify your account to continue.","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/signin/continue?sarp=1\\u0026x=2","validation_link":"https://accounts.google.com/v?a=1\\u0026b=2"}}]}}'
  assert.equal(verifyLinkIn(body), "https://accounts.google.com/v?a=1&b=2")
  assert.equal(verifyLinkIn(body.replace(/,"validation_link":"[^"]+"/, "")), "https://accounts.google.com/signin/continue?sarp=1&x=2")
  assert.equal(verifyLinkIn('validation_url: "http://example.com/x"'), "")
  assert.equal(verifyLinkIn("Verification Required"), "")
})
