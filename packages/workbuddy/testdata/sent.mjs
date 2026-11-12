// sentBy runs a few realistic chats through a WorkBuddy plugin module's
// loader and gives back every request it sent WorkBuddy, as the bytes on
// the wire read back (see unz), their encoding, and the ids derived from
// the chat. Every fetch is a fake. sent.test.mjs holds the result to what
// workbuddy 0.1.43 sent for the same chats (plugins#461); this runs any
// version's index.mjs, which is how those hashes were made.
import { createHash } from "node:crypto"
import { unz } from "./unz.mjs"

const CONFIG = {
  code: 0,
  data: {
    agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "hy3", "gemini-sent-461", "glm-5.2"] }],
    models: [
      { id: "deepseek-v4.1-flash", credits: "x0.00", supportsReasoning: true, onlyReasoning: true,
        reasoning: { canDisableThinking: true, defaultEffort: "high", supportedEfforts: ["low", "high", "max"] } },
      { id: "hy3", credits: "x0.00" },
      { id: "gemini-sent-461", credits: "x0.00" },
      { id: "glm-5.2", credits: "x0.79", supportsReasoning: true, reasoning: { defaultEffort: "xhigh", supportedEfforts: ["high", "xhigh"] } },
    ],
  },
}

const AFTER_TOOLS = JSON.stringify({ error: { message: "the conversation must end with a user message", code: 11153 } })
const REFUSAL = JSON.stringify({ error: { message: "unapproved channel", code: 14018 } })

// what an agent sends: OpenCode's tool names and schemas, a tool turn, an
// earlier turn's reasoning, an image, a long system prompt
const SYSTEM = "You are opencode, an interactive CLI tool.\n".repeat(40)
const TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: ["number", "null"] } }, required: ["filePath"] } } },
  { type: "function", function: { name: "github.create_issue", description: "MCP", parameters: { type: "object", properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } } } } },
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } },
]
const call = { role: "assistant", content: "", reasoning_content: "I should list them.", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] }
const result = { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt\n中文.md 🙂" }
const image = { type: "image_url", image_url: { url: "data:image/png;base64," + Buffer.from("not really a png").toString("base64") } }

export const CHATS = [
  // as an agent spaced it, nothing to change: goes byte for byte
  ["plain", "https://www.workbuddy.ai/v2/chat/completions", `{"model": "hy3",  "stream": true, "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}], "reasoning_effort": "low"}`],
  ["opencode tools", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, stream_options: { include_usage: true }, max_tokens: 32000, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "List the files." }, call, result, { role: "user", content: [{ type: "text", text: "and this" }, image] }], tools: TOOLS, tool_choice: "auto" })],
  ["default effort", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi 🙂" }], tools: TOOLS, tool_choice: { type: "function", function: { name: "github.create_issue" } } })],
  ["developer, no system", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "glm-5.2", messages: [{ role: "developer", content: "d" }, { role: "user", content: "x" }], max_completion_tokens: 9, reasoning: { effort: "high" } })],
  // gemini answers 11153 to tools then the user: the reply goes between
  // them, and the next chat has it up front
  ["after tools, refused", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "gemini-sent-461", stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "List the files." }, call, result, { role: "user", content: "now" }], tools: TOOLS })],
  ["after tools, known", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "gemini-sent-461", stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "List the files." }, call, result, { role: "user", content: [{ type: "text", text: "<system-reminder>r</system-reminder>" }] }, { role: "user", content: "now" }], tools: TOOLS })],
  // a system prompt refused once goes as the user's words, at once next time
  ["system refused", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "hy3", messages: [{ role: "system", content: "REFUSE-461 " + SYSTEM }, { role: "user", content: "hi" }] })],
  ["system known refused", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "hy3", messages: [{ role: "system", content: "REFUSE-461 " + SYSTEM }, { role: "user", content: "hi again" }], tools: TOOLS })],
  ["both", "https://www.workbuddy.ai/v2/chat/completions", JSON.stringify({ model: "gemini-sent-461", messages: [{ role: "system", content: "REFUSE-461 " + SYSTEM }, { role: "user", content: "go" }, call, result, { role: "system", content: "late" }, { role: "user", content: "now" }] })],
  // a Claude model on Messages goes as it came but for unsigned thinking
  ["messages", "https://www.workbuddy.ai/v1/messages", JSON.stringify({ model: "claude-opus-5.5", max_tokens: 64, system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }] }, { role: "user", content: "q2" }] })],
  ["bytes", "https://www.workbuddy.ai/v2/chat/completions", new TextEncoder().encode(JSON.stringify({ model: "hy3", messages: [{ role: "user", content: "bytes ü" }], tools: TOOLS }))],
  ["not json", "https://www.workbuddy.ai/v2/chat/completions", "{not json"],
]

// GROWN is the extra_vars a WorkBuddy AI chat is sent with (withGrowth),
// set before the body's closing brace
const GROWN = /,"extra_vars":(\{"growthEvent":"(?:[^"\\]|\\.)*","initiator":"user"\})(?=\}\s*$)/

const sha = (s) => createHash("sha256").update(s ?? "").digest("hex")

// sentBy(mod, freeOnly) is what mod's WorkBuddy AI plugin sent for CHATS,
// with the "Free models only" switch on or off
export async function sentBy(mod, freeOnly = false) {
  const real = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith("/v3/config")) return Response.json(CONFIG)
    const h = new Headers(init?.headers)
    const text = unz(init?.body)
    let s = typeof text === "string" ? text : new TextDecoder().decode(text)
    // the growth event a WorkBuddy AI chat carries since 0.2.31 (#691) is
    // set as the body's last field; what is left is held to 0.1.43's bytes,
    // and the event to the conversation the request went as
    const grown = GROWN.exec(s)
    const row = { url: u, encoding: h.get("content-encoding"), body: "", conversation: h.get("x-conversation-id"), turn: h.get("x-conversation-request-id") }
    if (grown) {
      s = s.slice(0, grown.index) + s.slice(grown.index + grown[0].length)
      const ev = JSON.parse(JSON.parse(grown[1]).growthEvent)
      if (ev.length !== 1 || ev[0].eventCode !== "chat_request_send" || ev[0].id !== row.conversation) row.growth = ev
    }
    row.body = sha(s)
    sent.push(row)
    if (s.includes("REFUSE-461") && s.includes('"role":"system","content":"REFUSE-461')) return new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
    if (s.includes('"gemini-sent-461"')) {
      const m = JSON.parse(s).messages
      let i = m.length - 1
      while (i >= 0 && m[i].role === "user") i--
      if (i < m.length - 1 && m[i]?.role === "tool") return new Response(AFTER_TOOLS, { status: 400, headers: { "content-type": "application/json" } })
    }
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const hooks = await mod.WorkBuddyAIAuthPlugin({ client: { auth: { set: async () => {} } }, magpie: { option: (_p, k) => freeOnly && k === "free_only" } })
    const auth = { type: "oauth", access: "test-only", refresh: "test-only", uid: "u", expires: Date.now() + 3600000 }
    const loader = await hooks.auth.loader(async () => auth)
    const out = []
    for (const [label, url, body] of CHATS) {
      const from = sent.length
      const res = await loader.fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } })
      await res.text()
      out.push({ label, status: res.status, sent: sent.slice(from) })
    }
    return canonical(out)
  } finally {
    globalThis.fetch = real
  }
}

// canonical names each derived id by where it first showed up, as the ids
// are salted afresh in each process: what stays is which requests share one
function canonical(out) {
  const seen = new Map()
  const name = (id) => {
    if (id == null) return null
    if (!seen.has(id)) seen.set(id, `id${seen.size}`)
    return seen.get(id)
  }
  for (const o of out) for (const s of o.sent) {
    s.conversation = name(s.conversation)
    s.turn = name(s.turn)
  }
  return out
}
