import assert from "node:assert/strict"
import childProcess, { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { agyRefusal, createUsageReader, DUE_FOR_RENEWAL, fetchUsage, GATEWAY_NO_FOLDER, parseStatusLineQuota, parseUsageReport, STILL_READING, verifyLinkIn } from "../usage.mjs"
import { catalogRows, familiesInGroup, modelsInGroup, storeCatalogRows } from "../model-ids.mjs"
import { inAccount } from "../account.mjs"
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
  const pools = result.windows.filter(w => !w.model)
  assert.deepEqual(pools.map(w => [w.pool, w.name]), [
    ["Gemini", "7 days"], ["Gemini", "5 hours"], ["Claude & GPT", "7 days"], ["Claude & GPT", "5 hours"], ["Gemini 4 Argon", "7 days"],
  ])
  assert.deepEqual(pools.map(w => w.models), [
    ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-4-hydrogen", "gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh"],
    ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-4-hydrogen", "gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh"],
    ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "gpt-oss-120b", "gpt-oss-120b-medium"],
    ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "gpt-oss-120b", "gpt-oss-120b-medium"],
    // Argon's description names no model; its group name is a catalog name.
    ["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-argon-medium"],
  ])
  assert.deepEqual(pools.map(w => w.used), [0, 0, 66.394961, 0, 0])
  // agy names a family in the description even though it lists no bare id.
  assert.ok(pools[2].models.includes("gpt-oss-120b"))
  // the pools' windows are set aside: they hold their models at a cap
  assert.ok(pools.every(w => w.aside === true))
  storeCatalogRows(null)
})

// will930128 on X: an Opus 5.5 routing group showed the agy-cli account's
// share as not known, last behind every account known, while its card
// showed Claude & GPT's 5 hours and 7 days. Every window was aside, so
// magpie's routing had none to weigh it by.
test("a model's own window is not set aside, so routing weighs the account by it", () => {
  storeCatalogRows(LIVE_MODEL_ROWS)
  const result = parseUsageReport(structuredClone(LIVE_REPORT))
  const own = result.windows.filter(w => w.model)
  assert.equal(own.length, 6)
  assert.ok(own.every(w => !w.aside && w.used !== undefined && w.models.length > 0))
  const opus = own.find(w => w.model === "claude-opus-5-5")
  assert.deepEqual([opus.pool, opus.used, opus.aside], ["Claude & GPT", 66.394961, undefined])
  assert.ok(opus.models.includes("claude-opus-5-5-high"))
  storeCatalogRows(null)
})

test("each model family a group names has its own window in the pool, at the pool's most used bucket", () => {
  storeCatalogRows(LIVE_MODEL_ROWS)
  const result = parseUsageReport(structuredClone(LIVE_REPORT))
  const own = result.windows.filter(w => w.model)
  assert.deepEqual(own.map(w => [w.name, w.model, w.family, w.pool, w.used, w.span, w.resetsAt]), [
    ["Claude Opus 5.5", "claude-opus-5-5", "Claude", "Claude & GPT", 66.394961, 604800, "2026-11-20T09:01:10.000Z"],
    ["Claude Sonnet 5.5", "claude-sonnet-5-5", "Claude", "Claude & GPT", 66.394961, 604800, "2026-11-20T09:01:10.000Z"],
    ["Gemini 3.8 Flash", "gemini-3.8-flash", "Gemini", "Gemini", 0, 604800, "2026-11-22T11:19:33.000Z"],
    ["Gemini 4 Argon", "gemini-4-argon", "Gemini", "Gemini 4 Argon", 0, 604800, "2026-11-22T11:19:33.000Z"],
    ["Gemini 4 Hydrogen", "gemini-4-hydrogen", "Gemini", "Gemini", 0, 604800, "2026-11-22T11:19:33.000Z"],
    ["GPT-OSS 120B", "gpt-oss-120b", "GPT-OSS", "Claude & GPT", 66.394961, 604800, "2026-11-20T09:01:10.000Z"],
  ])
  // a model's window names every id of its family, effort levels too
  assert.deepEqual(own[0].models, ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium"])
  // the models' windows come first, then the pools', as the antigravity plugin sent them
  assert.ok(result.windows.slice(0, own.length).every(w => w.model))

  // the 5 hours used more than the week: a model reads the 5 hours
  const busy = structuredClone(LIVE_REPORT)
  busy.command.data.groups[0].buckets[1].remaining_fraction = 0.25
  const flash = parseUsageReport(busy).windows.find(w => w.model === "gemini-3.8-flash")
  assert.deepEqual([flash.used, flash.span, flash.resetsAt], [75, 18000, "2026-11-15T16:19:33.000Z"])

  // a model two groups name reads the one that stops it first
  const twice = structuredClone(LIVE_REPORT)
  twice.command.data.groups[2].description = "Models within this group: Gemini 4 Argon, Gemini 3.8 Flash"
  twice.command.data.groups[2].buckets[0].remaining_fraction = 0.4
  const again = parseUsageReport(twice).windows.find(w => w.model === "gemini-3.8-flash")
  assert.deepEqual([again.pool, again.used], ["Gemini 4 Argon", 60])

  // a pool whose buckets say no share: its models get no window, not a guess
  const blind = structuredClone(LIVE_REPORT)
  for (const b of blind.command.data.groups[1].buckets) delete b.remaining_fraction
  assert.ok(!parseUsageReport(blind).windows.some(w => w.model && w.pool === "Claude & GPT"))
  storeCatalogRows(null)

  // no catalog: the pools' windows alone
  assert.ok(!parseUsageReport(structuredClone(LIVE_REPORT)).windows.some(w => w.model))
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

test("catalogRows and nameIndex stay isolated per account", () => {
  const ultra = [
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", effort: "high" },
    { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", effort: "low" },
    { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", effort: "high" },
  ]
  const pro = [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", effort: "high" },
  ]
  const claudeGroup = { description: "Models within this group: Claude Sonnet 5.5, Claude Sonnet 4.6" }
  const homeA = "/tmp/agy-test-home-a"
  const homeB = "/tmp/agy-test-home-b"
  try {
    storeCatalogRows(ultra)
    inAccount(homeA, () => storeCatalogRows(pro))
    inAccount(homeB, () => storeCatalogRows([{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" }]))

    assert.deepEqual(catalogRows().map(r => r.id), ultra.map(r => r.id))
    assert.deepEqual(modelsInGroup(claudeGroup), ["claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-low"])
    assert.deepEqual(inAccount(homeA, () => catalogRows().map(r => r.id)), pro.map(r => r.id))
    assert.deepEqual(inAccount(homeA, () => modelsInGroup(claudeGroup)), ["claude-sonnet-4-6"])
    assert.deepEqual(inAccount(homeA, () => familiesInGroup(claudeGroup).map(f => f.id)), ["claude-sonnet-4-6"])
    assert.deepEqual(inAccount(homeB, () => modelsInGroup(claudeGroup)), [])

    // Clearing one account does not clear the others.
    inAccount(homeA, () => storeCatalogRows(null))
    assert.equal(inAccount(homeA, () => catalogRows()), null)
    assert.deepEqual(inAccount(homeA, () => modelsInGroup(claudeGroup)), [])
    assert.deepEqual(modelsInGroup(claudeGroup), ["claude-sonnet-5-5", "claude-sonnet-5-5-high", "claude-sonnet-5-5-low"])
    assert.deepEqual(inAccount(homeB, () => catalogRows().map(r => r.id)), ["gemini-3.8-flash-high"])
  } finally {
    storeCatalogRows(null)
    inAccount(homeA, () => storeCatalogRows(null))
    inAccount(homeB, () => storeCatalogRows(null))
  }
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
  assert.deepEqual(result.windows.map(w => w.pool + " · " + w.name), ["Gemini · 5 hours", "Gemini · 7 days", "Claude & GPT · 5 hours", "Claude & GPT · 7 days", "Gemini 4 Argon · 7 days"])
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
  for (let timeoutMs = 600; ; timeoutMs *= 2) {
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
        children.push({ pid: child.pid })
        return child
      }
      syncBuiltinESMExports()
      await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs }), /didn't (?:say its version|finish) in \d/)
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

async function fixture(t, extraEnv = {}) {
  const isWin = process.platform === "win32"
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-test-"))
  t.after(async () => {
    for (let i = 0; i < 6; i++) {
      try { await fs.rm(directory, { recursive: true, force: true }); break }
      catch { await new Promise(r => setTimeout(r, 50)) }
    }
  })
  const script = path.join(directory, "fake.mjs")
  const executable = path.join(directory, isWin ? "agy.cmd" : "agy")
  const logPath = path.join(directory, "calls.jsonl")
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
// plugins#1602: print mode refuses at the eligibility check (agy 1.5.18's
// bytes); agy acp's session/new names TEST_TIER; the TUI, in a terminal,
// asks for the cursor first and then hands its statusLine command agy's
// payloads, TEST_QUOTA in the second.
if (mode === "eligibility" && !version) {
  const note = extra => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ pid: process.pid, ...extra }) + "\n")
  if (args[0] === "acp") {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", chunk => {
      buf += chunk
      let n
      while ((n = buf.indexOf("\n")) >= 0) {
        const message = JSON.parse(buf.slice(0, n))
        buf = buf.slice(n + 1)
        note({ acp: message.method })
        const result = message.method === "initialize"
          ? { protocolVersion: 1, agentCapabilities: { _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } }, agentInfo: { name: "Antigravity ACP Server", version: "1.5.18" } }
          : { sessionId: "d622672b-c237-40d5-9037-7861087f972f", ...(process.env.TEST_TIER ? { _meta: { antigravity: { tier: JSON.parse(process.env.TEST_TIER) } } } : {}) }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
      }
    })
  } else if (args.includes("-p")) {
    console.log(JSON.stringify({ conversation_id: "", status: "ERROR", response: "", error: "Eligibility check failed: Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.", duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: "error" }))
    console.error("error: Eligibility check failed: Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.")
    process.exitCode = 1
    process.exit()
  } else {
    const settings = JSON.parse(args[args.indexOf("--settings") + 1])
    note({ tty: Boolean(process.stdin.isTTY && process.stdout.isTTY), settings })
    process.stdin.setRawMode?.(true)
    process.stdout.write("\x1b[6n")
    let heard = ""
    process.stdin.on("data", chunk => {
      heard += chunk
      if (!heard.includes("\x1b[1;1R") || heard.includes("done")) return
      heard += "done"
      note({ answered: true })
      const payload = state => JSON.stringify({ cwd: process.cwd(), version: "1.5.18", product: "antigravity", agent_state: state, terminal_width: 120 })
      spawnSync("/bin/sh", ["-c", settings.statusLine.command], { input: payload("authenticating") })
      if (process.env.TEST_QUOTA) {
        const quota = JSON.parse(payload("initializing"))
        quota.quota = JSON.parse(process.env.TEST_QUOTA)
        spawnSync("/bin/sh", ["-c", settings.statusLine.command], { input: JSON.stringify(quota) })
      }
    })
  }
  setInterval(() => {}, 1000)
} else if (mode === "version-hang" && version || mode === "hang" && !version) {
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
  if (mode === "delay") await new Promise(resolve => setTimeout(resolve, Number(process.env.TEST_REPORT_DELAY_MS) || 150))
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
    // agy's stored sign-in can't be read here (signin.mjs is tested on its
    // own)
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

// plugins#1591 (I-am-c, agy 1.5.18): with magpie's Antigravity takeover on,
// ~/.gemini/config/config.json holds the app's gateway, agy reads it, and on
// a gateway its /usage answers SUCCESS with no groups: "agy returned no
// enabled, measured quota buckets". The read goes to a folder without it.
test("with the app's gateway on, /usage reads a folder without it (--gemini_dir), and the reader passes it on", async t => {
  const f = await fixture(t)
  const folder = path.join(path.dirname(f.env.TEST_LOG), "agy-own")
  const asked = []
  const geminiDir = async (agy) => { asked.push(agy); return { gateway: true, dir: folder } }
  const result = await fetchUsage(f.executable, { ...f.options, geminiDir })
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.deepEqual(logs[0].args, ["--version"])
  assert.deepEqual(logs[1].args.slice(0, 8), ["--gemini_dir", folder, "-p", "/usage", "--output-format", "json", "--agent", "magpie-usage"])
  assert.deepEqual(asked, [f.executable])
  // createUsageReader hands the folder to the read it runs
  const read = createUsageReader(async () => f.executable, { ...f.options, geminiDir })
  await read()
  const again = await f.logs()
  assert.deepEqual(again.at(-1).args.slice(0, 3), ["--gemini_dir", folder, "-p"])
})

test("with the app's gateway off, /usage runs on agy's own folder as before", async t => {
  const f = await fixture(t)
  await fetchUsage(f.executable, { ...f.options, geminiDir: async () => ({ gateway: false, dir: null }) })
  const logs = await f.logs()
  assert.deepEqual(logs[1].args.slice(0, 2), ["-p", "/usage"])
  assert.ok(!logs[1].args.some(arg => /gemini[-_]dir/.test(arg)))
})

test("a gateway agy can't be pointed past says why and runs no agy", async t => {
  const f = await fixture(t)
  await assert.rejects(fetchUsage(f.executable, { ...f.options, geminiDir: async () => ({ gateway: true, dir: null }) }), error => error.message === GATEWAY_NO_FOLDER)
  await assert.rejects(f.logs(), { code: "ENOENT" })
  await f.assertClean()
})

test("an agy that doesn't know --gemini_dir is asked to update, not read as signed out", async t => {
  const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "flags provided but not defined: -gemini_dir\nUsage of agy:" })
  await assert.rejects(fetchUsage(f.executable, { ...f.options, geminiDir: async () => ({ gateway: true, dir: path.join(path.dirname(f.env.TEST_LOG), "agy-own") }) }), error => error.message === GATEWAY_NO_FOLDER)
  await f.assertClean()
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
  // the next refresh reads quota again; agy's --version answer is kept for
  // its binary (plugins#1544)
  assert.deepEqual((await f.logs()).map((call) => call.args[0]), ["--version", "-p", "-p"])
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

// tmr11235 on X (magpie v0.1.4520): the account's usage said "agy CLI not
// found" while its chats ran through agy. A read made before agy was there
// was held for the backoff, which grows to hours; agy found since is read
// at once, and a failure held for one agy isn't another's.
test("no agy found is not held: an agy found since is read at once", async t => {
  const f = await fixture(t)
  let agy = null
  const clock = 1_000_000
  const read = createUsageReader(() => agy, { ...f.options, now: () => clock })
  for (let i = 0; i < 3; i++) {
    const missing = await read()
    assert.deepEqual(missing.windows, [])
    assert.equal(missing.signIn, "kept")
    assert.match(missing.error, /agy CLI not found[\s\S]*Sign in to this account again/)
  }
  agy = f.executable
  const found = await read()
  assert.equal(found.error, undefined)
  assert.equal(found.windows.length, 1)
  await f.assertClean()
})

test("a failure held for one agy is not another agy's", async t => {
  const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "connection refused" })
  let agy = f.executable
  const clock = 1_000_000
  const read = createUsageReader(() => agy, { ...f.options, now: () => clock })
  assert.match((await read()).error, /network or proxy/)
  f.env.TEST_MODE = ""
  assert.match((await read()).error, /network or proxy/, "the same agy is held")
  const other = path.join(path.dirname(f.executable), "agy2" + path.extname(f.executable))
  await fs.copyFile(f.executable, other)
  await fs.chmod(other, 0o755)
  agy = other
  assert.equal((await read()).windows.length, 1)
  await f.assertClean()
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
  const read = createUsageReader(() => f.executable, { ...f.options, timeoutMs: 3000, now: () => clock, signIn: async () => stored })
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
    const read = createUsageReader(() => f.executable, { ...f.options, timeoutMs: 3000, now: () => clock, signIn: async () => stored })
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
  const result = await createUsageReader(() => f.executable, { ...f.options, timeoutMs: 3000, signIn: async () => live })()
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

// plugins#1544: agy --version took 5 to 17 seconds on a one-CPU Linux host,
// and the quota read was given up at 3 seconds, before it could start.
test("a slow agy --version can finish within the usage deadline, and is asked once", async t => {
  const f = await fixture(t, { TEST_START_DELAY_MS: "4000" })
  const result = await fetchUsage(f.executable, { ...f.options, timeoutMs: 15_000 })
  assert.equal(result.windows.length, 1)
  assert.deepEqual((await f.logs()).map(call => call.args[0]), ["--version", "-p"])
  const again = await fetchUsage(f.executable, { ...f.options, timeoutMs: 15_000 })
  assert.equal(again.windows.length, 1)
  assert.deepEqual((await f.logs()).map(call => call.args[0]), ["--version", "-p", "-p"], "the same binary isn't asked its version again")
  await f.assertClean()
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
  const timer = setTimeout(() => controller.abort(), 600)
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

// ---- the quota is read through agy alone ---------------------------------
//
// Google made T3 Code take out code that read agy's stored sign-in and
// asked Google's quota endpoint itself (T3 Code PR #43026). The plugin did
// the same (readQuotaDirect: loadCodeAssist and retrieveUserQuotaSummary
// with agy's token, renewed with agy's OAuth client); now every request for
// the quota is agy's own /usage.

// agy 1.5.9's own answer when loadCodeAssist names an ineligible tier
// (UNSUPPORTED_LOCATION) and no current one, captured 2026-11-16 through
// CLOUD_CODE_URL.
const REFUSED = JSON.stringify({
  conversation_id: "", status: "ERROR", response: "",
  error: "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.",
  duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, thinking_tokens: 0 },
  finished_reason: "error",
})

// every fetch the plugin makes while t runs, answered with an error
function noFetch(t) {
  const asked = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => { asked.push(String(url)); throw new Error("no network in tests") }
  t.after(() => { globalThis.fetch = original })
  return asked
}

test("usage.mjs asks Google nothing itself: no endpoint, no OAuth client, no stored token", () => {
  const source = readFileSync(new URL("../usage.mjs", import.meta.url), "utf8")
  for (const banned of [/googleapis\.com/, /oauth2/i, /v1internal/, /retrieveUserQuotaSummary/, /loadCodeAssist\b[^\n]*fetch|fetch[^\n]*loadCodeAssist/, /storedToken/, /client_secret|GOCSPX/i, /\bfetch\(/]) {
    assert.doesNotMatch(source, banned)
  }
})

test("a quota read and a refusal alike go through agy -p, never a request of the plugin's own", async t => {
  const asked = noFetch(t)
  const live = { state: "present", fp: "live", canRenew: true, expiresAt: Date.now() + 3600_000, expired: false }
  const f = await fixture(t, { TEST_VERSION: "1.5.9" })
  const ok = await createUsageReader(() => f.executable, { ...f.options, signIn: async () => live })()
  assert.equal(ok.error, undefined)
  assert.equal(ok.windows.length, 1)
  // a region refusal stands as agy says it: unknown, never zero or full
  const refused = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "", TEST_FAILURE_REPORT: REFUSED, TEST_VERSION: "1.5.9" })
  const no = await createUsageReader(() => refused.executable, { ...refused.options, signIn: async () => live })()
  assert.deepEqual(no.windows, [])
  assert.match(no.error, /not eligible/)
  assert.equal(no.signIn, "kept")
  // agy acp is asked for the account's tier (plugins#1602), and names none
  assert.deepEqual((await refused.logs()).map(l => l.args[0]), process.platform !== "win32" && typeof globalThis.Bun?.Terminal === "function" ? ["--version", "-p", "acp"] : ["--version", "-p"])
  assert.deepEqual(asked, [])
  await f.assertClean()
  await refused.assertClean()
})

// plugins#1602 (cyclonevox: agy 1.5.18, Google AI Pro, region SG):
// loadCodeAssist names standard-tier current and allowed, g1-pro-tier
// paid, and free-tier ineligible (UNSUPPORTED_LOCATION). agy -p refuses at
// "Eligibility check failed" while agy acp and its TUI serve the account,
// so the card said "not eligible". The quota comes from agy's TUI, handed
// to a statusLine command of this run's, once agy acp names a tier.
const PRO_TIER = JSON.stringify({ name: "Gemini Code Assist in Google One AI Pro", id: "g1-pro-tier", upgradeUri: "" })
// the statusLine's quota as agy 1.5.18 hands it: bucket ids alone, a
// fraction of 0 kept, an unknown one as remaining_amount 0, an unknown
// reset as the epoch
const STATUS_QUOTA = {
  "gemini-weekly": { remaining_fraction: 0.75, reset_time: "2026-11-30T11:19:33Z", reset_in_seconds: 300000 },
  "gemini-5h": { remaining_fraction: 0.5, reset_time: "2026-11-27T16:19:33Z", reset_in_seconds: 10000 },
  "3p-weekly": { remaining_fraction: 0, reset_time: "2026-11-29T09:01:10Z", reset_in_seconds: 200000 },
  "3p-5h": { remaining_amount: 0, reset_time: "1970-01-01T00:00:00Z", reset_in_seconds: 0 },
  "gemini-argon-wtu-weekly": { remaining_fraction: 0.53, reset_time: "2026-11-30T11:19:33Z", reset_in_seconds: 300000, disabled: true },
}
const PTY = process.platform !== "win32" && typeof globalThis.Bun?.Terminal === "function"

test("the statusLine's buckets read as /usage's groups, by the same names and the catalog's models", () => {
  storeCatalogRows(LIVE_MODEL_ROWS)
  const result = parseStatusLineQuota(structuredClone(STATUS_QUOTA))
  const pools = result.windows.filter(w => !w.model)
  // in /usage's order, the 1970 reset read as none
  assert.deepEqual(pools.map(w => [w.pool, w.name, w.used, w.resetsAt]), [
    ["Gemini", "7 days", 25, "2026-11-30T11:19:33.000Z"],
    ["Gemini", "5 hours", 50, "2026-11-27T16:19:33.000Z"],
    ["Claude & GPT", "7 days", 100, "2026-11-29T09:01:10.000Z"],
    ["Claude & GPT", "5 hours", undefined, undefined],
  ])
  // the disabled Argon bucket is left out, as /usage's is
  assert.ok(!result.windows.some(w => w.pool === "Gemini 4 Argon"))
  assert.ok(pools[2].models.includes("claude-opus-5-5") && pools[2].models.includes("gpt-oss-120b"))
  assert.ok(!pools[2].models.some(m => m.startsWith("gemini")))
  // with an Argon bucket of its own, Argon is not in the Gemini pool
  assert.ok(pools[0].models.includes("gemini-4-hydrogen") && pools[0].models.includes("gemini-3.8-flash") && !pools[0].models.some(m => m.includes("argon")))
  const opus = result.windows.find(w => w.model === "claude-opus-5-5")
  assert.deepEqual([opus.pool, opus.used], ["Claude & GPT", 100])

  const argon = structuredClone(STATUS_QUOTA)
  delete argon["gemini-argon-wtu-weekly"].disabled
  const own = parseStatusLineQuota(argon).windows.filter(w => !w.model && w.pool === "Gemini 4 Argon")
  assert.deepEqual(own.map(w => [w.name, w.used]), [["7 days", 47]])
  assert.ok(own[0].models.includes("gemini-4-argon-high"))
  // no Argon bucket: its models share the Gemini pool
  const shared = structuredClone(STATUS_QUOTA)
  delete shared["gemini-argon-wtu-weekly"]
  assert.ok(parseStatusLineQuota(shared).windows.find(w => !w.model && w.pool === "Gemini").models.includes("gemini-4-argon"))
  storeCatalogRows(null)
  // no catalog: the pools still read
  assert.deepEqual(parseStatusLineQuota(structuredClone(STATUS_QUOTA)).windows.filter(w => !w.model).map(w => w.pool), ["Gemini", "Gemini", "Claude & GPT", "Claude & GPT"])
  // a bucket agy adds later gets a pool of its own name
  assert.deepEqual(parseStatusLineQuota({ "nano-5h": { remaining_fraction: 0.9 } }).windows.map(w => [w.pool, w.name, w.used]), [["nano", "5 hours", 10]])
  assert.throws(() => parseStatusLineQuota({}))
})

test("an account agy -p calls ineligible while agy acp names its tier reads its quota from agy's TUI", { skip: !PTY }, async t => {
  const asked = noFetch(t)
  storeCatalogRows(LIVE_MODEL_ROWS)
  t.after(() => storeCatalogRows(null))
  const f = await fixture(t, { TEST_MODE: "eligibility", TEST_TIER: PRO_TIER, TEST_QUOTA: JSON.stringify(STATUS_QUOTA), TEST_VERSION: "1.5.18" })
  const result = await fetchUsage(f.executable, { ...f.options, timeoutMs: 20_000 })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.windows.filter(w => !w.model).map(w => [w.pool, w.name, w.used]), [
    ["Gemini", "7 days", 25], ["Gemini", "5 hours", 50], ["Claude & GPT", "7 days", 100], ["Claude & GPT", "5 hours", undefined],
  ])
  const logs = await f.logs()
  const runs = logs.filter(l => l.args)
  assert.deepEqual(runs.map(l => l.args[0]), ["--version", "-p", "acp", "--settings"])
  // ACP: initialize, then session/new, nothing else (no prompt)
  assert.deepEqual(logs.filter(l => l.acp).map(l => l.acp), ["initialize", "session/new"])
  // the TUI ran in a terminal, its statusLine this run's only
  const tui = logs.find(l => l.settings)
  assert.equal(tui.tty, true)
  assert.deepEqual(Object.keys(tui.settings), ["statusLine"])
  assert.equal(tui.settings.statusLine.type, "command")
  assert.ok(logs.some(l => l.answered))
  // nothing agy ran outlives the read
  for (const pid of await f.pids([])) await waitForPidExit(pid)
  await f.assertClean()
  assert.deepEqual(asked, [])
})

test("an account agy acp names no tier for keeps the refusal, and agy's TUI is never started", { skip: !PTY }, async t => {
  const f = await fixture(t, { TEST_MODE: "eligibility", TEST_QUOTA: JSON.stringify(STATUS_QUOTA) })
  await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs: 20_000 }), /not eligible for Antigravity/)
  const logs = await f.logs()
  assert.deepEqual(logs.filter(l => l.args).map(l => l.args[0]), ["--version", "-p", "acp"])
  assert.ok(!logs.some(l => l.settings))
  for (const pid of await f.pids([])) await waitForPidExit(pid)
  await f.assertClean()
})

test("a tier with no quota in the statusLine keeps the refusal, and agy is stopped at the deadline", { skip: !PTY }, async t => {
  const f = await fixture(t, { TEST_MODE: "eligibility", TEST_TIER: PRO_TIER })
  await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs: 3_000 }), /not eligible for Antigravity/)
  const logs = await f.logs()
  assert.deepEqual(logs.filter(l => l.args).map(l => l.args[0]), ["--version", "-p", "acp", "--settings"])
  for (const pid of await f.pids([])) await waitForPidExit(pid)
  await f.assertClean()
})

test("another refusal than the eligibility check asks agy nothing more", { skip: !PTY }, async t => {
  const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: "", TEST_FAILURE_REPORT: JSON.stringify({ status: "ERROR", error: "Your Google account was disabled." }) })
  await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs: 5_000 }))
  assert.deepEqual((await f.logs()).map(l => l.args[0]), ["--version", "-p"])
})

test("on the app's gateway, agy acp and its TUI read the folder without it too", { skip: !PTY }, async t => {
  const f = await fixture(t, { TEST_MODE: "eligibility", TEST_TIER: PRO_TIER, TEST_QUOTA: JSON.stringify(STATUS_QUOTA) })
  const folder = path.join(path.dirname(f.env.TEST_LOG), "agy-own")
  const result = await fetchUsage(f.executable, { ...f.options, timeoutMs: 20_000, geminiDir: async () => ({ gateway: true, dir: folder }) })
  assert.ok(result.windows.length > 0)
  const runs = (await f.logs()).filter(l => l.args).map(l => l.args)
  assert.deepEqual(runs[2], ["acp", "--gemini-dir", folder])
  assert.deepEqual(runs[3].slice(0, 3), ["--gemini_dir", folder, "--settings"])
  for (const pid of await f.pids([])) await waitForPidExit(pid)
})

// plugins#1234 (qiankun229): agy run for usage with an ended access token
// renews it first, and when that failed for a moment (a DNS miss at
// Windows startup, a 10s keyring timeout) it opened Google's sign-in in the
// browser. With such a token agy isn't run for usage, and the plugin
// doesn't renew it either: agy's next chat does, and the quota is read
// after that.
test("an ended or ending access token with a refresh token runs no agy and asks Google nothing", async t => {
  const asked = noFetch(t)
  for (const ends of [1, 1_000_000 + 60_000]) {
    const f = await fixture(t, { TEST_VERSION: "1.5.9" })
    let stored = { state: "present", fp: "ended", canRenew: true, expiresAt: ends, expired: ends === 1 }
    const read = createUsageReader(() => f.executable, { ...f.options, now: () => 1_000_000, signIn: async () => stored })
    for (let i = 0; i < 2; i++) {
      const result = await read()
      assert.deepEqual(result.windows, [])
      assert.equal(result.error, DUE_FOR_RENEWAL)
      assert.equal(result.signIn, "kept")
    }
    await assert.rejects(f.logs(), { code: "ENOENT" })
    // agy renewed it (a chat): read at once, nothing held
    stored = { ...stored, expiresAt: 1_000_000 + 3600_000, expired: false }
    const back = await read()
    assert.equal(back.windows.length, 1)
    assert.equal(back.signIn, "kept")
    await f.assertClean()
  }
  assert.deepEqual(asked, [])
})

// agy -p /usage makes about twelve Code Assist calls in six rounds before
// the quota: 5 to 10 seconds on a quick network, 20 or more behind a slow
// proxy. It had 15 seconds less what the direct read took, and said only
// "agy usage query timed out." (9uK7K2AqpF10987 on X, Windows).
test("agy's own read gets 45 seconds unless told otherwise", async t => {
  const f = await fixture(t)
  await fetchUsage(f.executable, { ...f.options, env: { ...f.env, AGY_BRIDGE_USAGE_TIMEOUT_MS: "" } })
  const p = (await f.logs()).find(l => l.args[0] === "-p").args
  const s = Number(/^(\d+)s$/.exec(p[p.indexOf("--print-timeout") + 1])[1])
  assert.ok(s > 40 && s <= 45, `--print-timeout ${s}s`)
  await f.assertClean()
})

test("a read longer than magpie waits says agy is still reading, and the next call takes its answer without running agy again", async t => {
  const f = await fixture(t, { TEST_MODE: "delay", TEST_REPORT_DELAY_MS: "1500" })
  let settled
  const done = new Promise(r => { settled = r })
  const read = createUsageReader(() => f.executable, { ...f.options, waitMs: 300, timeoutMs: 20_000, onSettled: () => settled() })
  const first = await read()
  assert.deepEqual(first.windows, [])
  assert.equal(first.error, STILL_READING)
  assert.equal(first.signIn, "kept")
  // the run goes on with nobody waiting, and its answer is kept
  await done
  const runs = async () => (await f.logs()).filter(l => l.args[0] === "-p").length
  const next = await read()
  assert.equal(next.error, undefined)
  assert.equal(next.signIn, "kept")
  assert.equal(next.windows.length, 1)
  assert.equal(await runs(), 1, "the late answer is taken, agy isn't run again")
  // taken once: the call after it reads again
  f.env.TEST_MODE = ""
  const again = await read()
  assert.equal(again.windows.length, 1)
  assert.equal(await runs(), 2)
  await f.assertClean()
})

test("a read that runs out of time says so plainly, and is asked again a minute later", async t => {
  const f = await fixture(t, { TEST_MODE: "hang" })
  const live = { state: "present", fp: "live", canRenew: true, expiresAt: Date.now() + 3600_000, expired: false }
  let clock = 0
  const read = createUsageReader(() => f.executable, { ...f.options, timeoutMs: 3000, now: () => clock, signIn: async () => live })
  const result = await read()
  assert.deepEqual(result.windows, [])
  assert.equal(result.signIn, "kept")
  assert.match(result.error, /agy's own usage read didn't finish in 3s[\s\S]*asked again in a minute[\s\S]*network or proxy/)
  const runs = async () => (await f.logs()).filter(l => l.args[0] === "-p").length
  assert.equal(await runs(), 1)
  clock += 59_000
  assert.equal((await read()).error, result.error)
  assert.equal(await runs(), 1, "held for a minute")
  f.env.TEST_MODE = ""
  clock += 1_000
  assert.equal((await read()).windows.length, 1)
  assert.equal(await runs(), 2)
  await f.assertClean()
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
