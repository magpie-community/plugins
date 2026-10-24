// The HTTP/2 implementation runs against EventEmitters, never a socket.
import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import http2 from "node:http2"
import { _internal } from "./index.mjs"

const connect = http2.connect
afterEach(() => (http2.connect = connect))
const setup = () => {
  const c = new EventEmitter(), req = new EventEmitter()
  let destroyed = 0, connects = 0, paused = false, pauses = 0, resumes = 0
  c.destroy = () => { destroyed++; req.emit("close"); c.emit("close") }
  c.request = () => req
  req.end = () => {}
  req.pause = () => { paused = true; pauses++ }
  req.resume = () => { paused = false; resumes++ }
  http2.connect = () => { connects++; return c }
  return { c, req, destroyed: () => destroyed, connects: () => connects,
    paused: () => paused, pauses: () => pauses, resumes: () => resumes }
}
const post = (...signals) => _internal.h2post("https://offline.invalid/ai", {}, Buffer.alloc(0), ...signals)

test("pre-aborted requests create no connection", async () => {
  const f = setup(), abort = new AbortController()
  abort.abort()
  await expect(post(abort.signal)).rejects.toMatchObject({ status: 499 })
  expect(f.connects()).toBe(0)
})

for (const event of ["end", "close", "aborted", "error"]) {
  test(`${event} before response rejects and destroys the session`, async () => {
    const f = setup(), pending = post()
    f.req.emit(event, new Error("synthetic failure"))
    await expect(pending).rejects.toMatchObject({ status: 502 })
    expect(f.destroyed()).toBe(1)
  })
}

test("synchronous request failures also destroy the session", async () => {
  const f = setup()
  f.req.end = () => { throw new Error("request failed") }
  await expect(post()).rejects.toMatchObject({ status: 502 })
  expect(f.destroyed()).toBe(1)
})

test("normal end drains buffered chunks exactly once and removes abort hooks", async () => {
  const f = setup(), abort = new AbortController(), pending = post(abort.signal)
  f.req.emit("response", { ":status": 200 })
  f.req.emit("data", Buffer.from("a")); f.req.emit("data", Buffer.from("b")); f.req.emit("end")
  const res = await pending, chunks = []
  for await (const d of res.body()) chunks.push(d.toString())
  expect(chunks).toEqual(["a", "b"])
  abort.abort()
  expect(f.destroyed()).toBe(1)
})

test("data wakes a pending reader and early return destroys the connection", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const it = (await pending).body(), next = it.next()
  f.req.emit("data", Buffer.from("first"))
  expect((await next).value.toString()).toBe("first")
  await it.return()
  expect(f.destroyed()).toBe(1)
})

test("caller abort wakes a pending reader with the abort status", async () => {
  const f = setup(), abort = new AbortController(), pending = post(abort.signal)
  f.req.emit("response", { ":status": 200 })
  const it = (await pending).body(), next = it.next()
  abort.abort()
  await expect(next).rejects.toMatchObject({ status: 499 })
  expect(f.destroyed()).toBe(1)
})

test("session error after response wakes the reader and destroys once", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const next = (await pending).body().next()
  f.c.emit("error", new Error("synthetic failure"))
  await expect(next).rejects.toMatchObject({ status: 502 })
  expect(f.destroyed()).toBe(1)
})

test("only one iterator may consume a response", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending, first = res.body(), next = first.next()
  await expect(res.body().next()).rejects.toThrow(/already consumed/)
  res.cancel()
  await expect(next).rejects.toMatchObject({ status: 499 })
})

test("an unread HTTP/2 response is bounded and overflow destroys the session", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending
  f.req.emit("data", Buffer.alloc(_internal.MAX_H2_BUFFER))
  f.req.emit("data", Buffer.from("overflow"))
  await expect(res.body().next()).rejects.toThrow(/buffer exceeded/)
  expect(f.destroyed()).toBe(1)
})

test("the HTTP/2 limit counts queued bytes rather than the whole response", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending, it = res.body()
  const data = Buffer.alloc(_internal.MAX_H2_BUFFER)
  for (let i = 0; i < 2; i++) {
    const next = it.next()
    f.req.emit("data", data)
    expect((await next).value.length).toBe(data.length)
  }
  f.req.emit("end")
  expect((await it.next()).done).toBe(true)
  expect(f.destroyed()).toBe(1)
})

test("a source ignoring pause cannot grow the HTTP/2 queue indefinitely", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending
  for (let i = 0; i < 1025; i++) f.req.emit("data", Buffer.from("x"))
  await expect(res.body().next()).rejects.toThrow(/buffer exceeded/)
  expect(f.destroyed()).toBe(1)
})

test("a slow reader receives a long response losslessly through repeated pause and resume", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending
  let sent = 0
  const total = 2300
  const pump = () => {
    while (!f.paused() && sent < total) {
      const chunk = Buffer.alloc(4096)
      chunk.writeUInt32LE(sent++)
      f.req.emit("data", chunk)
    }
    if (sent === total) f.req.emit("end")
  }
  const resume = f.req.resume
  f.req.resume = () => { resume(); pump() }
  pump()
  expect(f.paused()).toBe(true)
  let received = 0
  for await (const chunk of res.body()) expect(chunk.readUInt32LE()).toBe(received++)
  expect(received).toBe(total)
  expect(f.pauses()).toBeGreaterThan(1)
  expect(f.resumes()).toBeGreaterThan(1)
  expect(f.destroyed()).toBe(1)
})

test("the byte watermark pauses before the safety cap and draining resumes it", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending, it = res.body()
  f.req.emit("data", Buffer.alloc(_internal.MAX_H2_BUFFER / 2))
  expect(f.paused()).toBe(true)
  expect((await it.next()).value.length).toBe(_internal.MAX_H2_BUFFER / 2)
  expect(f.resumes()).toBe(1)
  f.req.emit("end")
  expect((await it.next()).done).toBe(true)
})

for (const action of ["cancel", "error"]) {
  test(`${action} while paused releases the connection without resuming it`, async () => {
    const f = setup(), pending = post()
    f.req.emit("response", { ":status": 200 })
    const res = await pending
    f.req.emit("data", Buffer.alloc(_internal.MAX_H2_BUFFER / 2))
    expect(f.paused()).toBe(true)
    if (action === "cancel") res.cancel()
    else f.req.emit("error", new Error("synthetic failure"))
    await expect(res.body().next()).rejects.toMatchObject({ status: action === "cancel" ? 499 : 502 })
    expect(f.destroyed()).toBe(1)
    expect(f.resumes()).toBe(0)
  })
}

test("empty data events consume no queue slots", async () => {
  const f = setup(), pending = post()
  f.req.emit("response", { ":status": 200 })
  const res = await pending
  for (let i = 0; i < 2000; i++) f.req.emit("data", Buffer.alloc(0))
  f.req.emit("data", Buffer.from("answer"))
  f.req.emit("end")
  const chunks = []
  for await (const d of res.body()) chunks.push(d.toString())
  expect(chunks).toEqual(["answer"])
  expect(f.pauses()).toBe(0)
})
