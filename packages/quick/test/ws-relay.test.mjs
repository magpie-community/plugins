// The WS client and the relay end-to-end against a fake server: a fake
// WebSocket serves the captured handshake and a captured turn's events,
// and the relay answers a chat.completions request — streamed and
// aggregated — from them. Nothing touches a real host.
import { afterEach, expect, test } from "bun:test"
import { QuickSocket } from "../lib/ws-client.mjs"
import { relayTurn } from "../lib/relay.mjs"
import { parseFrame } from "../lib/frame.mjs"
import { readFileSync } from "node:fs"

const fx = JSON.parse(readFileSync(new URL("./fixtures-ws.json", import.meta.url), "utf8"))
const realWS = globalThis.WebSocket

// a fake WebSocket: records sends, answers with scripted frames
function fakeWS(script) {
  const sent = []
  class WS {
    static OPEN = 1
    static INSTANCES = []
    readyState = 0
    binaryType = ""
    constructor(url) {
      this.url = url
      this.listeners = {}
      WS.INSTANCES.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.emit("open")
        // the frames arrive after the open, on a later tick — the client
        // attaches its message listener once the open promise settles
        setTimeout(() => {
          for (const frame of script) this.emit("message", Buffer.from(frame, "hex"))
        }, 1)
      }, 0)
    }
    send(data) {
      sent.push(parseFrame(Buffer.from(data)))
    }
    addEventListener(name, fn) {
      (this.listeners[name] ??= []).push(fn)
    }
    on(name, fn) {
      this.addEventListener(name, fn)
    }
    once(name, fn) {
      const wrapped = (...a) => {
        this.off(name, wrapped)
        fn(...a)
      }
      this.addEventListener(name, wrapped)
    }
    off(name, fn) {
      const list = this.listeners[name]
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
    emit(name, ...args) {
      for (const fn of this.listeners[name] ?? []) fn(...args)
    }
    close() {
      this.readyState = 3
      this.emit("close", 1000)
    }
  }
  return { WS, sent }
}

// the captured handshake RECV frames (session_established, connected) and a
// full turn (message_start … turn_usage … message_complete)
function framesOf(...types) {
  return fx.filter((f) => types.includes(f.type)).map((f) => f.hex)
}

const account = { accountId: "1234567890", cookie: "a=1", mbtc: "m" }

afterEach(() => {
  globalThis.WebSocket = realWS
})

test("the socket handshake sends session_connect and reads the working session", async () => {
  const { WS, sent } = fakeWS(framesOf("session_established", "connected"))
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  expect(s.workingSessionId).toBe("6ba30663-3f73-40d6-a031-1ab629c0fa27")
  // the handshake went out first
  expect(sent[0].body.type).toBe("session_connect")
  s.close()
})

test("a chat turn streams the captured events and ends at message_complete", async () => {
  const { WS } = fakeWS([
    ...framesOf("session_established", "connected"),
    // a user_message send is followed by the turn's RECV frames
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const got = []
  for await (const e of s.chat({ text: "hi", agent_mode: "smart", thinking_effort: "high" })) got.push(e)
  expect(got.map((e) => e.type)).toEqual(["message_start", "text_delta", "text_delta", "turn_usage", "text_complete", "message_complete"])
  expect(got.find((e) => e.type === "turn_usage").resolved_model_id).toBeTypeOf("string")
  s.close()
})

test("the relay answers a chat.completions request from the captured turn", async () => {
  const { WS } = fakeWS([
    ...framesOf("session_established", "connected"),
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: false, body: { messages: [{ role: "user", content: "hi" }], thinking: "high" } })
  expect(res.status).toBe(200)
  const j = await res.json()
  expect(j.object).toBe("chat.completion")
  expect(j.choices[0].message.content).toBe("PROTOCOL-TEST-OK")
  expect(j.quick["quick.resolved_model_id"]).toBeTypeOf("string")
  expect(j.quick["quick.turn_seconds"]).toBeGreaterThanOrEqual(0)
  expect(j.usage.total_tokens).toBeGreaterThan(0)
  s.close()
})

test("the relay streams SSE chunks ending in [DONE]", async () => {
  const { WS } = fakeWS([
    ...framesOf("session_established", "connected"),
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: true, body: { messages: [{ role: "user", content: "hi" }] } })
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const text = await res.text()
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)))
  const joined = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  expect(joined).toBe("PROTOCOL-TEST-OK")
  const last = chunks[chunks.length - 2]
  expect(last.quick["quick.resolved_model_id"]).toBeTypeOf("string")
  s.close()
})

test("a tools request is refused with a clear 400", async () => {
  const { WS } = fakeWS([...framesOf("session_established", "connected")])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: false, body: { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f" } }] } })
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("tool")
  s.close()
})

test("a bad thinking value is refused with a clear 400", async () => {
  const { WS } = fakeWS([...framesOf("session_established", "connected")])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: false, body: { messages: [{ role: "user", content: "hi" }], thinking: "ultra" } })
  expect(res.status).toBe(400)
  s.close()
})

test("a thread id rides the request, the reply names it for the next turn", async () => {
  const { WS } = fakeWS([
    ...framesOf("session_established", "connected"),
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const thread = "11111111-2222-3333-4444-555555555555"
  const res = await relayTurn({ socket: s, model: "quick-balanced", stream: false, threadId: thread, body: { messages: [{ role: "user", content: "hi" }] } })
  const j = await res.json()
  // the server's own thread id comes back (the fixtures' turn runs on this thread)
  expect(j.quick["quick.thread_id"]).toBe("a0e19a02-f16b-414d-bc09-eebd73057310")
  expect(res.headers.get("x-quick-thread-id")).toBe("a0e19a02-f16b-414d-bc09-eebd73057310")
  // the request carried the caller's thread
  s.close()
})

test("a chat turn accepts a caller thread id for continuation", async () => {
  const { WS, sent } = fakeWS([
    ...framesOf("session_established", "connected"),
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const thread = "11111111-2222-3333-4444-555555555555"
  for await (const e of s.chat({ text: "again", agent_mode: "fast", thinking_effort: "off", thread_id: thread })) {
    if (e.type === "message_complete") break
  }
  const user = sent.find((f) => f.body?.type === "user_message")
  expect(user.body.payload.thread_id).toBe(thread)
  const dock = sent.find((f) => f.body?.type === "dock_state_sync")
  expect(dock.body.payload.session_id).toBe(thread)
  s.close()
})

test("an aborted turn sends stop_generation and finishes aborted", async () => {
  const { WS, sent } = fakeWS([
    ...framesOf("session_established", "connected"),
    // a long turn: deltas keep coming; the abort fires before message_complete
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const ac = new AbortController()
  // abort as soon as the first event arrives, so the turn ends early
  ac.abort()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: false, signal: ac.signal, body: { messages: [{ role: "user", content: "hi" }] } })
  // the relay aborted before message_complete: finish_reason says aborted (not stop)
  const j = await res.json()
  expect(j.choices[0].finish_reason).toBe("aborted")
  // the client asked the server to stop the turn
  const stop = sent.find((f) => f.body?.type === "stop_generation")
  expect(stop).toBeTruthy()
  s.close()
})

test("incognito defaults on and rides the user_message payload (live-verified 2026-11-22)", async () => {
  const { WS, sent } = fakeWS([
    ...framesOf("session_established", "connected"),
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: false, body: { messages: [{ role: "user", content: "hi" }] } })
  const j = await res.json()
  const user = sent.find((f) => f.body?.type === "user_message")
  // the web client's own incognito flag, captured on the live page
  expect(user.body.payload.incognito).toBe(true)
  expect(j.quick["quick.incognito"]).toBe(true)
  s.close()
})

test("quick.incognito: false opts back into the visible history", async () => {
  const { WS, sent } = fakeWS([
    ...framesOf("session_established", "connected"),
    ...fx.filter((f) => ["message_start", "text_delta", "turn_usage", "text_complete", "message_complete"].includes(f.type)).map((f) => f.hex),
  ])
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const res = await relayTurn({ socket: s, model: "quick-smart", stream: false, body: { messages: [{ role: "user", content: "hi" }], quick: { incognito: false } } })
  const j = await res.json()
  const user = sent.find((f) => f.body?.type === "user_message")
  expect(user.body.payload.incognito).toBe(false)
  expect(j.quick["quick.incognito"]).toBe(false)
  s.close()
})

test("quick.session_id re-attaches the socket to that conversation", async () => {
  const { WS, sent } = fakeWS(framesOf("session_established", "connected"))
  globalThis.WebSocket = WS
  const sessionId = "be7a0ec6-b80e-4578-89e0-0622b2c99669"
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect(sessionId)
  // the handshake's session_connect carried the caller's session id
  const connect = sent.find((f) => f.body?.type === "session_connect")
  expect(connect.body.payload.session_id).toBe(sessionId)
  s.close()
})

test("a plain socket's handshake opens a fresh conversation (empty session_id)", async () => {
  const { WS, sent } = fakeWS(framesOf("session_established", "connected"))
  globalThis.WebSocket = WS
  const s = await new QuickSocket(account, { pingMs: 3600_000 }).connect()
  const connect = sent.find((f) => f.body?.type === "session_connect")
  expect(connect.body.payload.session_id).toBe("")
  s.close()
})
