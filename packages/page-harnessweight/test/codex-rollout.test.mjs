import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, appendFile, chmod, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCodexReader, parseCodexRollout } from "../lib/codex-rollout.mjs"
import { summarizeTaskDurations } from "../lib/task-duration.mjs"
import { createHandler, TOKEN_HEADER } from "../service.mjs"

const NOW = 1794395000000
const SEC = Math.floor(NOW / 1000)
const row = (type, payload) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type, payload }) + "\n"
const meta = (id = "session-1", source = "vscode", thread_source = "user") => row("session_meta", { id, source, thread_source, base_instructions: "private prompt" })
const start = (id, extra = {}) => row("event_msg", { type: "task_started", turn_id: id, started_at: SEC - 10,
  turn_attribution: { turn_id: id, root_turn_id: id, turn_trigger: "user", parent_turn_id: null, initiating_agent_path: null }, ...extra })
const complete = (id, extra = {}) => row("event_msg", { type: "task_complete", turn_id: id, started_at: SEC - 10,
  completed_at: SEC - 1, duration_ms: 9500, last_agent_message: "private response", ...extra })
const abort = (id, reason) => row("event_msg", { type: "turn_aborted", turn_id: id, reason })
const attr = (id, extra) => ({ turn_id: id, root_turn_id: id, turn_trigger: "user", parent_turn_id: null, initiating_agent_path: null, ...extra })

test("accepts only verified user root turns and successful matching completions", () => {
  let text = meta() + start("ok") + row("event_msg", { type: "agent_message", text: "private assistant" }) + complete("ok")
  text += start("desktop", { turn_attribution: attr("desktop", { turn_trigger: "composer" }) }) + complete("desktop")
  text += start("failure") + complete("failure", { error: { message: "private error" } })
  for (const reason of ["interrupted", "replaced", "review_ended", "budget_limited"]) text += start(reason) + abort(reason, reason) + complete(reason)
  text += start("unfinished") + complete("missing-start")
  for (const trigger of ["automation_heartbeat_scheduled", "composer_queue_run_now", "exec", "daemon_recovery", null]) {
    const id = String(trigger); text += start(id, { turn_attribution: attr(id, { turn_trigger: trigger }) }) + complete(id)
  }
  text += start("child", { turn_attribution: attr("child", { parent_turn_id: "parent" }) }) + complete("child")
  text += start("agent-path", { turn_attribution: attr("agent-path", { initiating_agent_path: ["child"] }) }) + complete("agent-path")
  text += start("root-mismatch", { root_turn_id: "parent" }) + complete("root-mismatch")
  text += start("bad-attribution", { turn_attribution: attr("other", {}) }) + complete("bad-attribution")
  text += '{"type":"event_msg","payload":'
  const rows = parseCodexRollout(text, { now: NOW })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => [r.source, r.durationMs, r.precision]), [["codex-rollout", 9500, "millisecond"], ["codex-rollout", 9500, "millisecond"]])
  assert.doesNotMatch(JSON.stringify(rows), /private|session-1|unfinished|desktop|agent-path/)
  for (const m of [meta("sub", "vscode", "subagent"), meta("unknown", "vscode", null), meta("auto", "exec", "user")]) {
    assert.equal(parseCodexRollout(m + start("x") + complete("x"), { now: NOW }).length, 0)
  }
  assert.equal(parseCodexRollout(meta() + start("x") + complete("x") + abort(null, "interrupted"), { now: NOW }).length, 0)
  assert.deepEqual(parseCodexRollout(text.replaceAll('"task_started"', '"turn_started"'), { now: NOW }), [])
  assert.deepEqual(parseCodexRollout(text.replaceAll('"task_complete"', '"turn_complete"'), { now: NOW }), [])
})

test("uses original completion time and precise duration, with a seconds fallback", () => {
  const text = meta() + start("precise") + complete("precise", { duration_ms: 9876 }) +
    start("fallback") + complete("fallback", { duration_ms: null }) +
    start("invalid") + complete("invalid", { duration_ms: -1 }) +
    start("no-end") + complete("no-end", { completed_at: null })
  const rows = parseCodexRollout(text, { now: NOW })
  assert.deepEqual(rows.map(r => [r.t, r.durationMs, r.precision]), [[(SEC - 1) * 1000, 9876, "millisecond"], [(SEC - 1) * 1000, 9000, "second"]])
  const summary = summarizeTaskDurations(rows, { since: (SEC - 1) * 1000, now: NOW }).get("codex")
  assert.equal(summary.samples, 2)
  assert.equal(summary.averageMs, 9438)
  assert.deepEqual(summary.precision, { millisecond: 1, second: 1 })
  assert.equal(summarizeTaskDurations(rows, { since: (SEC - 1) * 1000 + 1, now: NOW }).size, 0)
})

test("reader incrementally handles partial tails and deduplicates replay without merging synthetic sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-codex-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = join(dir, "rollout-1.jsonl"), second = join(dir, "rollout-2.jsonl")
  await writeFile(first, meta("s1") + start("same") + complete("same") + start("pending") + complete("pending").slice(0, -2))
  await writeFile(second, meta("s2") + start("same") + complete("same") + start("external-import-1") + complete("external-import-1"))
  const reader = createCodexReader({ codexSessionsDir: dir, now: () => NOW })
  await reader.refresh()
  assert.equal(reader.rows().length, 2)
  await reader.refresh()
  assert.equal(reader.rows().length, 2)
  await appendFile(first, '}\n' + start("external-import-1") + complete("external-import-1"))
  await reader.refresh()
  assert.equal(reader.rows().length, 4)
  const absent = createCodexReader({ codexSessionsDir: join(dir, "missing"), now: () => NOW })
  await absent.refresh()
  assert.deepEqual(absent.rows(), [])
  assert.equal(absent.error(), false)
})

test("summary API serves Codex samples and leaves unsupported harness empty", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-codex-api-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sessions = join(dir, "sessions")
  await mkdir(sessions)
  const nowSec = Math.floor(Date.now() / 1000)
  const data = meta() + start("api", { started_at: nowSec - 10 }) + complete("api", { started_at: nowSec - 10, completed_at: nowSec - 1 })
  await writeFile(join(sessions, "rollout-api.jsonl"), data)
  const usage = join(dir, "usage.jsonl")
  await writeFile(usage, JSON.stringify({ t: new Date().toISOString(), agent: "grok", model: "m", status: 200, in: 1, out: 2 }) + "\n")
  const server = createServer()
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const port = server.address().port
  server.on("request", createHandler({ port, token: "test-token", usageLog: usage, dataDir: dir, codexSessionsDir: sessions, gatewayUrl: "http://127.0.0.1:1" }))
  const response = await fetch(`http://127.0.0.1:${port}/api/summary?period=7d`, { headers: { [TOKEN_HEADER]: "test-token" } })
  assert.equal(response.status, 200)
  const body = await response.json()
  const codex = body.agents.find(a => a.agent === "codex").taskDuration
  assert.equal(codex.samples, 1)
  assert.equal(codex.averageMs, 9500)
  assert.deepEqual(codex.sources, ["codex-rollout"])
  assert.equal(body.agents.find(a => a.agent === "grok").taskDuration.averageMs, null)
  assert.equal(body.taskTiming.adapters.find(a => a.source === "codex-rollout").boundary, "user-turn")
  assert.doesNotMatch(JSON.stringify(body), /private prompt|private response|session-1|taskKey/)
  const get = async (period) => (await fetch(`http://127.0.0.1:${port}/api/summary?period=${period}`, { headers: { [TOKEN_HEADER]: "test-token" } })).json()
  const pages = await Promise.all(["today", "7d", "30d"].map(get))
  assert.deepEqual(pages.map(p => p.agents.find(a => a.agent === "codex").taskDuration.samples), [1, 1, 1])
  await appendFile(join(sessions, "rollout-api.jsonl"), '{"private broken":\n')
  const broken = await get("7d")
  assert.equal(broken.agents.find(a => a.agent === "codex").taskDuration.reason, "read-error")
  assert.equal(broken.agents.find(a => a.agent === "codex").taskDuration.averageMs, null)
  assert.equal(broken.agents.find(a => a.agent === "grok").calls, 1)
  assert.equal(broken.taskTiming.readError, true)
  assert.deepEqual(broken.sources.codexReadIssues, { malformedJson: 1 })
  assert.doesNotMatch(JSON.stringify(broken), /private broken/)
})


test("error events and conflicting attribution cannot become successful samples", () => {
  const error = row("event_msg", { type: "error", turn_id: "x", message: "private failure" })
  for (const tail of [error + complete("x"), complete("x") + error,
    complete("x") + row("event_msg", { type: "error", message: "private unknown failure" }),
    complete("x") + start("x", { turn_attribution: attr("x", { turn_trigger: "exec" }) })]) {
    assert.deepEqual(parseCodexRollout(meta() + start("x") + tail, { now: NOW }), [])
  }
})

test("replay failures and conflicting durations exclude the original turn across files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-codex-replay-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, "rollout-1.jsonl"), meta("s1") + start("x") + complete("x") + start("y") + complete("y"))
  await writeFile(join(dir, "rollout-2.jsonl"), meta("s2") + start("x") + abort("x", "interrupted") + start("y") + complete("y", { duration_ms: 9999 }))
  const reader = createCodexReader({ codexSessionsDir: dir, now: () => NOW })
  await reader.refresh()
  assert.deepEqual(reader.rows(), [])
  assert.equal(reader.error(), false)
})

test("malformed and oversized records remain observable without retaining their content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-codex-malformed-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "rollout-1.jsonl")
  await writeFile(file, meta() + start("x") + complete("x") + '{"private malformed":\n')
  const reader = createCodexReader({ codexSessionsDir: dir, now: () => NOW })
  await reader.refresh()
  assert.deepEqual(reader.rows(), [])
  assert.deepEqual(reader.issues(), { malformedJson: 1 })
  await reader.refresh()
  assert.equal(reader.error(), true)
  await writeFile(file, meta() + start("x") + row("event_msg", { type: "agent_message", text: "界".repeat(3 * 1024 * 1024) }) + complete("x"))
  await reader.refresh()
  assert.equal(reader.issues().oversizedLine, 1)
  assert.deepEqual(reader.rows(), [])
  assert.doesNotMatch(JSON.stringify(reader.issues()), /private|界/)
})

test("read failures discard stale samples, report codes, and recover after permission repair", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-codex-permissions-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "rollout-1.jsonl")
  await writeFile(file, meta() + start("x") + complete("x"))
  const reader = createCodexReader({ codexSessionsDir: dir, now: () => NOW })
  await reader.refresh()
  assert.equal(reader.rows().length, 1)
  await chmod(file, 0)
  try {
    await reader.refresh()
    assert.deepEqual(reader.rows(), [])
    assert.deepEqual(reader.issues(), { EACCES: 1 })
  } finally { await chmod(file, 0o600) }
  await reader.refresh()
  assert.equal(reader.rows().length, 1)
  assert.equal(reader.error(), false)
  const invalidRoot = createCodexReader({ codexSessionsDir: file, now: () => NOW })
  await invalidRoot.refresh()
  assert.deepEqual(invalidRoot.issues(), { ENOTDIR: 1 })
})

test("incremental reader preserves UTF-8 partial tails and detects replacement and truncation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hw-codex-replace-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "rollout-1.jsonl"), replacement = join(dir, "replacement")
  const data = Buffer.from(meta() + start("x") + complete("x", { last_agent_message: "界" }))
  const cut = data.indexOf(Buffer.from("界")) + 1
  await writeFile(file, data.subarray(0, cut))
  const reader = createCodexReader({ codexSessionsDir: dir, now: () => NOW })
  await reader.refresh()
  assert.deepEqual(reader.rows(), [])
  await appendFile(file, data.subarray(cut))
  await reader.refresh()
  assert.equal(reader.rows().length, 1)
  await writeFile(replacement, meta() + start("y") + complete("y", { duration_ms: 1234 }))
  await rename(replacement, file)
  await reader.refresh()
  assert.equal(reader.rows()[0].durationMs, 1234)
  await writeFile(file, meta())
  await reader.refresh()
  assert.deepEqual(reader.rows(), [])
  assert.equal(reader.error(), false)
})
