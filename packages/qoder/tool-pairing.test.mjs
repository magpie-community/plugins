// Qoder refuses a whole request whose tool result answers no call before it
// ("Messages with role 'tool' must be a response to a preceding message with
// 'tool_calls'"), where another API takes the same conversation. A client's
// history reaches qoderMessages with such a result when it dropped an id, so
// the pairing is filled in rather than left broken.

import { describe, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderMessages } = _internal

const call = (id, name = "read_file") => ({
  role: "assistant",
  content: "",
  tool_calls: [{ ...(id === undefined ? {} : { id }), type: "function", function: { name, arguments: "{}" } }],
})

const result = (id, content = "ok") => ({ role: "tool", ...(id === undefined ? {} : { tool_call_id: id }), content })

// orphaned says which tool turns answer no call of the turn before them.
const orphaned = (out) => {
  const open = new Set()
  const bad = []
  for (const m of out) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      open.clear()
      for (const c of m.tool_calls) open.add(c.id)
      continue
    }
    if (m.role === "tool") {
      if (!open.has(m.tool_call_id)) bad.push(m.tool_call_id)
      open.delete(m.tool_call_id)
      continue
    }
    if (m.role === "user") open.clear()
  }
  return bad
}

const callIds = (out) => out.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id))
const resultIds = (out) => out.filter((m) => m.role === "tool").map((m) => m.tool_call_id)
const textOf = (out) => JSON.stringify(out.filter((m) => m.role === "user"))

describe("a tool result whose call lost its id", () => {
  test("is paired with the call, and both carry one id", () => {
    const out = qoderMessages([{ role: "user", content: "read it" }, call(undefined), result("c1")])
    expect(orphaned(out)).toEqual([])
    expect(callIds(out)).toHaveLength(1)
    expect(resultIds(out)).toEqual(callIds(out))
  })

  test("answers the call when neither kept an id", () => {
    const out = qoderMessages([{ role: "user", content: "read it" }, call(undefined), result(undefined, "myhost")])
    expect(orphaned(out)).toEqual([])
    expect(resultIds(out)).toEqual(callIds(out))
    // the output stays a tool turn, not words in the user's own
    expect(out.filter((m) => m.role === "tool")[0].content).toBe("myhost")
  })

  test("answers a turn's calls in the order they were made", () => {
    const out = qoderMessages([
      { role: "user", content: "both" },
      { role: "assistant", content: "", tool_calls: [
        { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
      ] },
      result(undefined, "A"),
      result(undefined, "B"),
    ])
    expect(orphaned(out)).toEqual([])
    expect(resultIds(out)).toEqual(["a", "b"])
  })
})

test("a result naming a call of its turn still answers that call", () => {
  const two = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
    ],
  }
  const out = qoderMessages([{ role: "user", content: "hi" }, two, result("b", "B"), result("a", "A")])
  expect(orphaned(out)).toEqual([])
  // each result keeps the call it named, whatever order they come in
  expect(resultIds(out)).toEqual(["b", "a"])
  expect(out.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["B", "A"])
})

test("a result with no call left to answer is carried as text, not sent as a tool turn", () => {
  const out = qoderMessages([{ role: "user", content: "hi" }, result("gone", "the words")])
  expect(out.filter((m) => m.role === "tool")).toHaveLength(0)
  expect(textOf(out)).toContain("the words")
})

test("a well-formed history is unchanged", () => {
  const msgs = [{ role: "user", content: "hi" }, call("c1"), result("c1", "done")]
  const out = qoderMessages(msgs)
  expect(callIds(out)).toEqual(["c1"])
  expect(resultIds(out)).toEqual(["c1"])
  expect(out.filter((m) => m.role === "tool")[0].content).toBe("done")
})

// #277's table, row 2: the call lost its id and the result names c1
test("#277: a call missing its id still gets the result naming c1", () => {
  const out = qoderMessages([{ role: "user", content: "hi" }, call(undefined), result("c1", "myhost")])
  expect(orphaned(out)).toEqual([])
  const tools = out.filter((m) => m.role === "tool")
  expect(tools.map((m) => m.content)).toEqual(["myhost"])
  expect(resultIds(out)).toEqual(callIds(out))
})

test("a result that lost its id doesn't take the call another result names", () => {
  const two = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
    ],
  }
  const out = qoderMessages([{ role: "user", content: "hi" }, two, result("lost", "B"), result("a", "A")])
  expect(orphaned(out)).toEqual([])
  expect(out.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content])).toEqual([["b", "B"], ["a", "A"]])
})

test("a result after the assistant's own words is carried as text", () => {
  const two = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
    ],
  }
  const out = qoderMessages([{ role: "user", content: "hi" }, two, result("a", "A"), { role: "assistant", content: "so far" }, result("b", "late")])
  // a tool turn must follow the turn with its call, not the assistant's words
  const at = out.findIndex((m) => m.role === "assistant" && !m.tool_calls)
  expect(out.slice(at + 1).filter((m) => m.role === "tool")).toHaveLength(0)
  expect(textOf(out)).toContain("late")
})
