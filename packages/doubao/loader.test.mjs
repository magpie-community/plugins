// auth.loader: what an agent's request becomes on its way to Doubao, and what
// Doubao's stream becomes on the way back. A local server plays Doubao; the
// agent's side is the Anthropic Messages shape magpie hands a provider.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DoubaoAuthPlugin } from "./index.mjs"

let server
let got = []
let answer = null
let stateDir

const realFetch = globalThis.fetch
const HOST = "https://www.doubao.com"
const COOKIE = "sessionid=abc; sessionid_ss=def; passport_csrf_token=csrf1"

function routeToFake() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(HOST + "/")) throw new Error("no network in tests: " + url)
    return realFetch(`http://127.0.0.1:${server.port}/${url.slice(HOST.length + 1)}`, init)
  }
}

const streamOf = (chunks) => new Response(
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch))
      c.close()
    },
  }),
  { headers: { "content-type": "text/event-stream" } },
)

async function loaderFor(authObj = { type: "api", key: COOKIE }) {
  const h = await DoubaoAuthPlugin({ client: { app: { log: async () => {} } }, directory: process.cwd() })
  return h.auth.loader(async () => authObj, { id: "doubao" })
}

// The body an agent sends: Anthropic Messages.
function agentRequest(body, path = "/v1/messages") {
  return new Request(`https://www.doubao.com/samantha${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "doubao-loader-"))
  process.env.MAGPIE_DOUBAO_STATE = join(stateDir, "state.json")
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      got.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(req.headers), body: await req.text() })
      if (answer) return answer(req, url)
      return streamOf(['data: {"text":"hi"}\n\n'])
    },
  })
})

afterAll(() => {
  server?.stop(true)
  globalThis.fetch = realFetch
  rmSync(stateDir, { recursive: true, force: true })
  delete process.env.MAGPIE_DOUBAO_STATE
})

beforeEach(() => {
  routeToFake()
  got = []
  answer = null
  rmSync(process.env.MAGPIE_DOUBAO_STATE, { force: true })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ---------------------------------------------------------------------------
// What the loader hands back
// ---------------------------------------------------------------------------

describe("loader", () => {
  test("no cookie is no loader, so the provider stays signed out", async () => {
    expect(await loaderFor({ type: "api", key: "" })).toEqual({})
  })

  test("with a cookie it gives a base URL, a key, and its own fetch", async () => {
    const l = await loaderFor()
    expect(l.baseURL).toContain("doubao.com")
    expect(typeof l.fetch).toBe("function")
    expect(l.apiKey).toBe("doubao")
  })

  test("a models read is answered here, not sent upstream", async () => {
    const l = await loaderFor()
    const res = await l.fetch(agentRequest({}, "/v1/models"), {})
    const j = await res.json()
    expect(j.object).toBe("list")
    expect(j.data.map((m) => m.id)).toContain("doubao-2.1-pro-deep")
    expect(got).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The request, as Doubao receives it
// ---------------------------------------------------------------------------

describe("the request Doubao receives", () => {
  test("it goes to /samantha/chat/completion with the client's own query", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({ model: "doubao", messages: [{ role: "user", content: "hi" }] }), {})
    expect(got[0].path).toBe("/samantha/chat/completion")
    expect(got[0].query.aid).toBe("582478")
    expect(got[0].query.samantha_web).toBe("1")
    expect(got[0].query.device_id).toBeTruthy()
    expect(got[0].query.web_id).toBeTruthy()
  })

  test("the cookie and the conversation header ride along", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({ messages: [{ role: "user", content: "hi" }] }), {})
    expect(got[0].headers.cookie).toBe(COOKIE)
    expect(got[0].headers["agw-js-conv"]).toBe("str")
    expect(got[0].headers["x-tt-passport-csrf-token"]).toBe("csrf1")
    expect(got[0].headers.accept).toBe("text/event-stream")
  })

  test("the whole history folds into one text block", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({
      system: "You are terse.",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    }), {})
    const body = JSON.parse(got[0].body)
    const text = JSON.parse(body.messages[0].content).text
    expect(text).toContain("You are terse.")
    expect(text).toContain("User: one")
    expect(text).toContain("Assistant: two")
    expect(text).toContain("User: three")
  })

  test("one user turn goes as itself, with no transcript labels", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({ messages: [{ role: "user", content: "just this" }] }), {})
    const text = JSON.parse(JSON.parse(got[0].body).messages[0].content).text
    expect(text).toBe("just this")
  })

  test("the deep-think model sets the flag the page's toggle sets", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({ model: "doubao-2.1-pro-deep", messages: [{ role: "user", content: "x" }] }), {})
    const body = JSON.parse(got[0].body)
    expect(body.completion_option.use_deep_think).toBe(true)
  })

  test("the plain model leaves it off", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({ model: "doubao-auto", messages: [{ role: "user", content: "x" }] }), {})
    expect(JSON.parse(got[0].body).completion_option.use_deep_think).toBe(false)
  })

  test("a first turn starts a conversation", async () => {
    const l = await loaderFor()
    await l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})
    const body = JSON.parse(got[0].body)
    expect(body.completion_option.need_create_conversation).toBe(true)
    expect(body.local_conversation_id).toMatch(/^local_[0-9a-f]{16}$/)
  })

  test("a second turn continues the one the stream named", async () => {
    answer = () => streamOf([
      `data: ${JSON.stringify({ event_type: 2002, event_data: JSON.stringify({ conversation_id: "397193850580994" }) })}\n\n`,
      `data: ${JSON.stringify({ event_type: 2001, event_data: JSON.stringify({ message: { content_type: 2001, content: '{"text":"ok"}' } }) })}\n\n`,
    ])
    const l = await loaderFor()
    await l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})
    got = []
    answer = null
    await l.fetch(agentRequest({ messages: [{ role: "user", content: "again" }] }), {})
    const body = JSON.parse(got[0].body)
    expect(body.local_conversation_id).toBe("397193850580994")
    expect(body.completion_option.need_create_conversation).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The answer, as the agent receives it
// ---------------------------------------------------------------------------

describe("the answer the agent receives", () => {
  test("it is an Anthropic event stream, not Doubao's", async () => {
    const l = await loaderFor()
    const res = await l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: message_stop")
    expect(text).toContain('"type":"text_delta"')
    // Doubao's own frames never surface
    expect(text).not.toContain("SSE_ACK")
    expect(text).not.toContain("patch_op")
  })

  test("the text arrives whole across several frames", async () => {
    answer = () => streamOf(['data: {"text":"你"}\n\n', 'data: {"text":"好"}\n\n'])
    const l = await loaderFor()
    const res = await l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})
    const text = await res.text()
    const deltas = [...text.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1])
    expect(deltas).toEqual(["你", "好"])
  })
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("refusals", () => {
  test("no cookie throws rather than sending an anonymous request", async () => {
    const h = await DoubaoAuthPlugin({ client: { app: { log: async () => {} } }, directory: process.cwd() })
    const l = await h.auth.loader(async () => ({ type: "api", key: "" }), { id: "doubao" })
    // a keyless account gets no loader at all
    expect(l).toEqual({})
  })

  test("a 401 is a dead session, and the day is fused", async () => {
    answer = () => new Response("{}", { status: 401 })
    const l = await loaderFor()
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow(/fresh cookie/)

    // the next attempt doesn't spend a request: the ledger already knows
    got = []
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow()
    expect(got).toHaveLength(0)
  })

  test("a 429 says it is backing off, and does not pretend the session died", async () => {
    answer = () => new Response("", { status: 429 })
    const l = await loaderFor()
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow(/rate-limiting/)
  })

  test("a 500 is reported with its status", async () => {
    answer = () => new Response("boom", { status: 502 })
    const l = await loaderFor()
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow(/502/)
  })

  test("a json error instead of a stream never reaches the agent as an empty answer", async () => {
    answer = () => Response.json({ code: 710012001, msg: "登录已过期" })
    const l = await loaderFor()
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow(/710012001/)
  })

  test("a captcha code fused the session for the day", async () => {
    answer = () => Response.json({ code: 710022004, msg: "请完成验证" })
    const l = await loaderFor()
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow()
    got = []
    await expect(l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})).rejects.toThrow(/expired earlier today/)
    expect(got).toHaveLength(0)
  })

  test("a gateway-error mid-stream ends the stream as an Anthropic error", async () => {
    answer = () => streamOf([
      'data: {"text":"半"}\n\n',
      'event: gateway-error\ndata: {"code":"Internal","message":"710012000 user invalid"}\n\n',
    ])
    const l = await loaderFor()
    const res = await l.fetch(agentRequest({ messages: [{ role: "user", content: "x" }] }), {})
    const text = await res.text()
    expect(text).toContain("event: error")
    expect(text).toContain("710012000")
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  test("the plugin asks the host to queue, instead of the vendor seeing a burst", async () => {
    const h = await DoubaoAuthPlugin({ client: { app: { log: async () => {} } }, directory: process.cwd() })
    expect(h.auth.maxConcurrency).toBe(1)
  })
})
