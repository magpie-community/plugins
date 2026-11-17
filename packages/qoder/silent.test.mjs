// Qoder CN once held a call 15 minutes with nothing sent: no reply
// headers, nothing logged, and the client gave up first (xiaotao6869,
// #1204). A call that hears nothing for QUEUE.silent is dropped, and its
// 504 says so, so magpie can fail over and the log shows where it waited.
// The upstream here never answers until its signal is aborted; the reply
// that sends headers and then nothing is the same wait, one step later.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const { QUEUE } = _internal
const real = globalThis.fetch
const saved = { ...QUEUE }
afterEach(() => {
  globalThis.fetch = real
  Object.assign(QUEUE, saved)
})

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "dfmodel", display_name: "DeepSeek Flash", enable: true }] }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const hang = (signal) =>
  new Promise((_, no) => signal?.addEventListener("abort", () => no(signal.reason ?? new Error("aborted")), { once: true }))

async function loader(chat) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  let calls = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/model/list")) return json(LISTING)
    calls++
    return chat(init.signal)
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, calls: () => calls }
}

for (const stream of [false, true]) {
  test(`a call Qoder sends no reply headers to is dropped after QUEUE.silent with a 504 that says so (stream ${stream})`, async () => {
    QUEUE.silent = 50
    const { fetch, calls } = await loader((signal) => hang(signal))
    const began = Date.now()
    const res = await fetch(API_CHAT, { method: "POST", body: JSON.stringify({ model: "dfmodel", stream, messages: [{ role: "user", content: "hi" }] }) })
    expect(res.status).toBe(504)
    expect((await res.json()).error.message).toMatch(/sent nothing for 0s after the request \(no reply headers\)/)
    expect(res.headers.get("X-Magpie-Sign-In")).toBeNull()
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(calls()).toBe(1)
  })
}

test("a reply whose headers came and whose first event never does is dropped the same way", async () => {
  QUEUE.silent = 50
  const { fetch } = await loader(
    (signal) =>
      new Response(
        new ReadableStream({
          start(ctl) {
            signal?.addEventListener("abort", () => ctl.error(signal.reason ?? new Error("aborted")), { once: true })
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  )
  const res = await fetch(API_CHAT, { method: "POST", body: JSON.stringify({ model: "dfmodel", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(504)
  expect((await res.json()).error.message).toMatch(/no first event/)
})

test("a reply that answers within QUEUE.silent is not cut, and the timer is gone after it", async () => {
  QUEUE.silent = 200
  const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200 })}\n\n`
  const { fetch } = await loader(async () => {
    await new Promise((r) => setTimeout(r, 20))
    return new Response(line({ choices: [{ delta: { content: "hello" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + line("[DONE]"), {
      headers: { "Content-Type": "text/event-stream" },
    })
  })
  const res = await fetch(API_CHAT, { method: "POST", body: JSON.stringify({ model: "dfmodel", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hello")
  await new Promise((r) => setTimeout(r, 300))
})
