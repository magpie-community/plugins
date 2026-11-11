// agy lazy-loads MCP tools (McpToolConfig.EnableLazyLoad and a call_mcp_tool
// tool in the agy binary): a tool whose advertised declaration is large is not
// put in the model's function list, and nothing tells the model it exists.
// Observed on agy 1.5.4 / Gemini 4 Carbon (plugins#989): tools of about 691
// tokens and up were missing, ones of about 561 and below were present. The
// cut-off is not in the binary, so the budget below stays under the lowest
// kept size and can be changed with AGY_BRIDGE_TOOL_BUDGET (characters).
export const DEFAULT_TOOL_BUDGET = 2000 // ~500 tokens at 4 characters a token
const MIN_DESCRIPTION = 240
const NESTED_DESCRIPTION = 90

export function toolBudget(env = process.env) {
  const n = Number(env.AGY_BRIDGE_TOOL_BUDGET)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TOOL_BUDGET
}

const size = (tool) => JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v)

// Schema keywords that carry a nested schema map (names are data, not keywords).
const MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
const SINGLE = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties"]
const LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"]

function walk(node, fn, top = true) {
  if (!isObject(node)) return node
  const out = { ...node }
  fn(out, top)
  for (const key of MAPS) {
    if (isObject(out[key])) out[key] = Object.fromEntries(Object.entries(out[key]).map(([k, v]) => [k, walk(v, fn, false)]))
  }
  for (const key of SINGLE) if (isObject(out[key])) out[key] = walk(out[key], fn, false)
  for (const key of LISTS) if (Array.isArray(out[key])) out[key] = out[key].map((v) => walk(v, fn, false))
  return out
}

function cut(text, max) {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

// Largest optional property of the top-level object, by serialized size.
function dropLargestOptional(schema) {
  const props = schema.properties
  if (!isObject(props)) return null
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  let pick = null
  let pickSize = -1
  for (const [name, value] of Object.entries(props)) {
    if (required.has(name)) continue
    const s = JSON.stringify(value).length
    if (s > pickSize) { pick = name; pickSize = s }
  }
  if (pick === null) return null
  const { [pick]: _gone, ...rest } = props
  return { name: pick, schema: { ...schema, properties: rest } }
}

// Fits one tool under the budget, losing the least meaning first. Returns the
// tool and what was lost: { steps: [...], dropped: [property names] }.
export function fitTool(tool, budget = toolBudget()) {
  const lost = { steps: [], dropped: [] }
  if (!budget || size(tool) <= budget) return { tool, lost }
  let cur = { ...tool }
  const step = (name, next) => {
    if (size(next) < size(cur)) { cur = next; lost.steps.push(name) }
    return size(cur) <= budget
  }
  const noise = new Set(["default", "examples", "example", "title", "$comment", "deprecated", "readOnly", "writeOnly"])
  if (step("noise", { ...cur, inputSchema: walk(cur.inputSchema, (n) => { for (const k of noise) delete n[k] }) })) return { tool: cur, lost }
  if (step("nested-descriptions", { ...cur, inputSchema: walk(cur.inputSchema, (n, top) => {
    if (!top && typeof n.description === "string") n.description = cut(n.description, NESTED_DESCRIPTION)
  }) })) return { tool: cur, lost }
  if (step("tool-description", { ...cur, description: cut(cur.description, Math.max(MIN_DESCRIPTION, budget - (size({ ...cur, description: "" })))) })) return { tool: cur, lost }
  if (step("nested-descriptions-removed", { ...cur, inputSchema: walk(cur.inputSchema, (n, top) => { if (!top) delete n.description }) })) return { tool: cur, lost }
  if (step("tool-description-short", { ...cur, description: cut(cur.description, MIN_DESCRIPTION) })) return { tool: cur, lost }
  while (size(cur) > budget) {
    const next = dropLargestOptional(cur.inputSchema)
    if (!next) break
    cur = { ...cur, inputSchema: next.schema }
    lost.dropped.push(next.name)
  }
  return { tool: cur, lost }
}

// Fits every tool. report(row) is called once per tool that changed or still
// does not fit, so the loss is never silent.
export function fitTools(tools, { budget = toolBudget(), report = () => {} } = {}) {
  return tools.map((tool) => {
    const before = size(tool)
    const { tool: fitted, lost } = fitTool(tool, budget)
    const after = size(fitted)
    if (fitted !== tool) {
      report({ tool: tool.name, before, after, budget, ...lost, stillOver: budget > 0 && after > budget })
    }
    return fitted
  })
}
