// plugins#1114, the sibling of qoder's #1113: a reply that is one JSON
// object in OpenAI's own wire shape, {"tool_calls":[{"name","arguments"}]},
// written as text, went out as the answer with "stop". The object is the
// issue's, byte for byte; it is now those calls, finished tool_calls, and
// it is never shown as text while the reply streams. JSON in prose or code,
// an empty list and one that can't be read stay text.
import { expect, test } from "bun:test"
import { heldFrom, parse } from "./prompt.mjs"
import { Streamer, completion } from "./openai.mjs"

const BARE = '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.go"}},{"name":"viking_search","arguments":{"query":"x"}}]}'
const CALLS = [["read_file", { path: "a.go" }], ["viking_search", { query: "x" }]]
let n = 0
const id = () => "call_" + ++n
const named = (calls) => calls.map((c) => [c.function.name, JSON.parse(c.function.arguments)])

test("a bare {\"tool_calls\":[…]} reply is its calls", () => {
  const p = parse(BARE, id)
  expect(named(p.calls)).toEqual(CALLS)
  expect(p.text).toBe("")
  // after a line of text, and with arguments as a JSON string (OpenAI's own)
  const q = parse('I will read it.\n  {"tool_calls": [{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.go\\"}"}}]}\n', id)
  expect(named(q.calls)).toEqual([CALLS[0]])
  expect(q.text).toBe("I will read it.")
  const c = completion({ id: "x", model: "m", final: { text: BARE }, promptTokens: 1, newId: id })
  expect(c.choices[0].finish_reason).toBe("tool_calls")
  expect(c.choices[0].message.content).toBeNull()
  expect(named(c.choices[0].message.tool_calls)).toEqual(CALLS)
})

test("JSON that isn't such an object stays text", () => {
  for (const t of [
    'The API answers {"tool_calls":[{"name":"a","arguments":{}}]} here.',
    '```json\n' + BARE + '\n```',
    '{"tool_calls":[]}',
    '{"tool_calls":[{"name":"","arguments":{}}]}',
    '{"tool_calls":[{"name":"a","arguments":"not json"}]}',
    '{"other":1}',
    '{"tool_calls":[{"name":"a","arguments":{"x":1}}',
  ]) {
    const p = parse(t, id)
    expect(p.calls).toEqual([])
    expect(p.text).toBe(t)
  }
})

test("the object is held, never shown, while the reply streams", () => {
  const st = new Streamer()
  const full = "Reading.\n" + BARE
  let shown = ""
  for (let k = 1; k <= full.length; k++) shown += st.update({ text: full.slice(0, k) }).content ?? ""
  expect(shown).toBe("Reading.\n")
  const f = st.finish({ text: full }, id)
  expect(f.content).toBe("")
  expect(named(f.calls)).toEqual(CALLS)
  // a line that only began like one is shown once it isn't
  expect(heldFrom('{"tool')).toBe(0)
  expect(heldFrom('a\n{"to')).toBe(2)
  expect(heldFrom('{"total": 3}')).toBe(12)
  const st2 = new Streamer()
  let out = ""
  const t = '{"total": 3}'
  for (let k = 1; k <= t.length; k++) out += st2.update({ text: t.slice(0, k) }).content ?? ""
  out += st2.finish({ text: t }, id).content
  expect(out).toBe(t)
  // in code it is text as it comes
  expect(heldFrom("```\n" + BARE)).toBe(4 + BARE.length)
})
