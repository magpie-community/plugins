import { test } from "node:test"
import assert from "node:assert/strict"

import { buildQuery } from "../pplx.mjs"

test("a single user turn becomes the query, with no conversation header", () => {
  const { query, follow } = buildQuery([{ role: "user", content: "What is the weather in Taipei?" }])
  assert.equal(query, "What is the weather in Taipei?")
  assert.equal(follow, null)
})

test("part content is flattened to text", () => {
  const { query } = buildQuery([
    { role: "user", content: [{ type: "text", text: "first" }, { type: "input_text", text: "second" }] },
  ])
  assert.equal(query, "first\nsecond")
})

test("earlier turns are context, the last user turn is the searchable query", () => {
  const { query } = buildQuery([
    { role: "user", content: "who is Ada Lovelace" },
    { role: "assistant", content: "A mathematician." },
    { role: "user", content: "when was she born" },
  ])
  assert.match(query, /^\[Conversation so far/)
  assert.match(query, /User: who is Ada Lovelace/)
  assert.match(query, /Assistant: A mathematician\./)
  assert.ok(query.endsWith("\n\nwhen was she born"))
})

test("system prompts are dropped unless keepSystem is set", () => {
  const messages = [
    { role: "system", content: "You are a coding agent with 400 tools." },
    { role: "user", content: "hello" },
  ]
  assert.equal(buildQuery(messages, false).query, "hello")
  const kept = buildQuery(messages, true).query
  assert.match(kept, /\[Instructions\] You are a coding agent/)
  assert.ok(kept.endsWith("\n\nhello"))
})

test("tool results are kept as conversation context", () => {
  const { query } = buildQuery([
    { role: "user", content: "search it" },
    { role: "tool", content: "42 results" },
    { role: "user", content: "and now?" },
  ])
  assert.match(query, /Tool result: 42 results/)
  assert.ok(query.endsWith("\n\nand now?"))
})

test("a known backend uuid makes a plain follow-up when there is history", () => {
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]
  const { query, follow } = buildQuery(messages, false, "uuid-123")
  assert.equal(query, "second question")
  assert.equal(follow, "uuid-123")
})

test("a backend uuid alone is not a follow-up without a second user turn", () => {
  const { follow } = buildQuery([{ role: "user", content: "only one" }], false, "uuid-123")
  assert.equal(follow, null)
})

test("an empty message list still asks something", () => {
  const { query } = buildQuery([])
  assert.equal(query, "")
  const { query: fallback } = buildQuery([{ role: "user", content: "" }])
  assert.equal(fallback, "Hello")
})
