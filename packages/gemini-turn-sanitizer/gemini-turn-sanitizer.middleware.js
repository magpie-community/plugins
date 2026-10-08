// Fix Google Gemini / Antigravity error:
// "Please ensure that function call turn comes immediately after a user turn or after a function response turn."
//
// Also ensures conversations begin with a user turn as required by Gemini's contents structure.
//
// Options:
//   {
//     "models": ["gemini", "antigravity"],   // optional prefix filter; empty array applies to all
//     "user_content": "Continue."            // prompt inserted for synthetic user turns
//   }

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return

  const o = ctx.options || {}
  if (Array.isArray(o.models) && o.models.length > 0) {
    const model = String(body.model ?? ctx.model ?? "")
    if (!o.models.some((m) => typeof m === "string" && model.toLowerCase().includes(m.toLowerCase()))) {
      return
    }
  }

  const prompt = typeof o.user_content === "string" && o.user_content ? o.user_content : "Continue."

  // 1. OpenAI Chat format & Anthropic Messages format (body.messages)
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return sanitizeChatMessages(body, prompt)
  }

  // 2. Native Gemini format (body.contents)
  if (Array.isArray(body.contents) && body.contents.length > 0) {
    return sanitizeGeminiContents(body, prompt)
  }
}

function sanitizeChatMessages(body, prompt) {
  const messages = body.messages
  const sanitized = []
  let changed = false
  let seenNonSystem = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || typeof msg !== "object") {
      sanitized.push(msg)
      continue
    }

    const role = msg.role
    const isSystem = role === "system" || role === "developer"
    const isAssistant = role === "assistant"

    // Check for tool calls (OpenAI tool_calls or Anthropic tool_use content blocks)
    const hasToolCalls = (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
      (Array.isArray(msg.content) && msg.content.some((b) => b && (b.type === "tool_use" || b.type === "function_call")))

    if (!isSystem) {
      // Rule 1: Conversation must open with a user turn (after optional system instructions)
      if (!seenNonSystem) {
        seenNonSystem = true
        if (isAssistant) {
          sanitized.push({
            role: "user",
            content: prompt,
          })
          changed = true
        }
      } else if (isAssistant && hasToolCalls) {
        // Rule 2: Assistant turn containing tool calls must immediately follow user or tool/function turn
        const prev = sanitized[sanitized.length - 1]
        const prevRole = prev ? prev.role : ""
        const isPrevToolResult = prevRole === "tool" || prevRole === "function" ||
          (prevRole === "user" && Array.isArray(prev.content) && prev.content.some((b) => b && b.type === "tool_result"))

        if (prevRole !== "user" && !isPrevToolResult) {
          sanitized.push({
            role: "user",
            content: prompt,
          })
          changed = true
        }
      }
    }

    sanitized.push(msg)
  }

  if (changed) {
    body.messages = sanitized
    return body
  }
}

function sanitizeGeminiContents(body, prompt) {
  const contents = body.contents
  const sanitized = []
  let changed = false

  for (let i = 0; i < contents.length; i++) {
    const entry = contents[i]
    if (!entry || typeof entry !== "object") {
      sanitized.push(entry)
      continue
    }

    const role = entry.role
    const isModel = role === "model"
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    const hasFunctionCall = parts.some((p) => p && (p.functionCall || p.function_call))

    if (sanitized.length === 0) {
      // First turn in Gemini contents must be a user turn
      if (isModel) {
        sanitized.push({
          role: "user",
          parts: [{ text: prompt }],
        })
        changed = true
      }
    } else if (isModel && hasFunctionCall) {
      const prev = sanitized[sanitized.length - 1]
      const prevRole = prev ? prev.role : ""
      const prevParts = prev && Array.isArray(prev.parts) ? prev.parts : []
      const isPrevFunctionResponse = prevParts.some((p) => p && (p.functionResponse || p.function_response))

      if (prevRole !== "user" && !isPrevFunctionResponse) {
        sanitized.push({
          role: "user",
          parts: [{ text: prompt }],
        })
        changed = true
      }
    }

    sanitized.push(entry)
  }

  if (changed) {
    body.contents = sanitized
    return body
  }
}
