// The OpenAI request's messages flattened into the one text the relay
// sends the web app (the inner request takes a single prompt string).
// The conversation history rides in the text: the app's own context
// window is the limit, and the relay's temporary chat (slot 45) keeps
// the account's history clean.
//
// Tool calling is prompt-injected with a fenced protocol (the way
// zexadev's messages.go does it, simplified): when the request carries
// `tools`, the flattened prompt opens with a system instruction that
// tells the model to answer tool requests inside a ```tool_call fence
// — a code block, never an execution — and renders past tool_calls and
// tool results back into that same fence so the model sees its own
// protocol.

// TOOL_SYSTEM is the instruction prepended when the request declares
// tools. The fence is a plain code block: the model is told explicitly
// that writing it does not run anything, and that several calls go in
// several blocks.
export const TOOL_SYSTEM = [
  "你可以调用工具。当需要调用工具时，只输出一个如下格式的代码块（可以输出多个，每个一次调用）：",
  "```tool_call",
  '{"name": "工具名", "arguments": {…}}',
  "```",
  "这个代码块只是声明要调用什么，不会真正执行。除工具调用外不要输出多余文字。收到工具结果（形如 [Tool result for …]）后再继续回答用户。",
].join("\n")

// renderToolCall puts one OpenAI tool_call back into the fence the
// model was taught, so its own past calls read as its own protocol.
export function renderToolCall(call) {
  const name = call?.function?.name ?? call?.id ?? ""
  let args = call?.function?.arguments ?? "{}"
  try {
    args = JSON.stringify(JSON.parse(args))
  } catch {
    // not JSON: keep the raw text inside the fence anyway
  }
  return "```tool_call\n" + JSON.stringify({ name, arguments: safeParse(args) }) + "\n```"
}

function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// flatten turns the OpenAI request (its `messages` array, or a body with
// one) into one prompt string. When `tools` is present the tool protocol
// is injected at the top.
export function flatten(bodyOrMessages, { tools } = {}) {
  const body = Array.isArray(bodyOrMessages) ? { messages: bodyOrMessages } : bodyOrMessages ?? {}
  const messages = body.messages
  const declared = tools ?? body.tools
  const lines = []
  if (Array.isArray(declared) && declared.length) lines.push(`[System]\n${TOOL_SYSTEM}`)
  for (const m of messages ?? []) {
    const role = m?.role ?? "user"
    const text = typeof m?.content === "string"
      ? m.content
      : Array.isArray(m?.content)
        ? m.content
            .map((c) => {
              if (typeof c === "string") return c
              if (typeof c?.text === "string") return c.text
              // a non-text part is not dropped on the floor: the model is
              // told it was there (this relay cannot carry images yet)
              if (c?.type === "image_url" || c?.image_url) return "[此消息带有一张图片：本中继暂不支持图片输入]"
              return ""
            })
            .filter(Boolean)
            .join("\n")
        : ""
    if (role === "system" || role === "developer") lines.push(`[System]\n${text}`)
    else if (role === "tool") lines.push(`[Tool result for ${m.tool_call_id ?? "call"}]\n${text}`)
    else if (role === "assistant") {
      const calls = Array.isArray(m?.tool_calls) ? m.tool_calls.map(renderToolCall).join("\n") : ""
      lines.push([text, calls].filter(Boolean).join("\n"))
    } else lines.push(text)
  }
  return lines.filter((l) => l.trim()).join("\n\n")
}

// lastUserText answers only the newest user message — the part a
// continued (server-side) conversation needs to send; the rest lives on
// the server. Images are not carried on this path, so they degrade to
// the same placeholder text flatten uses.
export function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content))
      return m.content
        .map((c) => {
          if (typeof c === "string") return c
          if (typeof c?.text === "string") return c.text
          if (c?.type === "image_url" || c?.image_url) return "[此消息带有一张图片：本中继暂不支持图片输入]"
          return ""
        })
        .filter(Boolean)
        .join("\n")
    return ""
  }
  return ""
}
