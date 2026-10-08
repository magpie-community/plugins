// The HTTP/2 implementation runs against EventEmitters, never a socket.
import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import http2 from "node:http2"
import { _internal } from "./index.mjs"

const connect = http2.connect
afterEach(() => (http2.connect = connect))
const setup = () => {
  const c = new EventEmitter(), req = new EventEmitter()
  let destroyed = 0, connects = 0
  c.destroy = () => { destroyed++; req.emit("close"); c.emit("close") }
  c.request = () => req
  req.end = () => {}
  http2.connect = () => { connects++; return c }
  return { c, req, destroyed: () => destroyed, connects: () => connects }
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
