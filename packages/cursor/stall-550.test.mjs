// plugins#550 (Windsland52, cursor-grok-4.6-xhigh, stateless path): after
// the step's one exec and its tool count, Cursor saved its blobs and a
// checkpoint and then sent only heartbeats for 240 s. The step had made
// three calls: two Cursor completed by itself (tool_call_completed with no
// tool_call_started and no exec) and the one it sent. 0.2.34 waited for the
// count's other two while Cursor waited for the one call's result.
//
// The frame sequence below is the reporter's wire trace in order (kinds and
// field numbers, which is all a trace keeps). The bytes are made up where
// the trace has only sizes: call ids, the tool's name, the count's value.
import "./nonet.mjs" // first: no request leaves this machine
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { NativeSessionPool, NATIVE_LIMITS, StepCalls, WireTrace, nativeFields, pendingCalls } from "./native-session.mjs"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bin, text, uint, message, envelope } from "./native-test-wire.mjs"

const { decode } = _internal

// the trace's 195 inbound frames, in order: H heartbeat, get/set a blob
// request (get_blob/set_blob), T thinking, 8 token_delta, D
// thinking_completed, x text, partial/completed/started the call updates
// 7/3/2 of call c<n>, exec the exec_server_message (McpArgs), count
// tool_requests_listed
const TRACE = `
H get get get get get get get get get get get get get get T T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8
T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 H T 8 T 8 T 8 T 8 T
8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 T 8 D x x
8 x x x 8 x x x 8 x x x 8 x x x 8 x x 8 8 partial:c1 completed:c1 8 8 partial:c2 completed:c2 8
8 partial:c3 started:c3 exec:c3 count set set set set set set set checkpoint H H H H H H H H H H
H H H H H H H H H H H H H H`.trim().split(/\s+/)

const MCP = 15 // ToolCall.mcp_tool_call
const SEARCH = 18 // ToolCall.web_search_tool_call: a kind Cursor runs itself
const span = bin(1, Buffer.alloc(16, 7))
const iu = (n, body) => bin(1, message(bin(n, body), uint(25, 0)))
const toolCall = (kind) => bin(kind, bin(1, text(1, "args")))
const callUpdate = (n, id, kind) => iu(n, message(text(1, id), bin(2, toolCall(kind))))
const mcpArgs = (rawID) => message(text(1, "magpie-read_file"), bin(2, message(text(1, "path"), bin(2, text(3, "a.txt")))), text(3, rawID), text(4, "magpie"), text(5, "read_file"), text(9, "magpie"))
// the trace's exec has no id (field 1): McpArgs, exec_id, span context, field 55
const execMessage = (rawID) => message(bin(11, mcpArgs(rawID)), text(15, "exec-" + rawID), bin(19, span), uint(55, 0))
const state = (pending) => message(...Array.from({ length: 12 }, (_, i) => bin(1, Buffer.alloc(32, i))), ...pending.map((p) => text(4, p)), bin(5, uint(1, 9)), bin(8, Buffer.alloc(32, 9)), uint(10, 0), text(22, "cli"), uint(26, 0), text(27, "UTC"), uint(39, 0))

function body(token, i, opts) {
  const [what, id] = token.split(":")
  const kind = id === "c3" ? MCP : SEARCH
  switch (what) {
    case "H": return bin(1, bin(13, Buffer.alloc(0)))
    // the trace's first get_blob has no request id
    case "get": return bin(4, message(...(i > 1 ? [uint(1, i)] : []), bin(2, bin(1, Buffer.alloc(32, i))), bin(4, span)))
    case "set": return bin(4, message(uint(1, i), bin(3, message(bin(1, Buffer.alloc(32, i % 250)), bin(2, text(1, "kept")))), bin(4, span)))
    case "T": return iu(4, text(1, "thought"))
    case "D": return iu(5, uint(1, 900))
    case "8": return bin(1, bin(8, uint(1, 2)))
    case "x": return iu(1, text(1, "words"))
    case "partial": return callUpdate(7, id, kind)
    case "completed": return opts.updates === false ? null : callUpdate(3, id, kind)
    case "started": return opts.updates === false ? null : callUpdate(2, id, kind)
    case "exec": return bin(2, execMessage(id))
    case "count": return bin(1, bin(27, uint(1, opts.count ?? 3)))
    case "checkpoint": return bin(3, state(opts.pending ?? ['{"call":"c3"}']))
  }
  throw new Error("fixture token " + token)
}
const wire = (opts = {}) => TRACE.map((t, i) => body(t, i, opts)).filter(Boolean)
// a stream that stays open after its frames, as Cursor's did
function open(list, onClose) {
  let i = 0, wake
  return {
    [Symbol.asyncIterator]() { return this },
    next: () => (i < list.length ? Promise.resolve({ value: list[i++], done: false }) : new Promise((r) => (wake = r))),
    return: () => (onClose?.(), wake?.({ done: true }), Promise.resolve({ done: true })),
  }
}
const readFile = [{ name: "read_file", description: "Read a file from disk", schema: { type: "object" }, schemaText: '{"type":"object"}' }]

async function stateless(list, extra = {}) {
  const events = [], notes = []
  const done = (async () => {
    for await (const e of decode(open(list.map((data) => ({ data }))), { send() {}, blobs: new Map(), tools: readFile, estimate: 1, note: (n) => notes.push(n), ...extra })) {
      events.push(e)
      if (e.stop || e.error) return
    }
  })()
  const timer = new Promise((r) => setTimeout(() => r("open"), 1000))
  return { how: await Promise.race([done.then(() => "ended"), timer]), events, notes }
}

test("stateless: the reporter's step ends on its one call once Cursor completed the other two (#550)", async () => {
  const { how, events, notes } = await stateless(wire())
  expect(how).toBe("ended")
  expect(events.filter((e) => e.tool).map((e) => [e.tool.name, JSON.parse(e.tool.args).path])).toEqual([["read_file", "a.txt"]])
  expect(events.at(-1).stop).toBe("tool_calls")
  // ended at the count, by the calls Cursor completed, before the checkpoint
  expect(notes).toEqual(["completed by Cursor", "completed by Cursor"])
})

test("stateless: with no call updates, the checkpoint waiting on the one call ends the step (#550)", async () => {
  const { how, events, notes } = await stateless(wire({ updates: false }))
  expect(how).toBe("ended")
  expect(events.filter((e) => e.tool)).toHaveLength(1)
  expect(events.at(-1).stop).toBe("tool_calls")
  expect(notes).toEqual(["waited on"])
})

test("stateless: a checkpoint waiting on more calls than came does not end the step (#550)", async () => {
  const { how } = await stateless(wire({ updates: false, pending: ["c3", "c4"] }))
  expect(how).toBe("open")
})

test("stateless: a quiet Run's error says what came of the step's calls (#550)", async () => {
  const list = wire({ updates: false, pending: ["c3", "c4"] }).map((data) => ({ data }))
  async function* quiet() {
    yield* list
    throw Object.assign(new Error("Cursor went quiet: 24 heartbeats and nothing else for 240 s (try again)"), { quiet: true, status: 502 })
  }
  const events = []
  for await (const e of decode(quiet(), { send() {}, blobs: new Map(), tools: readFile, estimate: 1 })) events.push(e)
  expect(events.at(-1).error.message).toBe("Cursor went quiet: 24 heartbeats and nothing else for 240 s; the step's tool count 3: 1 calls came, 0 answered here, 0 completed by Cursor (try again)")
})

test("StepCalls: a completion counts once, only for a call this step wrote and never started or sent", () => {
  const s = new StepCalls(nativeFields)
  const uf = (id) => nativeFields(text(1, id))
  // written, then completed: Cursor's own
  expect(s.update(7, uf("a"))).toBe(false)
  expect(s.update(3, uf("a"))).toBe(true)
  expect(s.update(3, uf("a"))).toBe(false)
  // started on the client: its completion is the result coming back
  s.update(7, uf("b"))
  s.update(2, uf("b"))
  expect(s.update(3, uf("b"))).toBe(false)
  // sent as an exec (its id among the exec's args), with no start
  s.update(7, uf("call-d"))
  s.exec(execMessage("call-d"))
  expect(s.update(3, uf("call-d"))).toBe(false)
  expect(s.completed).toBe(1)
  // an earlier step's call completing in this one is not counted again
  s.nextStep()
  expect(s.completed).toBe(0)
  expect(s.update(3, uf("e"))).toBe(false)
  expect(s.completed).toBe(0)
})

test("pendingCalls reads the checkpoint's pending_tool_calls", () => {
  expect(pendingCalls(state(["x"]))).toBe(1)
  expect(pendingCalls(state([]))).toBe(0)
  expect(pendingCalls(Buffer.from([0x0a, 0x05]))).toBe(null)
})

test("Wire trace: a trace keeps the count's number, each call update's kind, the checkpoint's pending count and why the Run was stateless (#550)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-trace-550-"))
  try {
    const trace = new WireTrace(dir, { path: "stateless", model: "synthetic-model", why: "retention capacity or reservation unavailable" })
    for (const data of wire()) if (!data.equals(bin(1, bin(13, Buffer.alloc(0))))) trace.frame("in", { data })
    trace.event("completed by Cursor")
    trace.write({ status: 502, message: "synthetic" })
    const body = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"))
    expect(body.why).toBe("retention capacity or reservation unavailable")
    const kept = body.frames.filter((f) => f.count != null || f.tool || f.pending != null).map(({ count, tool, pending }) => ({ count, tool, pending }))
    expect(kept).toEqual([
      { tool: [SEARCH, 1] }, { tool: [SEARCH, 1] }, { tool: [SEARCH, 1] }, { tool: [SEARCH, 1] },
      { tool: [MCP, 1] }, { tool: [MCP, 1] },
      { count: 3 },
      { pending: 1 },
    ].map((e) => ({ count: undefined, tool: undefined, pending: undefined, ...e })))
    expect(body.frames.at(-1)).toMatchObject({ event: "completed by Cursor" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// the native path, the same frames
const pools = []
afterEach(async () => { await Promise.all(pools.splice(0).map((p) => p.clear())) })
function owner(overrides = {}) {
  const pool = new NativeSessionPool({ ...NATIVE_LIMITS, ...overrides })
  pools.push(pool)
  const prepared = pool.prepare("synthetic-token", { model: "synthetic-model", messages: [{ role: "user", content: "synthetic" }] }, "synthetic-session", readFile)
  const run = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, _internal)
  run.chatTools = readFile
  run.bind({ send() {}, close() {} }, new Map(), 11)
  return run
}
const until = async (predicate) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach its expected state")
    await new Promise((r) => setTimeout(r, 5))
  }
}
const nativeFrames = (opts) => wire(opts).map((b) => ({ data: envelope(b).subarray(5) }))

// pending: a checkpoint that waits on more than came, so only the calls
// Cursor completed can seal it
for (const [name, opts] of [["call updates", { pending: ["c3", "c9"] }], ["the checkpoint alone", { updates: false }]]) test(`native: the reporter's step seals on its one call, by ${name} (#550)`, async () => {
  const run = owner({ batchWait: 2000 })
  run.pump(open(nativeFrames(opts)))
  await until(() => run.error || run.state === "awaiting-results")
  expect(run.error).toBeUndefined()
  expect(run.segment.events.filter((e) => e.tool).map((e) => e.tool.name)).toEqual(["read_file"])
  expect(run.segment.events.at(-1).stop).toBe("tool_calls")
})

test("native: a step still short of its count fails batchWait, naming the calls Cursor completed (#550)", async () => {
  const run = owner({ batchWait: 200 })
  run.pump(open(nativeFrames({ count: 4, pending: ["c3", "c4"] })))
  await until(() => run.error)
  expect(run.error.message).toMatch(/^Cursor did not complete its declared native tool batch: 1 of 4 calls came, 0 answered here, 2 completed by Cursor/)
})

// plugins#550's fifth trace (Windsland52, 2026-10-31 19:44, stateless,
// cursor-grok-4.6-xhigh): 19 blob requests, thinking and token counts, the
// thinking's end, text, then two MCP calls (partial, started, exec each)
// 43 ms apart, no tool count, and only heartbeats until quiet ended it
// after 240 s. The kinds and order are the trace's; the bytes are made up
// where it has only sizes.
const TRACE5 = [
  "H", ...Array(19).fill("get"),
  ...Array(40).fill(0).flatMap((_, i) => (i % 3 === 0 ? ["T"] : ["T", "8"])), "D",
  ...Array(26).fill(0).flatMap((_, i) => (i % 3 === 0 ? ["x", "8"] : ["x"])),
  "8", "partial:c1", "started:c1", "exec:c1", "8", "partial:c2", "started:c2", "exec:c2",
  ...Array(24).fill("H"),
]
const wire5 = (extra = []) => [...TRACE5, ...extra].map((t, i) => {
  const [what, id] = t.split(":")
  if (what === "partial") return callUpdate(7, id, id === "c9" ? SEARCH : MCP)
  if (what === "started") return callUpdate(2, id, MCP)
  return body(t, i, {})
})
// a stream that goes on with a heartbeat every few ms after its frames, as
// Cursor's did every 10 s, until it is closed
function beating(list, every = 10) {
  let i = 0, closed = false
  return {
    [Symbol.asyncIterator]() { return this },
    next: () => closed ? Promise.resolve({ done: true }) : i < list.length
      ? Promise.resolve({ value: { data: list[i++] }, done: false })
      : new Promise((r) => setTimeout(() => r(closed ? { done: true } : { value: { data: bin(1, bin(13, Buffer.alloc(0))) }, done: false }), every)),
    return: () => ((closed = true), Promise.resolve({ done: true })),
  }
}
async function run5(stream, countWait, ms = 2000) {
  const events = [], notes = []
  const done = (async () => {
    for await (const e of decode(stream, { send() {}, blobs: new Map(), tools: readFile, estimate: 1, note: (n) => notes.push(n), countWait })) {
      events.push(e)
      if (e.stop || e.error) return
    }
  })()
  const timer = new Promise((r) => setTimeout(() => r("open"), ms))
  return { how: await Promise.race([done.then(() => "ended"), timer]), events, notes }
}

test("stateless: the fifth trace's two calls with no count go to the caller once only heartbeats follow (#550)", async () => {
  const { how, events, notes } = await run5(beating(wire5()), 200)
  expect(how).toBe("ended")
  expect(events.filter((e) => e.tool).map((e) => e.tool.name)).toEqual(["read_file", "read_file"])
  expect(events.at(-1).stop).toBe("tool_calls")
  expect(notes).toEqual(["no count"])
})

test("stateless: the count wait is from Cursor's last frame that isn't a heartbeat (#550)", async () => {
  const started = Date.now()
  const { how } = await run5(beating(wire5(), 20), 300)
  expect(how).toBe("ended")
  // heartbeats every 20 ms never moved the 300 ms deadline
  expect(Date.now() - started).toBeLessThan(1500)
})

test("stateless: a call Cursor is still running holds the step past the count wait (#550)", async () => {
  // c9 written and neither started nor completed: Cursor's own, running
  const { how } = await run5(beating(wire5(["partial:c9"])), 100, 800)
  expect(how).toBe("open")
})

test("stateless: a count that comes inside the wait ends the step on the count, as before (#550)", async () => {
  const list = wire5().slice(0, -24)
  const { how, events, notes } = await run5(open([...list, bin(1, bin(27, uint(1, 2)))].map((data) => ({ data }))), 60_000)
  expect(how).toBe("ended")
  expect(events.filter((e) => e.tool)).toHaveLength(2)
  expect(notes).toEqual([])
})
