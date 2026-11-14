import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, appendFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { createTaskCollector, normalizeTaskEvent, summarizeTaskDurations, TASK_RETENTION_MS } from "../lib/task-duration.mjs"
import { createToolsReader } from "../lib/tools.mjs"
import { createToolsWriter } from "../harnessweight.hooks.mjs"
import { tasksLog } from "../lib/paths.mjs"
import { summarize } from "../lib/summarize.mjs"

const NOW = Date.now()
const event = (taskId, phase, atMs, extra = {}) => ({ version: 1, agent: "cursor", runId: "execution-1", taskId, event: phase, atMs, ...extra })
const row = (taskId, phase, atMs, extra) => normalizeTaskEvent(event(taskId, phase, atMs, extra), { now: NOW })
const stats = (events, options) => summarizeTaskDurations(events, { now: NOW, ...options }).get("cursor")

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hw-task-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = tasksLog({ dataDir: dir })
  const reader = createToolsReader(file, { now: () => NOW })
  const collect = createTaskCollector({ now: () => NOW })
  return { dir, file, reader, write: (e) => collect(e, { dataDir: dir }) }
}

test("real collector persists parallel tasks and deduplicates deliveries across collector restarts", async (t) => {
  const f = await fixture(t)
  const a = event("a", "started", NOW - 60_000)
  const b = event("b", "started", NOW - 50_000)
  const second = createTaskCollector({ now: () => NOW })
  await Promise.all([f.write(a), second(b, { dataDir: f.dir }), f.write(a)])
  await Promise.all([
    f.write(event("a", "completed", NOW - 45_000)),
    second(event("b", "completed", NOW - 5_000), { dataDir: f.dir }),
    f.write(event("a", "completed", NOW - 45_000)),
  ])
  await f.reader.refresh()
  const aStats = stats(f.reader.rows())
  assert.equal(aStats.samples, 2)
  assert.equal(aStats.totalMs, 60_000)
  assert.equal(aStats.averageMs, 30_000)
  assert.equal(aStats.available, true)
  assert.equal(aStats.coverage, "observed")
  assert.deepEqual(aStats.sources, ["task-events-v1"])
})

test("task IDs are isolated by harness and execution, not by session or arrival order", () => {
  const rows = [
    row("same", "completed", NOW - 1000), row("same", "started", NOW - 4000),
    row("same", "completed", NOW - 2000, { runId: "execution-2" }),
    row("same", "started", NOW - 9000, { runId: "execution-2" }),
    row("same", "started", NOW - 5000, { agent: "codex" }),
    row("same", "completed", NOW - 1000, { agent: "codex" }),
    row("same", "completed", NOW, { runId: "after-restart" }),
  ]
  const by = summarizeTaskDurations(rows, { now: NOW })
  assert.equal(by.get("cursor").samples, 2)
  assert.equal(by.get("cursor").averageMs, 5000)
  assert.equal(by.get("cursor").excluded.missingStart, 1)
  assert.equal(by.get("codex").samples, 1)
  assert.equal(by.get("codex").averageMs, 4000)
})

test("unfinished, failed, cancelled, missing-start, reversed and conflicting tasks never enter the mean", () => {
  const rows = [
    row("pending", "started", NOW - 5000),
    row("failed", "started", NOW - 5000), row("failed", "failed", NOW - 2000),
    row("cancel", "started", NOW - 5000), row("cancel", "cancelled", NOW - 2000),
    row("orphan", "completed", NOW - 2000),
    row("reverse", "started", NOW - 1000), row("reverse", "completed", NOW - 2000),
    row("conflict", "started", NOW - 5000), row("conflict", "completed", NOW - 2000), row("conflict", "cancelled", NOW - 1000),
    row("reused", "started", NOW - 5000), row("reused", "started", NOW - 4000), row("reused", "completed", NOW - 1000),
    row("end-conflict", "started", NOW - 5000), row("end-conflict", "completed", NOW - 2000), row("end-conflict", "completed", NOW - 1000),
  ]
  const a = stats(rows)
  assert.equal(a.averageMs, null)
  assert.equal(a.totalMs, null)
  assert.equal(a.available, false)
  assert.equal(a.samples, 0)
  assert.equal(a.reason, "no-valid-completions")
  assert.deepEqual(a.excluded, { incomplete: 1, failed: 1, cancelled: 1, missingStart: 1, invalid: 4 })
})

test("completion window includes exact boundaries and full cross-period duration", () => {
  const since = NOW - 10_000
  const rows = [
    row("cross", "started", since - 20_000), row("cross", "completed", since),
    row("edge", "started", NOW - 5000), row("edge", "completed", NOW),
    row("past", "started", since - 5000), row("past", "completed", since - 1),
    row("future", "started", NOW - 1000), { ...row("future", "completed", NOW), t: NOW + 1 },
  ]
  const a = stats(rows, { since })
  assert.equal(a.samples, 2)
  assert.equal(a.averageMs, 12_500)
  assert.equal(a.totalMs, 25_000)
  assert.equal(a.excluded.incomplete, 1)
  // A clock-resolution zero is valid only with an explicit pair of boundaries.
  assert.equal(stats([row("zero", "started", NOW), row("zero", "completed", NOW)]).samples, 1)
})

test("retention cannot turn an old open task into a measured task", () => {
  const rows = [row("long", "started", NOW - TASK_RETENTION_MS), row("long", "completed", NOW)]
  const before = summarizeTaskDurations(rows, { since: NOW - 5000, now: NOW }).get("cursor")
  assert.equal(before.averageMs, TASK_RETENTION_MS)
  const after = summarizeTaskDurations(rows, { since: NOW - 5000, now: NOW + 1 }).get("cursor")
  assert.equal(after.averageMs, null)
  assert.equal(after.excluded.missingStart, 1)
})

test("missing identities, invalid timestamps and non-task Cursor events are rejected or ignored", () => {
  for (const e of [
    event("", "started", NOW), event("a", "completed", NOW, { runId: "" }),
    event("a", "started", NOW + 1), event("a", "started", NOW - TASK_RETENTION_MS - 1),
    event("a", "started", "123"), event("a", "started", NOW, { version: 2 }),
    event("a", "session-end", NOW), event("a", "completed", NOW, { agent: "prompt text" }),
  ]) assert.throws(() => normalizeTaskEvent(e, { now: NOW }), TypeError)
  for (const hook_event_name of ["sessionStart", "sessionEnd", "subagentStop", "afterAgentResponse"]) {
    assert.equal(normalizeTaskEvent({ hook_event_name }, { source: "cursor", now: NOW }), null)
  }
  for (const status of [undefined, "unknown", "__proto__", "toString"]) {
    assert.throws(() => normalizeTaskEvent({ hook_event_name: "stop", conversation_id: "c", generation_id: "g", status }, { source: "cursor", now: NOW }))
  }
  assert.throws(() => normalizeTaskEvent(event("a", "started", NOW), { source: "unknown", now: NOW }), TypeError)
  for (const loop_count of [null, -1, 0.5, "0", "1", {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeTaskEvent({ hook_event_name: "stop", conversation_id: "c", generation_id: "g", status: "completed", loop_count }, { source: "cursor", now: NOW }), TypeError)
  }
  assert.equal(stats([{ ...row("a", "started", NOW), v: 99 }]), undefined)
})

test("task collector preserves a live writer lock and recovers after a skipped sample", async (t) => {
  const f = await fixture(t)
  const lock = JSON.stringify({ pid: process.pid, token: "held-by-test" })
  await writeFile(f.file + ".lock", lock)
  const collect = createTaskCollector({ now: () => NOW, append: createToolsWriter({ lockTimeoutMs: 20, warn: () => {} }) })
  await assert.rejects(collect(event("a", "started", NOW - 5000), { dataDir: f.dir }), { code: "HW_LOCK_TIMEOUT" })
  assert.equal(await readFile(f.file + ".lock", "utf8"), lock)
  await rm(f.file + ".lock")
  await collect(event("a", "completed", NOW), { dataDir: f.dir })
  await f.reader.refresh()
  assert.equal(stats(f.reader.rows()).averageMs, null)
  assert.equal(stats(f.reader.rows()).excluded.missingStart, 1)
})

test("Cursor lifecycle stores only opaque IDs, separates generations, and excludes errors, aborts and followups", async (t) => {
  const f = await fixture(t)
  let at = NOW - 10_000
  const collector = createTaskCollector({ now: () => at })
  const input = { conversation_id: "private-conversation", generation_id: "generation-1", prompt: "SECRET PROMPT", transcript_path: "/private/path", user_email: "private@email" }
  const emit = (e) => collector({ ...input, ...e }, { source: "cursor", dataDir: f.dir })
  await emit({ hook_event_name: "beforeSubmitPrompt" })
  at += 1000
  await emit({ hook_event_name: "beforeSubmitPrompt" })
  await emit({ hook_event_name: "beforeSubmitPrompt", generation_id: "generation-2" })
  at += 3000
  await emit({ hook_event_name: "stop", status: "completed", loop_count: 0 })
  at += 1000
  await emit({ hook_event_name: "stop", status: "completed", loop_count: 0 })
  await emit({ hook_event_name: "stop", status: "aborted", generation_id: "generation-2" })
  for (const [generation_id, status, loop_count] of [["g3", "error", 0], ["g4", "completed", 1]]) {
    await emit({ hook_event_name: "beforeSubmitPrompt", generation_id })
    await emit({ hook_event_name: "stop", generation_id, status, loop_count })
  }
  assert.equal(await emit({ hook_event_name: "sessionEnd" }), null)
  await f.reader.refresh()
  const a = stats(f.reader.rows())
  assert.equal(a.samples, 1)
  assert.equal(a.averageMs, 4000)
  assert.deepEqual(a.sources, ["cursor-hooks"])
  assert.equal(a.excluded.cancelled, 1)
  assert.equal(a.excluded.failed, 1)
  assert.equal(a.excluded.invalid, 1)
  const text = await readFile(f.file, "utf8")
  assert.doesNotMatch(text, /SECRET|private|generation-1|transcript|prompt|email/)
})

test("rotated generations and partial writes feed the real reader without inventing completions", async (t) => {
  const f = await fixture(t)
  const append = createToolsWriter({ now: () => NOW, maxBytes: 350 })
  const collect = createTaskCollector({ now: () => NOW, append })
  await collect(event("a", "started", NOW - 5000), { dataDir: f.dir })
  await collect(event("a", "completed", NOW), { dataDir: f.dir })
  await f.reader.refresh()
  assert.equal(stats(f.reader.rows()).averageMs, 5000)
  const incomplete = JSON.stringify(row("orphan", "completed", NOW))
  await appendFile(f.file, "malformed\n" + incomplete)
  await f.reader.refresh()
  assert.equal(stats(f.reader.rows()).samples, 1)
  assert.equal(stats(f.reader.rows()).excluded.missingStart, 0)
  await appendFile(f.file, "\n")
  await f.reader.refresh()
  assert.equal(stats(f.reader.rows()).excluded.missingStart, 1)
})

test("summary reports unavailable without lifecycle data and can include task-only harnesses", () => {
  const usage = [0, 1].map((n) => ({ t: NOW - n * 1000, agent: "claude", model: "m", protocol: "chat", session: "same-session", ms: 100, ttft: 20, in: 1, out: 1, cacheRead: 0, cacheWrite: 0, credits: 0 }))
  const tasks = [row("a", "started", NOW - 3000), row("a", "completed", NOW)]
  const body = summarize({ usage, tasks, now: NOW })
  const claude = body.agents.find((a) => a.agent === "claude")
  assert.equal(claude.session.count, 1)
  assert.equal(claude.p50ms, 100)
  assert.equal(claude.taskDuration.averageMs, null)
  assert.equal(claude.taskDuration.samples, 0)
  assert.equal(claude.taskDuration.coverage, "unavailable")
  assert.equal(body.agents.find((a) => a.agent === "cursor").taskDuration.averageMs, 3000)
  assert.equal(body.taskTiming.periodBasis, "completedAt")
  assert.equal(body.taskTiming.gatewayLifecycle, false)
  assert.equal(body.taskTiming.boundary, "execution-cycle")
  const failedRead = summarize({ usage, tasks, taskReadError: true, now: NOW })
  assert.equal(failedRead.agents[0].taskDuration.reason, "read-error")
  const clientTasks = [row("a", "started", NOW, { agent: "curl" }), row("a", "completed", NOW, { agent: "curl" })]
  assert.equal(summarize({ tasks: clientTasks, now: NOW }).agents.length, 0)
  assert.equal(summarize({ tasks: clientTasks, now: NOW, showClients: true }).agents.length, 1)
})

function cli(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../bin/task-event.js", import.meta.url).pathname, ...args])
    let stdout = "", stderr = ""
    child.stdout.on("data", (s) => { stdout += s })
    child.stderr.on("data", (s) => { stderr += s })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test("shipped CLI accepts real Cursor hook payloads across processes and fails open without leaking input", async (t) => {
  const f = await fixture(t)
  const args = ["--source", "cursor", "--data-dir", f.dir]
  const payload = { conversation_id: "c", generation_id: "g", prompt: "private prompt" }
  for (const extra of [{ hook_event_name: "beforeSubmitPrompt" }, { hook_event_name: "stop", status: "completed", loop_count: 0 }]) {
    assert.deepEqual(await cli(args, JSON.stringify({ ...payload, ...extra })), { code: 0, stdout: "", stderr: "" })
  }
  const reader = createToolsReader(f.file)
  await reader.refresh()
  const a = summarizeTaskDurations(reader.rows()).get("cursor")
  assert.equal(a.samples, 1)
  assert.ok(a.averageMs >= 0)
  const bad = await cli(args, '{"secret":"DO NOT LEAK",')
  assert.equal(bad.code, 0)
  assert.equal(bad.stdout, "")
  assert.match(bad.stderr, /task event skipped/)
  assert.doesNotMatch(bad.stderr, /DO NOT LEAK/)
})


test("Cursor configuration preview preserves hooks, is idempotent and executes quoted commands in an isolated directory", async (t) => {
  const f = await fixture(t)
  const configPath = join(f.dir, "hooks.json")
  const isolated = join(f.dir, "data with ' quote $()")
  const original = { version: 1, custom: "kept", hooks: { beforeSubmitPrompt: [{ command: "existing-command", timeout: 10 }], stop: [{ command: "existing-stop", loop_limit: 3 }], sessionStart: [{ command: "another-hook" }] } }
  await writeFile(configPath, JSON.stringify(original))
  const args = ["--print-cursor-config", configPath, "--agent", "actual-cursor", "--data-dir", isolated]
  const result = await cli(args, "")
  assert.equal(result.code, 0)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), original)
  const merged = JSON.parse(result.stdout)
  assert.equal(merged.custom, "kept")
  assert.deepEqual(merged.hooks.sessionStart, original.hooks.sessionStart)
  assert.deepEqual(merged.hooks.beforeSubmitPrompt[0], original.hooks.beforeSubmitPrompt[0])
  assert.deepEqual(merged.hooks.stop[0], original.hooks.stop[0])
  assert.equal(merged.hooks.stop[1].loop_limit, null)
  await writeFile(configPath, result.stdout)
  assert.deepEqual(JSON.parse((await cli(args, "")).stdout), merged)
  for (const phase of ["beforeSubmitPrompt", "stop"]) {
    const command = merged.hooks[phase][1].command
    const result = await new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command])
      let stdout = "", stderr = ""
      child.stdout.on("data", (s) => { stdout += s })
      child.stderr.on("data", (s) => { stderr += s })
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify({ conversation_id: "c", generation_id: "g", hook_event_name: phase, status: "completed", loop_count: 0 }))
    })
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" })
  }
  const reader = createToolsReader(tasksLog({ dataDir: isolated }))
  await reader.refresh()
  assert.equal(summarizeTaskDurations(reader.rows()).get("actual-cursor").samples, 1)
  await writeFile(configPath, '{"version":2,"hooks":{}}')
  const invalid = await cli(args, "")
  assert.equal(invalid.code, 1)
  assert.equal(invalid.stdout, "")
  assert.match(invalid.stderr, /config preview failed/)
})
