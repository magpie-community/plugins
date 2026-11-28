// The Gemini web app takes one message, not a chat request. To serve a
// client's chat request through it, the whole request
// (system prompt, tools, every turn) is written into one message, and the
// client's tools are asked for as text: <tool_call>{json}</tool_call>
// blocks, which are read back into OpenAI tool_calls.

const OPEN = "<tool_call>"
const CLOSE = "</tool_call>"

function partText(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return typeof content === "object" ? JSON.stringify(content) : String(content)
  return content
    .map((p) => {
      if (typeof p === "string") return p
      if (p?.type === "text" || p?.type === "input_text") return p.text ?? ""
      if (p?.type === "image_url" || p?.type === "input_image" || p?.type === "image") return "[image omitted: only text reaches this model]"
      if (p?.type === "file" || p?.type === "input_file") return "[file omitted: only text reaches this model]"
      return p?.text ?? ""
    })
    .join("")
}

function toolLine(t) {
  const f = t?.function ?? t
  if (!f?.name) return null
  const desc = String(f.description ?? "").trim()
  const params = f.parameters ? JSON.stringify(f.parameters) : "{}"
  return `## ${f.name}\n${desc ? desc + "\n" : ""}Arguments (JSON Schema): ${params}`
}

function callText(c) {
  const f = c?.function ?? c
  let args = f?.arguments ?? {}
  if (typeof args === "string") {
    try { args = JSON.parse(args || "{}") } catch {}
  }
  return OPEN + JSON.stringify({ name: f?.name, arguments: args }) + CLOSE
}

// toolNames 可以是字符串数组，或 {name, parameters?} 对象数组（带 schema
// 时，空工具名的调用可以按参数键唯一匹配补名）。namesOf 统一取出名字。
const namesOf = (toolNames) =>
  Array.isArray(toolNames) ? toolNames.map((t) => (typeof t === "string" ? t : t?.name ?? t?.function?.name)).filter((n) => typeof n === "string" && n) : []

// normalizeName 把模型写的工具名对到客户端声明的那个上：大小写与
// 标点不敏感（Read → read），`functions.` / `tools.` 前缀剥掉；对不上
// 返回 null（没声明工具时一律 null）。
export function normalizeName(name, toolNames) {
  const n = String(name ?? "").trim().replace(/^(functions|tools)\./, "")
  const names = namesOf(toolNames)
  if (!names.length) return null
  const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "")
  return names.find((t) => key(t) === key(n)) ?? null
}

// matchByArgs：工具名为空、但参数对象的键恰好是某一个声明工具 schema
// 的属性子集且只有它一个匹配 → 返回那个工具名；0 个或多个匹配都返回
// null（不猜）。glm-5.3-flash 在长提示下会写出 "name": "" 但参数正确。
function matchByArgs(args, toolNames) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  const keys = Object.keys(args)
  if (!keys.length) return null
  const hits = []
  for (const t of Array.isArray(toolNames) ? toolNames : []) {
    const name = typeof t === "string" ? t : t?.name ?? t?.function?.name
    const props = (typeof t === "object" ? t?.parameters ?? t?.function?.parameters : null)?.properties
    if (!name || !props || typeof props !== "object") continue
    if (keys.every((k) => k in props)) hits.push(name)
  }
  return hits.length === 1 ? hits[0] : null
}

// choice reads tool_choice into what the prompt asks of the model.
function choice(body, names) {
  const c = body.tool_choice
  if (c === "none") return { off: true }
  if (c === "required") return { must: true }
  const name = c?.function?.name ?? c?.name
  const only = normalizeName(name, names)
  if (only) return { must: true, only }
  return {}
}

// splitStatus 把 pi 的 bash/powershell 工具追加在结果末尾的状态行提出来：
// 「Command exited with code N」「Command timed out after N seconds[. The
// shell exited with code K after …]」「Command aborted」。OpenAI 的 tool
// 消息不带 isError，模型此前只看到裸输出，把「python 是 Windows 商店假
// shim（exit 9009）」当成引号写错重试了两次（2026-11-28 真机）。只认末尾
// 那一行，正文里同句式不算；超时那句的后半解释留在正文里。返回 null
// 表示没有状态行。
const STATUS_TAIL = /\n?\s*Command (exited with code (-?\d+)|timed out after (\d+) seconds(\.[^\n]*)?|aborted)\s*$/
export function splitStatus(content) {
  const text = String(content ?? "")
  const m = STATUS_TAIL.exec(text)
  if (!m) return null
  const body = text.slice(0, m.index).replace(/\s+$/, "")
  const status = m[2] ? `exit code ${m[2]}` : m[3] ? `timed out after ${m[3]} seconds` : "aborted"
  // 超时句后半（「The shell exited with code 1 after …」）是解释，留在正文
  const rest = m[4] ? m[4].slice(1).trim() : ""
  return { text: rest ? (body ? body + "\n" : "") + rest : body, status }
}

// flatten writes an OpenAI chat request as one message.
export function flatten(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((t) => ({ line: toolLine(t), name: (t?.function ?? t)?.name })).filter((t) => t.line)
  const ch = choice(body ?? {}, tools.map((t) => t.name))
  const useTools = tools.length > 0 && !ch.off
  const out = []
  out.push("You are the language model behind a client application. You cannot run anything yourself and must not use your own tools, web search, files or computer: you only write text.")
  if (useTools) {
    out.push(
      `When an action is needed, reply with one or more blocks of exactly\n${OPEN}{"name": "<tool>", "arguments": {...}}${CLOSE}\nand nothing after them. The caller runs them and sends you the results in the next message. When no action is needed, answer in plain text with no ${OPEN} block.`,
    )
    if (ch.only) out.push(`You must call the tool ${ch.only} now.`)
    else if (ch.must) out.push("You must call at least one tool now.")
  }
  const system = messages.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => partText(m.content).trim()).filter(Boolean)
  if (system.length) out.push("# Instructions from the client\n\n" + system.join("\n\n"))
  if (useTools) out.push("# Tools\n\n" + tools.map((t) => t.line).join("\n\n"))
  if (body?.response_format?.type === "json_object" || body?.response_format?.type === "json_schema") {
    const schema = body.response_format.json_schema?.schema
    out.push("Answer with one JSON value and nothing else." + (schema ? " It must match this JSON Schema: " + JSON.stringify(schema) : ""))
  }
  const names = new Map()
  const turns = []
  for (const m of messages) {
    if (!m || m.role === "system" || m.role === "developer") continue
    if (m.role === "user") turns.push("[user]\n" + partText(m.content))
    else if (m.role === "assistant") {
      const parts = []
      const text = partText(m.content)
      if (text.trim()) parts.push(text)
      for (const c of m.tool_calls ?? []) {
        names.set(c.id, c.function?.name)
        parts.push(callText(c))
      }
      if (parts.length) turns.push("[assistant]\n" + parts.join("\n"))
    } else if (m.role === "tool" || m.role === "function") {
      const n = m.name ?? names.get(m.tool_call_id)
      // 失败状态进标题（[tool result of bash — exit code 9009]），正文不再重复
      const { text, status } = splitStatus(partText(m.content)) ?? {}
      turns.push(`[tool result${n ? " of " + n : ""}${status ? " — " + status : ""}]\n` + (text ?? partText(m.content)))
    }
  }
  out.push("# Conversation so far\n\n" + turns.join("\n\n"))
  out.push("Write the next [assistant] turn now, without the [assistant] label.")
  return out.join("\n\n")
}

// 2026-11-28：模型把工具调用写成各种漂移形状 —— 句中直接跟裸 JSON、
// ```json 围栏、JSON 数组、尾逗号、大小写漂移（Read）、工具名带
// functions. 前缀、参数平铺在对象上。声明了工具时按名字白名单抬升；
// 没声明工具时裸 JSON 的 {"name"...} 留在正文（JSON-mode 的回答）。
const JSON_KEY = '{"tool_calls"'
const NAME_KEY = '{"name"'
const JSON_HEAD = /^\{\s*"(tool_calls|name)"\s*:/
const ARRAY_HEAD = /^\[\s*\{\s*"(tool_calls|name)"\s*:/
const NAME_HEAD = /^\{\s*"name"\s*:\s*"([^"]+)"/

// inCode says whether at is inside a ``` fence. 保留给 heldFrom 的尾部
// 检测：围栏里的普通文本不该被当成调用开头扣住。
const inCode = (text, at) => (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 1

// jsonEnd is where the JSON value at the start of v ends, -1 while it is
// not whole yet
function jsonEnd(v) {
  let depth = 0
  let str = false
  for (let k = 0; k < v.length; k++) {
    const c = v[k]
    if (str) {
      if (c === "\\") k++
      else if (c === '"') str = false
    } else if (c === '"') str = true
    else if (c === "{" || c === "[") depth++
    else if (c === "}" || c === "]") {
      if (--depth === 0) return k + 1
    }
  }
  return -1
}

// candidateStarts 返回 text 里所有「像调用」的 JSON 起点（{ 或 [ 开头，
// 第一个键是 name / tool_calls）。裸 {"name"...} 只在声明了工具时算。
function candidateStarts(text, toolNames) {
  const out = []
  for (let k = 0; k < text.length; k++) {
    if (text[k] !== "{" && text[k] !== "[") continue
    const v = text.slice(k)
    const m = JSON_HEAD.exec(v) ?? ARRAY_HEAD.exec(v)
    if (!m) continue
    if (m[1] === "name" && !(Array.isArray(toolNames) && toolNames.length)) continue
    out.push(k)
  }
  return out
}

// callFrom 把一个对象读成 {name, arguments}。name 走白名单；arguments
// 缺失且声明了工具时把其余键当参数（glm 的扁平漂移）；参数可以是字符串
// 化的 JSON。checkNames=false 用于 {"tool_calls":[…]}（无条件认）。
// 工具名为空但有参数：先按参数键唯一匹配补名，匹配不到返回 UNREADABLE
// （有调用意图、读不出），调用方记进 unreadable 而不是漏成正文。
const UNREADABLE = Symbol("unreadable")
function callFrom(v, toolNames, { checkNames = true } = {}) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const rawName = v.name ?? v.function?.name ?? v.tool ?? v.function?.tool
  let name = checkNames ? normalizeName(rawName, toolNames) : String(rawName ?? "").trim()
  let raw = v.arguments ?? v.parameters ?? v.input ?? v.args ?? v.function?.arguments
  if (raw == null) {
    if (!(Array.isArray(toolNames) && toolNames.length)) return null
    const rest = { ...v }
    for (const k of ["name", "id", "type", "index", "tool_calls", "function"]) delete rest[k]
    if (!Object.keys(rest).length) return null
    raw = rest
  }
  let args = raw
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch { return null }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  if (!name && checkNames) {
    // 空名：参数写得像某个声明工具的（键是其 schema 属性的子集）就补名
    name = matchByArgs(args, toolNames)
    if (!name) return v.arguments !== undefined || v.parameters !== undefined ? UNREADABLE : null
  }
  if (!name) return null
  return { name, arguments: JSON.stringify(args) }
}

// jsonCalls 读一个完整的 JSON 值：tool_calls 数组、调用数组、或单个
// {"name",…} 对象。JSON 解析失败时去掉尾逗号再试一次。
function jsonCalls(v, toolNames = null) {
  let f
  try { f = JSON.parse(v) } catch {
    try { f = JSON.parse(v.replace(/,\s*([}\]])/g, "$1")) } catch { return null }
  }
  if (Array.isArray(f)) {
    const got = f.map((x) => callFrom(x, toolNames))
    if (got.includes(UNREADABLE)) return UNREADABLE
    const calls = got.filter(Boolean)
    return calls.length ? calls : null
  }
  const list = f?.tool_calls
  if (Array.isArray(list) && list.length) {
    const calls = list.map((e) => callFrom(e?.function ?? e, toolNames, { checkNames: false })).filter(Boolean)
    return calls.length ? calls : null
  }
  const one = callFrom(f, toolNames)
  return one === UNREADABLE ? UNREADABLE : one ? [one] : null
}

function looksDeclared(slice, toolNames) {
  const m = NAME_HEAD.exec(slice)
  return !!(m && normalizeName(m[1], toolNames))
}

// liftCalls 把 text 里所有「像调用」的片段抬升。分两阶段：
// 1) <tool_call>…</tool_call> 块（含无闭合标签的函数语法 name({…})）；
// 2) 散落在正文里的 JSON（行首、句中、围栏里、数组）。
// 读得出的进 calls，读不出但有调用意图的（JSON 截断）进 unreadable；
// 两者都从 rest 里去掉，让流式层据此报错而不是把半截 JSON 当正文。
export function liftCalls(text, toolNames = null) {
  const calls = []
  const unreadable = []
  let rest = ""
  let i = 0
  // 阶段 1：<tool_call> 块。块以 </tool_call> 或下一个 <tool_call> 结束
  // （模型连开两个不闭合时每块各读各的）。读不出的记 unreadable——它
  // 带着插件自己要求的标签，是有调用意图的，不当正文漏出去。
  while (i < text.length) {
    const at = text.indexOf(OPEN, i)
    if (at < 0) { rest += text.slice(i); break }
    rest += text.slice(i, at)
    const close = text.indexOf(CLOSE, at + OPEN.length)
    const next = text.indexOf(OPEN, at + OPEN.length)
    // 块尾：第一个出现的闭合标签或下一个开标签（谁先到算谁）
    const end = close < 0 ? next : next < 0 ? close : Math.min(close, next)
    const raw = text.slice(at + OPEN.length, end < 0 ? text.length : end)
    const call = parseCall(raw)
    if (call) calls.push(call)
    else unreadable.push({ at, raw: text.slice(at, end < 0 ? text.length : end) })
    i = end < 0 ? text.length : close >= 0 && close <= (next < 0 ? Infinity : next) ? close + CLOSE.length : next
  }
  // 阶段 2：rest 里的 JSON 候选，从后往前处理（位置不失效）。
  const candidates = []
  for (const k of candidateStarts(rest, toolNames)) {
    if (candidates.length && k < candidates[candidates.length - 1].end) continue // 嵌套，跳过
    const v = rest.slice(k)
    const endRel = jsonEnd(v)
    candidates.push({ at: k, end: endRel < 0 ? rest.length : k + endRel, incomplete: endRel < 0 })
  }
  for (const cand of candidates.reverse()) {
    const slice = rest.slice(cand.at, cand.end)
    const got = cand.incomplete ? null : jsonCalls(slice, toolNames)
    if (got === UNREADABLE) {
      unreadable.push({ at: cand.at, raw: slice })
      rest = rest.slice(0, cand.at) + rest.slice(cand.end)
    } else if (got && got.length) {
      calls.unshift(...got)
      rest = rest.slice(0, cand.at) + rest.slice(cand.end)
    } else if (cand.incomplete && looksDeclared(slice, toolNames)) {
      unreadable.push({ at: cand.at, raw: slice })
      rest = rest.slice(0, cand.at) + rest.slice(cand.end)
    }
  }
  // 围栏里只剩调用、被抬升空了：空围栏也不当正文。
  const cleaned = calls.length ? rest.replace(/```[a-z]*\s*```/gi, "") : rest
  return { rest: cleaned, calls, unreadable }
}

// heldFrom is where text stops being safe to show while it streams: the
// first <tool_call>, the first call-shaped JSON, or a tail that could be
// the start of one (so a drifting call is never shown as prose).
export function heldFrom(text, toolNames = null) {
  let at = text.indexOf(OPEN)
  const keys = [JSON_KEY, ...(Array.isArray(toolNames) && toolNames.length ? [NAME_KEY] : [])]
  for (const start of candidateStarts(text, toolNames)) {
    if (at < 0 || start < at) at = start
  }
  if (at >= 0) return at
  // 尾部：可能是调用 JSON 的开头（含句中，如「好的：{"nam）。扣住它，
  // 让 finish 的 parse 决定是调用还是正文。
  const line = text.slice(text.lastIndexOf("\n") + 1)
  for (let n = Math.min(Math.max(...keys.map((k) => k.length)), line.length); n > 0; n--) {
    const tail = line.slice(-n).replace(/\s+/g, "")
    if (tail && keys.some((k) => k.startsWith(tail)) && !inCode(text, text.length - n)) return text.length - n
  }
  for (let n = Math.min(OPEN.length - 1, text.length); n > 0; n--) if (OPEN.startsWith(text.slice(-n))) return text.length - n
  return text.length
}

// jsObjectToJson 把 JS 对象字面量风格的参数（键无引号、单引号）转成
// 能 JSON.parse 的文本：find(pattern:"x") / find({pattern: 'x'}) 都行。
function jsObjectToJson(s) {
  const t = s
    .replace(/(^|[({,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
  return t.trim().startsWith("{") ? t : "{" + t + "}" // 括号里直接是键值对：包成对象
}

// parseCall reads what a <tool_call> block holds: {"name","arguments"}
// JSON — or GLM's own function-call syntax ask_question({...}), with the
// closing tag left off. The block is the format the plugin itself asks
// for, so it is read without a name whitelist. JS-object-style arguments
// (bare keys, single quotes) are accepted too — glm writes them.
function parseCall(raw) {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  const fn = s.match(/^([A-Za-z_][\w.-]*)\s*(\((.*)\)\s*)?$/s)
  if (fn && !fn[2]) return { name: fn[1], arguments: "{}" } // 只有名字、没参数：ls
  if (fn) {
    const inner = fn[3].trim()
    let args
    try { args = JSON.parse(inner) } catch {
      try { args = JSON.parse(jsObjectToJson(inner)) } catch { return null }
    }
    if (args === undefined) return null
    if (typeof args !== "object" || Array.isArray(args)) return null
    return { name: fn[1], arguments: JSON.stringify(args) }
  }
  let v
  try { v = JSON.parse(s) } catch { return null }
  if (Array.isArray(v)) v = v[0]
  const name = v?.name ?? v?.function?.name ?? v?.tool
  if (typeof name !== "string" || !name) return null
  let args = v.arguments ?? v.parameters ?? v.input ?? v.args ?? v.function?.arguments ?? {}
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch {}
  }
  return { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }
}

// parse splits a finished reply into its text and tool calls. A block that
// isn't a call it can read stays in the text, so nothing the model wrote is
// lost. `unreadable` holds call-shaped fragments that could not be read,
// for the stream layer to end with an error instead of leaking half JSON.
export function parse(text, newId = () => "call_" + Math.random().toString(36).slice(2, 14), toolNames = null) {
  const { rest, calls, unreadable } = liftCalls(text, toolNames)
  return {
    text: calls.length ? rest.trim() : rest,
    calls: calls.map((c) => ({ id: newId(), type: "function", function: c })),
    raw: rest,
    unreadable,
  }
}
