// plugins#1114, the sibling of qoder's #1113: a reply that is one JSON
// object in OpenAI's own wire shape, {"tool_calls":[{"name","arguments"}]},
// written as text, went out as the answer. The object is the issue's, byte
// for byte; TextTools now reads it as those calls, whole or a piece at a
// time, and never gives it out as text. JSON in prose or code, an empty
// list and one that can't be read stay text; one cut short ends the turn.
import "./nonet.mjs"
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const BARE = '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.go"}},{"name":"viking_search","arguments":{"query":"x"}}]}'
const CALLS = [["read_file", { path: "a.go" }], ["viking_search", { query: "x" }]]

function read(s, size = 0) {
  const t = new _internal.TextTools([])
  const pieces = size ? Array.from({ length: Math.ceil(s.length / size) }, (_, k) => s.slice(k * size, (k + 1) * size)) : [s]
  const out = { text: "", calls: [], error: null }
  for (const [k, p] of [...pieces, ""].entries()) {
    const r = t.push(p, k === pieces.length)
    out.text += r.text
    out.calls.push(...r.calls.map((c) => [c.name, JSON.parse(c.arguments)]))
    if (r.error) {
      out.error = r.error
      break
    }
  }
  return out
}

test('a bare {"tool_calls":[…]} reply is its calls, whole or a piece at a time', () => {
  for (const size of [0, 1, 5, 4096]) {
    expect(read(BARE, size)).toEqual({ text: "", calls: CALLS, error: null })
    // after a line of text, indented, with OpenAI's own entries
    const q = 'I will read it.\n  {"tool_calls": [{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.go\\"}"}}]}\n'
    expect(read(q, size)).toEqual({ text: "I will read it.\n", calls: [CALLS[0]], error: null })
  }
})

test("one cut short ends the turn as a failure, never the answer", () => {
  for (const size of [0, 1, 5]) {
    const r = read("Reading it.\n" + BARE.slice(0, 40), size)
    expect(r.text).toBe("Reading it.\n")
    expect(r.calls).toEqual([])
    expect(r.error).toContain("cut short")
  }
})

test("the same shape in prose, in code, with no calls or unreadable stays the answer", () => {
  const texts = [
    'OpenAI answers with {"tool_calls":[{"name":"x"}]} when it calls a tool.',
    "Like this:\n```json\n" + BARE + "\n```\n",
    '{"tool_calls":[]}',
    '{"tool_calls":[{"arguments":{}}]}',
    '{"total": 3}\nok',
    "a < b and {x}",
  ]
  for (const size of [0, 1, 5]) for (const s of texts) expect(read(s, size)).toEqual({ text: s, calls: [], error: null })
})
