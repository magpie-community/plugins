// Tabbit caps ONE message's `input_payload.content` at ~20480 characters.
//
// Measured on a live account, 2026-11-05:
//   20480 chars → 200 · 20500 → 200 · 20504 → 429
// The cap is on the parsed `content` string, not on the wire: content 10000
// with a 60000-char html_content went 200 (body ~70KB), while content 30000
// went 429 (body ~60KB). Transfer-Encoding: chunked changed nothing, and the
// Tabbit UA / X-Tabbit-Client-Surface headers changed nothing. Every model had
// the same limit (Default, DeepSeek-V4.1-Flash, GLM-5.3-Flash).
//
// Over the cap Tabbit answers 429 with a *paywall-flavoured* body:
//   {"message":"Welcome to Tabbit Browser (https://www.tabbit.com/), ...",
//    "code":492,...}
// That reads like rate limiting and carries no `retry-after`, so retrying or
// switching models never helps. magpie decides what to do from the text: it
// treats `prompt is too long` / `context_length_exceeded` as context overflow
// (compact and continue) and a bare 429 as "wait". Reporting Tabbit's body
// verbatim therefore makes an over-long prompt look like a rate limit.
//
// So this module does two things: turn an over-limit refusal into an honest
// 400 "prompt is too long", and catch an over-long turn *before* it is sent,
// where the message can say what to do about it.

// INPUT_LIMIT is the measured ceiling on `content`. Leave a little room: the
// turn body is assembled by `flatten`, and 20480 is the last value seen pass.
export const INPUT_LIMIT = 20480

// roomContentLength is what the check applies to: one turn's content, which is
// what Tabbit measures. `null` when there is nothing to measure.
export function contentLength(content) {
  return typeof content === "string" ? content.length : null
}

// tooLongMessage says the size and the fix in the terms magpie's overflow
// regex reads ("prompt is too long"), so it compacts instead of waiting.
export function tooLongMessage(chars, limit = INPUT_LIMIT) {
  return (
    `prompt is too long: ${chars} characters > ${limit} maximum ` +
    `(Tabbit caps one message's content at ${limit} characters)`
  )
}

// contentTooLong builds the 400 error for a content that cannot be sent.
export function contentTooLong(chars, limit = INPUT_LIMIT) {
  return Object.assign(new Error(tooLongMessage(chars, limit)), {
    status: 400,
    code: "context_length_exceeded",
  })
}

// looksLikeOverLimit reads Tabbit's refusal for the over-limit case. The
// refusal is a 429 (sometimes 403) whose body is the welcome blurb with
// code 492 — the same code a premium model returns, which is why the status
// and the phrasing both have to line up. A real paywall never carries the
// "Welcome to Tabbit Browser" wording, and a real rate limit carries
// `retry-after`; neither is treated as over-limit.
export function looksLikeOverLimit({ status, body, retryAfter } = {}) {
  if (retryAfter) return false
  if (status !== 429 && status !== 403) return false
  const text = String(body ?? "")
  return /welcome to tabbit browser/i.test(text)
}

// overLimitError turns a measured over-limit refusal into the 400 that magpie
// reads as context overflow, carrying the size it was sent with.
export function overLimitError(sentChars, limit = INPUT_LIMIT) {
  const detail =
    Number.isFinite(sentChars) && sentChars > 0
      ? tooLongMessage(sentChars, limit)
      : `prompt is too long: Tabbit caps one message's content at ${limit} characters`
  return Object.assign(new Error(detail), { status: 400, code: "context_length_exceeded" })
}
