// A request Cursor fails is answered with the status and words magpie's
// built-in Cursor (internal/gateway/cursor.go, cursorFailure) gave it, so the
// gateway moves on to the next account or member as it did.
import "./nonet.mjs" // first: no request leaves this machine
import { expect, test } from "bun:test"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const { failure, errorResponse } = _internal

test("an HTTP error that says nothing is worded as Go's status text", () => {
  expect(failure(402, "")).toEqual({ status: 402, message: "Payment Required" })
  expect(failure(429, "")).toEqual({ status: 429, message: "Too Many Requests" })
  expect(failure(503, "{}")).toEqual({ status: 503, message: "Service Unavailable" })
})

test("the codes and words map as the built-in's cursorStatus", () => {
  const end = (code, message) => JSON.stringify({ error: { code, message } })
  expect(failure(200, end("resource_exhausted", "slow down"))).toEqual({ status: 429, message: "usage limit reached: slow down" })
  expect(failure(200, end("unknown", "You've hit your usage limit"))).toEqual({ status: 429, message: "usage limit reached: You've hit your usage limit" })
  expect(failure(200, end("invalid_argument", "prompt is too long"))).toEqual({ status: 400, message: "input is too long for the model's context: prompt is too long" })
  expect(failure(200, end("invalid_argument", "bad"))).toEqual({ status: 400, message: "bad" })
  expect(failure(200, end("unavailable", "busy"))).toEqual({ status: 503, message: "busy" })
  expect(failure(200, end("permission_denied", "no"))).toEqual({ status: 403, message: "no" })
  expect(failure(200, end("internal", "boom"))).toEqual({ status: 502, message: "boom" })
  expect(failure(401, "")).toEqual({ status: 401, message: "Unauthorized — sign in to Cursor again in magpie" })
  expect(failure(200, end("unauthenticated", "Error"))).toEqual({ status: 401, message: "unauthenticated — sign in to Cursor again in magpie" })
})

// Cursor can refuse a prompt under an authentication code. The observed
// wording identifies the request, not an expired sign-in; the surrounding
// Connect envelopes below are synthetic variants of that failure.
for (const [status, code] of [[200, "unauthenticated"], [401, ""], [403, "permission_denied"]]) {
  test(`a content refusal is a request error (${status}, ${code})`, () => {
    const message = "Unauthorized request.: The provider refused to serve this request based on the content"
    const error = { code, message: "Error", details: [{ debug: { details: {
      title: "Unauthorized request.", detail: "The provider refused to serve this request based on the content",
    } } }] }
    for (const body of [error, { error }]) {
      expect(failure(status, JSON.stringify(body))).toEqual({ status: 400, message })
    }
    expect(failure(status, JSON.stringify({ code, message }))).toEqual({ status: 400, message })
  })
}

test("an unrelated unauthorized request still asks for sign-in", () => {
  expect(failure(200, JSON.stringify({ code: "unauthenticated", message: "Unauthorized request." })))
    .toEqual({ status: 401, message: "Unauthorized request. — sign in to Cursor again in magpie" })
})

// The built-in answered any "expired" with a 401 and marked nothing, a
// session's as a trial's; nor did a success clear a mark.
test("any expired is the built-in's 401", () => {
  const end = (code, message) => JSON.stringify({ error: { code, message } })
  expect(failure(200, end("failed_precondition", "Your free trial has expired"))).toEqual({
    status: 401, message: "Your free trial has expired — sign in to Cursor again in magpie" })
  expect(failure(400, end("", "Your session has expired"))).toEqual({
    status: 401, message: "Your session has expired — sign in to Cursor again in magpie" })
  expect(failure(401, "")).toEqual({ status: 401, message: "Unauthorized — sign in to Cursor again in magpie" })
})

test("every answer, failed or not, says the account is kept", async () => {
  for (const status of [401, 403, 429, 502]) {
    const res = errorResponse({ status, message: "x" })
    expect(res.status).toBe(status)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  }
  const ok = _internal.kept(new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  expect(ok.status).toBe(200)
  expect(ok.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(ok.headers.get("Content-Type")).toBe("text/event-stream")
  expect(await ok.text()).toBe("data: [DONE]\n\n")
})

test("a sign-in that can't give a token is a 401, the account kept", async () => {
  const hooks = await CursorAuthPlugin()
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "", refresh: "", expires: 0, accountId: "a@b.c" }))
  const res = await l.fetch("https://cursor.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "auto", messages: [] }) })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

// easyku (#1615): every claude-fable model failed while claude-opus-4-8
// worked on the same account. Cursor turns a Fable model away until its
// data retention policy is approved in Cursor's dashboard, asked when
// Privacy Mode is on (cursor.com/docs/models/claude-fable-5). The 502 it
// was answered as said neither: it is the model, not the account, and the
// user's step is in the dashboard. Its words are magpie's unserved model
// ("model … not enabled"), so only that model rests on that account.
const POLICY = "Review Data Policy: You must acknowledge Claude Fable 5's data retention policy to use the model."
for (const code of ["failed_precondition", "permission_denied", "unauthenticated", "internal", "unknown", ""]) {
  test(`a model whose data retention policy isn't approved says where to approve it (${code || "no code"})`, () => {
    const error = { code, message: "Error", details: [{ debug: { details: {
      title: "Review Data Policy", detail: "You must acknowledge Claude Fable 5's data retention policy to use the model.",
    } } }] }
    // a stream's end with no code ended well, so the no-code case is an HTTP error only
    for (const [status, body] of [...(code ? [[200, { error }]] : []), [400, error], [403, error]]) {
      const got = failure(status, JSON.stringify(body))
      expect(got.status).toBe(403)
      expect(got.message.startsWith(POLICY.replace(/\.$/, ""))).toBe(true)
      expect(got.message).toContain("https://cursor.com/dashboard/restricted_models/claude-fable-5")
      expect(got.message).not.toMatch(/sign in to Cursor again/)
      // magpie's unservedWords (internal/gateway/fallback.go): the model rests, not the account
      expect(got.message).toMatch(/model.{0,80}not (supported|accessible|available|found|enabled|allowed)/i)
      expect(got.message).not.toMatch(/quota|credit|rate limit|usage limit/i)
    }
  })
}

test("another model's data retention policy points at the dashboard, not Fable's page", () => {
  const body = JSON.stringify({ error: { code: "failed_precondition", message: "Review Data Policy: You must acknowledge Some Model's data retention policy to use the model." } })
  const got = failure(200, body)
  expect(got.status).toBe(403)
  expect(got.message).toContain("open https://cursor.com/dashboard signed in")
  expect(got.message).not.toContain("claude-fable-5")
})
