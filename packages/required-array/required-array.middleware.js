// Magpie gateway middleware: give every object tool schema an explicit
// "required" array. Some relays reject a function schema whose object has no
// required key (for example Mavis-Api answers `null is not of type "array"`),
// and a zero-parameter tool such as get_goal is enough to fail the request.
//
// Install: magpie plugin add @magpie-community/middleware-required-array

function fill(schema, depth) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 12) return
  if (schema.type === "object" && schema.properties && schema.required === undefined) schema.required = []
  for (const key of ["properties", "$defs"]) {
    const group = schema[key]
    if (group && typeof group === "object") for (const name in group) fill(group[name], depth + 1)
  }
  if (schema.items) fill(schema.items, depth + 1)
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[key])) for (const branch of schema[key]) fill(branch, depth + 1)
  }
}

export function onRequest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.tools)) return
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue
    if (tool.function && tool.function.parameters) fill(tool.function.parameters, 0) // OpenAI Chat
    else if (tool.type === "function" && tool.parameters) fill(tool.parameters, 0) // OpenAI Responses
    else if (tool.input_schema) fill(tool.input_schema, 0) // Anthropic Messages
  }
  return body
}
