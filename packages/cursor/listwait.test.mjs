// A chat request picks its variant from the account's model list, asked
// before its Run. A list Cursor couldn't give was asked again by every
// request, each waiting up to AvailableModels' 30 s before its Run, and a
// list past its keep was waited for again (ysm119 on Discord: 33–36 s to
// the first token on every Opus request). Against a fake Cursor: its API
// by a stand-in fetch, its agent API by an HTTP/2 server here.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "./index.mjs"
import { NATIVE_LIMITS, nativeSessions } from "./native-session.mjs"

const { pb, frame, lists } = _internal
const real = globalThis.fetch
const retained = NATIVE_LIMITS.perProcess
let server, base
const events = [] // what happened, in order
beforeAll(async () => {
  server = http2.createServer()
  server.on("stream", (stream) => {
    events.push("run")
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buf = Buffer.alloc(0)
    let started = false
    stream.on("data", (c) => {
      buf = Buffer.concat([buf, c])
      if (started || buf.length < 5 || buf.length < 5 + buf.readUInt32BE(1)) return
      started = true
      const update = (num, body) => frame(pb().bytes(1, pb().bytes(num, body)).done())
      stream.write(update(1, pb().str(1, "hi").done()))
      stream.write(update(14, pb().varint(1, 100).varint(2, 1).done()))
      const end = Buffer.from("{}")
      const head = Buffer.alloc(5)
      head[0] = 2
      head.writeUInt32BE(end.length, 1)
      stream.end(Buffer.concat([head, end]))
    })
    stream.on("error", () => {})
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server.close())
beforeEach(async () => {
  await nativeSessions.clear()
  NATIVE_LIMITS.perProcess = 0
  events.length = 0
})
afterEach(() => {
  NATIVE_LIMITS.perProcess = retained
  globalThis.fetch = real
})

// Cursor's API; the picker answers (ok) or fails, after ms
const PICKER = [{ name: "claude-opus-5-5", clientDisplayName: "Claude Opus 5.5", supportsNonMaxMode: true, contextTokenLimit: 300000 }]
function fakeAPI(picker) {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith("/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u.endsWith("/GetUsableModels")) return Response.json({ models: [] })
    // the full catalog (scope 3) is asked alongside, and fails here: it is
    // not the list this file times
    if (u.endsWith("/AvailableModels") && JSON.parse(init?.body || "{}").scope) return new Response("down", { status: 503 })
    if (u.endsWith("/AvailableModels")) {
      events.push("list asked")
      await new Promise((r) => setTimeout(r, picker.ms))
      events.push("list answered")
      return picker.ok ? Response.json({ models: PICKER }) : new Response("down", { status: 503 })
    }
    if (u.endsWith("/GetFilteredUsageEvents")) return Response.json({ usageEventsDisplay: [] })
    throw new Error("the test asked " + u)
  }
}

// a token of its own: another file's {exp} alone can be the same token,
// and would find this file's endpoint and list kept for it
let n = 0
const signIn = () => {
  const jwt = ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 + ++n, sub: "listwait-" + randomUUID() })).toString("base64url"), "sig"].join(".")
  return { type: "oauth", access: jwt, refresh: "", expires: 0, accountId: "a@b.c" }
}

async function ask(auth) {
  const hooks = await CursorAuthPlugin()
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(200)
  return res.json()
}

test("a list Cursor couldn't give is not waited for again by every request", async () => {
  fakeAPI({ ok: false, ms: 50 })
  const auth = signIn()
  for (let i = 0; i < 3; i++) await ask(auth)
  // the first request waited for the failed ask; the ones after it went
  // straight to their Runs
  expect(events).toEqual(["list asked", "list answered", "run", "run", "run"])
})

test("a list past its keep is used while a new one is asked for", async () => {
  fakeAPI({ ok: true, ms: 50 })
  const auth = signIn()
  await ask(auth)
  expect(events).toEqual(["list asked", "list answered", "run"])
  // ten minutes on
  const h = createHash("sha256").update(auth.access).digest("hex")
  lists.get(h).at -= 11 * 60_000
  events.length = 0
  fakeAPI({ ok: true, ms: 300 })
  await ask(auth)
  // the Run went with the list it had, before the new one came
  expect(events.indexOf("run")).toBeLessThan(events.indexOf("list answered") === -1 ? Infinity : events.indexOf("list answered"))
  for (let i = 0; i < 100 && !events.includes("list answered"); i++) await new Promise((r) => setTimeout(r, 10))
  expect(events).toEqual(["list asked", "run", "list answered"])
  // and the new list is kept
  expect(Date.now() - lists.get(h).at).toBeLessThan(60_000)
})

test("requests at once with no list share one ask", async () => {
  fakeAPI({ ok: true, ms: 100 })
  const auth = signIn()
  await Promise.all([ask(auth), ask(auth), ask(auth)])
  expect(events.filter((e) => e === "list asked")).toHaveLength(1)
})
