import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import http2 from "node:http2"
import { randomUUID } from "node:crypto"
import { CursorAuthPlugin, _internal } from "./index.mjs"
import { NATIVE_LIMITS, nativeSessions } from "./native-session.mjs"
import { readWire, nest, number, string, message, uint, text, update, tool, end, readResult, setBlob, getBlob } from "./native-test-wire.mjs"

const savedFetch = globalThis.fetch
const servers = []
const limits = { ...NATIVE_LIMITS }
const until = async (predicate) => {
  const deadline = Date.now() + 1200
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach its expected state")
    await new Promise((r) => setTimeout(r, 5))
  }
}
beforeEach(async () => {
  await nativeSessions.clear()
  _internal.resetH1()
})
afterEach(async () => {
  await nativeSessions.clear()
  for (const { server, sessions } of servers.splice(0)) {
    for (const session of sessions) session.destroy()
    await new Promise((r) => server.close(r))
  }
  globalThis.fetch = savedFetch
  _internal.resetH1()
  for (const key of Object.keys(NATIVE_LIMITS)) if (!(key in limits)) delete NATIVE_LIMITS[key]
  Object.assign(NATIVE_LIMITS, limits)
})

// Refusing the local H2 stream exercises the existing RunSSE/BidiAppend path.
// All API calls are synthetic; unknown calls fail instead of leaving localhost.
async function fixture({ failResult = false, stallKv = false } = {}) {
  const sessions = new Set()
  const server = http2.createServer()
  server.on("session", (s) => { sessions.add(s); s.on("error", () => {}); s.on("close", () => sessions.delete(s)) })
  server.on("stream", (s) => { s.on("error", () => {}); s.close(http2.constants.NGHTTP2_REFUSED_STREAM) })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  servers.push({ server, sessions })
  const base = `http://127.0.0.1:${server.address().port}`
  const seen = { sse: 0, runs: 0, appends: [], results: [], closes: [], kv: [], maxInFlight: 0 }
  let inFlight = 0
  let controller
  let ended = false
  let requestID
  const push = (b) => { if (!ended) controller.enqueue(b) }
  const finish = () => {
    if (ended) return
    push(end())
    ended = true
    controller.close()
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: [{ modelId: "synthetic-h1-model", displayName: "Synthetic H1" }] })
    if (u.endsWith("/agent.v1.AgentService/RunSSE")) {
      seen.sse++
      requestID = string(Buffer.from(init.body).subarray(5), 1)
      return new Response(new ReadableStream({
        start(c) {
          controller = c
          init.signal.addEventListener("abort", () => {
            if (ended) return
            ended = true
            c.close()
          }, { once: true })
        },
      }))
    }
    if (!u.endsWith("/aiserver.v1.BidiService/BidiAppend")) throw new Error("unexpected synthetic API call: " + u)
    const body = Buffer.from(init.body)
    expect(string(nest(body, 2), 1)).toBe(requestID)
    const seqno = number(body, 3)
    const wire = Buffer.from(string(body, 1), "hex")
    inFlight++
    seen.maxInFlight = Math.max(seen.maxInFlight, inFlight)
    seen.appends.push(seqno)
    try {
      const fs = readWire(wire)
      if (fs.some((f) => f.no === 1)) {
        seen.runs++
        push(update(4, text(1, "synthetic native thinking one")))
        push(update(27, uint(1, 1)))
        push(tool(7, "h1-native-call-one"))
      } else if (fs.some((f) => f.no === 2)) {
        const result = readResult(wire)
        expect(result.execID).toBe("exec-" + result.id)
        expect(seen.results.some((r) => r.id === result.id)).toBe(false)
        seen.results.push(result)
        // Hold the result append so a premature/concurrent close is observable.
        await new Promise((r) => setTimeout(r, 25))
        if (failResult) return new Response('{"code":"unavailable","message":"synthetic append failed after receiving result"}', { status: 503 })
      } else if (fs.some((f) => f.no === 5)) {
        const control = nest(wire, 5)
        const close = readWire(control).find((f) => f.no === 1)
        if (close) {
          const id = number(close.data, 1)
          const result = seen.results.find((r) => r.id === id)
          expect(result).toBeDefined()
          expect(seen.closes).not.toContain(id)
          seen.closes.push(id)
          if (id === 7) {
            push(update(4, text(1, "synthetic native thinking two")))
            push(tool(8, "h1-native-call-two", result.content[0].text))
            push(update(27, uint(1, 1)))
          } else {
            push(update(1, text(1, result.content[0].text)))
            push(update(14, message(uint(1, 17), uint(2, 5), uint(3, 11))))
            finish()
          }
        }
      } else if (fs.some((f) => f.no === 3)) {
        const kv = nest(wire, 3)
        seen.kv.push(number(kv, 1))
        if (stallKv && readWire(kv).some((f) => f.no === 2)) await new Promise((_, reject) => {
          if (init.signal.aborted) reject(init.signal.reason)
          else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        })
      }
      return new Response(new Uint8Array(0))
    } finally {
      inFlight--
    }
  }
  const account = {
    type: "oauth",
    access: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, sub: "synthetic-h1-" + randomUUID() })).toString("base64url")}.fixture`,
    refresh: "", accountId: "fixture@example.invalid",
  }
  const plugin = await CursorAuthPlugin()
  const loader = await plugin.auth.loader(async () => account)
  const ask = async (chat) => {
    const response = await loader.fetch(base + "/v1/chat/completions", {
      method: "POST", headers: { "x-magpie-cursor-session": "synthetic-h1-session" }, body: JSON.stringify(chat),
    })
    if (chat.stream) return response
    return { status: response.status, body: await response.json() }
  }
  return { seen, ask, push, ended: () => ended, inFlight: () => inFlight }
}
const initial = () => ({ model: "synthetic-h1-model", messages: [{ role: "user", content: "two synthetic calls" }],
  tools: [{ type: "function", function: { name: "audit_echo", parameters: { type: "object" } } }] })
const continuation = (chat, response, value) => ({ ...chat, messages: [...chat.messages, response.body.choices[0].message,
  { role: "tool", tool_call_id: response.body.choices[0].message.tool_calls[0].id, content: value }] })

test("native HTTP/1: two external roundtrips keep one RunSSE and serialize result-before-close BidiAppends", async () => {
  const { seen, ask } = await fixture()
  const chat = initial()
  const first = await ask(chat)
  expect(first.status).toBe(200)
  const marker = "synthetic-h1-result-" + randomUUID()
  const secondChat = continuation(chat, first, marker)
  const second = await ask(secondChat)
  expect(second.status).toBe(200)
  expect(JSON.parse(second.body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ value: marker })
  const final = await ask(continuation(secondChat, second, marker))
  expect(final.status).toBe(200)
  expect(final.body.choices[0].message.content).toBe(marker)
  expect(final.body.choices[0].finish_reason).toBe("stop")
  expect(final.body.usage.prompt_tokens).toBe(17)
  expect(final.body.usage.completion_tokens).toBe(5)
  expect(seen).toMatchObject({ sse: 1, runs: 1, appends: [0, 1, 2, 3, 4], closes: [7, 8], maxInFlight: 1 })
  expect(seen.results.map((r) => r.id)).toEqual([7, 8])
})

for (const stream of [false, true]) test(`native HTTP/1: ${stream ? "streamed" : "JSON"} failure after receiving a result invalidates its uncertain outcome without close or retry submission`, async () => {
  const { seen, ask } = await fixture({ failResult: true })
  const chat = initial()
  const first = await ask(chat)
  expect(first.status).toBe(200)
  const owner = [...nativeSessions.entries][0]
  const next = { ...continuation(chat, first, "synthetic uncertain result"), stream }
  const response = await ask(next)
  expect(response.status).toBe(503)
  const failed = stream ? { status: response.status, body: await response.json() } : response
  expect(failed.body.error.message).toContain("append failed")
  expect(failed.body.magpie_cursor.effective_model.id).toBe("synthetic-h1-model")
  const retry = await ask({ ...next, stream: false })
  // Contract invalidation evicts the uncertain owner, so a retry is expired
  // rather than a reusable replay of the original transport failure.
  expect(retry.status).toBe(410)
  expect(nativeSessions.entries.size).toBe(0)
  expect(nativeSessions.handles.size).toBe(0)
  expect(seen).toMatchObject({ sse: 1, runs: 1, appends: [0, 1], closes: [], maxInFlight: 1 })
  expect(seen.results).toHaveLength(1)
  expect(owner.state).toBe("failed")
})

for (const stream of [false, true]) test(`native HTTP/1: ${stream ? "streamed" : "JSON"} synchronous result-close admission overflow preserves 503 and prohibits retry`, async () => {
  const a = await fixture()
  const chat = initial()
  const first = await a.ask(chat)
  expect(first.status).toBe(200)
  const owner = [...nativeSessions.entries][0]
  const batch = owner.segment
  await until(() => a.inFlight() === 0 && owner.transport.outbound.messages === 0)
  NATIVE_LIMITS.outboundMessages = 1
  const next = { ...continuation(chat, first, "synthetic admitted H1 result"), stream }
  const response = await a.ask(next)
  expect(response.status).toBe(503)
  const body = stream ? await response.json() : response.body
  expect(body.error.message).toContain("native outbound messages limit reached")
  expect(body.error.message).toContain("uncertain")
  expect(body.error.message).toContain("cannot be replayed")
  expect(body.choices).toBeUndefined()
  expect(body.magpie_cursor.effective_model.id).toBe("synthetic-h1-model")
  expect(owner.error.status).toBe(503)
  expect(owner.state).toBe("failed")
  expect(owner.ac.signal.aborted).toBe(true)
  expect(owner.transport.outbound).toEqual({ bytes: 0, messages: 0 })
  expect(batch.resultDigest).toBeTruthy()
  expect(batch.calls[0].submitted).toBe(true)
  expect(nativeSessions.entries.size).toBe(0)
  expect(nativeSessions.handles.size).toBe(0)
  await until(() => a.inFlight() === 0 && a.ended())
  expect((await a.ask({ ...next, stream: false })).status).toBe(410)
  expect(a.seen).toMatchObject({ sse: 1, runs: 1, appends: [0, 1], closes: [], maxInFlight: 1 })
  expect(a.seen.results).toHaveLength(1)
  expect(a.seen.results[0]).toMatchObject({ id: 7, execID: "exec-7", content: [{ type: "text", text: "synthetic admitted H1 result" }] })
})

for (const bound of ["bytes", "messages"]) test(`native loader HTTP/1: stalled parked KV replies hit the outbound ${bound} bound and abort all transport work`, async () => {
  NATIVE_LIMITS.outboundBytes = 4 << 20
  NATIVE_LIMITS.outboundMessages = bound === "messages" ? 4 : 256
  const a = await fixture({ stallKv: true })
  const chat = initial()
  const first = await a.ask(chat)
  expect(first.status).toBe(200)
  const owner = [...nativeSessions.entries][0]
  const blobID = Buffer.from("synthetic-queued-blob")
  a.push(setBlob(90, blobID, Buffer.alloc(bound === "bytes" ? 1 << 20 : 1)))
  await until(() => a.seen.kv.includes(90) && a.inFlight() === 0)
  a.push(getBlob(91, blobID))
  await until(() => a.seen.kv.includes(91))
  for (let i = 0; i < 8; i++) a.push(getBlob(92 + i, blobID))
  await until(() => !!owner.error)
  expect(owner.error).toMatchObject({ status: 503 })
  expect(owner.error.message).toContain("outbound")
  expect(owner.error.message).toContain(bound)
  await until(() => a.inFlight() === 0 && a.ended())
  expect(owner.transport.outbound).toEqual({ bytes: 0, messages: 0 })
  expect(owner.ac.signal.aborted).toBe(true)
  expect(a.seen.kv).toEqual([90, 91])
  expect(a.seen.maxInFlight).toBe(1)
  expect(a.seen.results).toEqual([])
  expect(a.seen.closes).toEqual([])
  expect((await a.ask(continuation(chat, first, "late after overflow"))).status).toBe(503)
  expect(a.seen.runs).toBe(1)
})
