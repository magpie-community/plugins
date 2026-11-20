import { parseToolJSON } from "./anthropic-tools.mjs"

// Factory refuses a request whose tool list declares certain names, with a
// 403 content_policy_rejected, on every route (Anthropic Messages, OpenAI
// Responses and chat completions) and on both api.factory.ai and
// prem.factory.ai. Probed one tool at a time with an empty description: only
// the declared name decides, matched exactly and case-sensitively. A name
// that appears only in history (tool_use, function_call), in tool_choice or
// in text is not refused. The list moves: from 2026-11-17 22:30 PST it held
// Claude Code's, OpenCode's and Codex's names; from 2026-11-18 06:00 UTC it
// also holds the names first used in their place (BashTool, bash_tool, ...)
// and Claude Code's task tools, and no longer Codex's exec_command,
// write_stdin and Shell or NotebookEdit, EnterPlanMode, ExitPlanMode and
// get_weather. plugins#1291 also saw agent, Shell and StrReplace refused
// on 2026-11-18 07:04 UTC; they are kept, since a name renamed that Factory
// takes costs nothing and one missed refuses the whole request.
export const REFUSED_TOOL_NAMES = new Set([
  "Agent", "Bash", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "Write",
  "Shell", "StrReplace",
  "agent", "bash", "edit", "glob", "grep", "read", "run_shell", "task", "write",
  "AgentTool", "BashTool", "WriteTool", "bash_tool", "edit_tool", "read_tool", "write_tool",
  // measured on two real accounts on 2026-11-19 (can1357/oh-my-pi#19553):
  // web_search, read_file and execute_command too, and every name above
  // with leading underscores (_read, _web_search), while omp_read passes
  "web_search", "read_file", "execute_command",
])

// refusedName says whether Factory refuses a tool declared as name: one of
// the names above, or one of them behind leading underscores.
export function refusedName(name) {
  if (typeof name !== "string") return false
  return REFUSED_TOOL_NAMES.has(name) || REFUSED_TOOL_NAMES.has(name.replace(/^_+/, ""))
}

// TAKEN_NAMES are names Factory took as declared in the same probes (droid's
// own among them). A request renamed in full (aliasToolNames' every) keeps
// these, and mcp__ tools, as they are.
export const TAKEN_NAMES = new Set(["Read", "Edit", "Glob", "Grep", "Task", "WebSearch", "TodoWrite", "Execute", "Create"])

// DROID_NAMES is the tool of Factory's own client, droid, that does the
// same job, which Factory takes as declared: a refused tool goes out under
// it, unless the request already declares that name or another refused
// tool took it first.
export const DROID_NAMES = new Map([
  ["Bash", "Execute"], ["bash", "Execute"], ["run_shell", "Execute"], ["BashTool", "Execute"], ["bash_tool", "Execute"],
  ["Write", "Create"], ["write", "Create"], ["WriteTool", "Create"], ["write_tool", "Create"],
  ["Shell", "Execute"],
  ["Agent", "Task"], ["agent", "Task"], ["AgentTool", "Task"], ["task", "Task"],
  ["read", "Read"], ["read_tool", "Read"],
  ["edit", "Edit"], ["edit_tool", "Edit"],
  ["glob", "Glob"], ["grep", "Grep"],
  ["web_search", "WebSearch"], ["read_file", "Read"], ["execute_command", "Execute"],
])

// A refused tool droid has no name for (Claude Code's TaskCreate, ...), or
// one whose droid name is taken, goes out as its own name with a suffix
// drawn from this process (TaskCreate_3f9a): the same throughout the
// process, so a conversation reads one name and its prompt cache holds, but
// no fixed name a list could hold.
const SALT = crypto.randomUUID()
export function suffixed(name) {
  let h = 0x811c9dc5
  for (const c of SALT + "\0" + name) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
  return name + "_" + (h & 0xffff).toString(16).padStart(4, "0")
}

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
// later mention of it in the request, to a name it takes: droid's own for
// the job (Execute for Bash, Create for Write, ...), else a suffixed one,
// never one the request already declares. With every, it renames each
// declared tool but TAKEN_NAMES and mcp__ ones the same way: Factory's list
// keeps growing, and a request refused for a name not on ours yet goes once
// more so. It returns the body and the names to restore in the reply
// (alias → original). A body with nothing to rename goes on byte for byte.
export function aliasToolNames(body, every = false) {
  const aliases = new Map()
  const raw = text(body)
  if (raw == null) return { body, aliases }
  let request
  try { request = parseToolJSON(raw) } catch { return { body, aliases } }
  if (!isObject(request)) return { body, aliases }
  const decl = declared(request)
  const renames = (name) => refusedName(name) || (every && typeof name === "string" && !TAKEN_NAMES.has(name) && !name.startsWith("mcp__"))
  if (!decl.some(([h, k]) => renames(h[k]))) return { body, aliases }
  const taken = new Set(decl.map(([h, k]) => h[k]))
  const renamed = new Map()
  for (const [holder, key] of decl) {
    const name = holder[key]
    if (!renames(name)) continue
    if (!renamed.has(name)) {
      let alias = DROID_NAMES.get(name) ?? DROID_NAMES.get(name.replace(/^_+/, ""))
      if (alias == null || taken.has(alias)) alias = suffixed(name)
      while (taken.has(alias) || refusedName(alias)) alias += "_"
      taken.add(alias)
      renamed.set(name, alias)
      aliases.set(alias, name)
    }
    holder[key] = renamed.get(name)
  }
  for (const [holder, key] of uses(request)) if (renamed.has(holder[key])) holder[key] = renamed.get(holder[key])
  return { body: JSON.stringify(request), aliases }
}

// toolSet names the tools a request declares, in order, or "" when it
// declares none: a set refused until renamed in full is renamed in full
// from then on.
export function toolSet(body) {
  const raw = text(body)
  if (raw == null) return ""
  let request
  try { request = parseToolJSON(raw) } catch { return "" }
  if (!isObject(request)) return ""
  return declared(request).map(([h, k]) => String(h[k])).join("\n")
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
