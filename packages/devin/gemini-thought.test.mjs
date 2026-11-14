// A Gemini reply goes back to Devin with its thought signature, as the
// devin CLI sends it: a reply from gemini-4-hydrogen carries one in
// delta_signature (10), typed "gemini" (21), and the CLI's next request
// has it on the prompt with the reply's call, in signature (12),
// signature_type (18) and the model that wrote it (22). Without it,
// Devin's Gemini models deep in a dsh tool loop answered with usage and
// nothing else (X, @liuzhengdong99, magpie 0.1.4146).
// testdata/gemini-tool-reply.bin is a real GetChatMessage reply from
// gemini-4-hydrogen-medium to the devin CLI (a call to exec), captured
// through WINDSURF_API_SERVER_URL; it has the bot id, response id and
// usage, no credentials.
import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { _internal } from "./index.mjs"

const { PB, frame, fields, build, buildMessages, complete, completeMessages, familiesOf, SNAPSHOT } = _internal
const dec = new TextDecoder()
const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.forgetThoughts?.()
})

const captured = await readFile(new URL("./testdata/gemini-tool-reply.bin", import.meta.url))
const SIG = "AY89a1+u1EAPOiO7CmhB"
const CALL = "call_11646388125050983982"
const UID = "gemini-4-hydrogen-medium"
// Devin's list for the account that captured it has Gemini 4 Hydrogen,
// which the snapshot predates
const hydrogen = { uid: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", aliases: [], models: ["low", "medium", "high"].map((e) => ({ id: "gemini-4-hydrogen-" + e, name: "Gemini 4 Hydrogen " + e, context: 1048576, output: 65535 })) }
const families = [...familiesOf(SNAPSHOT), hydrogen]
const ctx = { key: "k", server: "https://devin.test", families }

// prompts is each ChatMessagePrompt a request sends, with the thought it
// carries back
const prompts = (body) =>
  fields(body)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const p = { role: 0, calls: [], thinking: null, signature: null, type: null, model: null }
      for (const g of fields(f.data)) {
        if (g.num === 2) p.role = g.n
        else if (g.num === 6) p.calls.push(dec.decode(fields(g.data).find((h) => h.num === 1).data))
        else if (g.num === 11) p.thinking = dec.decode(g.data)
        else if (g.num === 12) p.signature = dec.decode(g.data)
        else if (g.num === 18) p.type = dec.decode(g.data)
        else if (g.num === 22) p.model = dec.decode(g.data)
      }
      return p
    })

// replyAndNext sends one request to the captured reply through the given
// wire, reads the reply whole, and builds the next request with the
// reply's call answered, to the model next
async function chatAndNext(stream, next = UID) {
  globalThis.fetch = async () => new Response(captured)
  const res = await complete(ctx, { model: "gemini-4-hydrogen", reasoning_effort: "medium", stream, messages: [{ role: "user", content: "cat calc.py" }] })
  expect(res.status).toBe(200)
  let call
  if (stream) {
    for (const l of (await res.text()).split("\n")) {
      const tc = l.startsWith("data: {") && JSON.parse(l.slice(6)).choices?.[0]?.delta?.tool_calls?.[0]
      if (tc?.id) call = { id: tc.id, type: "function", function: { name: tc.function.name, arguments: '{"command":"cat calc.py"}' } }
    }
  } else call = (await res.json()).choices[0].message.tool_calls[0]
  expect(call.id).toBe(CALL)
  const messages = [
    { role: "user", content: "cat calc.py" },
    { role: "assistant", content: "", tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "def add(a,b): return a+b" },
  ]
  return prompts(build({ model: "x", messages }, next, "k"))
}

for (const stream of [false, true])
  test(`a chat completion's Gemini call goes back with its signature, as the CLI sends it (stream ${stream})`, async () => {
    const ps = await chatAndNext(stream)
    const a = ps.find((p) => p.calls.length)
    expect(a.calls).toEqual([CALL])
    expect(a.signature?.startsWith(SIG)).toBe(true)
    expect(a.type).toBe("gemini")
    expect(a.model).toBe(UID)
    // the prompts around it carry none
    expect(ps.filter((p) => p.signature).length).toBe(1)
  })

test("a Gemini signature goes back to Gemini only", async () => {
  for (const next of ["swe-2-medium", "claude-opus-4-6"]) {
    const ps = await chatAndNext(false, next)
    expect(ps.some((p) => p.signature || p.type || p.model)).toBe(false)
  }
})

test("a call the plugin never saw goes back as before, unsigned", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ]
  expect(prompts(build({ model: "x", messages }, UID, "k")).some((p) => p.signature)).toBe(false)
})

for (const stream of [false, true])
  test(`a Messages Gemini tool_use goes back with its signature (stream ${stream})`, async () => {
    globalThis.fetch = async () => new Response(captured)
    const res = await completeMessages(ctx, { model: "gemini-4-hydrogen", max_tokens: 64, stream, output_config: { effort: "medium" }, messages: [{ role: "user", content: "cat calc.py" }] })
    expect(res.status).toBe(200)
    let id
    if (stream) id = /"id":"(call_[0-9]+)"/.exec(await res.text())[1]
    else id = (await res.json()).content.find((b) => b.type === "tool_use").id
    const messages = [
      { role: "user", content: "cat calc.py" },
      { role: "assistant", content: [{ type: "tool_use", id, name: "exec", input: { command: "cat calc.py" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "def add(a,b): return a+b" }] },
    ]
    const a = prompts(buildMessages({ model: "x", messages }, UID, "k")).find((p) => p.calls.length)
    expect(a.signature?.startsWith(SIG)).toBe(true)
    expect(a.type).toBe("gemini")
    expect(a.model).toBe(UID)
  })

test("a Gemini reply with only words goes back signed by its words", async () => {
  const usage = new PB().varint(2, 10).varint(3, 5).done()
  globalThis.fetch = async () =>
    new Response(new Blob([frame(new PB().str(3, "Hi there,").done()), frame(new PB().str(3, " friend!").str(10, "SIGTEXT").str(21, "gemini").done()), frame(new PB().varint(5, 1).bytes(7, usage).done())]))
  const j = await (await complete(ctx, { model: "gemini-4-hydrogen", reasoning_effort: "medium", messages: [{ role: "user", content: "hi" }] })).json()
  expect(j.choices[0].message.content).toBe("Hi there, friend!")
  const messages = [{ role: "user", content: "hi" }, j.choices[0].message, { role: "user", content: "again" }]
  const a = prompts(build({ model: "x", messages }, UID, "k")).find((p) => p.role === 2)
  expect([a.signature, a.type, a.model]).toEqual(["SIGTEXT", "gemini", UID])
})
