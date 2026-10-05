// WorkBuddy's refusal of Codex's and Claude Code's system prompt carries
// the hint magpie's built-in added (provider.WBRefusedHint), at the end of
// the message, where magpie's routing page looks for it.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { explained, REFUSED_HINT, EXHAUSTED_HINT } = _internal

test("the refusal ends in the hint", async () => {
  const res = await explained(new Response(JSON.stringify({ error: { message: "Illegal API invocation from an unapproved channel", code: 11004 } }), { status: 403 }))
  expect(res.status).toBe(403)
  expect((await res.json()).error.message).toBe("Illegal API invocation from an unapproved channel — " + REFUSED_HINT)
})

test("credits exhausted error ends in the exhausted hint", async () => {
  const res = await explained(
    new Response(
      JSON.stringify({
        error: {
          data: {
            code: 14018,
            msg: "Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage ",
            requestId: "test-req",
          },
        },
      }),
      { status: 429 }
    )
  )
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.error.type).toBe("insufficient_quota")
  expect(body.error.code).toBe(14018)
  expect(body.error.message).toBe(
    "Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage  — " +
      EXHAUSTED_HINT
  )
})

test("credits exhausted as {code, msg} says its msg, then the exhausted hint", async () => {
  const res = await explained(
    new Response(JSON.stringify({ code: 14018, msg: "Credits exhausted" }), { status: 429 })
  )
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.error.type).toBe("insufficient_quota")
  expect(body.error.code).toBe(14018)
  expect(body.error.message).toBe("Credits exhausted — " + EXHAUSTED_HINT)
})

test("other errors pass as they came", async () => {
  const res = await explained(new Response('{"error":{"message":"rate limited"}}', { status: 429 }))
  expect(res.status).toBe(429)
  expect(await res.text()).toBe('{"error":{"message":"rate limited"}}')
})

test("unrelated errors containing 14018 in requestId pass through untouched", async () => {
  const timeout = '{"error":{"message":"upstream timeout","requestId":"req-1759614018"}}'
  const res1 = await explained(new Response(timeout, { status: 504 }))
  expect(res1.status).toBe(504)
  expect(await res1.text()).toBe(timeout)

  const notfound = '{"error":{"message":"model not found","requestId":"a1b2-14018-ff"}}'
  const res2 = await explained(new Response(notfound, { status: 404 }))
  expect(res2.status).toBe(404)
  expect(await res2.text()).toBe(notfound)
})

test("truncated body with code 14018 is explained", async () => {
  const trunc = '{"error":{"data":{"code":14018,"msg":"Credits exh'
  const res = await explained(new Response(trunc, { status: 429 }))
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.error.type).toBe("insufficient_quota")
  expect(body.error.code).toBe(14018)
  expect(body.error.message).toBe(trunc + " — " + EXHAUSTED_HINT)
})

test("a model of no credits is free, as magpie's built-in read them", () => {
  const { freeCredits } = _internal
  for (const c of ["x0.00", "0", 0, " X0 "]) expect(freeCredits(c)).toBe(true)
  for (const c of ["x0.03", "", null, undefined, "free", 1]) expect(freeCredits(c)).toBe(false)
})

// wbExplain's refusal in WorkBuddy's own envelope reads its msg
test("a refusal as {code, msg} says its msg, then the hint", async () => {
  const res = await explained(new Response(JSON.stringify({ code: 11004, msg: "Illegal API invocation from an unapproved channel" }), { status: 403 }))
  expect(res.status).toBe(403)
  expect((await res.json()).error.message).toBe("Illegal API invocation from an unapproved channel — " + REFUSED_HINT)
})

// a body handed over as bytes still gets WorkBuddy's system message
test("a chat body in bytes is read, and given the system message", () => {
  const { withSystem } = _internal
  const chat = { model: "m", messages: [{ role: "user", content: "hi" }] }
  const want = { model: "m", messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "hi" }] }
  for (const b of [Buffer.from(JSON.stringify(chat)), new TextEncoder().encode(JSON.stringify(chat)), new TextEncoder().encode(JSON.stringify(chat)).buffer])
    expect(JSON.parse(withSystem(b))).toEqual(want)
  expect(JSON.parse(withSystem(JSON.stringify(chat)))).toEqual(want)
})
