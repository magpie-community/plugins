// The OpenAI request's messages flattened into the one text the relay
// sends the web app (StreamGenerate's inner[0] takes a single prompt
// string). The conversation history rides in the text: the app's own
// context window is the limit, and the relay's temporary chat (slot 45)
// keeps the account's history clean.
//
// Same shape as quick's flatten: system lines first, each exchange in
// order, tool calls named and their results inlined (they are context,
// not executable here).

// flatten turns the OpenAI request (its `messages` array) into one
// prompt string
export function flatten(bodyOrMessages) {
  const messages = Array.isArray(bodyOrMessages) ? bodyOrMessages : bodyOrMessages?.messages
  const lines = []
  for (const m of messages ?? []) {
    const role = m?.role ?? "user"
    const text = typeof m?.content === "string"
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n")
        : ""
    if (role === "system" || role === "developer") lines.push(`[System]\n${text}`)
    else if (role === "tool") lines.push(`[Tool result for ${m.tool_call_id ?? "call"}]\n${text}`)
    else if (role === "assistant") {
      const calls = Array.isArray(m?.tool_calls)
        ? m.tool_calls.map((c) => `[Tool call ${c?.function?.name ?? c?.id ?? ""}] ${c?.function?.arguments ?? ""}`).join("\n")
        : ""
      lines.push([text, calls].filter(Boolean).join("\n"))
    } else lines.push(text)
  }
  return lines.filter((l) => l.trim()).join("\n\n")
}
