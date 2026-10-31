// slim, the turn guess, the patch and the secret check, on their own: pure
// functions, no hook, no network.
import { expect, test } from "bun:test"
import { aeliosProtocol, appendPatch, hasSecret, humanTurn, serverState, slim, spoken } from "./slim.mjs"

const big = (n) => "x".repeat(n)

// A Claude Code shaped request of about 80 KB: a long system prompt, many
// tools with schemas, file contents in tool results, thinking and an image.
function claudeCode() {
  const tools = Array.from({ length: 18 }, (_, i) => ({
    name: ["Bash", "Edit", "Read", "Write", "Grep", "Glob"][i % 6] + (i >= 6 ? i : ""),
    description: big(900),
    input_schema: { type: "object", properties: { a: { type: "string", description: big(300) } } },
  }))
  return {
    model: "claude-opus-4-5", stream: true, max_tokens: 32000,
    system: [{ type: "text", text: big(12000), cache_control: { type: "ephemeral" } }],
    tools,
    metadata: { user_id: "user_abc", session_id: "sess-1" },
    thinking: { type: "enabled", budget_tokens: 8000 },
    messages: [
      { role: "user", content: [{ type: "text", text: "<system-reminder>" + big(3000) + "</system-reminder>" }, { type: "text", text: "Please fix the login bug" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: big(4000), signature: big(400) },
        { type: "text", text: "Looking at it." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/src/login.ts" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big(20000) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Write", input: { file_path: "/src/big.ts", content: big(20000) } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: big(2000) }] }] },
      { role: "assistant", content: [{ type: "text", text: "Fixed." }] },
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: big(4000) } },
        { type: "text", text: "Thanks! Now the logout one.", cache_control: { type: "ephemeral" } },
      ] },
    ],
  }
}

test("protocols map to Aelios's names; gemini isn't supported", () => {
  expect(aeliosProtocol("anthropic")).toBe("messages")
  expect(aeliosProtocol("chat")).toBe("chat")
  expect(aeliosProtocol("responses")).toBe("responses")
  expect(aeliosProtocol("gemini")).toBeNull()
})

test("slim is pure: the same request gives the same bytes, and the input is untouched", () => {
  const body = claudeCode()
  const before = JSON.stringify(body)
  const a = JSON.stringify(slim(body, "messages"))
  const b = JSON.stringify(slim(structuredClone(body), "messages"))
  expect(a).toBe(b)
  expect(JSON.stringify(body)).toBe(before)
})

test("slim makes an 80 KB Claude Code request much smaller and keeps only what was said", () => {
  const body = claudeCode()
  const size = Buffer.byteLength(JSON.stringify(body))
  expect(size).toBeGreaterThan(75_000)
  const s = slim(body, "messages")
  const wire = JSON.stringify(s)
  expect(Buffer.byteLength(wire)).toBeLessThan(size / 5)
  expect(Object.keys(s).sort()).toEqual(["messages", "metadata", "tools"])
  expect(s.metadata).toEqual({ session_id: "sess-1" })
  expect(s.tools[0]).toEqual({ name: "Bash" })
  expect(wire).not.toContain("cache_control")
  expect(wire).not.toContain("thinking")
  expect(wire).not.toContain("signature")
  expect(s.messages[1].content).toEqual([{ type: "text", text: "Looking at it." }, { type: "tool_use", name: "Read", input: { file_path: "/src/login.ts" } }])
  expect(s.messages[2].content).toEqual([{ type: "tool_result", content: "" }])
  // a tool call over 16 KB keeps its name, not its arguments
  expect(s.messages[3].content).toEqual([{ type: "tool_use", name: "Write", input: {} }])
  expect(s.messages[6].content).toEqual([{ type: "text", text: "[image]" }, { type: "text", text: "Thanks! Now the logout one." }])
})

test("chat: system prompts and tool output go, tool calls and names stay", () => {
  const s = slim({
    model: "gpt", temperature: 0, tool_choice: "auto",
    tools: [{ type: "function", function: { name: "send_message", description: "d", parameters: {} } }],
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:x" } }] },
      { role: "assistant", content: null, reasoning_content: "hmm", tool_calls: [{ id: "c1", type: "function", function: { name: "send_message", arguments: "{\"to\":\"mum\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "sent ok" },
    ],
  }, "chat")
  expect(s).toEqual({
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "[image]" }] },
      { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "send_message", arguments: "{\"to\":\"mum\"}" } }] },
      { role: "tool", content: "" },
    ],
    tools: [{ type: "function", function: { name: "send_message" } }],
  })
})

test("responses: string input, items, reasoning dropped, outputs emptied, server state kept", () => {
  expect(slim({ instructions: "x", input: "hello", store: false }, "responses")).toEqual({ input: "hello" })
  const s = slim({
    instructions: "x", previous_response_id: "resp_1",
    tools: [{ type: "function", name: "shell", parameters: {} }, { type: "local_shell" }],
    input: [
      { type: "message", role: "developer", content: "dev" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }, { type: "input_image", image_url: "x" }] },
      { type: "reasoning", summary: [], encrypted_content: "zzz" },
      { type: "function_call", call_id: "c", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "c", output: "file list" },
      { type: "item_reference", id: "msg_1" },
    ],
  }, "responses")
  expect(s).toEqual({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }, { type: "text", text: "[image]" }] },
      { type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", output: "" },
      { type: "item_reference" },
    ],
    tools: [{ type: "function", name: "shell" }, { type: "local_shell" }],
    previous_response_id: "resp_1",
  })
  expect(serverState(s, "responses")).toBe(true)
  expect(serverState({ input: "hi" }, "responses")).toBe(false)
  expect(serverState({ messages: [], previous_response_id: "x" }, "messages")).toBe(false)
})

test("humanTurn: the user's own words, not a tool result or an envelope", () => {
  expect(humanTurn(slim(claudeCode(), "messages"), "messages")).toBe(true)
  const tool = { messages: [{ role: "user", content: [{ type: "tool_result", content: "" }] }] }
  expect(humanTurn(tool, "messages")).toBe(false)
  const toolWithReminder = { messages: [{ role: "user", content: [{ type: "tool_result", content: "" }, { type: "text", text: "<system-reminder>todo list changed</system-reminder>" }] }] }
  expect(humanTurn(toolWithReminder, "messages")).toBe(false)
  expect(humanTurn({ messages: [{ role: "assistant", content: "x" }] }, "messages")).toBe(false)
  expect(humanTurn({ messages: [{ role: "tool", content: "" }] }, "chat")).toBe(false)
  expect(humanTurn({ input: "hi" }, "responses")).toBe(true)
  expect(humanTurn({ input: [{ type: "function_call_output", output: "" }] }, "responses")).toBe(false)
  expect(humanTurn({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] }, "responses")).toBe(true)
  expect(humanTurn({ messages: [] }, "messages")).toBe(false)
})

test("appendPatch follows Aelios's appendMemory for each shape", () => {
  const str = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }
  expect(appendPatch(str, "messages", "MEM")).toBe(true)
  expect(str.messages[0].content).toBe("a")
  expect(str.messages[2].content).toBe("c\n\nMEM")

  const arr = { messages: [{ role: "user", content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }] }] }
  appendPatch(arr, "messages", "MEM")
  expect(arr.messages[0].content).toEqual([{ type: "text", text: "c", cache_control: { type: "ephemeral" } }, { type: "text", text: "MEM" }])

  const r1 = { input: "hi" }
  appendPatch(r1, "responses", "MEM")
  expect(r1.input).toBe("hi\n\nMEM")
  const r2 = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }
  appendPatch(r2, "responses", "MEM")
  expect(r2.input[0].content.at(-1)).toEqual({ type: "input_text", text: "MEM" })

  expect(appendPatch({ messages: [{ role: "assistant", content: "x" }] }, "chat", "MEM")).toBe(false)
  expect(appendPatch(str, "messages", "")).toBe(false)
})

test("hasSecret catches common credentials, not ordinary talk", () => {
  for (const s of ["my key is sk-abcdefghijklmnop", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz", "password=hunter2",
    "AIza" + "a".repeat(35), "xoxb-1234567890-abc", "-----BEGIN RSA PRIVATE KEY-----"]) expect(hasSecret(s)).toBe(true)
  expect(hasSecret({ input: { token: "abc123" } })).toBe(true)
  expect(hasSecret(slim(claudeCode(), "messages"))).toBe(false)
  expect(hasSecret("Let's talk about the weather tomorrow")).toBe(false)
})

test("spoken takes text and tool arguments from each reply shape", () => {
  expect(spoken({ content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }, { type: "tool_use", name: "x", input: { b: 1 } }] })).toEqual(["a", { b: 1 }])
  expect(spoken({ choices: [{ message: { content: "a", tool_calls: [{ function: { arguments: "{}" } }] } }] })).toEqual(["a", "{}"])
  expect(spoken({ output: [{ type: "message", content: [{ type: "output_text", text: "a" }] }, { type: "function_call", arguments: "{}" }] })).toEqual(["a", "{}"])
  expect(spoken(null)).toEqual([])
})
