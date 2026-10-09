import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

test("a plain Codex task reaches Grok as a user message without requiring tools", () => {
  const task = {
    type: "agent_message", author: "/root", recipient: "/root/research",
    content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nresearch the failure" }],
  }
  const sent = JSON.parse(_internal.rewrite(JSON.stringify({ input: [task] })))
  expect(sent.input).toEqual([{
    type: "message", role: "user",
    content: [{ type: "input_text", text: "From /root to /root/research\n\n" }, ...task.content],
  }])
})

test("a subagent's reply keeps its sender, recipient, position and multimodal parts", () => {
  const before = { type: "function_call", call_id: "call_1", name: "send_message", arguments: "{}" }
  const after = { type: "function_call_output", call_id: "call_1", output: "sent" }
  const reply = { type: "agent_message", author: "/root/research", recipient: "/root", content: [
    { type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\nfound the cause" },
    { type: "input_image", image_url: "data:image/png;base64,fixture" },
  ] }
  const sent = JSON.parse(_internal.rewrite(JSON.stringify({ tools: [], input: [before, reply, after] })))
  expect(sent.input).toEqual([before, {
    type: "message", role: "user",
    content: [{ type: "input_text", text: "From /root/research to /root\n\n" }, ...reply.content],
  }, after])
})

test("a sealed or malformed agent message is never converted or dropped", () => {
  for (const item of [
    { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "sealed fixture" }] },
    { type: "agent_message", content: [{ type: "input_text", text: "header" }, { type: "encrypted_content", encrypted_content: "sealed fixture" }] },
    { type: "agent_message", content: [{ type: "input_text", encrypted_content: "sealed fixture" }] },
    { type: "agent_message", encrypted_content: "sealed fixture", content: [{ type: "input_text", text: "header" }] },
    { type: "agent_message", content: [{ type: "future_content", payload: "keep me" }] },
    { type: "agent_message", content: [] },
    { type: "agent_message", content: null },
  ]) {
    const body = JSON.stringify({ input: [item] })
    expect(_internal.rewrite(body)).toBe(body)
  }
})

test("ordinary Responses histories stay byte-for-byte unchanged", () => {
  const body = '{ "input": [{"type":"message","role":"user","content":"hello"}] }'
  expect(_internal.rewrite(body)).toBe(body)
})
