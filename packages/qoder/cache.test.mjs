// #290: Codex's side session on Qoder's Ultimate read 0% of its prompt from
// cache while Fast read most of it. Qoder's own client (qoder-agent-sdk in
// Qoder.app, qodercli 1.1.75) marks the last turn's last block
// cache_control ephemeral, sends the user turns' blocks as contents too, and
// names its session (session_id) on every turn; the plugin did none of
// that, and gave a call without an id a new random id on every request.

import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, sessionOf } = _internal
const m = { key: "ultimate", config: { key: "ultimate" }, context: 1_000_000 }

const turns = [
  { role: "system", content: "You are Codex." },
  { role: "user", content: "review this diff" },
  { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "shell", arguments: '{"cmd":"git diff"}' } }] },
  { role: "tool", content: "diff --git a/x b/x" },
  { role: "assistant", content: "Looks fine. Anything else?" },
  { role: "user", content: [{ type: "text", text: "check the tests" }] },
]

const marked = (body) =>
  body.messages.flatMap((x, i) => [...(Array.isArray(x.content) ? x.content : []), ...(x.contents ?? [])].filter((b) => b.cache_control).map((b) => [i, b.text, b.cache_control]))

test("the last user turn's last block is marked for the cache, as Qoder's client marks it", () => {
  const body = qoderBody({ messages: turns }, m)
  const last = body.messages.at(-1)
  expect(last.role).toBe("user")
  expect(last.content.at(-1)).toEqual({ type: "text", text: "check the tests", cache_control: { type: "ephemeral" } })
  expect(last.contents).toEqual(last.content)
  // only that block: the system prompt and earlier turns go as before
  expect(new Set(marked(body).map(([i]) => i))).toEqual(new Set([body.messages.length - 1]))
  // every user turn carries its blocks as contents too
  for (const x of body.messages.filter((x) => x.role === "user")) expect(x.contents).toEqual(x.content)
})

test("a turn ending in a tool's result is not marked, as Qoder's client leaves it", () => {
  const body = qoderBody({ messages: turns.slice(0, 4) }, m)
  expect(body.messages.at(-1).role).toBe("tool")
  expect(marked(body)).toEqual([])
})

test("the caller's turns are left as they were", () => {
  const msgs = structuredClone(turns)
  qoderBody({ messages: msgs }, m)
  expect(msgs).toEqual(turns)
})

test("every turn of one conversation names one session, another conversation another", () => {
  const a = qoderBody({ messages: turns.slice(0, 2) }, m).session_id
  expect(qoderBody({ messages: turns }, m).session_id).toBe(a)
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(qoderBody({ messages: [turns[0], { role: "user", content: "another task" }] }, m).session_id).not.toBe(a)
  // Codex's thread names it when sent, and the key itself never goes out
  const k = qoderBody({ prompt_cache_key: "019a-thread", messages: turns }, m)
  expect(k.session_id).toBe(sessionOf({ prompt_cache_key: "019a-thread", messages: [] }))
  expect(k.session_id).not.toBe(a)
  expect(JSON.stringify(k)).not.toContain("019a-thread")
  // each request is its own
  const [x, y] = [qoderBody({ messages: turns }, m), qoderBody({ messages: turns }, m)]
  expect(x.request_id).not.toBe(y.request_id)
  expect(x.chat_record_id).toBe(x.request_id)
})

test("a call sent without an id goes out with the same id on every turn", () => {
  const ids = (body) => body.messages.flatMap((x) => [...(x.tool_calls ?? []).map((c) => c.id), ...(x.tool_call_id ? [x.tool_call_id] : [])])
  const one = ids(qoderBody({ messages: turns.slice(0, 4) }, m))
  const two = ids(qoderBody({ messages: turns }, m))
  expect(one).toHaveLength(2)
  expect(one[0]).toMatch(/^call_[0-9a-f]{32}$/)
  expect(two).toEqual(one)
  // two like calls of one turn still differ
  const twin = { type: "function", function: { name: "shell", arguments: "{}" } }
  const both = ids(qoderBody({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [twin, twin] }] }, m))
  expect(new Set(both).size).toBe(2)
})
