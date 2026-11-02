// Zed's cloud parses an Anthropic request's context_management into its own
// enum (zed crates/anthropic), which has only compact_20260112, and needs
// edits. Claude Code sends clear_thinking_20251015, which Zed answered 400
// "unknown variant `clear_thinking_20251015`, expected `compact_20260112`"
// (nllay, #636). The plugin passes compaction on and leaves the rest out.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

// sent is the provider_request the plugin hands Zed for an Anthropic body.
async function sent(body) {
  let got
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions") {
      got = JSON.parse(init.body)
      const ev = (e) => JSON.stringify({ event: e })
      return new Response(
        [
          ev({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
          ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
          ev({ type: "message_stop" }),
          JSON.stringify({ status: "stream_ended" }),
        ].join("\n") + "\n",
        { headers: { "x-zed-server-supports-status-messages": "true" } },
      )
    }
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/messages", { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  await res.text()
  return got.provider_request
}

const body = (context_management) => ({
  model: "claude-sonnet-5",
  stream: true,
  max_tokens: 100,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  context_management,
})

const CLEAR_THINKING = { type: "clear_thinking_20251015", keep: "all" }
const CLEAR_TOOLS = { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 30000 } }
const COMPACT = { type: "compact_20260112", trigger: { type: "input_tokens", value: 100000 } }

test("Claude Code's clear-thinking edit alone leaves context_management out", async () => {
  expect("context_management" in (await sent(body({ edits: [CLEAR_THINKING] })))).toBe(false)
})

test("an edit Zed has no variant for is left out too", async () => {
  expect("context_management" in (await sent(body({ edits: [CLEAR_TOOLS] })))).toBe(false)
  expect("context_management" in (await sent(body({ edits: [CLEAR_THINKING, CLEAR_TOOLS] })))).toBe(false)
})

test("compaction goes on, alone, as it was written", async () => {
  expect((await sent(body({ edits: [CLEAR_THINKING, COMPACT, CLEAR_TOOLS] }))).context_management).toEqual({ edits: [COMPACT] })
  expect((await sent(body({ edits: [COMPACT] }))).context_management).toEqual({ edits: [COMPACT] })
})

test("edits that aren't a list of edits are left out, not thrown on", async () => {
  expect((await sent(body({ edits: [null, CLEAR_THINKING, COMPACT] }))).context_management).toEqual({ edits: [COMPACT] })
  for (const cm of [{ edits: "x" }, { edits: [] }, {}, null, "x"]) {
    expect("context_management" in (await sent(body(cm)))).toBe(false)
  }
})

test("a request without context_management is sent without one", async () => {
  const b = body()
  delete b.context_management
  expect("context_management" in (await sent(b))).toBe(false)
})
