// EDwinpzy (magpie's Discord, #feedback, magpie 0.1.2717): Command Code's
// reflection/beam:free answers a fresh one-turn chat, and turns the second
// turn away with 400 "Missing required parameter:
// 'messages[N].reasoning_content'": it wants every earlier assistant
// message's reasoning back, a reply another model made too, and takes the
// request once each has something there. Seen through magpie's
// /v1/chat/completions and /v1/responses alike; both reach the plugin as a
// chat completion whose assistant turn has no reasoning_content. The
// refusal's words are the reporter's; the JSON around them is the Provider
// API's error shape, not bytes saved from Beam.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
  _internal.reasoningAsked.clear()
})

const BEAM = "reflection/beam:free"

// refusal is the Provider API's 400 for the first assistant message at i
// with no reasoning
const refusal = (i) =>
  Response.json(
    {
      error: {
        message: `Missing required parameter: 'messages[${i}].reasoning_content'.`,
        type: "invalid_request_error",
        param: `messages[${i}].reasoning_content`,
        code: "missing_required_parameter",
      },
    },
    { status: 400 },
  )

// vendor answers as Beam does for the models in strict: a request with an
// assistant message whose reasoning_content is missing or blank is turned
// away; any other model takes anything. It records each body sent.
function vendor(strict = [BEAM]) {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url ?? String(input)).pathname
    if (!path.endsWith("/chat/completions")) return new Response("", { status: 404 })
    const body = JSON.parse(init.body ?? (await input.text()))
    sent.push(body)
    if (strict.includes(body.model)) {
      const i = body.messages.findIndex((m) => m.role === "assistant" && !(typeof m.reasoning_content === "string" && m.reasoning_content.trim()))
      if (i >= 0) return refusal(i)
    }
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
  }
  return sent
}

async function fetcher() {
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k", metadata: { plan: "GOAT" } }))
  return (body) => opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: JSON.stringify(body) })
}

// The reporter's second turn as magpie hands it to the plugin from each
// route: /v1/chat/completions relays the client's history (its own Beam
// reply, kept without reasoning, and another model's), /v1/responses
// builds the same turns from the Responses items.
const SECOND_TURNS = {
  "chat completions": {
    model: BEAM,
    stream: true,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "what model are you?" },
    ],
  },
  responses: {
    model: BEAM,
    stream: true,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "what model are you?" },
    ],
  },
}

for (const [route, turn] of Object.entries(SECOND_TURNS)) {
  test(`Beam's second turn (${route}) goes with each earlier reply's reasoning, and is answered`, async () => {
    const sent = vendor()
    const send = await fetcher()
    const res = await send(turn)
    expect(res.status).toBe(200)
    expect(sent.length).toBe(1)
    const a = sent[0].messages.filter((m) => m.role === "assistant")
    expect(a.length).toBe(1)
    expect(a[0].reasoning_content).toBe(_internal.NO_THOUGHT)
    expect(a[0].content).toBe("Hello! How can I help?")
    // nothing else of the request changes
    expect(sent[0].messages.map(({ reasoning_content, ...m }) => m)).toEqual(turn.messages)
    expect(sent[0].stream).toBe(true)
  })
}

test("a reply's own reasoning goes back as it was; one sent as reasoning goes as reasoning_content", async () => {
  const sent = vendor()
  const send = await fetcher()
  const res = await send({
    model: BEAM,
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", reasoning_content: "thought b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d", reasoning: "thought d" },
      { role: "user", content: "e" },
      // a tool turn of another model, which magpie sends with a space
      { role: "assistant", content: null, reasoning_content: " ", tool_calls: [{ id: "t1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "x" },
    ],
  })
  expect(res.status).toBe(200)
  const a = sent[0].messages.filter((m) => m.role === "assistant")
  expect(a[0].reasoning_content).toBe("thought b")
  expect(a[1].reasoning_content).toBe("thought d")
  expect("reasoning" in a[1]).toBe(false)
  expect(a[2].reasoning_content).toBe(_internal.NO_THOUGHT)
  expect(a[2].tool_calls[0].id).toBe("t1")
})

test("a fresh one-turn request goes as it came", async () => {
  const sent = vendor()
  const send = await fetcher()
  const body = { model: BEAM, messages: [{ role: "user", content: "hi" }] }
  expect((await send(body)).status).toBe(200)
  expect(sent[0]).toEqual(body)
})

test("another model's history goes as it came", async () => {
  const sent = vendor()
  const send = await fetcher()
  const body = { ...SECOND_TURNS["chat completions"], model: "stealth/glyph-cluster:free" }
  expect((await send(body)).status).toBe(200)
  expect(sent.length).toBe(1)
  expect(sent[0]).toEqual(body)
})

test("a model the Provider API asks the same of is asked once more with it, and has it from then on", async () => {
  const model = "someone/new-reasoner"
  const sent = vendor([model])
  const send = await fetcher()
  const body = { ...SECOND_TURNS["chat completions"], model }
  expect((await send(body)).status).toBe(200)
  expect(sent.length).toBe(2)
  expect(sent[0].messages[1].reasoning_content).toBeUndefined()
  expect(sent[1].messages[1].reasoning_content).toBe(_internal.NO_THOUGHT)
  // the next request is filled at once
  expect((await send(body)).status).toBe(200)
  expect(sent.length).toBe(3)
  expect(sent[2].messages[1].reasoning_content).toBe(_internal.NO_THOUGHT)
})

test("a 400 about something else is not asked again", async () => {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    sent.push(JSON.parse(init.body))
    return Response.json({ error: { message: "Missing required parameter: 'messages'.", type: "invalid_request_error" } }, { status: 400 })
  }
  const send = await fetcher()
  const res = await send({ ...SECOND_TURNS["chat completions"], model: "stealth/glyph-cluster:free" })
  expect(res.status).toBe(400)
  expect(sent.length).toBe(1)
  expect(_internal.reasoningAsked.size).toBe(0)
})
