// A request's max_tokens is never sent above the model's own ceiling: Qoder
// CN's QoDuck (lmodel) answered a client's DeepSeek-sized budget with a 400
// "Error in upstream response: Range of max_tokens should be [1, 131072]"
// on every account, which reached magpie as a 502 and rested each account
// in turn (plugins#822, Gruu6y). A value the client asked lower goes as
// asked.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const { qoderBody, modelInfo, failure, LEARNED_CAPS } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
beforeEach(() => LEARNED_CAPS.clear())

// the issue's own words, as Qoder CN said them behind its 400
const RANGE = "Range of max_tokens should be [1, 131072]"
const UPSTREAM = "Error in upstream response"
const REFUSED = JSON.stringify({ message: UPSTREAM, details: JSON.stringify({ error: { message: RANGE } }) })

const lmodel = modelInfo({ key: "lmodel", display_name: "QoDuck", enable: true, max_input_tokens: 1048576 })
const dfmodel = modelInfo({ key: "dfmodel", display_name: "DeepSeek-Flash", enable: true, max_input_tokens: 1048576 })
const sent = (m, extra) => qoderBody({ messages: [{ role: "user", content: "hi" }], ...extra }, m).parameters.max_tokens

test("lmodel's max_tokens is held to 131072, never raised", () => {
  expect(sent(lmodel, { max_tokens: 384000 })).toBe(131072)
  expect(sent(lmodel, { max_completion_tokens: 200000 })).toBe(131072)
  expect(sent(lmodel, { max_tokens: 131072 })).toBe(131072)
  expect(sent(lmodel, { max_tokens: 8000 })).toBe(8000)
  expect(sent(lmodel, {})).toBe(32000)
})

test("a model with no known ceiling is sent what was asked; its entry's own ceiling is kept", () => {
  expect(sent(dfmodel, { max_tokens: 384000 })).toBe(384000)
  const named = modelInfo({ key: "xmodel", enable: true, max_output_tokens: 65536 })
  expect(sent(named, { max_tokens: 384000 })).toBe(65536)
  expect(sent(named, { max_tokens: 1000 })).toBe(1000)
})

test("Qoder's range refusal is the request's 400 with the ceiling, and still readable", () => {
  for (const [how, text] of [
    ["Qoder's JSON", REFUSED],
    ["details as an object", JSON.stringify({ message: UPSTREAM, details: { error: { message: RANGE } } })],
    ["plain text", `${UPSTREAM}: ${RANGE}`],
  ]) {
    const f = failure(400, text)
    expect([how, f.status, f.signIn, f.maxTokens]).toEqual([how, 400, "", 131072])
    expect(f.message).toContain(`${UPSTREAM}: ${RANGE}`)
  }
  // the vendor's own failure stays a 502 for magpie to ask again
  expect(failure(400, JSON.stringify({ message: UPSTREAM }))).toEqual({ status: 502, message: UPSTREAM, signIn: "" })
})

// a loader on site create whose chat refuses any max_tokens above cap as
// Qoder CN did, in the HTTP reply or in the stream's envelope
async function loader(create, cap, inStream = false, said = cap) {
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/model/list")) return Response.json({ chat: [{ key: "lmodel", display_name: "QoDuck", enable: true, max_input_tokens: 1048576 }, { key: "nmodel", display_name: "N", enable: true }] })
    if (u.pathname === "/api/v1/jobToken/refresh") return Response.json({ token: "jt", refresh_token: "rt", expires_in: 3_600_000 })
    if (!String(url).includes("agent_chat_generation")) throw new Error("unexpected " + url)
    const body = JSON.parse(_internal.decodeBody(init.body))
    asked.push(body.parameters.max_tokens)
    if (body.parameters.max_tokens > cap) {
      const text = REFUSED.replace("131072", String(said))
      if (inStream) return new Response(`data: ${JSON.stringify({ headers: {}, body: text, statusCodeValue: 400, statusCode: "BAD_REQUEST" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      return new Response(text, { status: 400 })
    }
    const chunk = { choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    return new Response(`data: ${JSON.stringify({ body: JSON.stringify(chunk) })}\n\ndata: ${JSON.stringify({ body: "[DONE]" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  }
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, uid: "u1", machineId: "m1" }
  const hooks = await create({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  const ask = (model, max_tokens, stream = false) =>
    l.fetch("https://test.invalid/chat/completions", { method: "POST", body: JSON.stringify({ model, stream, max_tokens, messages: [{ role: "user", content: "hi" }] }) })
  return { ask, asked }
}

for (const [site, create] of [["qoder-cn", QoderCNAuthPlugin], ["qoder", QoderAuthPlugin]]) {
  for (const inStream of [false, true]) {
    for (const stream of [false, true]) {
      const how = `${site}, refused ${inStream ? "in the stream" : "over HTTP"}, stream=${stream}`
      test(`${how}: lmodel is sent 131072 first and answered`, async () => {
        const { ask, asked } = await loader(create, 131072, inStream)
        const res = await ask("lmodel", 384000, stream)
        expect(res.status).toBe(200)
        expect(asked).toEqual([131072])
      })
      test(`${how}: a model whose ceiling Qoder names is asked again once at it, and sent it from then on`, async () => {
        const { ask, asked } = await loader(create, 65536, inStream)
        expect((await ask("nmodel", 200000, stream)).status).toBe(200)
        expect(asked).toEqual([200000, 65536])
        expect((await ask("nmodel", 200000, stream)).status).toBe(200)
        expect((await ask("nmodel", 4000, stream)).status).toBe(200)
        expect(asked).toEqual([200000, 65536, 65536, 4000])
      })
    }
  }
}

test("a refusal that holds at the ceiling it named is said as Qoder said it, a 400 that rests no account", async () => {
  const { ask, asked } = await loader(QoderCNAuthPlugin, 1000, false, 65536)
  const res = await ask("nmodel", 200000)
  expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([400, null])
  expect((await res.json()).error.message).toContain(`${UPSTREAM}: Range of max_tokens should be [1, 65536]`)
  expect(asked).toEqual([200000, 65536])
})
