// A request Devin fails is answered with the status and words magpie's
// built-in Devin (internal/gateway/devin.go, devinFailure) gave it, so the
// gateway moves on to the next account or member as it did. magpie puts
// "Devin: " before the message itself.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const enc = new TextEncoder()
const end = (obj) => {
  const b = enc.encode(JSON.stringify(obj))
  const out = new Uint8Array(5 + b.length)
  out[0] = 2
  new DataView(out.buffer).setUint32(1, b.length)
  out.set(b, 5)
  return out
}
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) out.set(p, (i += p.length) - p.length)
  return out
}

const ask = async (reply, stream = false) => {
  globalThis.fetch = async () => reply()
  const res = await _internal.complete(
    { key: "k", server: "https://devin.test", families: _internal.familiesOf(_internal.SNAPSHOT) },
    { model: "swe-2", stream, messages: [{ role: "user", content: "hi" }] },
  )
  return { status: res.status, body: await res.text(), signIn: res.headers.get("X-Magpie-Sign-In") }
}
const errOf = (r) => JSON.parse(r.body).error.message

test("an HTTP error that says nothing is worded as Go's status text", async () => {
  const r = await ask(() => new Response("", { status: 402 }))
  expect(r.status).toBe(402)
  expect(errOf(r)).toBe("Payment Required")
})

test("a stream that ends on resource_exhausted before anything is a 429 without a second Devin:", async () => {
  const r = await ask(() => new Response(end({ error: { code: "resource_exhausted", message: "daily quota used up" } })), true)
  expect(r.status).toBe(429)
  expect(errOf(r)).toBe("usage limit reached: daily quota used up")
})

test("a too-long conversation is the built-in's 400", async () => {
  const r = await ask(() => new Response(end({ error: { code: "invalid_argument", message: "prompt is too long" } })))
  expect(r.status).toBe(400)
  expect(errOf(r)).toBe("input is too long for the model's context: prompt is too long")
})

// the built-in answered it 401 and left the account as it was
test("a refused key is the built-in's 401, the account kept", async () => {
  const r = await ask(() => new Response(JSON.stringify({ code: "unauthenticated", message: "bad key" }), { status: 401 }))
  expect(r.status).toBe(401)
  expect(errOf(r)).toBe("bad key — sign in to Devin again")
  expect(r.signIn).toBe("kept")
})

test("unauthenticated at the stream's end is a 401 that keeps the account too", async () => {
  const r = await ask(() => new Response(end({ error: { code: "unauthenticated", message: "key revoked" } })))
  expect(r.status).toBe(401)
  expect(errOf(r)).toBe("key revoked — sign in to Devin again")
  expect(r.signIn).toBe("kept")
})

test("no key to send is a 401 that keeps the account", async () => {
  const { DevinAuthPlugin } = await import("./index.mjs")
  const hooks = await DevinAuthPlugin()
  let auth = { type: "api", key: "k", metadata: {} }
  const opts = await hooks.auth.loader(async () => auth)
  auth = null
  const res = await opts.fetch("https://devin.test/v1/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

test("an empty reply is the built-in's 502 of a broken-off one", async () => {
  const r = await ask(() => new Response(""))
  expect(r.status).toBe(502)
  expect(errOf(r)).toBe("the reply broke off: EOF")
})

test("an error after metadata fails before the stream opens", async () => {
  const empty = new Uint8Array(5) // a message frame with no fields
  const r = await ask(() => new Response(join(empty, end({ error: { code: "resource_exhausted", message: "rate limit" } }))), true)
  expect(r.status).toBe(429)
  expect(errOf(r)).toBe("usage limit reached: rate limit")
})

// a success cleared no mark the built-in's account could have had
test("a metadata-only answer fails and keeps the account signed in", async () => {
  for (const stream of [false, true]) {
    const r = await ask(() => new Response(join(new Uint8Array(5), end({}))), stream)
    expect(r.status).toBe(502)
    expect(errOf(r)).toContain("empty reply")
    expect(r.signIn).toBe("kept")
  }
})
