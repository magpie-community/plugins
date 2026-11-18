import { parseToolJSON } from "./anthropic-tools.mjs"

// Factory refuses a request whose tool list declares certain names, with a
// 403 content_policy_rejected, on every route (Anthropic Messages, OpenAI
// Responses and chat completions) and on both api.factory.ai and
// prem.factory.ai. Seen from 2026-11-17 22:30 PST; before that the same
// Claude Code requests were answered. Probed one tool at a time with an
// empty description: only the declared name decides, matched exactly and
// case-sensitively (Read, Edit, shell, BashTool and bash_tool pass). A name
// that appears only in history (tool_use, function_call), in tool_choice or
// in text is not refused. These are Claude Code's, OpenCode's and Codex's
// names, plus the API documentation's get_weather.
export const REFUSED_TOOL_NAMES = new Set([
  "Agent", "Bash", "EnterPlanMode", "ExitPlanMode", "NotebookEdit", "Shell", "Write",
  "bash", "edit", "exec_command", "get_weather", "read", "write", "write_stdin",
])

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v)

function text(body) {
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8")
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
  return null
}

// declared lists every place a request declares a tool by name, as
// [holder, key] pairs: Anthropic's custom tools, OpenAI's function tools
// (Responses' flat ones and chat completions' nested ones) and Gemini's
// function declarations. Anthropic's server tools (a type other than
// custom) keep the names Anthropic gives them.
function declared(request) {
  const out = []
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    if (!isObject(tool)) continue
    if (tool.type === "function" && isObject(tool.function)) out.push([tool.function, "name"])
    else if (typeof tool.name === "string" && (tool.type == null || tool.type === "custom" || tool.type === "function")) out.push([tool, "name"])
    if (Array.isArray(tool.functionDeclarations)) for (const d of tool.functionDeclarations) if (isObject(d)) out.push([d, "name"])
  }
  return out
}

// uses lists where a request names a declared tool again: tool_choice,
// earlier calls in the history and Gemini's function responses and
// allowed names, so the model reads one name throughout.
function uses(request) {
  const out = []
  const choice = request.tool_choice
  if (isObject(choice)) {
    if (isObject(choice.function)) out.push([choice.function, "name"])
    else if (typeof choice.name === "string") out.push([choice, "name"])
    // Responses' allowed_tools lists tools as they are declared
    for (const t of Array.isArray(choice.tools) ? choice.tools : []) {
      if (isObject(t?.function)) out.push([t.function, "name"])
      else if (isObject(t) && typeof t.name === "string") out.push([t, "name"])
    }
  }
  for (const m of Array.isArray(request.messages) ? request.messages : []) {
    if (!isObject(m)) continue
    if (Array.isArray(m.content)) for (const b of m.content) if (isObject(b) && b.type === "tool_use") out.push([b, "name"])
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (isObject(c?.function)) out.push([c.function, "name"])
  }
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (isObject(item) && (item.type === "function_call" || item.type === "custom_tool_call")) out.push([item, "name"])
  }
  for (const c of Array.isArray(request.contents) ? request.contents : []) {
    for (const p of Array.isArray(c?.parts) ? c.parts : []) {
      if (isObject(p?.functionCall)) out.push([p.functionCall, "name"])
      if (isObject(p?.functionResponse)) out.push([p.functionResponse, "name"])
    }
  }
  const allowed = request.toolConfig?.functionCallingConfig?.allowedFunctionNames
  if (Array.isArray(allowed)) for (let i = 0; i < allowed.length; i++) out.push([allowed, i])
  return out
}

// aliasToolNames renames each declared tool Factory refuses, and every
// later mention of it in the request, to a name it takes: BashTool for
// Bash, bash_tool for bash, never one the request already declares. It
// returns the body and the names to restore in the reply (alias →
// original). A body with nothing to rename goes on byte for byte.
export function aliasToolNames(body) {
  const aliases = new Map()
  const raw = text(body)
  if (raw == null) return { body, aliases }
  let request
  try { request = parseToolJSON(raw) } catch { return { body, aliases } }
  if (!isObject(request)) return { body, aliases }
  const decl = declared(request)
  if (!decl.some(([h, k]) => REFUSED_TOOL_NAMES.has(h[k]))) return { body, aliases }
  const taken = new Set(decl.map(([h, k]) => h[k]))
  const renamed = new Map()
  for (const [holder, key] of decl) {
    const name = holder[key]
    if (!REFUSED_TOOL_NAMES.has(name)) continue
    if (!renamed.has(name)) {
      let alias = /^[A-Z]/.test(name) ? name + "Tool" : name + "_tool"
      while (taken.has(alias) || REFUSED_TOOL_NAMES.has(alias)) alias += "_"
      taken.add(alias)
      renamed.set(name, alias)
      aliases.set(alias, name)
    }
    holder[key] = renamed.get(name)
  }
  for (const [holder, key] of uses(request)) if (renamed.has(holder[key])) holder[key] = renamed.get(holder[key])
  return { body: JSON.stringify(request), aliases }
}

// restore puts the original names back wherever a reply names a tool: a
// "name" field holding an alias (Anthropic's tool_use, OpenAI's function
// calls in Responses and chat completions, Gemini's functionCall). A call's
// own arguments are the model's data and stay as they are, as they do in a
// stream, where they arrive as JSON text.
const ARGUMENTS = new Set(["input", "args", "arguments"])
function restore(value, aliases) {
  let changed = false
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (!isObject(v)) return
    for (const [k, x] of Object.entries(v)) {
      if (k === "name" && typeof x === "string" && aliases.has(x)) { v[k] = aliases.get(x); changed = true }
      else if (!ARGUMENTS.has(k)) walk(x)
    }
  }
  walk(value)
  return changed
}

function headersOf(res) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return { status: res.status, statusText: res.statusText, headers }
}

function eventStream(body, aliases) {
  const reader = body.getReader()
  // Bytes Factory sends that are not UTF-8 go on as U+FFFD rather than
  // failing the reply.
  const decoder = new TextDecoder("utf-8")
  const encoder = new TextEncoder()
  let pending = "", ended = false
  const frame = (raw) => {
    const lines = raw.split(/\r\n|\n|\r/)
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n")
    if (!data.includes("\"name\"")) return raw
    let event
    try { event = parseToolJSON(data) } catch { return raw }
    if (!restore(event, aliases)) return raw
    // the event's data lines become one; its other fields and ending stay
    const eol = /\r\n|\n|\r/.exec(raw)?.[0] ?? "\n"
    const ending = /(?:\r\n|\n|\r)+$/.exec(raw)?.[0] ?? ""
    const body = raw.slice(0, raw.length - ending.length).split(/\r\n|\n|\r/)
    let first = true
    const out = []
    for (const l of body) {
      if (!l.startsWith("data:")) out.push(l)
      else if (first) { out.push("data: " + JSON.stringify(event)); first = false }
    }
    return out.join(eol) + ending
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(pending)
          if (boundary || (ended && pending)) {
            const end = boundary ? boundary.index + boundary[0].length : pending.length
            const raw = pending.slice(0, end)
            pending = pending.slice(end)
            controller.enqueue(encoder.encode(frame(raw)))
            return
          }
          if (ended) { controller.close(); return }
          const chunk = await reader.read()
          pending += decoder.decode(chunk.value, { stream: !chunk.done })
          ended = chunk.done
        }
      } catch (e) {
        controller.error(e)
        await reader.cancel(e).catch(() => {})
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

// restoreToolNames gives the caller its own tool names back in Factory's
// reply, streamed or whole. Without aliases, or for a failed or bodiless
// reply, the response goes on untouched.
export async function restoreToolNames(res, aliases) {
  if (!aliases.size || !res.ok || !res.body) return res
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream")) return new Response(eventStream(res.body, aliases), headersOf(res))
  if (!type.includes("json")) return res
  const raw = await res.text()
  let value
  try { value = parseToolJSON(raw) } catch { return new Response(raw, headersOf(res)) }
  return new Response(restore(value, aliases) ? JSON.stringify(value) : raw, headersOf(res))
}
