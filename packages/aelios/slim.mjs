// What the Aelios hook sends and how it puts recalled memory back, kept apart
// from the hook so it can be tested on its own. Everything here is a pure
// function of its input: the same request always slims to the same bytes,
// which is what lets Aelios hash a turn to the same exchange id at recall
// time and again at record time.

// magpie's protocol names, as Aelios calls them. Gemini is not supported yet.
const protocols = { anthropic: "messages", chat: "chat", responses: "responses" }
export function aeliosProtocol(protocol) {
  return protocols[protocol] ?? null
}

// A single tool call's arguments above this are dropped (kept as an empty
// object), so one large file write doesn't make the request large.
const maxToolInput = 16 << 10
const placeholders = {
  image: "[image]", image_url: "[image]", input_image: "[image]",
  document: "[file]", file: "[file]", input_file: "[file]",
  audio: "[audio]", input_audio: "[audio]",
}
const thinking = new Set(["thinking", "redacted_thinking", "reasoning"])

const object = (v) => !!v && typeof v === "object" && !Array.isArray(v)
const isText = (p) => object(p) && ["text", "input_text", "output_text"].includes(p.type) && typeof p.text === "string"

function capObject(value) {
  if (value === undefined) return undefined
  let size
  try { size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") } catch { return {} }
  return size > maxToolInput ? {} : value
}
function capString(value) {
  if (typeof value !== "string") return capObject(value)
  return Buffer.byteLength(value, "utf8") > maxToolInput ? "{}" : value
}

// One content block of a message, or undefined to drop it.
function block(p) {
  if (!object(p)) return undefined
  if (isText(p)) return { type: p.type, text: p.text }
  if (thinking.has(p.type)) return undefined
  if (placeholders[p.type]) return { type: "text", text: placeholders[p.type] }
  if (p.type === "tool_use" || p.type === "server_tool_use") {
    const out = { type: p.type }
    if (typeof p.name === "string") out.name = p.name
    out.input = capObject(p.input) ?? {}
    return out
  }
  // tool_result, mcp_tool_result, web_search_tool_result, …: the structure
  // stays, what the tool returned does not
  if (typeof p.type === "string" && /(^|_)tool_result$/.test(p.type)) return { type: p.type, content: "" }
  return undefined
}

function content(c) {
  if (typeof c === "string") return c
  if (!Array.isArray(c)) return ""
  return c.map(block).filter(Boolean)
}

function messagesItem(m) {
  if (!object(m) || typeof m.role !== "string") return undefined
  return { role: m.role, content: content(m.content) }
}

function chatItem(m) {
  if (!object(m) || typeof m.role !== "string") return undefined
  // system prompts are not what anyone said in the conversation
  if (m.role === "system" || m.role === "developer") return undefined
  if (m.role === "tool") return { role: "tool", content: "" }
  const out = { role: m.role, content: content(m.content) }
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.filter(object).map((t) => ({
      type: typeof t.type === "string" ? t.type : "function",
      function: { name: typeof t.function?.name === "string" ? t.function.name : "", arguments: capString(t.function?.arguments ?? "") },
    }))
  }
  return out
}

function responsesItem(item) {
  if (!object(item)) return undefined
  const type = typeof item.type === "string" ? item.type : undefined
  if (type === "reasoning") return undefined
  if (!type || type === "message" || type === "input_message") {
    if (typeof item.role !== "string" || item.role === "system" || item.role === "developer") return undefined
    const out = {}
    if (type) out.type = type
    out.role = item.role
    out.content = content(item.content)
    return out
  }
  if (type === "function_call") {
    return { type, name: typeof item.name === "string" ? item.name : "", arguments: capString(item.arguments ?? "") }
  }
  if (type === "custom_tool_call") {
    const input = typeof item.input === "string" && Buffer.byteLength(item.input, "utf8") > maxToolInput ? "" : item.input ?? ""
    return { type, name: typeof item.name === "string" ? item.name : "", input }
  }
  if (/_output$/.test(type)) return { type, output: "" }
  // other items (item_reference, local_shell_call, web_search_call, …)
  // keep only what kind they are
  return { type }
}

function tool(t, protocol) {
  if (!object(t)) return undefined
  if (protocol === "chat") {
    const out = {}
    if (typeof t.type === "string") out.type = t.type
    out.function = { name: typeof t.function?.name === "string" ? t.function.name : typeof t.name === "string" ? t.name : "" }
    return out
  }
  const out = {}
  // Responses' built-in tools (local_shell, apply_patch) have a type and no name
  if (protocol === "responses" && typeof t.type === "string") out.type = t.type
  if (typeof t.name === "string") out.name = t.name
  return Object.keys(out).length ? out : undefined
}

// slim keeps what was said: roles, text, tool names and the arguments of
// tool calls (Aelios records "speech" tools, such as sending a message, from
// them). Tool results become empty, attachments become placeholders,
// thinking goes, and so do system prompts and everything at the top level
// but the messages, the tool names, the session id and whether a Responses
// request continues server-side state.
export function slim(body, protocol) {
  const src = object(body) ? body : {}
  const out = {}
  if (protocol === "responses") {
    if (typeof src.input === "string") out.input = src.input
    else out.input = (Array.isArray(src.input) ? src.input : []).map(responsesItem).filter(Boolean)
  } else {
    const item = protocol === "chat" ? chatItem : messagesItem
    out.messages = (Array.isArray(src.messages) ? src.messages : []).map(item).filter(Boolean)
  }
  if (Array.isArray(src.tools)) out.tools = src.tools.map((t) => tool(t, protocol)).filter(Boolean)
  if (typeof src.metadata?.session_id === "string") out.metadata = { session_id: src.metadata.session_id }
  if (protocol === "responses") {
    if (typeof src.previous_response_id === "string" && src.previous_response_id) out.previous_response_id = src.previous_response_id
    if (src.conversation !== undefined && src.conversation !== null) out.conversation = typeof src.conversation === "string" ? src.conversation : true
  }
  return out
}

export function items(body, protocol) {
  if (protocol === "responses") return typeof body.input === "string" ? [{ role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : []
  return Array.isArray(body.messages) ? body.messages : []
}

// A Responses request that continues state kept on the provider's side:
// Aelios can't see that history, so it neither recalls nor records it.
export function serverState(body, protocol) {
  return protocol === "responses" && !!(body.previous_response_id || body.conversation ||
    items(body, protocol).some((i) => object(i) && i.type === "item_reference"))
}

function visible(c) {
  if (typeof c === "string") return c
  if (!Array.isArray(c)) return ""
  return c.filter(isText).map((p) => p.text).join("\n")
}
// Client envelopes (<system-reminder>, <environment_context>, …) are not the
// person talking.
const envelope = /<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi

// humanTurn is a local first guess at Aelios's classifyTurn on a slimmed
// body: the last item is the user's, with text of their own, and not just a
// tool result. Aelios decides in the end; this only saves a request for
// every tool step.
export function humanTurn(slimmed, protocol) {
  const list = items(slimmed, protocol)
  const last = list.at(-1)
  if (!object(last) || last.role !== "user") return false
  if (last.type && !["message", "input_message"].includes(last.type)) return false
  const text = visible(last.content).replace(envelope, "").trim()
  if (!text) return false
  return true
}

// appendPatch adds the recalled memory after the last user message, the
// way Aelios's own gateway does (appendMemory): a string grows by two
// newlines and the patch, an array gets one more text block. Earlier
// messages and every cache_control marker are left as they are.
export function appendPatch(body, protocol, patch) {
  if (!patch) return false
  if (protocol === "responses" && typeof body.input === "string") {
    body.input += `\n\n${patch}`
    return true
  }
  const list = items(body, protocol)
  const last = list.at(-1)
  if (!object(last) || last.role !== "user") return false
  if (typeof last.content === "string") last.content += `\n\n${patch}`
  else if (Array.isArray(last.content) || last.content === undefined) last.content = [...(last.content ?? []), { type: protocol === "responses" ? "input_text" : "text", text: patch }]
  else return false
  return true
}

// What the assistant said in a reply (each protocol's non-streaming shape):
// its text and the arguments of its tool calls, for the secret check.
export function spoken(reply) {
  const out = []
  if (!object(reply)) return out
  const take = (v) => { if (typeof v === "string") out.push(v); else if (v !== undefined) out.push(v) }
  for (const p of Array.isArray(reply.content) ? reply.content : []) {
    if (isText(p)) take(p.text)
    else if (object(p) && p.type === "tool_use") take(p.input)
  }
  for (const c of Array.isArray(reply.choices) ? reply.choices : []) {
    const m = c?.message
    if (!object(m)) continue
    take(typeof m.content === "string" ? m.content : visible(m.content))
    for (const t of Array.isArray(m.tool_calls) ? m.tool_calls : []) take(t?.function?.arguments)
  }
  for (const item of Array.isArray(reply.output) ? reply.output : []) {
    if (!object(item)) continue
    if (item.type === "message") take(visible(item.content))
    else if (item.type === "function_call") take(item.arguments)
    else if (item.type === "custom_tool_call") take(item.input)
  }
  return out
}

// A turn that looks like it holds a credential is not recorded at all
// (masking part of it could still leave the rest on the server). The same
// patterns PowerContext's hook checks.
const secret = /(?:(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|token|authorization|[A-Za-z0-9]*(?:password|passwd|pwd)|secret|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*\S+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@|\b(?:sk|rk)_live_[A-Za-z0-9]{8,}|\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [^-]*PRIVATE KEY-----)/iu
export function hasSecret(value) {
  if (typeof value === "string") {
    if (secret.test(value)) return true
    if (/^\s*[[{]/u.test(value)) {
      try { return hasSecret(JSON.parse(value)) } catch { /* plain text */ }
    }
    return false
  }
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, item]) => secret.test(`${key}: ${typeof item === "string" ? item : "[value]"}`) || hasSecret(item))
}
