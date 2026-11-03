// The account's MiniMax Matrix connector tools, as magpie tools every
// agent on this provider can call: image/video/audio/music generation and
// understanding, through MiniMax Code's connector gateway
// (/minimax-cloud/api/v1/connectors/*). request is the parent transport's
// authenticated OAuth POST (site, path, body, {signal, timeoutMs, account}); it
// answers the response's JSON body with base_resp already checked.
//
// The bundled matrix-tools.json is a copy of the catalog's real schemas,
// taken from mcode-tools (connector tool <name>) on 2026-11-03, so loading
// this plugin never asks the network. The live catalog still routes every
// call (provider/provider_tool_name/runtime_tool_name), and is re-read on
// each operation: another signed-in account may connect different tools.
import { readFileSync } from "node:fs"

const LIST_PATH = "/minimax-cloud/api/v1/connectors/connected-tools/list"
const CALL_PATH = "/minimax-cloud/api/v1/connectors/tools/call"
const MATRIX = "connector__matrix__"
const LIST_MS = 30 * 1000
const CALL_MS = 55 * 1000 // magpie's MCP host lets a tool run about this long
const GEN_MS = 10 * 60 * 1000 // a generation may outlast it; ctx.abort still cuts it
const SITES = ["minimax-code", "minimax-code-global"]

// a bundled copy of the gateway's schemas; loading never waits on a fetch
const MATRIX_TOOLS = Object.freeze(
  JSON.parse(readFileSync(new URL("./matrix-tools.json", import.meta.url), "utf8")).tools)

// generation and understanding calls get the long budget; the rest the
// host's. A video is submit + later query, never a poll inside one call.
const LONG = new Set([
  "generate_image", "submit_video_generation", "synthesize_speech",
  "batch_text_to_audio", "batch_text_to_music", "enhance_image",
  "remove_image_background", "describe_images", "videos_understand",
  "audios_understand", "listen_audio", "search_images",
  "reverse_image_search",
])

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined)
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)

// ---- a small JSON-Schema check -------------------------------------------------
// Enough of the draft for the bundled schemas: types, required, enum,
// properties + additionalProperties, items, string/array/number limits,
// const, allOf/anyOf/oneOf, not, and if/then/else (the video schema's
// per-model rules). Anything it doesn't know it leaves for the gateway.
function check(schema, value, path, errs) {
  if (!obj(schema)) return
  if (schema.const !== undefined && value !== schema.const)
    errs.push(path + " must be " + JSON.stringify(schema.const))
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value)))
    errs.push(path + " must be one of " + schema.enum.map((e) => JSON.stringify(e)).join(", "))
  const t = schema.type
  if (t === "string" && typeof value !== "string") errs.push(path + " must be a string")
  else if (t === "integer" && !Number.isInteger(value)) errs.push(path + " must be an integer")
  else if (t === "number" && (typeof value !== "number" || !Number.isFinite(value))) errs.push(path + " must be a number")
  else if (t === "boolean" && typeof value !== "boolean") errs.push(path + " must be a boolean")
  else if (t === "array" && !Array.isArray(value)) errs.push(path + " must be an array")
  else if (t === "object" && !obj(value)) errs.push(path + " must be an object")
  if (errs.length) return
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(path + " is shorter than " + schema.minLength)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(path + " is longer than " + schema.maxLength)
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(path + " must be >= " + schema.minimum)
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(path + " must be <= " + schema.maximum)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(path + " needs at least " + schema.minItems + " item(s)")
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(path + " takes at most " + schema.maxItems + " item(s)")
    if (obj(schema.items)) value.forEach((v, i) => check(schema.items, v, path + "[" + i + "]", errs))
  }
  if (obj(value)) {
    const props = obj(schema.properties) ?? {}
    for (const key of schema.required ?? [])
      if (value[key] === undefined || value[key] === null) errs.push(path + "." + key + " is required")
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) check(props[key], v, path + "." + key, errs)
      else if (schema.additionalProperties === false) errs.push(path + "." + key + " is not an accepted argument")
      else if (obj(schema.additionalProperties)) check(schema.additionalProperties, v, path + "." + key, errs)
    }
  }
  for (const sub of schema.allOf ?? []) check(sub, value, path, errs)
  const iff = schema.if
  if (obj(iff) && (obj(schema.then) || obj(schema.else))) {
    const errsIf = []
    check(iff, value, path, errsIf)
    const branch = errsIf.length === 0 ? schema.then : schema.else
    if (obj(branch)) check(branch, value, path, errs)
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const ok = schema.anyOf.some((sub) => { const e = []; check(sub, value, path, e); return e.length === 0 })
    if (!ok) errs.push(path + " matches none of the accepted shapes")
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const ok = schema.oneOf.filter((sub) => { const e = []; check(sub, value, path, e); return e.length === 0 }).length
    if (ok !== 1) errs.push(path + " must match exactly one of the accepted shapes")
  }
  if (obj(schema.not)) {
    const e = []
    check(schema.not, value, path, e)
    if (e.length === 0) errs.push(path + " uses a combination the tool refuses")
  }
}
const same = (a, b) => a === b || (obj(a) && obj(b) && JSON.stringify(a) === JSON.stringify(b))

// checked(schema, args) validates a tool call's own arguments (site and
// account already stripped) against its input_schema; a failure means the
// call never left, which for a priced generation is the point.
function checked(schema, args) {
  if (!obj(args)) throw new Error("tool arguments must be an object")
  const errs = []
  check(schema, args, "arguments", errs)
  if (errs.length) throw new Error("bad arguments: " + errs.join("; "))
  return args
}

// ---- the connector gateway -------------------------------------------------------

// validateTool is the catalog entry the gateway needs to route a call.
function routeOf(t) {
  const r = obj(t)
  if (!r || !str(r.provider) || !str(r.provider_tool_name) || !str(r.runtime_tool_name)) return undefined
  return { provider: r.provider, provider_tool_name: r.provider_tool_name, runtime_tool_name: r.runtime_tool_name }
}

// catalog reads the account's connected tools. It is deliberately not
// cached: a different account (or a changed connection) answers a
// different list, and a stale route would call the wrong provider.
async function catalog(request, site, signal, account) {
  const body = await request(site, LIST_PATH, {}, { signal, timeoutMs: LIST_MS, account })
  const b = obj(body)
  if (!b || !Array.isArray(b.tools)) throw new Error("MiniMax connector list: malformed response (no tools array)")
  if (!Array.isArray(b.provider_failures)) throw new Error("MiniMax connector list: malformed response (no provider_failures)")
  if (typeof b.partial !== "boolean") throw new Error("MiniMax connector list: malformed partial flag")
  if (b.provider_failures.some(f => !obj(f) || !str(f.provider) || !str(f.code) || !str(f.message)))
    throw new Error("MiniMax connector list: malformed provider failure")
  const seen = new Set()
  const tools = []
  for (const t of b.tools) {
    const r = routeOf(t)
    if (!r || typeof t.input_schema_json !== "string") throw new Error("MiniMax connector list: malformed tool entry")
    if (seen.has(r.runtime_tool_name)) throw new Error("MiniMax connector list: duplicate tool " + r.runtime_tool_name)
    seen.add(r.runtime_tool_name)
    tools.push({ ...r, description: typeof t.description === "string" ? t.description : "", input_schema_json: t.input_schema_json, output_schema_json: t.output_schema_json })
  }
  return { tools, partial: b.partial === true, failures: b.provider_failures.filter(obj) }
}

// find resolves a runtime_tool_name in the fresh catalog, telling the
// truth about a provider failure instead of pretending success.
function find(cat, name) {
  const match = cat.tools.find((t) => t.runtime_tool_name === name)
  if (match) return match
  const provider = /^connector__(.+?)__/.exec(name)?.[1]
  const f = provider && cat.failures.find((x) => x.provider === provider)
  if (f) throw new Error("connector provider " + f.provider + " is unavailable: " + (f.code ?? "?") + " — " + (f.message ?? ""))
  throw new Error("connector tool " + JSON.stringify(name) + " is not connected on this account" + (cat.partial ? " (catalog is partial; it may still exist)" : ""))
}

// invoke sends one call through the gateway and answers the parsed result.
// is_error is the tool's own failure, thrown with its code and message —
// never shaped like a result.
async function invoke(request, site, entry, args, signal, timeoutMs, account) {
  const body = await request(site, CALL_PATH, {
    provider: entry.provider,
    provider_tool_name: entry.provider_tool_name,
    runtime_tool_name: entry.runtime_tool_name,
    arguments_json: JSON.stringify(args ?? {}),
  }, { signal, timeoutMs, account })
  const b = obj(body)
  if (!b) throw new Error("MiniMax connector call " + entry.runtime_tool_name + ": malformed response")
  if (b.is_error === true) {
    const code = str(b.error_code) ?? "connector_tool_error"
    const msg = str(b.error_message) ?? "the connector tool failed"
    throw new Error(code + ": " + msg)
  }
  if (b.is_error !== undefined && typeof b.is_error !== "boolean") throw new Error("MiniMax connector call: malformed is_error flag")
  const raw = b.result_json
  if (typeof raw !== "string" || !raw.trim()) throw new Error("MiniMax connector call: missing result_json")
  let result
  try { result = JSON.parse(raw) } catch {
    throw new Error("MiniMax connector call " + entry.runtime_tool_name + ": result_json is not valid JSON")
  }
  if (obj(result) && result.code !== undefined && Number.isFinite(Number(result.code)) && Number(result.code) !== 0)
    throw new Error("MiniMax Matrix tool: " + (str(result.message) ?? "request failed") + " (code=" + result.code + ")")
  return result
}

// ---- the tools -------------------------------------------------------------------

// Each tool's visible args are its own input_schema's properties plus two
// routing fields, site and account, which are stripped before the call
// leaves: the gateway never sees them.
const siteArg = {
  type: "string",
  enum: SITES,
  default: "minimax-code",
  description: "Which MiniMax Code site's account asks: minimax-code (China, default) or minimax-code-global (international).",
}
const accountArg = {
  type: "string",
  description: "The full stored account key, e.g. minimax-code or minimax-code#xxxxxx. Defaults to the selected site's first stored account. The selected account stays fixed during the call and any authentication retry.",
}

function routing(args, callCtx) {
  const a = obj(args) ?? {}
  const site = a.site === undefined ? "minimax-code" : a.site
  if (!SITES.includes(site)) throw new Error("site must be one of " + SITES.join(", "))
  if (a.account !== undefined && typeof a.account !== "string") throw new Error("account must be a string")
  const rest = { ...a }
  delete rest.site
  delete rest.account
  return { site, account: a.account, args: rest, signal: callCtx?.abort }
}

function directTool(request, name, def) {
  const inner = def.input_schema ?? { type: "object", properties: {} }
  return {
    description: def.description,
    args: {
      ...inner,
      type: "object",
      properties: { site: siteArg, account: accountArg, ...(inner.properties ?? {}) },
      required: inner.required ?? [],
      additionalProperties: inner.additionalProperties ?? false,
    },
    async execute(args, callCtx) {
      const r = routing(args, callCtx)
      const cat = await catalog(request, r.site, r.signal, r.account)
      const entry = find(cat, MATRIX + name)
      const checkedArgs = checked(entry.input_schema_json ? parseSchema(entry.input_schema_json) : inner, r.args)
      return invoke(request, r.site, entry, checkedArgs, r.signal, LONG.has(name) ? GEN_MS : CALL_MS, r.account)
    },
  }
}
function parseSchema(json) {
  try {
    const value = JSON.parse(json)
    if (!obj(value)) throw new Error()
    return value
  } catch { throw new Error("MiniMax connector list: malformed input_schema_json") }
}

export function createConnectorTools(request) {
  if (typeof request !== "function") throw new Error("createConnectorTools needs the request transport")
  const tool = {}

  // the named matrix tools, each its own first-class magpie tool
  for (const [name, def] of Object.entries(MATRIX_TOOLS)) tool[name] = directTool(request, name, def)

  tool.list_tools = {
    description:
      "List this account's connected MiniMax Matrix tools with their descriptions (the catalog is read fresh, so a newly connected tool shows up). " +
      "Pass keyword to filter names and descriptions. The answer notes when the catalog is partial or a provider failed.",
    args: {
      type: "object",
      properties: {
        site: siteArg,
        account: accountArg,
        keyword: { type: "string", description: "optional filter on tool names and descriptions" },
      },
      additionalProperties: false,
    },
    async execute(args, callCtx) {
      const r = routing(args, callCtx)
      const cat = await catalog(request, r.site, r.signal, r.account)
      const kw = str(r.args.keyword)?.toLocaleLowerCase()
      const tools = cat.tools
        .filter((t) => t.runtime_tool_name.startsWith(MATRIX))
        .filter((t) => !kw || t.runtime_tool_name.toLocaleLowerCase().includes(kw) || t.description.toLocaleLowerCase().includes(kw))
        .map((t) => ({ tool_name: t.runtime_tool_name, description: t.description }))
      return { tools, partial: cat.partial, provider_failures: cat.failures }
    },
  }

  tool.tool_schema = {
    description:
      "Show a connected tool's real input and output JSON schema as the account's catalog declares them, before calling it with call_tool.",
    args: {
      type: "object",
      properties: {
        site: siteArg,
        account: accountArg,
        tool_name: { type: "string", description: "the connector tool's full runtime name, e.g. connector__matrix__generate_image" },
      },
      required: ["tool_name"],
      additionalProperties: false,
    },
    async execute(args, callCtx) {
      const r = routing(args, callCtx)
      const name = str(r.args.tool_name)
      if (!name) throw new Error("tool_name is required")
      if (!name.startsWith(MATRIX)) throw new Error("tool_schema only describes connector__matrix__* tools")
      const cat = await catalog(request, r.site, r.signal, r.account)
      const entry = find(cat, name)
      let input_schema = null
      let output_schema = null
      input_schema = parseSchema(entry.input_schema_json)
      try { output_schema = entry.output_schema_json ? JSON.parse(entry.output_schema_json) : null } catch { output_schema = { malformed: entry.output_schema_json } }
      return { tool_name: name, provider: entry.provider, description: entry.description, input_schema, output_schema, partial: cat.partial }
    },
  }

  tool.call_tool = {
    description:
      "Call a connected MiniMax Matrix connector tool by its runtime_tool_name with a JSON arguments object. " +
      "Only connector__matrix__* tools are callable through here — this account's other integrations stay unreachable, so nothing else can be spent or read by accident. " +
      "Use list_tools and tool_schema first; arguments are checked against the catalog's own schema before the call goes out.",
    args: {
      type: "object",
      properties: {
        site: siteArg,
        account: accountArg,
        tool_name: { type: "string", description: "a connector__matrix__* runtime name from list_tools" },
        arguments: { type: "object", description: "the tool's arguments, conforming to its input_schema" },
      },
      required: ["tool_name", "arguments"],
      additionalProperties: false,
    },
    async execute(args, callCtx) {
      const r = routing(args, callCtx)
      const name = str(r.args.tool_name)
      if (!name) throw new Error("tool_name is required")
      if (!name.startsWith(MATRIX)) throw new Error("call_tool only calls connector__matrix__* tools; got " + JSON.stringify(name))
      const cat = await catalog(request, r.site, r.signal, r.account)
      const entry = find(cat, name)
      const checkedArgs = checked(entry.input_schema_json ? parseSchema(entry.input_schema_json) : { type: "object" }, r.args.arguments)
      return invoke(request, r.site, entry, checkedArgs, r.signal, GEN_MS, r.account)
    },
  }

  for (const t of Object.values(tool)) {
    const execute = t.execute
    t.execute = async (args, ctx) => {
      checked(t.args, args)
      ctx?.abort?.throwIfAborted()
      return execute(args, ctx)
    }
  }
  return { tool }
}

export const _internal = { check, checked, catalog, find, invoke, routing, MATRIX_TOOLS, SITES }
