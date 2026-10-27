// Qoder's queue (code 10605) is waited out as Qoder's own client waits it
// (qoder-agent-sdk's worker in Qoder.app 0.4.3, "[ModelQueue]"): it asks
// /api/v2/service/ask/queue/status with the request's requestSetId, the
// model and the queueType until isQueued is false, waits that state's
// retryAfterSeconds and sends the same request again. wallance on Discord:
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
let clock, pauses
beforeEach(() => {
  clock = 1_000_000
  pauses = []
  QUEUE.now = () => clock
  QUEUE.pause = async (ms, signal) => {
    if (signal?.aborted) throw signal.reason
    pauses.push(ms)
    clock += ms
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
      sent.statuses.push({ url: u, headers: init.headers })
      return statuses(sent.statuses.length)
    }
    sent.chats.push(JSON.parse(_internal.decodeBody(init.body)))
    return chats(sent.chats.length)
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, sent }
}

test("a queued request waits its turn in Qoder's queue and is sent again, the same request, once the queue lets it through", async () => {
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
  // the same request: the queue knows it by its request_set_id
  expect(sent.chats[1].request_set_id).toBe(sent.chats[0].request_set_id)
  expect(sent.chats[1].request_id).toBe(sent.chats[0].request_id)
  expect(sent.chats[1].messages).toEqual(sent.chats[0].messages)
  const first = sent.statuses[0]
  expect(first.url.origin + first.url.pathname).toBe("https://api3.qoder.sh/algo/api/v2/service/ask/queue/status")
  expect(Object.fromEntries(first.url.searchParams)).toEqual({ requestSetId: sent.chats[0].request_set_id, modelKey: "dfmodel", queueType: "p3" })
  expect(first.headers["X-Request-ID"]).toBe(sent.chats[0].request_id)
  expect(first.headers["X-Session-ID"]).toBe(sent.chats[0].session_id)
  expect(first.headers.Authorization).toStartWith("Bearer COSY.")
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
  expect((await res.json()).error.message).toBe("Qoder queued the request for dfmodel (this plan's queue: p3); try again in 30s")
  expect(sent.chats.length).toBe(1)
  // 30s pauses, the last cut to what was left of the budget
  expect(pauses.reduce((a, b) => a + b, 0)).toBe(QUEUE.budget)
  expect(Math.max(...pauses)).toBe(30_000)
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
