// A streamed Chat Completions reply put together for a client that asked
// for one whole: two calls that share an upstream index but have their own
// ids are two calls, not one with {"a"}{"b"} arguments (plugins#930).
// Fragments with no id, or the same id, go on with the open call.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

async function whole(deltas) {
  const lines = [{ status: "started" }, ...deltas.map((delta) => ({ event: { id: "c1", object: "chat.completion.chunk", created: 1, model: "grok-4.7", choices: [{ index: 0, delta, finish_reason: null }] } })),
    { event: { id: "c1", object: "chat.completion.chunk", created: 1, model: "grok-4.7", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } }, { status: "stream_ended" }]
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions")
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "x-zed-server-supports-status-messages": "true" } })
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "grok-4.7", stream: false, messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
  })
  expect(res.status).toBe(200)
  return (await res.json()).choices[0].message.tool_calls.map((c) => [c.id, c.function.name, c.function.arguments])
}

const A = { index: 0, id: "call_fixture_A", type: "function", function: { name: "fixture_alpha", arguments: '{"key":"A"}' } }
const B = (index) => ({ index, id: "call_fixture_B", type: "function", function: { name: "fixture_beta", arguments: '{"key":"B"}' } })

test("two ids at one index are two calls", async () => {
  const calls = await whole([{ tool_calls: [A] }, { tool_calls: [B(0)] }])
  expect(calls).toEqual([["call_fixture_A", "fixture_alpha", '{"key":"A"}'], ["call_fixture_B", "fixture_beta", '{"key":"B"}']])
  for (const [, , args] of calls) expect(() => JSON.parse(args)).not.toThrow()
})

test("calls at their own indexes stay two calls", async () => {
  expect(await whole([{ tool_calls: [A] }, { tool_calls: [B(1)] }])).toEqual([
    ["call_fixture_A", "fixture_alpha", '{"key":"A"}'], ["call_fixture_B", "fixture_beta", '{"key":"B"}'],
  ])
})

test("fragments with no id, or the same id, go on with the open call", async () => {
  expect(await whole([
    { tool_calls: [{ index: 0, id: "call_fixture_A", type: "function", function: { name: "fixture_alpha", arguments: '{"ke' } }] },
    { tool_calls: [{ index: 0, function: { arguments: 'y":' } }] },
    { tool_calls: [{ index: 0, id: "call_fixture_A", function: { arguments: '"A"}' } }] },
  ])).toEqual([["call_fixture_A", "fixture_alpha", '{"key":"A"}']])
})
