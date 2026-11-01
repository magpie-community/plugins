// A reply that fails before any of its answer fails as magpie's built-in
// Kiro relay failed it (internal/gateway/claude_subscription.go relay): a
// status, not a stream — a 429 when the error reads as a quota or rate limit
// (quotaWords), else a 502 — so magpie's gateway moves on to the next account.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { events, reply } = _internal

// frame is one AWS event-stream message with string headers.
function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}

const stream = (...fs) =>
  new ReadableStream({
    start(c) {
      for (const f of fs) c.enqueue(f)
      c.close()
    },
  })

const exception = (type, message) => frame({ ":message-type": "exception", ":exception-type": type }, { message })
const text = (content) => frame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content })

const ask = (body, streaming) => reply(events(body, "claude-sonnet-4.5", 0), "claude-sonnet-4.5", streaming)

test("a throttling exception before the answer is a 429, streamed or not", async () => {
  for (const s of [true, false]) {
    const res = await ask(stream(exception("ThrottlingException", "Too many requests")), s)
    expect(res.status).toBe(429)
    const b = await res.json()
    expect(b.error.message).toBe("rate limited: Too many requests")
  }
})

test("a quota exception before the answer is a 429", async () => {
  const res = await ask(stream(exception("ServiceQuotaExceededException", "You have reached the limit")), true)
  expect(res.status).toBe(429)
})

test("another exception before the answer is a 502, not a stream", async () => {
  const res = await ask(stream(exception("InternalServerException", "Encountered an unexpected error")), true)
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toBe("InternalServerException: Encountered an unexpected error")
})

// magpie's gateway (tooLong) takes a 400 with these words for a conversation
// past the model's window: another member with room is asked, no account
// rests, and a lone agent is told to compact. As a 502 the Kiro account
// rested, was asked again, and the agent got a vendor error it never
// compacted for (ergou0954_54426 on Discord: "kiro 那边报错说超出上下文").
const saysTooLong = (m) => /^input is too long for the model's context: /.test(m)

test("Kiro's too-long exception in the stream is a 400 that says too long, streamed or not", async () => {
  for (const [kind, msg] of [
    ["ValidationException", "Input is too long."],
    ["ValidationException", "Improperly formed request. (CONTENT_LENGTH_EXCEEDS_THRESHOLD)"],
  ]) {
    for (const s of [true, false]) {
      const res = await ask(stream(exception(kind, msg)), s)
      expect(res.status).toBe(400)
      const b = await res.json()
      expect(b.error.type).toBe("invalid_request_error")
      expect(saysTooLong(b.error.message)).toBe(true)
      expect(b.error.message).toContain(msg)
    }
  }
})

test("a reply Kiro stops for a full window before a word is a 400 that says too long", async () => {
  const full = () => stream(frame({ ":message-type": "event", ":event-type": "metadataEvent" }, { stopReason: "MODEL_CONTEXT_WINDOW_EXCEEDED" }))
  for (const s of [true, false]) {
    const res = await ask(full(), s)
    expect(res.status).toBe(400)
    expect(saysTooLong((await res.json()).error.message)).toBe(true)
  }
})

test("a reply Kiro stops for a full window after some of it says it was cut short", async () => {
  const cut = () =>
    stream(text("Half an ans"), frame({ ":message-type": "event", ":event-type": "metadataEvent" }, { stopReason: "MODEL_CONTEXT_WINDOW_EXCEEDED" }))
  const res = await ask(cut(), false)
  expect(res.status).toBe(200)
  expect((await res.json()).stop_reason).toBe("model_context_window_exceeded")
  const sse = await (await ask(cut(), true)).text()
  expect(sse).toContain('"stop_reason":"model_context_window_exceeded"')
})

test("Kiro's HTTP 400 for a too-long input stays a 400 that says too long", () => {
  const f = failure(400, JSON.stringify({ message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }))
  expect(f.status).toBe(400)
  expect(saysTooLong(f.message)).toBe(true)
})

test("a quota or throttle still isn't taken for too long", async () => {
  expect((await ask(stream(exception("ServiceQuotaExceededException", "You have reached the limit")), true)).status).toBe(429)
  expect((await ask(stream(exception("ThrottlingException", "Too many requests")), true)).status).toBe(429)
})

test("an exception after the answer began ends the stream with an error event", async () => {
  const res = await ask(stream(text("Hello"), exception("ThrottlingException", "slow down")), true)
  expect(res.status).toBe(200)
  const sse = await res.text()
  expect(sse).toContain("Hello")
  expect(sse).toContain("event: error")
})

test("unstreamed, what was said before an exception is the answer", async () => {
  const res = await ask(stream(text("Hello"), exception("InternalServerException", "boom")), false)
  expect(res.status).toBe(200)
  expect((await res.json()).content).toEqual([{ type: "text", text: "Hello" }])
})

// Failing before any of the answer, a request is answered with the built-in's
// status (internal/gateway/kiro.go askKiro), and X-Magpie-Sign-In: kept,
// as the built-in marked no Kiro account lapsed, even one Kiro refused.
const { generate, refresh, failure } = _internal
const msgReq = { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }
const gone = (msg) => Object.assign(new Error(msg), { gone: true })

test("credentials that can't be had are a 401, the account kept even when the sign-in is gone", async () => {
  let res = await generate(async () => { throw new Error("refreshing Kiro's sign-in: fetch failed") }, {}, msgReq)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("refreshing Kiro's sign-in: fetch failed")
  res = await generate(async () => { throw gone("Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE") }, {}, msgReq)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

const withFetch = async (answer, fn) => {
  const was = globalThis.fetch
  globalThis.fetch = async (...a) => answer(...a)
  try {
    return await fn()
  } finally {
    globalThis.fetch = was
  }
}
const creds = (fail) => {
  let n = 0
  return async () => {
    if (n++ && fail) throw fail
    return { token: "t", tokenType: "", profile: "arn:aws:codewhisperer:us-east-1:1:profile/x", region: "us-east-1" }
  }
}

test("a refresh failing after Kiro's 403 is a 502, the account kept even when Kiro refused it", async () => {
  await withFetch(() => new Response("{}", { status: 403 }), async () => {
    let res = await generate(creds(new Error("refreshing Kiro's sign-in: 503 Service Unavailable")), {}, msgReq)
    expect(res.status).toBe(502)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    res = await generate(creds(gone("Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE")), {}, msgReq)
    expect(res.status).toBe(502)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })
})

test("Kiro's own 401 is passed on without marking the account", async () => {
  await withFetch(() => new Response(JSON.stringify({ message: "bad token" }), { status: 401 }), async () => {
    const res = await generate(creds(), {}, msgReq)
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await res.json()).error.message).toBe("bad token")
  })
})

test("an error Kiro gives no words for is Go's status text", () => {
  expect(failure(500, "")).toEqual({ status: 500, message: "Internal Server Error" })
})

test("a refresh is worded as the built-in's", async () => {
  const c = { method: "social", refresh: "r", region: "us-east-1", access: "a" }
  await withFetch(() => new Response("", { status: 500 }), async () => {
    await expect(refresh(c)).rejects.toThrow(/^refreshing Kiro's sign-in: 500 Internal Server Error$/)
  })
  await withFetch(() => new Response("", { status: 400 }), async () => {
    await expect(refresh(c)).rejects.toMatchObject({ gone: true, message: "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE" })
  })
  await expect(refresh({ ...c, refresh: "" })).rejects.toMatchObject({ message: "Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE" })
  await expect(refresh({ ...c, method: "odd" })).rejects.toMatchObject({ message: "Kiro's sign-in has expired" })
})

// a success, even after a renewal, never cleared the built-in's account
test("an answer says the account is kept, streamed or not, renewed or not", async () => {
  const ok = () => new Response(stream(text("Hello")), { status: 200 })
  for (const s of [true, false]) {
    await withFetch(ok, async () => {
      const res = await generate(creds(), {}, { ...msgReq, stream: s })
      expect(res.status).toBe(200)
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    })
    let n = 0
    await withFetch(() => (n++ ? ok() : new Response("{}", { status: 403 })), async () => {
      const res = await generate(creds(), {}, { ...msgReq, stream: s })
      expect(res.status).toBe(200)
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    })
  }
})
