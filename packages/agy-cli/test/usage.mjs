import assert from "node:assert/strict"
import childProcess, { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createUsageReader, fetchUsage, parseUsageReport } from "../usage.mjs"

const report = groups => ({ status: "SUCCESS", command: { name: "usage", data: { groups } } })
const group = (buckets, name = "Gemini Models") => ({ name, buckets })
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
if (mode === "version-hang" && version || mode === "hang" && !version) setInterval(() => {}, 1000)
else if (version) {
  console.log(process.env.TEST_VERSION || "1.3.5")
} else if (mode === "fail") {
  console.error(process.env.TEST_ERROR || "oops secret@example.com https://secret.invalid/token")
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
    options: { env, tempRoot: directory },
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

test("reports sanitized failures and preserves the bridge sign-in; failures are retryable", async t => {
  for (const [message, expected] of [
    ["Not logged in secret@example.com https://secret.invalid/token", /sign in again/],
    ["Eligibility check failed: EOF secret@example.com", /eligibility check failed on a network/],
    ["not eligible secret@example.com", /not eligible/],
    ["connection refused: secret@example.com https://secret.invalid", /network or proxy/],
    ["unrecognized secret@example.com", /could not read usage/],
  ]) {
    const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: message })
    const read = createUsageReader(() => f.executable, f.options)
    const result = await read()
    assert.deepEqual(result.windows, [])
    assert.equal(result.signIn, "kept")
    assert.match(result.error, expected)
    assert.doesNotMatch(result.error, /secret|https:/)
    f.env.TEST_MODE = ""
    assert.equal((await read()).windows.length, 1)
    await f.assertClean()
  }
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
