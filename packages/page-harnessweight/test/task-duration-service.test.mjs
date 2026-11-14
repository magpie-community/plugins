import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler, TOKEN_HEADER } from "../service.mjs"
import { createTaskCollector } from "../lib/task-duration.mjs"
import { tasksLog, toolsLog } from "../lib/paths.mjs"

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hw-task-api-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const usageLog = join(dir, "usage.jsonl")
  await writeFile(usageLog, JSON.stringify({ t: new Date().toISOString(), agent: "cursor", model: "m", status: 200, in: 1, out: 2, ms: 999, session: "unrelated-session" }) + "\n")
  return { dir, options: { dataDir: dir, usageLog, codexSessionsDir: join(dir, "empty-codex"), gatewayUrl: "http://127.0.0.1:1", token: "test-token" } }
}

async function start(t, options) {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  server.on("request", createHandler({ ...options, port: server.address().port }))
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
  t.after(close)
  const url = `http://127.0.0.1:${server.address().port}`
  return { close, url, get: (period = "7d") => fetch(`${url}/api/summary?period=${period}&tz=0`, { headers: { [TOKEN_HEADER]: "test-token" } }) }
}

test("HTTP summary reads real task events, refreshes completions and preserves boundaries across service restarts", async (t) => {
  const f = await fixture(t)
  const first = await start(t, f.options)
  const noTelemetry = await (await first.get()).json()
  assert.equal(noTelemetry.agents[0].taskDuration.averageMs, null)
  assert.equal(noTelemetry.agents[0].taskDuration.samples, 0)
  assert.equal(noTelemetry.telemetry.request.state, "observed")
  assert.equal(noTelemetry.telemetry.tools.state, "missing")
  assert.equal(noTelemetry.telemetry.tasks.eventLog.state, "missing")
  assert.equal(noTelemetry.telemetry.tasks.codex.state, "no-completions")
  await writeFile(tasksLog({ dataDir: f.dir }), "")
  const emptyLog = await (await first.get()).json()
  assert.equal(emptyLog.telemetry.tasks.eventLog.state, "no-events")
  assert.equal(emptyLog.agents[0].taskDuration.coverage, "unavailable")
  assert.equal(noTelemetry.agents[0].p50ms, 999)
  const at = Date.now()
  const collect = createTaskCollector()
  const emit = (taskId, event, atMs, runId = "run-1") => collect({ version: 1, agent: "cursor", taskId, event, atMs, runId }, { dataDir: f.dir })
  await emit("a", "started", at - 60_000)
  await emit("b", "started", at - 50_000)
  const pending = await (await first.get()).json()
  assert.equal(pending.telemetry.tasks.eventLog.state, "observed")
  assert.equal(pending.telemetry.tasks.eventLog.latestAt, at - 50_000)
  assert.equal(pending.agents[0].taskDuration.excluded.incomplete, 2)
  assert.equal(pending.agents[0].taskDuration.averageMs, null)
  await first.close()
  // The native hook can run while the dashboard service is down.
  await emit("a", "completed", at - 45_000)
  await emit("b", "completed", at - 5_000)
  await emit("b", "completed", at - 5_000)
  const second = await start(t, f.options)
  const response = await second.get()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const body = await response.json()
  const a = body.agents[0].taskDuration
  assert.equal(a.averageMs, 30_000)
  assert.equal(a.samples, 2)
  assert.equal(a.totalMs, 60_000)
  assert.equal(body.taskTiming.periodBasis, "completedAt")
  assert.equal(body.sources.taskRows, 5)
  assert.equal(body.sources.tasksLog, tasksLog({ dataDir: f.dir }))
  assert.equal((await fetch(`${second.url}/api/summary`)).status, 403)
  assert.doesNotMatch(JSON.stringify(body), /taskKey|run-1|taskId/)
})

test("HTTP summary retains full task duration across period boundaries and does not infer it from old sessions", async (t) => {
  const f = await fixture(t)
  const now = Date.now()
  const collect = createTaskCollector()
  for (const [taskId, event, atMs] of [
    ["cross", "started", now - 8 * 86400e3], ["cross", "completed", now - 6 * 86400e3],
    ["old", "started", now - 9 * 86400e3], ["old", "completed", now - 8 * 86400e3],
  ]) await collect({ version: 1, agent: "cursor", runId: "r", taskId, event, atMs }, { dataDir: f.dir })
  const server = await start(t, f.options)
  const week = await (await server.get()).json()
  assert.equal(week.agents[0].taskDuration.samples, 1)
  assert.equal(week.agents[0].taskDuration.averageMs, 2 * 86400e3)
  const month = await (await server.get("30d")).json()
  assert.equal(month.agents[0].taskDuration.samples, 2)
  assert.equal(month.agents[0].taskDuration.averageMs, 1.5 * 86400e3)
})

test("task log read failure degrades task timing alone with an explicit reason", async (t) => {
  const f = await fixture(t)
  const file = tasksLog({ dataDir: f.dir })
  await mkdir(file, { recursive: true })
  const server = await start(t, f.options)
  const response = await server.get()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.agents[0].calls, 1)
  assert.equal(body.agents[0].taskDuration.averageMs, null)
  assert.equal(body.agents[0].taskDuration.reason, "read-error")
  assert.equal(body.taskTiming.readError, true)
  assert.equal(body.telemetry.tasks.eventLog.state, "read-error")
  await rm(file, { recursive: true })
  const now = Date.now()
  const collect = createTaskCollector()
  for (const [event, atMs] of [["started", now - 5000], ["completed", now]]) {
    await collect({ version: 1, agent: "cursor", runId: "r", taskId: "t", event, atMs }, { dataDir: f.dir })
  }
  const recovered = await (await server.get()).json()
  assert.equal(recovered.taskTiming.readError, false)
  assert.equal(recovered.telemetry.tasks.eventLog.state, "observed")
  assert.equal(recovered.agents[0].taskDuration.averageMs, 5000)
})


test("request and tool source errors are isolated and recover without stale data", async (t) => {
  const f = await fixture(t)
  const toolFile = toolsLog({ dataDir: f.dir })
  await mkdir(toolFile, { recursive: true })
  const server = await start(t, f.options)
  let body = await (await server.get()).json()
  assert.equal(body.telemetry.request.state, "observed")
  assert.equal(body.telemetry.tools.state, "read-error")
  assert.equal(body.agents[0].calls, 1)
  await rm(toolFile, { recursive: true })
  await writeFile(toolFile, JSON.stringify({ t: Date.now(), agent: "cursor", bytes: 20 }) + "\n")
  body = await (await server.get()).json()
  assert.equal(body.telemetry.tools.state, "observed")
  await rm(f.options.usageLog)
  await mkdir(f.options.usageLog)
  body = await (await server.get()).json()
  assert.equal(body.telemetry.request.state, "read-error")
  assert.equal(body.telemetry.tools.state, "observed")
  assert.equal(body.sources.usageRows, 0)
  await rm(f.options.usageLog, { recursive: true })
  body = await (await server.get()).json()
  assert.equal(body.telemetry.request.state, "missing")
  await writeFile(f.options.usageLog, "")
  body = await (await server.get()).json()
  assert.equal(body.telemetry.request.state, "no-events")
})
