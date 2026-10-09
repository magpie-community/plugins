// Where HTTP/2 can't open a Run (a proxy or network that blocks it), the
// Run goes over HTTP/1.1 as Cursor's clients run it: RunSSE down, a
// BidiAppend for each client message up. Against a fake Cursor: its API,
// RunSSE and BidiAppend included, answered by a stand-in fetch, its agent
// API by a port here nothing listens on. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import http from "node:http"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const { fields, pb, frame } = _internal

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
beforeEach(() => _internal.resetH1())

// how many HTTP/2 sessions the plugin opened
let h2Tries = 0
const connect = http2.connect
http2.connect = (origin, ...rest) => {
  if (!String(origin).startsWith("http://127.0.0.1:")) throw new Error("the test connected to " + origin)
  h2Tries++
  return connect(origin, ...rest)
}
afterAll(() => {
  http2.connect = connect
  _internal.resetH1()
})

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp, sub: "http1-" + Math.random() })).toString("base64url"), "sig"].join(".")
let n = 0
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

// the agent API: a port nothing listens on, so an HTTP/2 session to it fails
let base
beforeAll(async () => {
  const server = http.createServer()
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
  await new Promise((r) => server.close(r))
})

const end = (body) => {
  const f = frame(Buffer.from(body))
  f[0] = 2
  return f
}
const update = (num, body) => frame(pb().bytes(1, pb().bytes(num, body)).done())

// Cursor's API over HTTP/1.1. RunSSE's stream answers once BidiAppend has
// brought the Run's first message: "hi" and the turn's end, or the error
// given. What each call carried is noted.
function fakeAPI({ refuse } = {}) {
  const seen = { sse: [], appends: [] }
  const streams = new Map() // request id → RunSSE's controller
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const h = new Headers(init.headers)
    if (u.endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: [{ modelId: "grok-4.7-fast", displayName: "Grok 4.7 Fast" }] })
    if (u === "https://api2.cursor.sh/agent.v1.AgentService/RunSSE") {
      const id = fields(Buffer.from(init.body).subarray(5))[0].data.toString()
      seen.sse.push({ id, type: h.get("content-type"), auth: h.get("authorization"), encoding: h.get("accept-encoding") })
      if (refuse) return new Response(end(JSON.stringify({ error: refuse })), { headers: { "content-type": "application/connect+proto" } })
      return new Response(new ReadableStream({ start: (c) => streams.set(id, c) }), { headers: { "content-type": "application/connect+proto" } })
    }
    if (u === "https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend") {
      const f = fields(Buffer.from(init.body))
      const id = fields(f.find((x) => x.num === 2).data)[0].data.toString()
      const seqno = f.find((x) => x.num === 3)?.n ?? 0
      const msg = Buffer.from(f.find((x) => x.num === 1).data.toString(), "hex")
      seen.appends.push({ id, seqno, type: h.get("content-type") })
      const c = streams.get(id)
      if (c && seqno === 0 && fields(msg).some((x) => x.num === 1)) {
        c.enqueue(update(1, pb().str(1, "hi").done()))
        c.enqueue(update(14, pb().varint(1, 0).done()))
        c.enqueue(end("{}"))
        c.close()
      }
      return new Response(new Uint8Array(0), { headers: { "content-type": "application/proto" } })
    }
    throw new Error("the test asked " + u)
  }
  return seen
}

async function ask(auth) {
  const hooks = await CursorAuthPlugin()
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch(base + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "grok-4.7-fast", messages: [{ role: "user", content: "hello" }] }),
  })
  return { status: res.status, body: await res.json() }
}

test("a Run HTTP/2 can't open goes as RunSSE + BidiAppend over HTTP/1.1, and the next ones straight there", async () => {
  const seen = fakeAPI()
  const auth = fresh()
  h2Tries = 0
  const a = await ask(auth)
  expect(a.status).toBe(200)
  expect(a.body.choices[0].message.content).toBe("hi")
  expect(h2Tries).toBe(1)
  expect(seen.sse).toHaveLength(1)
  expect(seen.sse[0]).toMatchObject({ type: "application/connect+proto", encoding: "identity" })
  expect(seen.sse[0].auth).toBe(`Bearer ${auth.access}`)
  // the Run's first message, numbered 0, under RunSSE's request id
  expect(seen.appends[0]).toMatchObject({ id: seen.sse[0].id, seqno: 0, type: "application/proto" })
  const b = await ask(auth)
  expect(b.body.choices[0].message.content).toBe("hi")
  expect(h2Tries).toBe(1) // no second try over HTTP/2
  expect(seen.sse).toHaveLength(2)
})

test("an error Cursor ends RunSSE with keeps its status", async () => {
  fakeAPI({
    refuse: { code: "unauthenticated", message: "Error", details: [{ debug: { error: "ERROR_NOT_LOGGED_IN", details: { title: "Authentication error", detail: "If you are logged in, try logging out and back in." } } }] },
  })
  const r = await ask(fresh())
  expect(r.status).toBe(401)
  expect(r.body.error.message).toContain("Authentication error")
})
