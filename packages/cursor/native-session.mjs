import { createHash, randomBytes } from "node:crypto"
import { assistantDisplay, normalizeToolResult } from "./chat-contract.mjs"

// Retention is process-local. Losing a Run never authorizes replaying an MCP
// result on another Run; checkpoints are retained evidence, not restart handles.
export const NATIVE_LIMITS = {
  resultWait: 120_000,
  lifetime: 15 * 60_000,
  batchWait: 30_000,
  drain: 6000,
  replayWait: 120_000,
  blobBytes: 64 << 20,
  outputBytes: 16 << 20,
  argumentBytes: 1 << 20,
  argumentFields: 100_000,
  argumentDepth: 64,
  outboundBytes: 16 << 20,
  outboundMessages: 256,
  perAccount: 8,
  perProcess: 32,
}

const HANDLE = /^call_cursor_[a-f0-9]+_\d+_\d+$/
const hash = (s) => createHash("sha256").update(s).digest("hex")
const canonical = (v) => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)
const bytes = (v) => Buffer.byteLength(canonical(v))
const later = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

export class NativeSessionError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const invalid = (message, status = 409) => { throw new NativeSessionError(status, message) }
const failureOf = (e) => ({ status: e?.status ?? 502, message: e?.message ?? String(e) })

// Unlike the compatibility codec, malformed protobuf tails must fail a live
// continuation. Dropping one could turn a truncated batch into a valid handoff.
export function nativeFields(input, maxFields = Infinity) {
  const b = Buffer.from(input)
  const out = []
  let at = 0
  const uv = () => {
    let n = 0
    let scale = 1
    for (let i = 0; i < 10 && at < b.length; i++) {
      const c = b[at++]
      n += (c & 127) * scale
      if (c < 128 && Number.isSafeInteger(n)) return n
      scale *= 128
    }
    invalid("malformed native protobuf", 502)
  }
  while (at < b.length) {
    const key = uv()
    const num = Math.floor(key / 8)
    const wire = key % 8
    if (!num || num > 0x1fffffff) invalid("malformed native protobuf field", 502)
    let n = 0
    let data = Buffer.alloc(0)
    if (wire === 0) n = uv()
    else if (wire === 2 || wire === 1 || wire === 5) {
      const size = wire === 2 ? uv() : wire === 1 ? 8 : 4
      if (at + size > b.length) invalid("truncated native protobuf", 502)
      data = b.subarray(at, at + size)
      at += size
    } else invalid("unsupported native protobuf wire type", 502)
    if (out.length >= maxFields) invalid("native protobuf field limit reached", 502)
    out.push({ num, wire, n, data })
  }
  return out
}
// Decode every known Value kind, including overwritten oneof/map fields, so
// corrupt bytes cannot become different, valid JSON through prefix decoding.
// Missing scalar/map values keep protobuf defaults; unknown fields are skipped
// only after their complete wire envelope has passed validation.
export function nativeMcpArgs(input, limits = NATIVE_LIMITS) {
  if (input.length > limits.argumentBytes) invalid("native MCP argument byte limit reached", 502)
  let remaining = limits.argumentFields
  const read = (b) => {
    const fs = nativeFields(b, remaining)
    remaining -= fs.length
    return fs
  }
  const typed = (f, wire) => {
    if (f.wire !== wire) invalid("invalid native MCP argument field type", 502)
  }
  const utf8 = (b) => {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b) }
    catch { invalid("invalid UTF-8 in native MCP arguments", 502) }
  }
  function mapEntry(b, depth) {
    let key = "", value = null
    for (const f of read(b)) {
      if (f.num === 1) { typed(f, 2); key = utf8(f.data) }
      else if (f.num === 2) { typed(f, 2); value = decodeValue(f.data, depth) }
    }
    return [key, value]
  }
  function decodeStruct(b, depth) {
    const entries = []
    for (const f of read(b)) if (f.num === 1) {
      typed(f, 2)
      entries.push(mapEntry(f.data, depth))
    }
    return Object.fromEntries(entries)
  }
  function decodeValue(b, depth = 0) {
    if (depth > limits.argumentDepth) invalid("native MCP argument nesting limit reached", 502)
    let value = null
    for (const f of read(b)) {
      if (f.num < 1 || f.num > 6) continue
      typed(f, [0, 1, 2, 0, 2, 2][f.num - 1])
      switch (f.num) {
        case 1:
          if (f.n !== 0) invalid("invalid native protobuf NullValue", 502)
          value = null
          break
        case 2:
          value = f.data.readDoubleLE(0)
          if (!Number.isFinite(value)) invalid("nonfinite native MCP argument number", 502)
          break
        case 3: value = utf8(f.data); break
        case 4: value = f.n !== 0; break
        case 5: value = decodeStruct(f.data, depth + 1); break
        case 6:
          value = []
          for (const item of read(f.data)) if (item.num === 1) {
            typed(item, 2)
            value.push(decodeValue(item.data, depth + 1))
          }
          break
      }
    }
    return value
  }
  const fs = read(input), entries = []
  for (const f of fs) {
    if ([1, 3, 4, 5, 9].includes(f.num)) { typed(f, 2); utf8(f.data) }
    else if (f.num === 2) { typed(f, 2); entries.push(mapEntry(f.data, 0)) }
    else if (f.num === 6) typed(f, 2)
    else if (f.num === 7) typed(f, 0)
  }
  return { fields: fs, args: Object.fromEntries(entries) }
}

const field = (fs, n) => fs.find((f) => f.num === n)
const str = (fs, n) => field(fs, n)?.data.toString("utf8") ?? ""
const num = (fs, n) => field(fs, n)?.n ?? 0

function argsOf(s) {
  try {
    const v = typeof s === "string" ? JSON.parse(s) : s
    if (v && typeof v === "object" && !Array.isArray(v)) return v
  } catch {}
  invalid("invalid tool arguments in native continuation", 400)
}
function normalizeMessage(m) {
  if (m?.role !== "assistant") return m
  const { text, reasoning } = assistantDisplay(m)
  const out = { ...m, content: text }
  delete out.reasoning
  delete out.reasoning_content
  delete out.reasoning_text
  if (reasoning) out.reasoning_content = reasoning
  if (m.tool_calls) out.tool_calls = m.tool_calls.map((c) => ({
    ...c, type: c.type ?? "function", function: { ...c.function, arguments: argsOf(c.function?.arguments ?? "{}") },
  }))
  return out
}
const historyDigest = (messages) => hash(canonical(messages.map(normalizeMessage)))
function isClosedHistoryCall(messages, callAt, id) {
  const userAt = messages.findIndex((m, i) => i > callAt && m.role === "user")
  if (userAt < 0) return false
  const resultAt = messages.findIndex((m, i) => i > callAt && i < userAt && m.role === "tool" && m.tool_call_id === id)
  if (resultAt < 0) return false
  return messages.some((m, i) => i > resultAt && i < userAt && m.role === "assistant" && !m.tool_calls?.length && assistantDisplay(m).text.length)
}
function controlsOf(chat, selector, tools) {
  const controls = { ...chat }
  for (const k of ["messages", "stream", "stream_options"]) delete controls[k]
  return hash(canonical({ selector, controls, tools }))
}
const selectorOf = (chat, session) => canonical({
  session: session || "",
  cache: typeof chat.prompt_cache_key === "string" ? chat.prompt_cache_key : "",
  conversation: typeof chat.conversation_id === "string" ? chat.conversation_id : "",
})
const hasSelector = (chat, session) => !!(session || chat.prompt_cache_key || chat.conversation_id)

// A complete result batch is validated before reserving or writing any exec.
// Only the current exported assistant may omit display reasoning. All earlier
// accepted history must match, including instruction order and attachments.
function matchResults(batch, messages) {
  if (historyDigest(messages.slice(0, batch.prefixLength)) !== batch.prefixDigest) invalid("native continuation history diverged")
  const suffix = messages.slice(batch.prefixLength)
  const assistants = []
  while (suffix[assistants.length]?.role === "assistant") assistants.push(suffix[assistants.length])
  if (!assistants.length) invalid("native continuation is missing its assistant tool calls", 400)
  let content = ""
  let reasoning = ""
  const calls = []
  for (const m of assistants) {
    const unknown = Object.keys(m).filter((k) => !["role", "content", "tool_calls", "reasoning", "reasoning_content", "reasoning_text"].includes(k))
    if (unknown.length) invalid("unsupported assistant fields in native continuation", 400)
    const display = assistantDisplay(m)
    content += display.text
    reasoning += display.reasoning
    for (const c of m.tool_calls ?? []) {
      if (c.type && c.type !== "function") invalid("unsupported native continuation tool call", 400)
      calls.push({ id: c.id, name: c.function?.name, args: argsOf(c.function?.arguments ?? "{}") })
    }
  }
  if (content !== batch.content || reasoning && reasoning !== batch.reasoning) invalid("native continuation assistant output changed")
  const expected = batch.calls.map((c) => ({ id: c.id, name: c.name, args: argsOf(c.args) }))
  const sorted = (v) => [...v].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  if (canonical(sorted(calls)) !== canonical(sorted(expected))) invalid("native continuation tool calls changed")
  const results = suffix.slice(assistants.length)
  if (results.some((m) => m?.role !== "tool")) invalid("new input cannot be interleaved with pending native results")
  const ids = new Set()
  for (const m of results) {
    if (ids.has(m.tool_call_id)) invalid("duplicate native tool result", 400)
    ids.add(m.tool_call_id)
    if (!expected.some((c) => c.id === m.tool_call_id)) invalid("unknown native tool result", 400)
  }
  if (ids.size !== expected.length) invalid("all parallel native tool results must be submitted together", 400)
  return [...results].sort((a, b) => a.tool_call_id.localeCompare(b.tool_call_id))
}

class Segment {
  constructor(owner, chat) {
    this.owner = owner
    this.prefixLength = chat.messages.length
    this.prefixDigest = historyDigest(chat.messages)
    this.events = []
    this.staged = []
    this.calls = []
    this.content = ""
    this.reasoning = ""
    this.expected = null
    this.closed = false
    this.clean = false
    this.waiters = new Set()
    const choice = chat.tool_choice
    this.choice = choice
    this.parallel = chat.parallel_tool_calls
    this.buffer = choice === "required" || typeof choice === "object" || this.parallel === false
  }
  wake() {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }
  emit(e) {
    this.owner.retain(bytes(e))
    if (e.text) this.content += e.text
    if (e.reasoning) this.reasoning += e.reasoning
    if (this.buffer) this.staged.push(e)
    else this.events.push(e)
    this.wake()
  }
  validate() {
    if (this.choice === "none" && this.calls.length) invalid("Cursor violated tool_choice=none", 502)
    if ((this.choice === "required" || typeof this.choice === "object") && !this.calls.length) invalid("Cursor did not produce the required tool call", 502)
    const name = this.choice?.function?.name
    if (name && this.calls.some((c) => c.name !== name)) invalid("Cursor called a different named tool", 502)
    if (this.parallel === false && this.calls.length > 1) invalid("Cursor produced parallel calls while parallel_tool_calls=false", 502)
  }
  finish(stop) {
    this.validate()
    this.events.push(...this.staged)
    this.staged.length = 0
    for (const [index, c] of this.calls.entries()) {
      const e = { tool: { index, id: c.id, name: c.name, args: c.args } }
      this.owner.retain(bytes(e))
      this.events.push(e)
    }
    this.owner.retain(bytes(stop))
    this.events.push(stop)
    this.closed = true
    this.wake()
  }
  fail(error) {
    this.staged.length = 0
    // Errors also override a sealed, as yet undelivered handoff.
    this.events = [{ error }]
    this.closed = true
    this.wake()
  }
  iterator({ replay = false } = {}) {
    const segment = this
    let at = 0
    let errorSent = false
    return {
      async next() {
        while (!segment.closed && at >= segment.events.length) await new Promise((r) => segment.waiters.add(r))
        if (!replay && segment.owner.error) {
          if (errorSent) return { done: true }
          errorSent = true
          return { value: { error: segment.owner.error }, done: false }
        }
        if (at < segment.events.length) {
          const event = segment.events[at++]
          if (replay && event.stop) return { value: { ...event, usage: {
            prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
            prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            magpie_native: { accounting: "replayed" },
          } }, done: false }
          return { value: event, done: false }
        }
        return { done: true }
      },
      async return() {
        if (!replay) await segment.owner.cancel("the Chat response was cancelled")
        return { done: true }
      },
      [Symbol.asyncIterator]() { return this },
    }
  }
}

export class NativeSessionPool {
  constructor(limits = NATIVE_LIMITS) {
    this.limits = limits
    this.entries = new Set()
    this.handles = new Map()
    this.selectors = new Map()
  }
  prepare(tok, chat, session, tools) {
    if (!Array.isArray(chat.messages)) invalid("native requests require a messages array", 400)
    if (bytes(chat) > this.limits.outputBytes) invalid("native request/history retention limit reached", 400)
    const account = hash(tok)
    const selector = selectorOf(chat, session)
    const controls = controlsOf(chat, selector, tools)
    const trailing = []
    for (let i = chat.messages.length - 1; i >= 0 && chat.messages[i]?.role === "tool"; i--) trailing.push(chat.messages[i].tool_call_id)
    const handles = trailing.filter((id) => typeof id === "string" && HANDLE.test(id))
    if (handles.length) {
      const found = handles.map((id) => this.handles.get(id))
      if (found.some((v) => !v)) invalid("native tool continuation expired or its process owner was lost", 410)
      const { owner, batch } = found[0]
      if (found.some((v) => v.owner !== owner || v.batch !== batch)) invalid("tool results belong to different native batches", 400)
      if (owner.account !== account) invalid("native continuation belongs to a different account")
      if (owner.controls !== controls) invalid("native continuation account, model, parameters, tools, or session changed")
      if (owner.error) invalid(owner.error.message, owner.error.status)
      const results = matchResults(batch, chat.messages)
      // Encoding is pure and happens for the whole batch before any writes.
      const encoded = results.map((m) => owner.encodeResult(m))
      const digest = hash(canonical(results))
      if (batch.resultDigest) {
        if (batch.resultDigest !== digest) invalid("native tool result changed after submission")
        if (!batch.next?.clean) invalid("an identical native continuation is already in progress")
        return { owner, batch, replay: true, segment: batch.next }
      }
      if (owner.state !== "awaiting-results" || owner.segment !== batch || !batch.clean) invalid("the native batch is not ready for continuation")
      return { owner, batch, results, encoded, digest, chat }
    }
    // Our exported calls cannot be silently downgraded to a new Run even when
    // the result suffix is missing, branched, compressed, or contains new input.
    const exported = chat.messages.flatMap((m, at) => (m?.tool_calls ?? []).filter((c) => HANDLE.test(c?.id ?? "")).map((c) => ({ id: c.id, at })))
    for (const c of exported) {
      const handle = this.handles.get(c.id)
      const closed = isClosedHistoryCall(chat.messages, c.at, c.id)
      // Closed historical pairs are imported text for a fresh user turn. They
      // carry no native ownership, including when the caller changed accounts.
      if (closed && handle?.owner.state === "complete" && handle.batch.resultDigest) continue
      if (!handle) {
        if (!closed) invalid("native history handle expired or its process owner was lost", 410)
        continue
      }
      if (handle.owner.account !== account) invalid("native history belongs to a different account")
      if (!handle.batch.resultDigest) invalid("pending native calls require a complete matching result batch", 400)
      if (handle.owner.error) invalid(handle.owner.error.message, handle.owner.error.status)
      invalid("native history must finish its turn before a new request")
    }
    if (hasSelector(chat, session)) {
      const active = this.selectors.get(account + ":" + selector)
      if (active) invalid("another native request owns this session; finish its pending calls first")
    }
    return { account, selector, controls, selected: hasSelector(chat, session), chat }
  }
  create(prepared, resolution, wire) {
    if (prepared.selected && this.selectors.has(prepared.account + ":" + prepared.selector)) invalid("another native request owns this session")
    const crowded = () => this.entries.size >= this.limits.perProcess || [...this.entries].filter((e) => e.account === prepared.account).length >= this.limits.perAccount
    while (crowded()) {
      const accountFull = [...this.entries].filter((e) => e.account === prepared.account).length >= this.limits.perAccount
      const finished = [...this.entries].find((e) => ["complete", "failed", "cancelled", "expired"].includes(e.state) && (!accountFull || e.account === prepared.account))
      if (!finished) invalid("native Run retention capacity reached", 503)
      this.forget(finished)
    }
    const owner = new NativeSession(this, prepared, resolution, wire)
    this.entries.add(owner)
    if (prepared.selected) this.selectors.set(owner.account + ":" + owner.selector, owner)
    return owner
  }
  release(owner) {
    const key = owner.account + ":" + owner.selector
    if (this.selectors.get(key) === owner) this.selectors.delete(key)
  }
  forget(owner) {
    clearTimeout(owner.replayTimer)
    this.release(owner)
    this.entries.delete(owner)
    for (const [id, h] of this.handles) if (h.owner === owner) this.handles.delete(id)
    owner.blobs.clear()
    owner.checkpoint = null
    owner.execs.clear()
    owner.nativeCalls.clear()
  }
  async clear() {
    await Promise.all([...this.entries].map((e) => e.cancel("native owner removed")))
    for (const e of this.entries) {
      clearTimeout(e.replayTimer)
      this.forget(e)
    }
  }
}

class NativeSession {
  constructor(pool, prepared, resolution, wire) {
    Object.assign(this, prepared)
    this.pool = pool
    this.limits = pool.limits
    this.resolution = resolution
    this.wire = wire
    this.identity = randomBytes(12).toString("hex")
    this.state = "opening"
    this.ac = new AbortController()
    this.execs = new Map()
    this.nativeCalls = new Map()
    this.blobs = new Map()
    this.knownHashes = new Set()
    this.blobSize = 0
    this.retainedBytes = 0
    this.sequence = 0
    this.segments = 0
    this.said = 0
    this.wrote = 0
    this.terminal = false
    this.segment = new Segment(this, prepared.chat)
    this.retain(bytes(prepared.chat))
    this.lifetimeTimer = later(() => this.fail({ status: 410, message: "native Run lifetime expired" }, "expired"), this.limits.lifetime)
  }
  retain(n) {
    if (this.retainedBytes + n > this.limits.outputBytes) invalid("native output/history retention limit reached", 503)
    this.retainedBytes += n
  }
  attach(signal, segment = this.segment) {
    if (signal?.aborted) {
      this.fail({ status: 410, message: "the Chat request was already cancelled" }, "cancelled")
      return
    }
    const abort = () => this.fail({ status: 410, message: "the Chat request was cancelled" }, "cancelled")
    signal?.addEventListener("abort", abort, { once: true })
    segment.detach = () => signal?.removeEventListener("abort", abort)
  }
  delivered(segment = this.segment) {
    if (this.error) return
    segment.clean = true
    segment.detach?.()
  }
  closeTransport() {
    if (this.transportClosed) return
    this.transportClosed = true
    clearInterval(this.runHeartbeat)
    clearInterval(this.execHeartbeat)
    clearTimeout(this.batchTimer)
    clearTimeout(this.resultTimer)
    clearTimeout(this.drainTimer)
    clearTimeout(this.lifetimeTimer)
    this.ac.abort()
    this.transport?.close()
  }
  fail(error, state = "failed") {
    if (this.error || this.state === "complete") return
    this.error = error
    this.state = state
    this.segment.fail(error)
    for (const segment of this.batches ?? []) segment.detach?.()
    this.segment.detach?.()
    this.closeTransport()
    this.pool.release(this)
    this.replayTimer = later(() => this.pool.forget(this), this.limits.replayWait)
  }
  async cancel(message) {
    this.fail({ status: 410, message }, "cancelled")
    await this.pumpTask
  }
  bind(transport, blobs, estimate) {
    if (this.transportClosed || this.error) {
      transport.close()
      return
    }
    this.transport = transport
    this.estimate = estimate
    this.blobs = blobs
    this.knownHashes = new Set(blobs.keys())
    this.blobSize = [...blobs.values()].reduce((n, b) => n + b.length, 0)
    if (this.blobSize > this.limits.blobBytes) invalid("native bootstrap blob limit reached", 503)
    if (this.error) return this.closeTransport()
    this.state = "running"
    const { pb } = this.wire
    const heartbeat = (message) => {
      try { this.send(message) } catch (e) { this.fail(failureOf(e)) }
    }
    this.runHeartbeat = setInterval(() => heartbeat(pb().bytes(7, Buffer.alloc(0)).done()), 5000)
    this.execHeartbeat = setInterval(() => {
      for (const c of this.execs.values()) if (!c.submitted) heartbeat(pb().bytes(5, pb().bytes(3, pb().varint(1, c.requestID))).done())
    }, 3000)
    this.runHeartbeat.unref?.()
    this.execHeartbeat.unref?.()
  }
  send(message) {
    if (this.error || this.transportClosed) invalid("native transport is no longer writable", 410)
    this.transport.send(message)
  }
  execClose(id) {
    this.send(this.wire.pb().bytes(5, this.wire.pb().bytes(1, this.wire.pb().varint(1, id))).done())
  }
  encodeResult(message) {
    const { pb } = this.wire
    const result = normalizeToolResult(message).mcpResult.result
    const success = pb()
    for (const item of result.value.content) {
      const { content } = item
      if (content.case === "text") success.bytes(1, pb().bytes(1, pb().str(1, content.value.text)))
      else success.bytes(1, pb().bytes(2, pb().bytes(1, content.value.data).str(2, content.value.mimeType)))
    }
    if (result.value.isError) success.varint(2, 1)
    return pb().bytes(1, success).done() // McpResult.success, not stored McpToolResult
  }
  resume(prepared, signal) {
    if (prepared.replay) return this.response(prepared.segment, true)
    const batch = prepared.batch
    if (this.error || this.state !== "awaiting-results" || this.segment !== batch || batch.resultDigest) invalid("native continuation is already reserved")
    const next = new Segment(this, prepared.chat)
    this.attach(signal, next)
    if (this.error) invalid(this.error.message, this.error.status)
    // Reserve synchronously. Competing continuations cannot interleave writes.
    batch.resultDigest = prepared.digest
    batch.next = next
    this.segment = next
    this.state = "submitting"
    clearTimeout(this.resultTimer)
    clearTimeout(this.batchTimer)
    try {
      for (let i = 0; i < prepared.results.length; i++) {
        const call = batch.calls.find((c) => c.id === prepared.results[i].tool_call_id)
        const msg = this.wire.pb().varint(1, call.requestID)
        if (call.execID) msg.str(15, call.execID)
        msg.bytes(11, prepared.encoded[i])
        this.send(this.wire.pb().bytes(2, msg).done())
        call.submitted = true
        this.execClose(call.requestID)
      }
      this.state = "running"
    } catch (e) {
      const error = failureOf(e)
      this.fail({ status: error.status, message: `${error.message}; native result submission failed; its outcome is uncertain and cannot be replayed` })
    }
    return this.response(next)
  }
  response(segment = this.segment, replay = false) {
    return {
      events: segment.iterator({ replay }),
      cancel: () => replay ? Promise.resolve() : this.cancel("the Chat response was cancelled"),
      invalidate: async () => {
        // A cached segment has no ownership of the Run it came from. Its
        // delivery may be abandoned while that Run awaits a later batch.
        if (replay) return
        await this.cancel("the Cursor output violated the Chat contract")
        this.pool.forget(this)
      },
      resolution: this.resolution,
      delivered: () => replay || this.delivered(segment),
      diagnostic: `same-run; bootstrap=imported-history; new-turn=stateless; restart=unsupported${replay ? "; replay=true" : ""}`,
    }
  }
  acceptCall(call) {
    if (this.terminal || this.state === "awaiting-results") invalid("native call arrived after its batch was sealed", 502)
    if (!Number.isInteger(call.requestID)) invalid("native tool call is missing its exec request ID", 502)
    const prior = this.execs.get(call.requestID)
    const digest = hash(canonical({ requestID: call.requestID, execID: call.execID, nativeID: call.nativeID, name: call.name, args: argsOf(call.args) }))
    if (prior) {
      if (prior.digest !== digest) invalid("native exec identity changed during retransmission", 502)
      return
    }
    if (call.nativeID && this.nativeCalls.has(call.nativeID)) invalid("native tool-call ID was reused for another exec", 502)
    call.id = `call_cursor_${this.identity}_${this.segments}_${this.segment.calls.length}`
    call.digest = digest
    this.execs.set(call.requestID, call)
    if (call.nativeID) this.nativeCalls.set(call.nativeID, call)
    this.segment.calls.push(call)
    this.retain(bytes(call))
    this.said += call.args.length
    this.waitForBatch()
    this.sealBatch()
  }
  waitForBatch() {
    this.batchTimer ??= later(() => this.fail({ status: 502, message: "Cursor did not complete its declared native tool batch" }), this.limits.batchWait)
  }
  listed(count) {
    if (!Number.isSafeInteger(count) || count < 1) invalid("invalid native tool count", 502)
    if (this.segment.expected != null && this.segment.expected !== count) invalid("inconsistent native tool count", 502)
    this.segment.expected = count
    if (this.state === "awaiting-results") return // an identical retransmission
    this.waitForBatch()
    this.sealBatch()
  }
  sealBatch() {
    const segment = this.segment
    if (segment.expected == null) return
    if (segment.calls.length > segment.expected) invalid("native tool batch exceeded its declared count", 502)
    if (segment.calls.length !== segment.expected || segment.closed) return
    clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.state = "awaiting-results"
    this.batches ??= []
    this.batches.push(segment)
    for (const c of segment.calls) this.pool.handles.set(c.id, { owner: this, batch: segment })
    segment.finish({ stop: "tool_calls", usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      magpie_native: { accounting: "pending" },
    } })
    this.segments++
    this.resultTimer = later(() => this.fail({ status: 410, message: "native tool-result deadline expired" }, "expired"), this.limits.resultWait)
  }
  store(id, data) {
    if (!id.length) invalid("native blob ID is empty", 502)
    const key = id.toString("hex")
    if (this.knownHashes.has(key) && hash(data) !== key) invalid("native content-addressed bootstrap blob changed", 502)
    const size = this.blobSize - (this.blobs.get(key)?.length ?? 0) + data.length
    if (size + (this.checkpoint?.bytes.length ?? 0) > this.limits.blobBytes) invalid("native blob retention limit reached", 503)
    // Incoming IDs are opaque: a fixed-root ID need not be SHA-256(data).
    this.blobs.set(key, Buffer.from(data))
    this.blobSize = size
    this.validateCheckpoint()
  }
  checkpointReceived(data) {
    if (data.length + this.blobSize > this.limits.blobBytes) invalid("native checkpoint retention limit reached", 503)
    nativeFields(data)
    this.checkpoint = { bytes: Buffer.from(data), sequence: ++this.sequence, status: "incomplete", terminal: this.terminal }
    this.validateCheckpoint()
  }
  validateCheckpoint() {
    if (!this.checkpoint) return
    const state = nativeFields(this.checkpoint.bytes)
    const missing = new Set()
    let supported = true
    const get = (id) => {
      const key = id.toString("hex")
      const b = this.blobs.get(key)
      if (!b) missing.add(key)
      return b
    }
    const refs = new Set([1, 3, 6, 7, 11, 13])
    const known = new Set(Array.from({ length: 34 }, (_, i) => i + 1).filter((n) => n !== 2))
    // These shapes contain additional state/reference contracts which are not
    // implemented by the caller-MCP bridge. Preserve their bytes without
    // claiming reference closure or restart eligibility.
    const complex = new Set([3, 6, 7, 11, 12, 13, 15, 16, 20, 24, 29, 30, 31, 32])
    for (const f of state) {
      if (!known.has(f.num) || complex.has(f.num)) supported = false
      if (refs.has(f.num) && f.data.length) get(f.data)
      if (f.num !== 8) continue
      const turn = get(f.data)
      if (!turn) continue
      const tf = nativeFields(turn)
      const agent = field(tf, 1)
      if (!agent || tf.some((f) => f.num !== 1)) { supported = false; continue }
      const agentFields = nativeFields(agent.data)
      if (!field(agentFields, 1)?.data.length) supported = false
      for (const a of agentFields) {
        if (a.num === 1) {
          const user = get(a.data)
          if (user) nativeFields(user)
        } else if (a.num === 2) {
          const step = get(a.data)
          if (step) {
            const sf = nativeFields(step)
            if (sf.length !== 1 || ![1, 2, 3].includes(sf[0].num)) supported = false
            else {
              const stepFields = nativeFields(sf[0].data)
              if (sf[0].num === 2 && (stepFields.length !== 1 || stepFields[0].num !== 15)) supported = false
            }
          }
        } else if (![3, 4, 5, 6].includes(a.num)) supported = false
      }
    }
    this.checkpoint.missing = missing.size
    this.checkpoint.status = !supported ? "unsupported" : missing.size ? "incomplete" : "complete"
    this.checkpoint.terminal = this.terminal
  }
  terminalSeen(fields) {
    if (this.segment.calls.length) invalid("Cursor ended a turn with unresolved native tool calls", 502)
    this.segment.validate()
    this.terminal = true
    this.state = "finalizing"
    this.usageFields = fields
    if (this.checkpoint) this.checkpoint.terminal = true
    clearTimeout(this.batchTimer)
    this.drainTimer = later(() => {
      try { this.complete() } catch (e) { this.fail(failureOf(e)) }
    }, this.limits.drain)
  }
  complete() {
    if (this.error || this.state === "complete") return
    if (!this.terminal) invalid("native Run ended before TurnEnded or a complete final answer", 502)
    const { usageOf } = this.wire
    const measuredInput = this.usageFields?.some((f) => [1, 3, 4].includes(f.num))
    const measuredOutput = this.usageFields?.some((f) => f.num === 2)
    const u = usageOf(this.usageFields ?? [])
    if (!measuredInput) u.input = this.estimate
    if (!measuredOutput) u.output = Math.floor((this.said + 3) / 4)
    const prompt = u.input + u.cacheRead + u.cacheWrite
    this.segment.finish({ stop: "stop", usage: {
      prompt_tokens: prompt, completion_tokens: u.output, total_tokens: prompt + u.output,
      prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
      ...(this.usageFields?.some((f) => f.num === 5) ? { completion_tokens_details: { reasoning_tokens: u.reasoning } } : {}),
      ...(!measuredInput || !measuredOutput ? { magpie_native: { accounting: "estimated" } } : {}),
    } })
    this.state = "complete"
    this.closeTransport()
    this.pool.release(this)
    this.replayTimer = later(() => this.pool.forget(this), this.limits.replayWait)
  }
  async pump(stream) {
    const { pb, exec, failure } = this.wire
    try {
      for await (const f of stream) {
        if (this.error || this.state === "complete") return
        if (f.end) {
          const e = failure(200, f.data)
          if (e.status < 200 || e.status > 299) throw new NativeSessionError(e.status, e.message)
          if (!this.terminal && !this.segment.calls.length && this.segment.content) this.terminalSeen([])
          this.complete()
          return
        }
        for (const m of nativeFields(f.data)) {
          switch (m.num) {
            case 1:
              for (const u of nativeFields(m.data)) {
                const uf = nativeFields(u.data)
                if (u.num === 1 || u.num === 4) {
                  const text = str(uf, 1)
                  if (this.terminal || this.state === "awaiting-results") invalid("native output arrived outside a running Chat segment", 502)
                  if (text) {
                    this.said += text.length
                    if (u.num === 1) this.wrote += text.length
                    this.segment.emit(u.num === 1 ? { text } : { reasoning: text })
                  }
                } else if (u.num === 14) {
                  if (!this.segment.content && !this.segment.calls.length) invalid("an empty reply (Cursor ended the turn without text or a tool call)", 502)
                  this.terminalSeen(uf)
                } else if (u.num === 27) this.listed(num(uf, 1))
              }
              break
            case 2: {
              const c = exec(m.data, this.chatTools, (b) => this.send(b), (id) => this.execClose(id), null, true)
              if (c) this.acceptCall(c)
              break
            }
            case 3:
              this.checkpointReceived(m.data)
              break
            case 4: {
              const kv = nativeFields(m.data)
              const id = num(kv, 1)
              for (const k of kv) {
                if (k.num === 2) {
                  const want = field(nativeFields(k.data), 1)?.data.toString("hex") ?? ""
                  const b = this.blobs.get(want)
                  const res = b ? pb().bytes(1, b) : pb().bytes(2, pb().str(1, "blob not found"))
                  this.send(pb().bytes(3, pb().varint(1, id).bytes(2, res)).done())
                } else if (k.num === 3) {
                  try {
                    const set = nativeFields(k.data)
                    this.store(field(set, 1)?.data ?? Buffer.alloc(0), field(set, 2)?.data ?? Buffer.alloc(0))
                  } catch (e) {
                    this.send(pb().bytes(3, pb().varint(1, id).bytes(3, pb().bytes(1, pb().str(1, "native blob could not be retained")))).done())
                    throw e
                  }
                  this.send(pb().bytes(3, pb().varint(1, id).bytes(3, Buffer.alloc(0))).done())
                }
              }
              break
            }
            case 5:
              for (const c of nativeFields(m.data)) if (c.num === 1) {
                const id = num(nativeFields(c.data), 1)
                const pending = this.execs.get(id)
                if (pending && !pending.submitted) invalid("Cursor cancelled a pending native tool exec; late results cannot be submitted", 410)
              }
              break
            case 7:
              invalid("unsupported native interaction query", 502)
          }
        }
      }
      if (!this.error && this.state !== "complete") {
        if (this.terminal) this.complete()
        else invalid("native reply broke off before completing its turn or tool batch: EOF", 502)
      }
    } catch (e) {
      if (!this.error && this.state !== "complete") this.fail(failureOf(e))
    }
  }
}

export const nativeSessions = new NativeSessionPool()
