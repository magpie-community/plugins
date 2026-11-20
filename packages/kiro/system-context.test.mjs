// #538 (zengxiaosong): in a Claude Code project session the plugin is sent
// [user, system], the system message being Claude Code's environment
// context, and both were joined into the message Kiro answers: the
// question, then the context. The context is now a turn of its own before
// the question, answered by Kiro IDE's placeholder ("Understood."), and the
// question is the message answered. Tool calls and their results are never
// parted for it.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const MODEL = "claude-opus-5.5"
const build = (req) => JSON.parse(_internal.buildKiro(req, MODEL, "", _internal.thinking(req, MODEL)))
const turns = (body) =>
  [...(body.conversationState.history ?? []), { userInputMessage: body.conversationState.currentMessage.userInputMessage }].map((e) =>
    e.userInputMessage ? ["user", e.userInputMessage.content] : ["assistant", e.assistantResponseMessage.content])

test("the reporter's [user, system] keeps the question as the message answered", () => {
  for (const effort of ["xhigh", "max"]) {
    // the repro in #538, as written
    const req = {
      model: MODEL, system: "SESSION_INSTRUCTIONS",
      thinking: { type: "adaptive" }, output_config: { effort },
      messages: [
        { role: "user", content: "USER_QUESTION" },
        { role: "system", content: "ENV_CONTEXT", output_config: { effort } },
      ],
    }
    expect(turns(build(req))).toEqual([
      ["user", "<thinking_mode>enabled</thinking_mode><max_thinking_length>12288</max_thinking_length>\nSESSION_INSTRUCTIONS\n\nENV_CONTEXT"],
      ["assistant", "Understood."],
      ["user", "USER_QUESTION"],
    ])
  }
})

test("context after a later question goes before that question only", () => {
  const req = {
    system: "S",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "system", content: [{ type: "text", text: "ENV_CONTEXT" }] },
    ],
  }
  expect(turns(build(req))).toEqual([
    ["user", "S\n\nfirst"],
    ["assistant", "answer"],
    ["user", "ENV_CONTEXT"],
    ["assistant", "Understood."],
    ["user", "second"],
  ])
  // a conversation not ending in a system message is as it was
  const plain = { messages: req.messages.slice(0, 3) }
  expect(_internal.contextFirst(plain.messages)).toBe(plain.messages)
})

test("context after tool results stays with them, every call answered as before", () => {
  const messages = [
    { role: "user", content: "list files" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
    { role: "system", content: "ENV_CONTEXT" },
  ]
  expect(_internal.contextFirst(messages)).toBe(messages)
  const body = build({ messages })
  const cur = body.conversationState.currentMessage.userInputMessage
  expect(cur.userInputMessageContext.toolResults).toEqual([{ toolUseId: "toolu_1", status: "success", content: [{ text: "a.txt" }] }])
  expect(cur.content).toBe("ENV_CONTEXT")
  expect(body.conversationState.history.at(-1).assistantResponseMessage.toolUses).toEqual([{ name: "Bash", toolUseId: "toolu_1", input: { command: "ls" } }])
  // a question right after calls (their results not sent) isn't moved either
  const unanswered = [...messages.slice(0, 2), { role: "user", content: "go on" }, { role: "system", content: "ENV_CONTEXT" }]
  expect(_internal.contextFirst(unanswered)).toBe(unanswered)
  // nor is an empty context
  const empty = [{ role: "user", content: "q" }, { role: "system", content: "" }]
  expect(_internal.contextFirst(empty)).toBe(empty)
})
