// Tabbit's per-message content cap (~20480 chars) and how the plugin reports it.
//
// Measured 2026-11-05 on a live account: content 20480/20500 → 200, 20504 →
// 429 with the welcome blurb and code 492. See src/limit.mjs for the evidence.
import test from "node:test"
import assert from "node:assert/strict"
import { INPUT_LIMIT, contentLength, contentTooLong, looksLikeOverLimit, overLimitError, tooLongMessage } from "../src/limit.mjs"

const WELCOME_429 = JSON.stringify({
  message: "Welcome to Tabbit Browser (https://www.tabbit.com/), where you can use the most comprehensive and advanced models for free.",
  code: 492,
})

test("looksLikeOverLimit recognises Tabbit's welcome-blurb 429", () => {
  assert.equal(looksLikeOverLimit({ status: 429, body: WELCOME_429 }), true)
})

test("looksLikeOverLimit recognises the same body on a 403", () => {
  assert.equal(looksLikeOverLimit({ status: 403, body: WELCOME_429 }), true)
})

test("a real rate limit is NOT over-limit (it carries retry-after)", () => {
  assert.equal(looksLikeOverLimit({ status: 429, body: WELCOME_429, retryAfter: "30" }), false)
})

test("a premium-model paywall is NOT over-limit", () => {
  const paywall = JSON.stringify({ detail: { message: "Model Kimi-K3 is available to premium users only.", details: { code: 492 } } })
  assert.equal(looksLikeOverLimit({ status: 403, body: paywall }), false)
})

test("an ordinary 429/403/500 is NOT over-limit", () => {
  assert.equal(looksLikeOverLimit({ status: 429, body: "slow down" }), false)
  assert.equal(looksLikeOverLimit({ status: 403, body: "forbidden" }), false)
  assert.equal(looksLikeOverLimit({ status: 500, body: WELCOME_429 }), false)
  assert.equal(looksLikeOverLimit({}), false)
})

test("the over-limit message reads as magpie's context overflow", () => {
  const msg = tooLongMessage(30000)
  // magpie matches these case-insensitively to decide to compact.
  assert.match(msg, /prompt is too long/i)
  assert.match(msg, /30000/)
  assert.match(msg, new RegExp(String(INPUT_LIMIT)))
})

test("contentTooLong is a 400 whose code names the overflow", () => {
  const err = contentTooLong(30000)
  assert.equal(err.status, 400)
  assert.equal(err.code, "context_length_exceeded")
  assert.match(err.message, /prompt is too long/i)
})

test("overLimitError carries the size it was sent with, or stays generic", () => {
  assert.match(overLimitError(25000).message, /25000/)
  assert.match(overLimitError(undefined).message, /prompt is too long/i)
  assert.match(overLimitError(0).message, /prompt is too long/i)
})

test("contentLength measures only strings", () => {
  assert.equal(contentLength("abc"), 3)
  assert.equal(contentLength(""), 0)
  assert.equal(contentLength(undefined), null)
  assert.equal(contentLength(null), null)
  assert.equal(contentLength({ a: 1 }), null)
})

test("INPUT_LIMIT is the measured ceiling", () => {
  // 20480 passed and 20504 failed on a live account; the limit sits between.
  assert.equal(INPUT_LIMIT, 20480)
})
