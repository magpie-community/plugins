// Factory rejects composition keywords at the tool schema's root. Keep the
// original schema under one argument, and hide that wire-only envelope from
// the caller in both replies and the next turn's history.
const argument = "arguments"
const compositions = ["anyOf", "oneOf", "allOf"]
const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
const schemaLists = ["anyOf", "oneOf", "allOf", "prefixItems"]
const schemaValues = ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "items", "additionalItems", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]
const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v)

export function parseToolJSON(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number" || Number.isSafeInteger(value)) return value
    if (context?.source && typeof JSON.rawJSON === "function") return JSON.rawJSON(context.source)
    // Never round a tool's large integer into a different argument on an old
    // runtime that cannot retain JSON number tokens.
    if (!Number.isFinite(value) || Number.isInteger(value)) throw new Error("Factory: this runtime cannot preserve the tool's JSON number")
    return value
  })
}

function rebaseSchema(schema, rebase = true, legacy = false) {
  if (!isObject(schema)) return
  const id = schema.$id ?? (legacy ? schema.id : undefined)
  if (typeof id === "string" && id.split("#")[0]) rebase = false
  if (rebase) {
    // Draft 2019-09's recursive anchor must remain a resource root. Refuse
    // this unsupported relocation instead of changing its resolution scope.
    if (schema.$recursiveAnchor === true || Object.hasOwn(schema, "$recursiveRef")) throw new Error("Factory: a recursive tool schema needs $id before it can be wrapped")
    for (const key of ["$ref", "$dynamicRef"]) {
      const ref = schema[key]
      if (typeof ref !== "string" || !ref.startsWith("#")) continue
      const pointer = decodeURIComponent(ref.slice(1))
      if (pointer === "" || pointer.startsWith("/")) schema[key] = "#/properties/" + argument + ref.slice(1)
    }
  }
  // Visit schema positions only: const/default/examples may contain ordinary
  // data named $ref, properties or anyOf and must not be rewritten.
  for (const key of schemaMaps) {
    if (isObject(schema[key])) for (const child of Object.values(schema[key])) rebaseSchema(child, rebase, legacy)
  }
  for (const key of schemaLists) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) rebaseSchema(child, rebase, legacy)
  }
  for (const key of schemaValues) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) rebaseSchema(child, rebase, legacy)
    else rebaseSchema(schema[key], rebase, legacy)
  }
  if (isObject(schema.dependencies)) for (const child of Object.values(schema.dependencies)) rebaseSchema(child, rebase, legacy)
}

function bodyString(body) {
  return typeof body === "string" ? body
    : body instanceof ArrayBuffer ? Buffer.from(body).toString("utf8")
    : ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8") : ""
}

export function wrapAnthropicTools(body) {
  const names = new Set()
  const text = bodyString(body)
  let request
  try { request = parseToolJSON(text) } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return { body, names }
  }
  if (!Array.isArray(request?.tools) || !Array.isArray(request.messages)) return { body, names }
  for (const tool of request.tools) {
    const schema = tool?.input_schema
    if (typeof tool?.name !== "string" || !isObject(schema) || !compositions.some((key) => Object.hasOwn(schema, key))) continue
    rebaseSchema(schema, true, /draft-0[34]/.test(schema.$schema ?? ""))
    tool.input_schema = { type: "object", properties: { [argument]: schema }, required: [argument], additionalProperties: false }
    if (schema.$schema) tool.input_schema.$schema = schema.$schema
    if (Array.isArray(tool.input_examples)) tool.input_examples = tool.input_examples.map((input) => ({ [argument]: input }))
    names.add(tool.name)
  }
  if (!names.size) return { body, names }
  for (const message of request.messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === "tool_use" && names.has(block.name) && Object.hasOwn(block, "input")) block.input = { [argument]: block.input }
    }
  }
  return { body: JSON.stringify(request), names }
}

// Factory refuses a request that declares a tool under certain names
// (client-phrases.json, toolNames). Such a tool is declared as <name>_tool
// instead (then _tool_2, _tool_3 while that name is taken), in every field of
// the request that carries tool names, and its calls in a reply get the
// original name back. The aliases are chosen from the request alone, in the
// order its tools are declared.
const alias = "_tool"
const list = (v) => Array.isArray(v) ? v : []

// Per API, the objects whose `name` (key `k` of `o`, as [o, k]) is a declared
// tool's, and those that name a declared tool in a choice, a call or a result.
const nameSlots = {
  anthropic(r) {
    // a typed tool (bash_20250124) must keep its name
    const declared = list(r.tools).filter((t) => isObject(t) && (t.type == null || t.type === "custom")).map((t) => [t, "name"])
    const used = []
    if (isObject(r.tool_choice) && r.tool_choice.type === "tool") used.push([r.tool_choice, "name"])
    for (const m of list(r.messages)) {
      if (m?.role !== "assistant") continue
      for (const b of list(m.content)) if (b?.type === "tool_use") used.push([b, "name"])
    }
    return { declared, used }
  },
  chat(r) {
    const declared = list(r.tools).filter((t) => isObject(t?.function)).map((t) => [t.function, "name"])
    const used = []
    if (isObject(r.tool_choice?.function)) used.push([r.tool_choice.function, "name"])
    for (const m of list(r.messages)) {
      if (m?.role !== "assistant") continue
      for (const c of list(m.tool_calls)) if (isObject(c?.function)) used.push([c.function, "name"])
    }
    return { declared, used }
  },
  responses(r) {
    const declared = list(r.tools).filter((t) => isObject(t) && t.type === "function").map((t) => [t, "name"])
    const used = []
    if (isObject(r.tool_choice) && r.tool_choice.type === "function") used.push([r.tool_choice, "name"])
    for (const item of list(r.input)) if (item?.type === "function_call") used.push([item, "name"])
    return { declared, used }
  },
  gemini(r) {
    const declared = []
    for (const t of list(r.tools)) for (const d of list(t?.functionDeclarations)) if (isObject(d)) declared.push([d, "name"])
    const used = []
    const allowed = r.toolConfig?.functionCallingConfig?.allowedFunctionNames
    if (Array.isArray(allowed)) allowed.forEach((_, i) => used.push([allowed, i]))
    for (const c of list(r.contents)) {
      for (const p of list(c?.parts)) {
        if (isObject(p?.functionCall)) used.push([p.functionCall, "name"])
        if (isObject(p?.functionResponse)) used.push([p.functionResponse, "name"])
      }
    }
    return { declared, used }
  },
}

// aliasToolNames is body, a request of API `dialect` ("anthropic", "chat",
// "responses" or "gemini"), with every tool it declares under a name of
// `refused` (a Set) declared under its alias, and the aliases as a Map from
// alias to original name. A request with nothing to alias comes back as it
// is, the same body.
export function aliasToolNames(dialect, body, refused) {
  const none = { body, aliases: new Map() }
  const slots = nameSlots[dialect]
  const text = slots && bodyString(body)
  if (!text) return none
  let request
  try { request = parseToolJSON(text) } catch { return none }
  if (!isObject(request)) return none
  const { declared, used } = slots(request)
  const taken = new Set(declared.map(([o, k]) => o[k]))
  const renamed = new Map()
  for (const [o, k] of declared) {
    const name = o[k]
    if (!refused.has(name) || renamed.has(name)) continue
    let next = name + alias, n = 1
    while (taken.has(next) || refused.has(next)) next = `${name}${alias}_${++n}`
    taken.add(next)
    renamed.set(name, next)
  }
  if (!renamed.size) return none
  for (const [o, k] of [...declared, ...used]) {
    const next = renamed.get(o[k])
    if (next !== undefined) o[k] = next
  }
  return { body: JSON.stringify(request), aliases: new Map([...renamed].map(([name, next]) => [next, name])) }
}

// the reply's side: each gives back the original name to the tool calls in
// a reply (or one SSE event) of its API, and says whether it changed any
const back = (o, aliases) => {
  const name = aliases.get(o?.name)
  if (name === undefined) return false
  o.name = name
  return true
}
const nameRestorers = {
  anthropic(v, aliases) {
    let changed = false
    for (const b of [...list(v.content), v.content_block]) if (b?.type === "tool_use") changed = back(b, aliases) || changed
    return changed
  },
  chat(v, aliases) {
    let changed = false
    for (const choice of list(v.choices)) {
      for (const call of [...list(choice?.message?.tool_calls), ...list(choice?.delta?.tool_calls)]) changed = back(call?.function, aliases) || changed
    }
    return changed
  },
  responses(v, aliases) {
    let changed = false
    for (const item of [v.item, ...list(v.output), ...list(v.response?.output)]) if (item?.type === "function_call") changed = back(item, aliases) || changed
    return changed
  },
  gemini(v, aliases) {
    let changed = false
    for (const candidate of list(v.candidates)) {
      for (const part of list(candidate?.content?.parts)) changed = back(part?.functionCall, aliases) || changed
    }
    return changed
  },
}
// a streamed Gemini reply without alt=sse is an array of such objects
function restoreNames(dialect, value, aliases) {
  if (Array.isArray(value)) return value.map((v) => restoreNames(dialect, v, aliases)).includes(true)
  return isObject(value) && nameRestorers[dialect](value, aliases)
}

function unwrap(input, name) {
  if (!isObject(input) || !Object.hasOwn(input, argument) || Object.keys(input).length !== 1) throw new Error(`Factory: tool ${name} returned invalid wrapped arguments`)
  return input[argument]
}

function responseHeaders(res) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return { status: res.status, statusText: res.statusText, headers }
}

function toolStream(body, names, aliases, dialect) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const blocks = new Map()
  const marks = [...aliases.keys()]
  let pending = "", ended = false
  const incomplete = () => {
    if (blocks.size) throw new Error("Factory: incomplete wrapped tool arguments")
  }
  const frame = (raw, ending) => {
    const lines = raw.split(/\r\n|\n|\r/)
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
    if (!data) return [raw + ending]
    if (data === "[DONE]") { incomplete(); return [raw + ending] }
    // a reply that only has names to restore leaves alone every event that
    // can't carry one
    if (!names.size && !marks.some((mark) => data.includes(mark))) return [raw + ending]
    let event
    try { event = parseToolJSON(data) } catch (e) {
      if (names.size || !(e instanceof SyntaxError)) throw e
      return [raw + ending]
    }
    const replace = (value) => {
      let first = true
      const next = []
      for (const line of lines) {
        if (!line.startsWith("data:")) next.push(line)
        else if (first) { next.push("data: " + JSON.stringify(value)); first = false }
      }
      return next.join(raw.includes("\r\n") ? "\r\n" : "\n") + ending
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && names.has(event.content_block.name)) {
      if (blocks.has(event.index)) throw new Error("Factory: duplicate wrapped tool block")
      blocks.set(event.index, { name: event.content_block.name, json: "", initial: event.content_block.input })
      event.content_block.input = {}
      restoreNames(dialect, event, aliases)
      return [replace(event)]
    }
    const block = blocks.get(event.index)
    if (block && event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      if (typeof event.delta.partial_json !== "string") throw new Error("Factory: invalid tool argument delta")
      block.json += event.delta.partial_json
      return []
    }
    if (block && event.type === "content_block_stop") {
      const input = unwrap(block.json ? parseToolJSON(block.json) : block.initial, block.name)
      blocks.delete(event.index)
      const delta = { type: "content_block_delta", index: event.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }
      return ["event: content_block_delta\ndata: " + JSON.stringify(delta) + "\n\n", raw + ending]
    }
    if (event.type === "error") blocks.clear() // preserve the upstream error
    if (event.type === "message_stop") incomplete()
    return [restoreNames(dialect, event, aliases) ? replace(event) : raw + ending]
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(pending)
          if (boundary || (ended && pending)) {
            const raw = boundary ? pending.slice(0, boundary.index) : pending
            const ending = boundary?.[0] ?? ""
            pending = boundary ? pending.slice(boundary.index + ending.length) : ""
            const out = frame(raw, ending)
            for (const value of out) controller.enqueue(encoder.encode(value))
            if (out.length) return
            continue
          }
          if (ended) { incomplete(); controller.close(); return }
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

async function reply(res, names, aliases, dialect) {
  if ((!names.size && !aliases.size) || !res.ok || !res.body) return res
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) return new Response(toolStream(res.body, names, aliases, dialect), responseHeaders(res))
  if (!(res.headers.get("content-type") ?? "").includes("json")) return res
  const text = await res.text()
  let message
  try { message = parseToolJSON(text) } catch (e) {
    if (names.size || !(e instanceof SyntaxError)) throw e
    return new Response(text, responseHeaders(res))
  }
  let changed = false
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== "tool_use" || !names.has(block.name)) continue
    block.input = unwrap(block.input, block.name)
    changed = true
  }
  changed = restoreNames(dialect, message, aliases) || changed
  return new Response(changed ? JSON.stringify(message) : text, responseHeaders(res))
}

// unwrapAnthropicTools is res, a Messages reply, with the wrapped arguments
// of the tools in names unwrapped and the aliases (alias to original name)
// of aliasToolNames undone.
export function unwrapAnthropicTools(res, names, aliases = new Map()) {
  return reply(res, names, aliases, "anthropic")
}

// restoreToolNames is res, a reply of API `dialect` other than Messages (as
// aliasToolNames takes them), with its aliases undone: JSON or SSE.
export function restoreToolNames(res, dialect, aliases) {
  return reply(res, new Set(), aliases, dialect)
}
