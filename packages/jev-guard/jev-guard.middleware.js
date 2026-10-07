// Jev System One Quality and Safety Guardrail for Magpie Gateway
// Intercepts dangerous instruction patterns and guards outgoing requests.

export function onRequest(body, ctx) {
  const text = getUserText(body, ctx.protocol)
  if (!text) return

  const options = ctx.options || {}
  const patterns = Array.isArray(options.blocked_patterns) ? options.blocked_patterns : []
  const rejectMsg = options.reject_message || "Jev Gate: High-risk instruction pattern blocked."

  for (const p of patterns) {
    if (typeof p === "string" && p && text.includes(p)) {
      ctx.reject(403, rejectMsg)
      return
    }
  }
}

export function onResponse(body, ctx) {
  // Post-flight inspection hook
  if (ctx.status >= 400) return
}

function getUserText(body, protocol) {
  if (!body) return ""
  if (protocol === "responses") {
    if (typeof body.input === "string") return body.input
    if (Array.isArray(body.input)) {
      const u = body.input.find((m) => m && m.role === "user")
      if (u) return typeof u.content === "string" ? u.content : ""
    }
  } else {
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i]
        if (m && m.role === "user") {
          if (typeof m.content === "string") return m.content
        }
      }
    }
  }
  return ""
}
