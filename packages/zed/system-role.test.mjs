// Claude Code puts {role: "system"} messages inside an Anthropic request's
// messages (a turn's effort, its hooks' notices after tool results). Zed's
// cloud takes only user and assistant there: 400 "failed to parse Anthropic
// request: unknown variant `system`, expected `user` or `assistant`" (Roy on
// Discord). The plugin sends their text in a user turn, where it was said.
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
  await res.text()
  return got.provider_request
}

const roles = (r) => r.messages.map((m) => m.role)
const SYSTEM = [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }]
const NOTICE = "PostToolUse:Read hook additional context: the file is generated"

test("a hook notice after tool results joins their user turn, after the results", async () => {
  const r = await sent({
    model: "claude-sonnet-5",
    stream: true,
    max_tokens: 100,
    system: SYSTEM,
    messages: [
      { role: "user", content: "read a.go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.go" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "package a" }] },
      { role: "system", content: NOTICE },
    ],
  })
  expect(roles(r)).toEqual(["user", "assistant", "user"])
  expect(r.messages[2].content).toEqual([
    { type: "tool_result", tool_use_id: "t1", content: "package a", is_error: false },
    { type: "text", text: NOTICE },
  ])
  // the top-level system, the cache's prefix, is as the agent sent it
  expect(r.system).toEqual(SYSTEM)
})

test("an empty system message that only carries a turn's effort is left out", async () => {
  const r = await sent({
    model: "claude-sonnet-5",
    stream: true,
    max_tokens: 100,
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [], output_config: { effort: "low" } },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ],
  })
  expect(r.messages).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ])
  expect(r.output_config).toEqual({ effort: "high" })
})

test("system text before a user turn goes after its tool results, and one after an assistant turn is a user turn", async () => {
  const r = await sent({
    model: "claude-sonnet-5",
    stream: true,
    max_tokens: 100,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "system", content: [{ type: "text", text: "The user sent a new message while you were working:\nstop", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.go", is_error: false }, { type: "text", text: "<total_tokens>9</total_tokens>" }] },
      { role: "assistant", content: "Stopping." },
      { role: "system", content: NOTICE },
    ],
  })
  expect(roles(r)).toEqual(["user", "assistant", "user", "assistant", "user"])
  expect(r.messages[2].content).toEqual([
    { type: "tool_result", tool_use_id: "t1", content: "a.go", is_error: false },
    { type: "text", text: "The user sent a new message while you were working:\nstop", cache_control: { type: "ephemeral" } },
    { type: "text", text: "<total_tokens>9</total_tokens>" },
  ])
  expect(r.messages[4]).toEqual({ role: "user", content: [{ type: "text", text: NOTICE }] })
})
