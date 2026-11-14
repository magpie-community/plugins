// Task boundaries come from the harness, never from gateway requests or idle gaps.
import { createHash } from "node:crypto"
import { createToolsWriter, MAX_FILE_BYTES } from "../harnessweight.hooks.mjs"
import { tasksLog } from "./paths.mjs"

export const TASK_RETENTION_MS = 30 * 24 * 3600e3
const EVENTS = new Set(["started", "completed", "failed", "cancelled"])
const SOURCES = new Set(["task-events-v1", "cursor-hooks", "codex-rollout"])
const CURSOR_ENDS = new Map([["completed", "completed"], ["aborted", "cancelled"], ["error", "failed"]])
const name = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(v)
const id = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 512
const time = (v) => Number.isSafeInteger(v) && v > 0

export function taskTimingMetadata() {
  return {
    version: 1, unit: "ms", boundary: "execution-cycle", periodBasis: "completedAt",
    retentionMs: TASK_RETENTION_MS, maxLogBytes: 2 * MAX_FILE_BYTES, sampling: "observed-completions-only",
    adapters: [{ source: "cursor-hooks", harness: "cursor", status: "opt-in", boundary: "generation",
      clock: "hook-observed", start: "beforeSubmitPrompt", end: "stop", reference: "https://cursor.com/docs/hooks" },
    { source: "codex-rollout", harness: "codex", status: "automatic", boundary: "user-turn",
      clock: "event", start: "task_started", end: "task_complete",
      reference: "https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs" }],
    protocol: "task-events-v1", protocolClock: "event", gatewayLifecycle: false,
  }
}

// v1 requires a unique runId per execution and a taskId per user task/turn.
// Retries preserve these IDs and atMs. Restarts must not reuse IDs for new work.
export function normalizeTaskEvent(input, { source = "protocol", agent, now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid task event")
  let runId, taskId, event, at, clock
  if (source === "cursor") {
    // https://cursor.com/docs/hooks: generation_id changes with every user message.
    if (!["beforeSubmitPrompt", "stop"].includes(input.hook_event_name)) return null
    agent ??= "cursor"
    runId = input.conversation_id
    taskId = input.generation_id
    event = input.hook_event_name === "beforeSubmitPrompt" ? "started"
      : CURSOR_ENDS.get(input.status)
    if (!event) throw new TypeError("Missing Cursor terminal status")
    if (input.hook_event_name === "stop" && input.loop_count !== undefined &&
      (!Number.isSafeInteger(input.loop_count) || input.loop_count < 0)) throw new TypeError("Invalid Cursor loop count")
    // Auto-followups cannot establish the end of the original user's task.
    if (input.hook_event_name === "stop" && input.loop_count > 0) event = "ambiguous"
    at = now
    clock = "hook-observed"
    source = "cursor-hooks"
  } else if (source === "protocol") {
    if (input.version !== 1 || !EVENTS.has(input.event)) throw new TypeError("Invalid task event version or phase")
    agent = input.agent
    ;({ runId, taskId, event } = input)
    at = input.atMs
    clock = "event"
    source = "task-events-v1"
  } else {
    throw new TypeError("Unknown task event source")
  }
  if (!name(agent) || !id(runId) || !id(taskId)) throw new TypeError("Task event requires agent, runId and taskId")
  if (!time(at) || at > now || at < now - TASK_RETENTION_MS) throw new TypeError("Task event time outside retention window")
  const taskKey = createHash("sha256").update(JSON.stringify([agent, source, runId, taskId])).digest("hex")
  // Keep only opaque correlation keys, phase and numbers; never raw hook payloads.
  return { v: 1, agent, source, taskKey, event, t: at, clock }
}

// CLI lifecycle events can wait longer for competing writers than gateway requests.
export function createTaskCollector({ now = Date.now, append = createToolsWriter({ lockTimeoutMs: 1000 }) } = {}) {
  return async function collect(input, options = {}) {
    const row = normalizeTaskEvent(input, { source: options.source, agent: options.agent, now: now() })
    if (!row) return null
    await append(tasksLog(options), row)
    return row
  }
}

export function emptyTaskDuration(reason = "no-lifecycle-events") {
  return {
    available: false, averageMs: null, totalMs: null, samples: 0,
    coverage: "unavailable", reason, sources: [],
    excluded: { incomplete: 0, failed: 0, cancelled: 0, missingStart: 0, invalid: 0 },
    precision: { millisecond: 0, second: 0 },
  }
}
export function validTaskEvent(r) {
  return r?.v === 1 && name(r.agent) && SOURCES.has(r.source)
    && /^[a-f0-9]{64}$/.test(r.taskKey) && (EVENTS.has(r.event) || r.event === "ambiguous")
    && time(r.t) && r.clock === (r.source === "cursor-hooks" ? "hook-observed" : "event")
    && (r.source !== "codex-rollout" || (r.agent === "codex" && r.event === "completed"
      && Number.isSafeInteger(r.durationMs) && r.durationMs >= 0 && ["millisecond", "second"].includes(r.precision)))
}

// Completion windows are inclusive [since, now]. Starts may precede since;
// both boundaries must survive retention. Incomplete counts are window observations.
export function summarizeTaskDurations(events = [], { since = 0, now = Date.now() } = {}) {
  const groups = new Map()
  for (const r of events) {
    if (!validTaskEvent(r) || r.t > now || r.t < now - TASK_RETENTION_MS) continue
    const key = JSON.stringify([r.agent, r.source, r.taskKey])
    let g = groups.get(key)
    if (!g) { g = { agent: r.agent, source: r.source, phases: new Map(), invalid: false }; groups.set(key, g) }
    const prior = g.phases.get(r.event)
    // Generic events carry original timestamps: conflicting retries are ambiguous.
    if (prior !== undefined && prior !== r.t && r.clock === "event") g.invalid = true
    if (r.source === "codex-rollout") {
      if (g.durationMs !== undefined && (g.durationMs !== r.durationMs || g.precision !== r.precision)) g.invalid = true
      g.durationMs = r.durationMs
      g.precision = r.precision
    }
    // Native hooks have no timestamp. Repeated deliveries retain the first observation.
    g.phases.set(r.event, prior === undefined ? r.t : Math.min(prior, r.t))
  }
  const by = new Map(), measuredSources = new Map()
  for (const g of groups.values()) {
    const times = [...g.phases.values()]
    const start = g.phases.get("started")
    const terminals = [...g.phases.keys()].filter((e) => e !== "started")
    const end = terminals.length === 1 ? g.phases.get(terminals[0]) : undefined
    // Filter using the terminal, not the start; include its entire wall-clock duration.
    if ((end ?? Math.max(...times)) < since) continue
    let a = by.get(g.agent)
    if (!a) { a = emptyTaskDuration("no-valid-completions"); a.coverage = "observed"; by.set(g.agent, a) }
    if (!a.sources.includes(g.source)) a.sources.push(g.source)
    if (g.invalid || terminals.length > 1 || terminals[0] === "ambiguous" || (end !== undefined && start !== undefined && end < start)) {
      a.excluded.invalid++
    } else if (!terminals.length) {
      a.excluded.incomplete++
    } else if (terminals[0] === "cancelled" || terminals[0] === "failed") {
      a.excluded[terminals[0]]++
    } else if (start === undefined && g.source !== "codex-rollout") {
      a.excluded.missingStart++
    } else {
      a.samples++
      if (!measuredSources.has(g.agent)) measuredSources.set(g.agent, new Set())
      measuredSources.get(g.agent).add(g.source)
      a.totalMs = (a.totalMs ?? 0) + (g.source === "codex-rollout" ? g.durationMs : end - start)
      if (g.source === "codex-rollout") a.precision[g.precision]++
    }
  }
  for (const [agent, a] of by) {
    a.sources.sort()
    const measured = [...(measuredSources.get(agent) || [])]
    if (measured.length > 1) { a.available = false; a.averageMs = null; a.totalMs = null; a.reason = "mixed-sources" }
    else if (a.samples) { a.metricSource = measured[0]; a.available = true; a.averageMs = a.totalMs / a.samples; a.reason = null }
  }
  return by
}
