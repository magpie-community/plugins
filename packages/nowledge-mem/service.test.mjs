import { expect, test } from "bun:test"
import { _internal } from "./service.mjs"

const req = (headers) => ({ headers: { get: (name) => headers[name.toLowerCase()] ?? null } })
const port = 3479

test("the test service only answers on a loopback Host", () => {
  expect(_internal.hostOK(req({ host: "127.0.0.1:3479" }), port)).toBe(true)
  expect(_internal.hostOK(req({ host: "localhost:3479" }), port)).toBe(true)
  expect(_internal.hostOK(req({ host: "evil.example:3479" }), port)).toBe(false)
  expect(_internal.hostOK(req({ host: "127.0.0.1:1" }), port)).toBe(false)
  expect(_internal.hostOK(req({}), port)).toBe(false)
})

test("the test service only takes the sandbox or its own Origin", () => {
  expect(_internal.originOK(req({ origin: "null" }), port)).toBe(true)
  expect(_internal.originOK(req({ origin: "http://127.0.0.1:3479" }), port)).toBe(true)
  expect(_internal.originOK(req({}), port)).toBe(true)
  expect(_internal.originOK(req({ origin: "http://evil.example" }), port)).toBe(false)
  expect(_internal.originOK(req({ origin: "https://localhost:3479" }), port)).toBe(false)
})
