// streamGenerateContent must not sit on Bun's ~300s socket timer. The
// deadlines are injected short here so a stall fails in milliseconds.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { AntigravityAuthPlugin, _internal } from "./index.mjs"
import { auth, fake, real, reset } from "./fake.mjs"

const URL_ = (m, method = "streamGenerateContent") => `https://daily-cloudcode-pa.googleapis.com/v1beta/models/${m}:${method}?alt=sse`
const ask = (text = "hi") => JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }] })
const enc = new TextEncoder()
const sseEvent = (text) => "data: " + JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text }] } }] }, traceId: "t" }) + "\r\n\r\n"
const models = { models: { "gemini-3-flash": { displayName: "Gemini 3 Flash" } } }

beforeEach(() => {
  reset()
  const d = _internal.streamDeadlines
  if (d) {
    d.firstChunkMs = 210_000
    d.idleMs = 180_000
  }
})
afterEach(() => (globalThis.fetch = real))

function useDeadlines(firstChunkMs, idleMs) {
  const d = _internal.streamDeadlines
  if (!d) throw new Error("streamDeadlines is not configurable")
  d.firstChunkMs = firstChunkMs
  d.idleMs = idleMs
}

function spy(signal) {
  let n = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (type, fn, opts) => {
    if (type === "abort") n++
    return add(type, fn, opts)
  }
  signal.removeEventListener = (type, fn, opts) => {
    if (type === "abort") n--
    return remove(type, fn, opts)
  }
  return () => n
}

function hang(signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
  })
}

function sseResponse(chunks, signal) {
  let i = 0
  return new Response(
    new ReadableStream({
      pull(ctl) {
        if (i >= chunks.length) return ctl.close()
        const next = chunks[i++]
        if (next === "") return ctl.enqueue(new Uint8Array(0))
        if (next && typeof next === "object" && next.hang) return hang(signal)
        ctl.enqueue(typeof next === "string" ? enc.encode(next) : next)
      },
      cancel() {},
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

// install routes Code Assist's other methods through fake() and lets the
// test answer streamGenerateContent, recording the fetch init.
function install(onStream) {
  const calls = []
  fake({ fetchAvailableModels: models })
  const base = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const call = { url, timeout: init.timeout, signal: init.signal }
    calls.push(call)
    if (url.includes("streamGenerateContent")) return onStream(call)
    return base(input, init)
  }
  return calls
}

async function loaderFetch(a = auth()) {
  const p = await AntigravityAuthPlugin({})
  const l = await p.auth.loader(async () => a)
  return l.fetch
}

async function search(args, ctx) {
  const p = await AntigravityAuthPlugin({})
  return p.search.antigravity.execute(args, { getAuth: async () => auth(), ...ctx })
}

const streamCalls = (calls) => calls.filter((c) => c.url.includes("streamGenerateContent"))

async function caught(p) {
  try {
    return { value: await p }
  } catch (error) {
    return { error }
  }
}

test("streamGenerateContent fetch disables Bun's socket timeout", async () => {
  const calls = install(() => sseResponse([sseEvent("Hi")]))
  const f = await loaderFetch()
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(res.status).toBe(200)
  expect(await res.text()).toContain("Hi")
  const sent = streamCalls(calls)
  expect(sent.length).toBeGreaterThan(0)
  for (const c of sent) expect(c.timeout).toBe(false)
  // model and token reads keep their own short timeouts
  const other = calls.filter((c) => !c.url.includes("streamGenerateContent") && c.url.includes("v1internal:"))
  expect(other.length).toBeGreaterThan(0)
  for (const c of other) expect(c.timeout).toBeUndefined()

  const again = install(() => sseResponse([sseEvent("Hi")]))
  const g = await loaderFetch()
  const whole = await g(URL_("gemini-3-flash", "generateContent"), { method: "POST", body: ask() })
  expect(whole.status).toBe(200)
  expect(streamCalls(again).every((c) => c.timeout === false)).toBe(true)
})

test("a header stall aborts at the first-chunk deadline", async () => {
  useDeadlines(50, 5_000)
  const calls = install((c) => hang(c.signal))
  const f = await loaderFetch()
  const t0 = Date.now()
  const { error } = await caught(f(URL_("gemini-3-flash"), { method: "POST", body: ask() }))
  const elapsed = Date.now() - t0
  expect(error?.name).toBe("TimeoutError")
  expect(error?.message ?? "").toMatch(/first chunk/i)
  expect(error?.name).not.toBe("AbortError")
  expect(elapsed).toBeGreaterThanOrEqual(40)
  expect(elapsed).toBeLessThan(800)
  expect(streamCalls(calls).length).toBe(1)
})

test("headers with no non-empty chunk abort at the first-chunk deadline", async () => {
  useDeadlines(50, 5_000)
  for (const chunks of [[], [""]]) {
    install((c) => sseResponse([...chunks, { hang: true }], c.signal))
    const f = await loaderFetch()
    const t0 = Date.now()
    const { error } = await caught(f(URL_("gemini-3-flash"), { method: "POST", body: ask() }))
    expect(error?.name).toBe("TimeoutError")
    expect(error?.message ?? "").toMatch(/first chunk/i)
    expect(Date.now() - t0).toBeLessThan(800)
  }
})

test("a live stream outlasts both deadlines while chunks keep arriving", async () => {
  useDeadlines(60, 80)
  const parts = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
  install(async () => {
    let i = 0
    return new Response(
      new ReadableStream({
        async pull(ctl) {
          if (i >= parts.length) return ctl.close()
          if (i > 0) await Bun.sleep(20)
          ctl.enqueue(enc.encode(sseEvent(parts[i++])))
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  })
  const f = await loaderFetch()
  const ac = new AbortController()
  const left = spy(ac.signal)
  const t0 = Date.now()
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: ac.signal })
  const text = await res.text()
  expect(Date.now() - t0).toBeGreaterThan(60 + 80)
  const texts = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
  expect(texts.map((c) => c.candidates[0].content.parts[0].text).join("")).toBe(parts.join(""))
  expect(left()).toBe(0)
})

test("a stall after the first chunk aborts at the stream-idle deadline", async () => {
  useDeadlines(3_000, 50)
  install((c) => sseResponse([sseEvent("Hel"), { hang: true }], c.signal))
  const f = await loaderFetch()
  const t0 = Date.now()
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(res.status).toBe(200)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let saw = ""
  let error
  for (;;) {
    try {
      const n = await reader.read()
      if (n.done) break
      saw += dec.decode(n.value)
    } catch (e) {
      error = e
      break
    }
  }
  const elapsed = Date.now() - t0
  expect(saw).toContain("Hel")
  expect(error?.name).toBe("TimeoutError")
  expect(error?.message ?? "").toMatch(/stall/i)
  expect(error?.message ?? "").not.toMatch(/first chunk/i)
  expect(elapsed).toBeGreaterThan(30)
  expect(elapsed).toBeLessThan(800)
})

test("a caller abort wins over either deadline and is not a timeout", async () => {
  useDeadlines(5_000, 5_000)
  const pre = new AbortController()
  const reason = new DOMException("user cancelled", "AbortError")
  pre.abort(reason)
  const left = spy(pre.signal)
  const calls = install((c) => hang(c.signal))
  const f = await loaderFetch()
  const t0 = Date.now()
  const { error } = await caught(f(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: pre.signal }))
  expect(error).toBe(reason)
  expect(error?.name).toBe("AbortError")
  expect(Date.now() - t0).toBeLessThan(400)
  expect(streamCalls(calls).length).toBe(0)
  expect(left()).toBe(0)

  const mid = new AbortController()
  const midLeft = spy(mid.signal)
  const midReason = new DOMException("stopped", "AbortError")
  install((c) => hang(c.signal))
  const g = await loaderFetch()
  const pending = g(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: mid.signal })
  setTimeout(() => mid.abort(midReason), 20)
  const started = Date.now()
  const got = await caught(pending)
  expect(got.error).toBe(midReason)
  expect(got.error?.name).toBe("AbortError")
  expect(Date.now() - started).toBeLessThan(800)
  expect(midLeft()).toBe(0)
})

test("a non-2xx response and a consumer cancel drop the deadlines", async () => {
  useDeadlines(40, 40)
  const ac = new AbortController()
  const left = spy(ac.signal)
  let aborted = false
  install((c) => {
    c.signal.addEventListener("abort", () => (aborted = true))
    return new Response(JSON.stringify({ error: { code: 500, message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } })
  })
  const f = await loaderFetch()
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: ac.signal })
  expect(res.status).toBe(500)
  expect(await res.text()).toContain("boom")
  expect(left()).toBe(0)
  await Bun.sleep(100)
  expect(aborted).toBe(false)

  let cancelled = false
  let timedOut = false
  const parent = new AbortController()
  const parentLeft = spy(parent.signal)
  install((c) => {
    c.signal.addEventListener("abort", () => {
      if (c.signal.reason?.name === "TimeoutError") timedOut = true
    })
    let sent = false
    return new Response(
      new ReadableStream({
        pull(ctl) {
          if (!sent) {
            sent = true
            ctl.enqueue(enc.encode(sseEvent("Hel")))
            return
          }
          return hang(c.signal)
        },
        cancel() {
          cancelled = true
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  })
  const g = await loaderFetch()
  const ok = await g(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: parent.signal })
  await ok.body.cancel()
  await Bun.sleep(0)
  expect(cancelled).toBe(true)
  expect(parentLeft()).toBe(0)
  await Bun.sleep(100)
  expect(timedOut).toBe(false)
})

test("web search uses the same fetch deadline", async () => {
  useDeadlines(50, 5_000)
  const calls = install((c) => hang(c.signal))
  const t0 = Date.now()
  const { error } = await caught(search({ query: "bun release" }))
  expect(streamCalls(calls).every((c) => c.timeout === false)).toBe(true)
  expect(error?.name).toBe("TimeoutError")
  expect(error?.message ?? "").toMatch(/first chunk/i)
  expect(Date.now() - t0).toBeLessThan(800)

  const ac = new AbortController()
  ac.abort(new DOMException("search cancelled", "AbortError"))
  const stopped = install((c) => hang(c.signal))
  const { error: cancelled } = await caught(search({ query: "bun release" }, { abort: ac.signal }))
  expect(cancelled?.name).toBe("AbortError")
  expect(cancelled?.message).toBe("search cancelled")
  expect(streamCalls(stopped).length).toBe(0)
})

test("non-2xx response bodies respect deadlines and caller abort in complete() and webSearch()", async () => {
  useDeadlines(50, 50)
  const partial500 = (signal) =>
    new Response(
      new ReadableStream({
        pull(ctl) {
          if (!this.sent) {
            this.sent = true
            ctl.enqueue(enc.encode('{"error":{"message":"half'))
            return
          }
          return hang(signal)
        },
        cancel() {},
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    )

  // complete() stalls on partial 500 body -> TimeoutError
  install((c) => partial500(c.signal))
  const f = await loaderFetch()
  const t0 = Date.now()
  const { error: err500 } = await caught(f(URL_("gemini-3-flash"), { method: "POST", body: ask() }))
  expect(err500?.name).toBe("TimeoutError")
  expect(Date.now() - t0).toBeLessThan(800)

  // webSearch() stalls on partial 500 body -> TimeoutError
  install((c) => partial500(c.signal))
  const t1 = Date.now()
  const { error: searchErr } = await caught(search({ query: "stalled 500" }))
  expect(searchErr?.name).toBe("TimeoutError")
  expect(Date.now() - t1).toBeLessThan(800)

  // Caller abort with custom non-Error reason cancels stalled 500 body and preserves reason
  useDeadlines(5_000, 5_000)
  const ac = new AbortController()
  const left = spy(ac.signal)
  install((c) => partial500(c.signal))
  const g = await loaderFetch()
  const pending = g(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: ac.signal })
  setTimeout(() => ac.abort("caller reason"), 20)
  const { error: abortedErr } = await caught(pending)
  expect(abortedErr).toBe("caller reason")
  expect(left()).toBe(0)
})

test("idle deadline and caller abort clean up immediately when consumer stops pulling", async () => {
  // Path 1: idle timeout fires while consumer is not reading
  useDeadlines(3_000, 50)
  let cancelled1 = false
  const ac1 = new AbortController()
  const left1 = spy(ac1.signal)
  install((c) =>
    new Response(
      new ReadableStream({
        pull(ctl) {
          if (!this.sent) {
            this.sent = true
            ctl.enqueue(enc.encode(sseEvent("Hi")))
            return
          }
          return hang(c.signal)
        },
        cancel() { cancelled1 = true },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  )
  const f = await loaderFetch()
  const res1 = await f(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: ac1.signal })
  // Do NOT pull res1.body; wait for idle deadline to fire
  await Bun.sleep(100)
  expect(cancelled1).toBe(true)
  expect(left1()).toBe(0)
  const { error: readErr1 } = await caught(res1.text())
  expect(readErr1?.name).toBe("TimeoutError")

  // Path 2: caller aborts while consumer is not reading
  useDeadlines(5_000, 5_000)
  let cancelled2 = false
  const ac2 = new AbortController()
  const left2 = spy(ac2.signal)
  install((c) =>
    new Response(
      new ReadableStream({
        pull(ctl) {
          if (!this.sent) {
            this.sent = true
            ctl.enqueue(enc.encode(sseEvent("Hi")))
            return
          }
          return hang(c.signal)
        },
        cancel() { cancelled2 = true },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  )
  const g = await loaderFetch()
  const res2 = await g(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: ac2.signal })
  ac2.abort("stop now")
  await Bun.sleep(20)
  expect(cancelled2).toBe(true)
  expect(left2()).toBe(0)
  const { error: readErr2 } = await caught(res2.text())
  expect(readErr2).toBe("stop now")
})

test("aborting a failing upstream stream produces no unhandledRejection and preserves non-Error reason", async () => {
  useDeadlines(5_000, 5_000)
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const ac = new AbortController()
    install(() => {
      let sent = false
      return new Response(
        new ReadableStream({
          pull(ctl) {
            if (!sent) {
              sent = true
              ctl.enqueue(enc.encode(sseEvent("First")))
              return
            }
            return Promise.reject(new Error("upstream boom"))
          },
          cancel() {},
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    })
    const f = await loaderFetch()
    const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask(), signal: ac.signal })
    ac.abort("custom abort reason")
    const { error } = await caught(res.text())
    expect(error).toBe("custom abort reason")
    await Bun.sleep(30)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})
