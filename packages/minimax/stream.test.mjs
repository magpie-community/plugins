// A chat asks for its answer uncompressed. MiniMax answers a chat it is
// asked to compress as one gzip member, flushed when the answer is done:
// the events of a streamed answer all arrive at once, and the first token
// waits for the last. Asked uncompressed, it sends the events as they come.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeGlobalAuthPlugin } from "./index.mjs"
import { fakeMiniMax } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 }
const body = '{"model":"MiniMax-M3.1-Flash","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}'

// the fake of MiniMax's chat endpoint: asked to compress, it answers as one
// gzip member, flushed when the answer is done; asked not to, it sends the
// events as they come
const events = ["message_start", "content_block_delta", "content_block_stop"]
const sse = (r) => {
  const enc = new TextEncoder()
  if ((r.headers.get("accept-encoding") ?? "").includes("gzip")) {
    const text = events.map((e) => "event: " + e + "\n\n").join("")
    return new Response(Bun.gzipSync(Buffer.from(text)), { headers: { "content-encoding": "gzip", "content-type": "text/event-stream" } })
  }
  let i = 0
  return new Response(
    new ReadableStream({
      async pull(c) {
        if (i >= events.length) return c.close()
        c.enqueue(enc.encode("event: " + events[i++] + "\n\n"))
        await Bun.sleep(200)
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const loader = async () => (await MiniMaxCodeGlobalAuthPlugin({ client: {} })).auth.loader(async () => auth)

test("a chat asks for no compression", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", sse)
  const opts = await loader()
  await opts.fetch(opts.baseURL + "/messages", { method: "POST", body })
  expect(f.seen.at(-1).headers.get("accept-encoding")).toBe("identity")
})

test("a caller asking for the compression itself doesn't get it", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", sse)
  const opts = await loader()
  await opts.fetch(opts.baseURL + "/messages", { method: "POST", headers: { "accept-encoding": "gzip, deflate, br, zstd" }, body })
  expect(f.seen.at(-1).headers.get("accept-encoding")).toBe("identity")
})

test("the answer comes uncompressed, as the events come", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", sse)
  const opts = await loader()
  const res = await opts.fetch(opts.baseURL + "/messages", { method: "POST", body })
  expect(res.headers.get("content-encoding")).toBe(null)
  const reader = res.body.getReader()
  const at = []
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    at.push(Date.now())
  }
  // the events arrive while the answer is still being made, not at its end
  expect(at.length).toBe(events.length)
  expect(at[at.length - 1] - at[0]).toBeGreaterThan(150)
})
