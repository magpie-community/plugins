// #1213 (nanfei892): QwenWork's kimi-k3.1-pro answered 400 "Error in
// upstream response" (502 here) to every request whose history held a
// call-only assistant turn, content null or "", from the second turn of any
// agent on; one space served it, and other models took the empty turn.

import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, kimiModel } = _internal

const turns = (content) => [
  { role: "system", content: "you are a coding agent" },
  { role: "user", content: "read it" },
  { role: "assistant", content, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_1", content: "ok" },
]
const model = (key, name) => ({ key, name, config: { key, display_name: name } })
const callTurn = (body) => body.messages.find((x) => x.role === "assistant" && x.tool_calls)

test("a Kimi model's call-only turn carries text, for null and empty content", () => {
  for (const m of [model("kimi-k3.1-pro", "Kimi-K3.1-Pro"), model("kmodel", "Kimi-K2.8-Preview"), model("kmodel_latest", "Kimi-K3")])
    for (const content of [null, "", undefined]) {
      const turn = callTurn(qoderBody({ messages: turns(content) }, m))
      expect(turn.content).toBe(" ")
      expect(turn.tool_calls[0].id).toBe("call_1")
    }
})

test("a Kimi call turn that has text keeps it as written", () => {
  expect(callTurn(qoderBody({ messages: turns("reading it") }, model("kimi-k3.1-pro", "Kimi-K3.1-Pro"))).content).toBe("reading it")
})

test("other models get the call-only turn as written", () => {
  for (const m of [model("deepseek-flash", "DeepSeek-Flash"), model("glm-5.3", "GLM-5.3"), model("qwen4-max", "Qwen4-Max"), model("dfmodel", "DeepSeek")]) {
    expect(kimiModel(m)).toBe(false)
    expect(callTurn(qoderBody({ messages: turns(null) }, m)).content).toBe("")
  }
})
