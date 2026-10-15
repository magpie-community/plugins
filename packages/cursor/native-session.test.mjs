import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { _internal } from "./index.mjs"
import { NativeSessionPool, NATIVE_LIMITS, nativeFields } from "./native-session.mjs"
import { bin, text, uint, message, tool, update, setBlob, checkpoint, end, readWire, nest, number, readResult } from "./native-test-wire.mjs"

const pools = []
afterEach(async () => { await Promise.all(pools.splice(0).map((p) => p.clear())) })
const registered = [{ name: "audit_echo", description: "synthetic", schema: { type: "object" }, schemaText: '{"type":"object"}' }]
const chat = (extra = {}) => ({ model: "synthetic-model", messages: [{ role: "user", content: "synthetic" }], ...extra })
function owner(extra = {}, overrides = {}) {
  const pool = new NativeSessionPool({ ...NATIVE_LIMITS, ...overrides })
  pools.push(pool)
  const request = chat(extra)
  const prepared = pool.prepare("synthetic-token", request, "synthetic-session", registered)
  const run = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, _internal)
  run.chatTools = registered
  const writes = []
  let closed = 0
  run.bind({ send: (b) => writes.push(Buffer.from(b)), close: () => closed++ }, new Map(), 11)
  return { run, writes, pool, request, closed: () => closed }
}
const frames = (wire) => wire.map((b) => ({ data: b.subarray(5), end: !!(b[0] & 2) }))

// H2 e2e covers the full lifecycle. These cases probe protocol fault/retention
// boundaries without depending on a network socket or the production codec.
test("native KV: failed storage replies with SetBlobResult.error, never success ACK", async () => {
  const { run, writes, closed } = owner({}, { blobBytes: 8 })
  await run.pump(frames([setBlob(31, Buffer.from("opaque"), Buffer.alloc(9))]))
  expect(run.error.status).toBe(503)
  expect(closed()).toBe(1)
  expect(writes).toHaveLength(1)
  const kv = nest(writes[0], 3)
  expect(number(kv, 1)).toBe(31)
  const response = nest(kv, 3)
  expect(readWire(response).map((f) => f.no)).toEqual([1])
  expect(run.blobs.size).toBe(0)
})

test("native KV: known bootstrap hashes are checked; opaque fixed-root IDs retain exact mutable bytes", async () => {
  const { run } = owner()
  const original = Buffer.from("synthetic original")
  const id = createHash("sha256").update(original).digest()
  run.knownHashes.add(id.toString("hex"))
  run.store(id, original)
  expect(() => run.store(id, Buffer.from("changed"))).toThrow("bootstrap blob changed")
  const opaque = Buffer.from("fixed-root")
  run.store(opaque, Buffer.from("first"))
  run.store(opaque, Buffer.from("second"))
  expect(run.blobs.get(opaque.toString("hex")).toString()).toBe("second")
})

test("native checkpoints: missing step/user/turn closure is never promoted, latest received state wins", () => {
  const { run } = owner()
  const user = Buffer.from("synthetic-user")
  const turn = Buffer.from("synthetic-turn")
  const step = Buffer.from("synthetic-step")
  const state = bin(8, turn)
  run.checkpointReceived(state)
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(turn, bin(1, message(bin(1, user), bin(2, step))))
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(user, text(1, "synthetic user"))
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(step, bin(3, text(1, "native thinking")))
  expect(run.checkpoint.status).toBe("complete")
  run.checkpointReceived(bin(8, Buffer.from("new-missing-turn")))
  expect(run.checkpoint.sequence).toBe(2)
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(Buffer.from("unrelated-late-blob"), text(1, "late"))
  expect(run.checkpoint.sequence).toBe(2)
  expect(run.checkpoint.status).toBe("incomplete")
})

test("native checkpoints: unknown/reference-bearing shapes stay retained and disable closure claims", () => {
  const { run } = owner()
  const state = message(bin(31, text(1, "synthetic subagent reference")), bin(99, text(1, "future state")))
  run.checkpointReceived(state)
  expect(run.checkpoint.bytes).toEqual(state)
  expect(run.checkpoint.status).toBe("unsupported")
})

test("native results: independent wire decoder sees exact text, image, explicit error flag and numeric/exec IDs", () => {
  const { run } = owner()
  const image = Buffer.from("89504e470d0a1a0a", "hex")
  const result = run.encodeResult({ role: "tool", tool_call_id: "synthetic_call", content: [{ type: "text", text: 'Error-looking JSON: {"error":"ordinary output"}\n精确' }, { type: "image_url", image_url: { url: "data:image/png;base64," + image.toString("base64") } }], is_error: true })
  const wire = _internal.pb().bytes(2, _internal.pb().varint(1, 41).str(15, "synthetic-exec").bytes(11, result)).done()
  expect(readResult(wire)).toEqual({ id: 41, execID: "synthetic-exec", isError: true,
    content: [{ type: "text", text: 'Error-looking JSON: {"error":"ordinary output"}\n精确' }, { type: "image", data: image, mimeType: "image/png" }] })
  expect(readResult(_internal.pb().bytes(2, _internal.pb().varint(1, 1).bytes(11, run.encodeResult({ role: "tool", tool_call_id: "synthetic_call", content: '{"error":"success text"}' }))).done()).isError).toBe(false)
})

test("native protocol: changed duplicate exec and inconsistent count fail before publishing calls", async () => {
  for (const kind of ["duplicate", "count"]) {
    const { run } = owner()
    const wire = kind === "duplicate" ? [tool(7, "synthetic-call", "first"), tool(7, "synthetic-call", "changed")]
      : [update(27, uint(1, 2)), update(27, uint(1, 1))]
    await run.pump(frames(wire))
    expect(run.error.status).toBe(502)
    expect(run.segment.events.some((e) => e.tool)).toBe(false)
  }
})

for (const kind of [10, 36]) test(`native protocol: repeated MCP envelopes validate before exec kind ${kind} can send a response`, () => {
  const writes = [], closes = []
  const malformed = Buffer.from("08075a0c2a0a61756469745f6563686f5a030a0561", "hex")
  let error
  try {
    _internal.exec(message(bin(kind, Buffer.alloc(0)), malformed), registered, (b) => writes.push(b), (id) => closes.push(id), null, true)
  } catch (e) { error = e }
  expect(error?.status).toBe(502)
  expect(error?.message).toContain("truncated")
  expect(writes).toEqual([])
  expect(closes).toEqual([])
})

test("native protocol: malformed message tails fail explicitly, including after partial display output", async () => {
  const { run } = owner()
  const iterator = run.segment.iterator()
  run.segment.emit({ reasoning: "synthetic partial display" })
  expect((await iterator.next()).value.reasoning).toBe("synthetic partial display")
  await run.pump([{ data: Buffer.from([0x0a, 0x05, 0x01]) }])
  expect((await iterator.next()).value.error.status).toBe(502)
  expect((await iterator.next()).done).toBe(true)
  expect(() => nativeFields(Buffer.from([0x80]))).toThrow("malformed")
})

test("native admission: competing initial requests cannot overwrite a session reservation", () => {
  const { pool, run, request } = owner()
  const competing = { ...pool.prepare("another-account", request, "synthetic-session", registered), account: run.account, controls: run.controls }
  expect(pool.create(competing, run.resolution, _internal)).toBeNull()
  expect(pool.selectors.get(run.account + ":" + run.selector)).toBe(run)
})

test("native admission: completed replay entries are bounded; active entries are preserved", () => {
  const { pool, run } = owner({}, { perAccount: 2, perProcess: 2 })
  run.terminalSeen(nativeFields(message(uint(1, 0), uint(2, 0))))
  run.complete()
  for (const session of ["second", "third"]) {
    const prepared = pool.prepare("synthetic-token", chat(), session, registered)
    const next = pool.create(prepared, run.resolution, _internal)
    if (session === "second") {
      next.chatTools = registered
      next.bind({ send() {}, close() {} }, new Map(), 1)
      next.terminalSeen(nativeFields(message(uint(1, 0), uint(2, 0))))
      next.complete()
    }
  }
  expect(pool.entries.size).toBe(2)
  expect(pool.entries.has(run)).toBe(false)
})

test("native finalization: transport errors after TurnEnded fail instead of converting partial output to success", async () => {
  const { run } = owner()
  const error = { end: true, data: Buffer.from('{"error":{"code":"unavailable","message":"synthetic transport failure"}}') }
  await run.pump([...frames([update(1, text(1, "partial final")), update(14, message(uint(1, 3), uint(2, 2)))]), error])
  expect(run.error.status).toBe(503)
  expect(run.segment.events.some((e) => e.stop)).toBe(false)
})

test("native transport: KV, Run heartbeat and exec heartbeat share queued/in-flight admission", async () => {
  const req = Object.assign(new EventEmitter(), { writable: true, destroyed: false })
  const writes = []
  req.write = (packet) => { writes.push(packet); return false }
  let closed = 0
  const transport = _internal.nativeTransport(req, () => closed++, () => { throw new Error("unexpected failure") }, { outboundBytes: 1024, outboundMessages: 3 })
  const { pb } = _internal
  const messages = [pb().bytes(7, Buffer.alloc(0)).done(), pb().bytes(5, pb().bytes(3, pb().varint(1, 7))).done(), pb().bytes(3, pb().varint(1, 4).bytes(2, pb().bytes(1, Buffer.from("blob")))).done()]
  for (const message of messages) transport.send(message)
  expect(writes).toHaveLength(1)
  expect(transport.outbound).toEqual({ bytes: messages.reduce((n, b) => n + b.length + 5, 0), messages: 3 })
  expect(() => transport.send(messages[0])).toThrow("outbound messages limit")
  transport.close()
  await Promise.resolve()
  expect(transport.outbound).toEqual({ bytes: 0, messages: 0 })
  expect(closed).toBe(1)
  expect(req.listenerCount("drain")).toBe(0)
  expect(req.listenerCount("close")).toBe(0)
})

test("native lifecycle: binding a transport after opening cancellation closes it exactly once", async () => {
  const pool = new NativeSessionPool()
  pools.push(pool)
  const prepared = pool.prepare("synthetic-token", chat(), "synthetic-session", registered)
  const run = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, _internal)
  await run.cancel("synthetic opening cancellation")
  let closed = 0
  run.bind({ send() { throw new Error("cancelled owner wrote") }, close() { closed++ } }, new Map(), 1)
  expect(closed).toBe(1)
  expect(run.state).toBe("cancelled")
  expect(run.runHeartbeat).toBeUndefined()
  expect(run.execHeartbeat).toBeUndefined()
})

test("native lifecycle: absolute deadline terminates a Run even without a parked result deadline", async () => {
  const { run, closed } = owner({}, { lifetime: 35 })
  const event = await run.segment.iterator().next()
  expect(event.value.error.status).toBe(410)
  expect(run.state).toBe("expired")
  expect(closed()).toBe(1)
})
