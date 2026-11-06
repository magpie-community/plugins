// Qoder's queue (code 10605) is waited out as Qoder's own client waits it
// (qoder-agent-sdk's worker in Qoder.app 0.4.3, "[ModelQueue]"): it asks
// /api/v2/service/ask/queue/status with the request's requestSetId, the
// model and the queueType until isQueued is false, waits that state's
// retryAfterSeconds and sends the request again (its request_set_id, a new
// request_id). wallance on Discord:
// Qoder's free dfmodel answered "Qoder queued the request for dfmodel (this
// plan's queue: p3); try again in 30s" through magpie, while Qoder's client
// answered, slowly. The refusal is the shape of the real one in
// testdata/queued-10605.json with isQueued true, as wallance's message
// says; the status replies are that shape too, not captured bytes.
//
// The clock and the pauses are the test's own (QUEUE.now, QUEUE.pause): a
// pause moves the clock on at once, and says how long it was asked to be.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const { QUEUE } = _internal
const real = globalThis.fetch
const saved = { ...QUEUE }
let clock, pauses, timers
// tick moves the clock on by ms, calling each QUEUE.every timer as often
// as its interval passes, at the time it passes
const tick = (ms) => {
  const to = clock + ms
  for (;;) {
    const t = timers.filter((t) => !t.stopped).sort((a, b) => a.next - b.next)[0]
    if (!t || t.next > to) break
    clock = t.next
    t.next += t.ms
    t.fn()
  }
  clock = to
}
beforeEach(() => {
  clock = 1_000_000
  pauses = []
  timers = []
  QUEUE.now = () => clock
  QUEUE.pause = async (ms, signal) => {
    if (signal?.aborted) throw signal.reason
    pauses.push(ms)
    tick(ms)
  }
  QUEUE.every = (fn, ms) => {
    const t = { fn, ms, next: clock + ms, stopped: false }
    timers.push(t)
    return () => (t.stopped = true)
  }
})
afterEach(() => {
  globalThis.fetch = real
  Object.assign(QUEUE, saved)
})

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const ask = (signal) => ({ method: "POST", body: JSON.stringify({ model: "dfmodel", messages: [{ role: "user", content: "hi" }] }), signal })
const LISTING = { chat: [{ key: "dfmodel", display_name: "DeepSeek Flash", enable: true }] }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const QUEUED = { isQueued: true, modelKey: "dfmodel", queueCount: 3, queueType: "p3", retryAfterSeconds: 30, serviceAvailable: true, waitTime: 20 }
const refused = (q = QUEUED) => json({ code: "10605", message: JSON.stringify(q) }, 403)
const line = (body, statusCodeValue = 200) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue })}\n\n`
const answered = () =>
  new Response(line({ choices: [{ delta: { content: "hello" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + line("[DONE]"), {
    headers: { "Content-Type": "text/event-stream" },
  })
const status = (st) => json({ success: true, data: st })

// a loader whose chats are answered by chats(), in turn, and status asks by
// statuses(); what was sent is kept
async function loader({ chats, statuses }) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  const sent = { chats: [], statuses: [] }
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/model/list")) return json(LISTING)
    if (u.pathname.endsWith("/queue/status")) {
      sent.statuses.push({ url: u, headers: init.headers, signal: init.signal })
      return statuses(sent.statuses.length)
    }
    sent.chats.push(JSON.parse(_internal.decodeBody(init.body)))
    return chats(sent.chats.length)
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, sent }
}

test("a queued request waits its turn in Qoder's queue and is sent again, in the same request set under a new request id, once the queue lets it through", async () => {
  const { fetch, sent } = await loader({
    chats: (n) => (n === 1 ? refused() : answered()),
    statuses: (n) => status(n < 3 ? { ...QUEUED, queueCount: 3 - n, retryAfterSeconds: 12 } : { isQueued: false, modelKey: "dfmodel", queueType: "p3", retryAfterSeconds: 1, serviceAvailable: true }),
  })
  const res = await fetch(API_CHAT, ask())
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hello")
  // asked at once, then after each state's retryAfterSeconds; once through,
  // its own retryAfterSeconds before the request goes again
  expect(pauses).toEqual([12_000, 12_000, 1_000])
  expect(sent.chats.length).toBe(2)
  // the queue knows it by its request_set_id; the resend is a new call in
  // it, a new request_id and chat_record_id, as Qoder's client sends it
  // (o4i before each resend)
  expect(sent.chats[1].request_set_id).toBe(sent.chats[0].request_set_id)
  expect(sent.chats[1].request_id).not.toBe(sent.chats[0].request_id)
  expect(sent.chats[1].chat_record_id).toBe(sent.chats[1].request_id)
  expect(sent.chats[1].session_id).toBe(sent.chats[0].session_id)
  expect(sent.chats[1].messages).toEqual(sent.chats[0].messages)
  const first = sent.statuses[0]
  expect(first.url.origin + first.url.pathname).toBe("https://api3.qoder.sh/algo/api/v2/service/ask/queue/status")
  expect(Object.fromEntries(first.url.searchParams)).toEqual({ requestSetId: sent.chats[0].request_set_id, modelKey: "dfmodel", queueType: "p3" })
  expect(first.headers["X-Request-ID"]).toBe(sent.chats[0].request_id)
  expect(first.headers["X-Session-ID"]).toBe(sent.chats[0].session_id)
  expect(first.headers.Authorization).toStartWith("Bearer COSY.")
})

test("a refusal's stream is closed before the wait, and the status asks after a resend name the resend", async () => {
  // Qoder keeps a 10605 stream open after its one event (seen on a real
  // qoder.com account, plugins#427): it is closed, not held through the
  // wait and the resend
  const signals = []
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  const chats = []
  const statuses = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/model/list")) return json(LISTING)
    if (u.pathname.endsWith("/queue/status")) {
      statuses.push(init.headers["X-Request-ID"])
      return status(statuses.length % 2 ? QUEUED : { isQueued: false, serviceAvailable: true })
    }
    chats.push(JSON.parse(_internal.decodeBody(init.body)))
    signals.push(init.signal)
    if (chats.length === 3) return answered()
    const ev = new TextEncoder().encode(line({ code: "10605", message: JSON.stringify(QUEUED) }, 403))
    return new Response(new ReadableStream({ start: (c) => c.enqueue(ev) }), { headers: { "Content-Type": "text/event-stream" } })
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch(API_CHAT, ask())
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hello")
  expect(chats.length).toBe(3)
  expect(signals.map((s) => s.aborted)).toEqual([true, true, false])
  expect(new Set(chats.map((c) => c.request_id)).size).toBe(3)
  expect(new Set(chats.map((c) => c.request_set_id)).size).toBe(1)
  expect(statuses).toEqual([chats[0].request_id, chats[0].request_id, chats[1].request_id, chats[1].request_id])
})

test("the queue's refusal in the stream is waited out the same way", async () => {
  const { fetch, sent } = await loader({
    chats: (n) =>
      n === 1
        ? new Response(line({ code: "10605", message: JSON.stringify(QUEUED) }, 403), { headers: { "Content-Type": "text/event-stream" } })
        : answered(),
    statuses: () => status({ isQueued: false, serviceAvailable: true }),
  })
  const res = await fetch(API_CHAT, ask())
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hello")
  expect(sent.chats.length).toBe(2)
})

test("a wait held past the budget is the 503 with Retry-After it was, the request not sent again", async () => {
  const { fetch, sent } = await loader({ chats: () => refused(), statuses: () => status(QUEUED) })
  const res = await fetch(API_CHAT, ask())
  expect(res.status).toBe(503)
  expect(res.headers.get("Retry-After")).toBe("30")
  expect((await res.json()).error.message).toBe("Qoder queued the request for dfmodel (this plan's queue: p3, 3 ahead); try again in 30s")
  expect(sent.chats.length).toBe(1)
  // 30s pauses, the last cut to what was left of the budget
  expect(pauses.reduce((a, b) => a + b, 0)).toBe(QUEUE.budget)
  expect(Math.max(...pauses)).toBe(30_000)
})

// With another candidate after it (magpie's X-Magpie-Fallback: the model's
// next account or provider, a routing group's next member), a queued
// request isn't waited out: its 503 goes back at once, with where it stood
// in the queue, and magpie asks the next (axuhere on X: a free model held
// at "预计等待超过 10 分钟" while another provider could answer). The last
// candidate isn't told, and waits as Qoder's client does (above).
test("told another candidate follows, a queued request is answered at once with the queue's reason", async () => {
  const { fetch, sent } = await loader({ chats: () => refused(), statuses: () => status(QUEUED) })
  const res = await fetch(API_CHAT, { ...ask(), headers: { "x-magpie-fallback": "1" } })
  expect(res.status).toBe(503)
  expect(res.headers.get("Retry-After")).toBe("30")
  expect((await res.json()).error.message).toBe("Qoder queued the request for dfmodel (this plan's queue: p3, 3 ahead); try again in 30s")
  expect(sent.chats.length).toBe(1)
  expect(sent.statuses.length).toBe(0)
  expect(pauses).toEqual([])
})

test("the pause is the queue's retryAfterSeconds held to 0.5s..30s, and 30s when it says none", async () => {
  const states = [
    { ...QUEUED, retryAfterSeconds: 0.1 },
    { ...QUEUED, retryAfterSeconds: 300 },
    { ...QUEUED, retryAfterSeconds: undefined },
    { isQueued: false },
  ]
  const { fetch } = await loader({ chats: (n) => (n === 1 ? refused() : answered()), statuses: (n) => status(states[n - 1]) })
  expect((await fetch(API_CHAT, ask())).status).toBe(200)
  expect(pauses).toEqual([500, 30_000, 30_000])
})

test("service unavailable keeps waiting; the queue saying nothing of itself, or no queue there (404), ends the wait at once", async () => {
  let r = await loader({
    chats: (n) => (n === 1 ? refused() : answered()),
    statuses: (n) => status(n === 1 ? { isQueued: false, serviceAvailable: false, retryAfterSeconds: 5 } : { isQueued: false }),
  })
  // isQueued false comes first, as in Qoder's client: through, after 5s
  expect((await r.fetch(API_CHAT, ask())).status).toBe(200)
  expect(pauses).toEqual([5_000])

  pauses = []
  r = await loader({
    chats: (n) => (n === 1 ? refused() : answered()),
    statuses: (n) => status(n === 1 ? { serviceAvailable: false, retryAfterSeconds: 2 } : { isQueued: false }),
  })
  expect((await r.fetch(API_CHAT, ask())).status).toBe(200)
  expect(pauses).toEqual([2_000])

  for (const reply of [() => status({ nothing: 1 }), () => new Response("not found", { status: 404 })]) {
    pauses = []
    r = await loader({ chats: () => refused(), statuses: reply })
    expect((await r.fetch(API_CHAT, ask())).status).toBe(503)
    expect(r.sent.statuses.length).toBe(1)
    expect(r.sent.chats.length).toBe(1)
  }
})

test("three failed status asks in a row end the wait; one between good ones doesn't", async () => {
  let r = await loader({ chats: () => refused(), statuses: () => new Response("boom", { status: 500 }) })
  expect((await r.fetch(API_CHAT, ask())).status).toBe(503)
  expect(r.sent.statuses.length).toBe(3)
  // a failed ask's pause isn't the last state's: 30s
  expect(pauses).toEqual([30_000, 30_000])

  pauses = []
  const replies = [() => new Response("", { status: 502 }), () => status(QUEUED), () => new Response("", { status: 502 }), () => new Response("", { status: 502 }), () => status({ isQueued: false })]
  r = await loader({ chats: (n) => (n === 1 ? refused() : answered()), statuses: (n) => replies[n - 1]() })
  expect((await r.fetch(API_CHAT, ask())).status).toBe(200)
  expect(r.sent.statuses.length).toBe(5)
})

test("the queue is waited out 10 times for one request at most", async () => {
  QUEUE.budget = 24 * 60 * 60 * 1000
  const { fetch, sent } = await loader({ chats: () => refused(), statuses: () => status({ isQueued: false }) })
  const res = await fetch(API_CHAT, ask())
  expect(res.status).toBe(503)
  expect(sent.chats.length).toBe(11)
})

test("a cancelled request stops waiting: no status asked and no request sent after", async () => {
  const stop = new AbortController()
  const { fetch, sent } = await loader({
    chats: () => refused(),
    statuses: (n) => {
      if (n === 2) stop.abort(new DOMException("the client went away", "AbortError"))
      return status(QUEUED)
    },
  })
  const res = await fetch(API_CHAT, ask(stop.signal))
  expect(res.status).toBe(502)
  expect(sent.statuses.length).toBe(2)
  expect(sent.chats.length).toBe(1)
})

test("the real pause ends early when the request is cancelled", async () => {
  QUEUE.pause = saved.pause
  const stop = new AbortController()
  const p = QUEUE.pause(60_000, stop.signal)
  stop.abort(new DOMException("gone", "AbortError"))
  await expect(p).rejects.toThrow("gone")
})

test("the state is found where Qoder's client finds it", () => {
  expect(_internal.queueState(JSON.stringify({ data: { isQueued: true, queueType: "p3", retryAfterSeconds: "7" } }))).toEqual({
    isQueued: true,
    serviceAvailable: undefined,
    modelKey: undefined,
    queueType: "p3",
    retryAfterSeconds: 7,
  })
  expect(_internal.queueState(JSON.stringify({ code: "200", message: JSON.stringify({ isQueued: false }) }))?.isQueued).toBe(false)
  expect(_internal.queueState(JSON.stringify({ result: JSON.stringify({ serviceAvailable: false }) }))?.serviceAvailable).toBe(false)
  expect(_internal.queueState("not json")).toBeUndefined()
  expect(_internal.queueState(JSON.stringify({ data: { queueCount: 1 } }))).toBeUndefined()
})

// A streamed request (every agent's: Codex, Claude Code, OpenCode) waits as
// long as Qoder's client does, an hour, where it waited 4 minutes and then
// was the 503 Codex retried, a stop and a restart for the user
// (real-jacket, plugins#807). It is answered 200 at once, with a comment
// saying the queue, and a comment every QUEUE.beat while it waits: magpie
// hears each as the reply going on, and keeps Codex alive with
// response.in_progress, the event its 300s idle timeout counts.
const streamed = (signal) => ({ ...ask(signal), body: JSON.stringify({ model: "dfmodel", stream: true, messages: [{ role: "user", content: "hi" }] }) })

// comments are the stream's SSE comment lines, each with the clock's time
// when it was sent
async function read(res, until) {
  const lines = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line) lines.push({ line, at: clock })
    }
    if (until?.(lines)) return { lines, reader }
  }
  return { lines, reader }
}

test("a streamed request Qoder queues is answered 200 at once, hears a comment every beat while it waits past 4 minutes, and gets the answer in the same stream", async () => {
  let open
  const gate = new Promise((ok) => (open = ok))
  // the queue lets it through after 20 minutes: 40 asks 30s apart
  const { fetch, sent } = await loader({
    chats: (n) => (n === 1 ? refused() : answered()),
    statuses: async (n) => {
      if (n === 1) await gate // the client has its 200 before the wait goes on
      return status(n <= 40 ? { ...QUEUED, retryAfterSeconds: 30 } : { isQueued: false, serviceAvailable: true })
    },
  })
  const began = clock
  const res = await fetch(API_CHAT, streamed())
  expect(res.status).toBe(200)
  expect(res.headers.get("Content-Type")).toBe("text/event-stream")
  open()
  const { lines } = await read(res)
  expect(lines[0].line).toBe(": Qoder queued the request for dfmodel (this plan's queue: p3, 3 ahead); try again in 30s")
  expect(lines[0].at).toBe(began)
  // waited 20 minutes, a comment each beat of it: the timer says one each
  // time it fires, at the beat, which the test's clock keeps
  const comments = lines.filter((l) => l.line.startsWith(":"))
  const data = lines.filter((l) => l.line.startsWith("data:"))
  expect(pauses.reduce((a, b) => a + b, 0)).toBe(20 * 60_000)
  expect(timers.map((t) => t.ms)).toEqual([QUEUE.beat])
  expect(QUEUE.beat).toBeLessThanOrEqual(10_000)
  expect(comments.length).toBe(1 + (20 * 60_000) / QUEUE.beat)
  expect(comments.slice(1).every((l) => l.line === ": queued")).toBe(true)
  // the answer follows, whole, and the beat stops with it
  expect(data.some((l) => l.line.includes('"content":"hello"'))).toBe(true)
  expect(data.at(-1).line).toBe("data: [DONE]")
  expect(timers.every((t) => t.stopped)).toBe(true)
  expect(sent.chats.length).toBe(2)
  expect(sent.chats[1].request_set_id).toBe(sent.chats[0].request_set_id)
})

test("a streamed request still queued after Qoder's hour ends its stream with the queue's refusal, sent once", async () => {
  const { fetch, sent } = await loader({ chats: () => refused(), statuses: () => status(QUEUED) })
  const res = await fetch(API_CHAT, streamed())
  expect(res.status).toBe(200)
  const { lines } = await read(res)
  const data = lines.filter((l) => l.line.startsWith("data:"))
  expect(data.length).toBe(1)
  expect(JSON.parse(data[0].line.slice(5)).error).toEqual({
    message: "Qoder queued the request for dfmodel (this plan's queue: p3, 3 ahead); try again in 30s",
    code: 503,
  })
  expect(pauses.reduce((a, b) => a + b, 0)).toBe(60 * 60_000)
  expect(sent.chats.length).toBe(1)
  expect(timers.every((t) => t.stopped)).toBe(true)
})

test("a held stream's resend refused for another reason ends the stream with that refusal", async () => {
  const { fetch } = await loader({
    chats: (n) => (n === 1 ? refused() : json({ code: "113", message: "credits used up" }, 403)),
    statuses: () => status({ isQueued: false, serviceAvailable: true }),
  })
  const res = await fetch(API_CHAT, streamed())
  expect(res.status).toBe(200)
  const { lines } = await read(res)
  const err = JSON.parse(lines.find((l) => l.line.startsWith("data:")).line.slice(5)).error
  expect(err.code).toBe(429)
})

test("a held stream the client cancels stops the wait: its beat ends, and no status is asked or request sent after", async () => {
  let open
  const gate = new Promise((ok) => (open = ok))
  const { fetch, sent } = await loader({
    chats: () => refused(),
    statuses: async (n) => {
      if (n === 2) await gate
      return status(QUEUED)
    },
  })
  const res = await fetch(API_CHAT, streamed())
  const { reader } = await read(res, (lines) => lines.length >= 1)
  while (sent.statuses.length < 2) await new Promise((ok) => setImmediate(ok))
  expect(sent.statuses[1].signal.aborted).toBe(false)
  await reader.cancel(new DOMException("the client went away", "AbortError"))
  // the wait's signal is the stream's: the ask in flight is called off
  expect(sent.statuses[1].signal.aborted).toBe(true)
  expect(timers.every((t) => t.stopped)).toBe(true)
  open()
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok))
  expect(sent.statuses.length).toBe(2)
  expect(sent.chats.length).toBe(1)
})

test("the same request not streamed still waits 4 minutes at most, then the 503", async () => {
  const { fetch } = await loader({ chats: () => refused(), statuses: () => status(QUEUED) })
  const res = await fetch(API_CHAT, ask())
  expect(res.status).toBe(503)
  expect(pauses.reduce((a, b) => a + b, 0)).toBe(4 * 60_000)
})
