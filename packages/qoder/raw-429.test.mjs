// A 429 that names no quota carries Qoder's status, code and own reply, so a
// user sees what Qoder said and not only "usage limit reached"
// (QwenWork flash through dsh: "All models failed").
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

test("a 429 with no quota in it shows Qoder's status, code and reply", () => {
  const body = JSON.stringify({ code: "9001", message: "All models failed", details: "{\"error\":{\"message\":\"flash: rate limited\"}}" })
  const f = _internal.failure(429, body)
  expect(f.status).toBe(429)
  expect(f.message.startsWith("usage limit reached: All models failed")).toBe(true)
  expect(f.message).toContain("HTTP 429")
  expect(f.message).toContain("code 9001")
  expect(f.message).toContain("flash: rate limited")
})

test("an empty 429 still says its status", () => {
  const f = _internal.failure(429, "")
  expect(f.status).toBe(429)
  expect(f.message).toContain("HTTP 429")
})

test("a quota code keeps its short words", () => {
  expect(_internal.failure(429, JSON.stringify({ code: "112", message: "credits used up" })).message).toBe("usage limit reached: credits used up")
})
