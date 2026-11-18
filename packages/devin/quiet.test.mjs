import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

// A request Devin took and then answered nothing to held the agent for 10
// to 20 minutes with keepalives and no error (wu_chong4136 on X). Each case
// waits on the plugin's answer, not on a duration: before the quiet wait
// these held for ever and the test's own timeout failed them.

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.quietFor()
})

const ask = (stream) =>
  _internal.complete(
    { key: "test", server: "https://devin.test", families: _internal.familiesOf(_internal.SNAPSHOT) },
    { model: "gemini-4-argon", stream, messages: [{ role: "user", content: "?" }] },
  )

// a fetch that never answers, aborted only by its signal
const silentHead = (_url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))

// a frame Devin sends while it thinks, with nothing an agent sees
const thinkingFrame = () => _internal.frame(new Uint8Array([0x0a, 0x01, 0x61]))

test("a request Devin never answers gives up with a 504", async () => {
  _internal.quietFor(100)
  globalThis.fetch = silentHead
  for (const stream of [true, false]) {
    const res = await ask(stream)
    expect(res.status).toBe(504)
    expect((await res.json()).error.message).toContain("Devin sent nothing")
  }
})

test("a reply whose body never starts gives up with a 504, and is cancelled", async () => {
  _internal.quietFor(100)
  let cancelled = 0
  globalThis.fetch = async () =>
    new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => void cancelled++ }))
  const res = await ask(true)
  expect(res.status).toBe(504)
  expect((await res.json()).error.message).toContain("Devin sent nothing")
  expect(cancelled).toBe(1)
})

test("a reply that goes quiet after frames that say nothing gives up with a 504", async () => {
  _internal.quietFor(100)
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(thinkingFrame())
        },
        pull: () => new Promise(() => {}),
      }),
    )
  const res = await ask(true)
  expect(res.status).toBe(504)
})

test("frames that keep coming inside the wait are never given up", async () => {
  _internal.quietFor(200)
  let n = 0
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 50))
          if (++n < 12) return c.enqueue(thinkingFrame())
          c.enqueue(_internal.frame(new Uint8Array([0x1a, 0x02, 0x68, 0x69]))) // text "hi"
          const end = new TextEncoder().encode("{}")
          const f = new Uint8Array(5 + end.length)
          f[0] = 2
          new DataView(f.buffer).setUint32(1, end.length)
          f.set(end, 5)
          c.enqueue(f)
          c.close()
        },
      }),
    )
  const res = await ask(false)
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hi")
})
