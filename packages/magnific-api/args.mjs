// Tool arguments, written once as JSON Schema properties. magpie takes JSON
// Schema as it is; OpenCode wants zod fields, made here from the same
// properties when its plugin package (and so its zod) can be imported.
export async function zodOf() {
  try { return (await import("@opencode-ai/plugin")).tool.schema ?? null } catch { return null }
}

function field(z, p) {
  if (p.enum) return z.enum(p.enum)
  if (p.type === "integer" || p.type === "number") {
    let n = p.type === "integer" ? z.number().int() : z.number()
    if (typeof p.minimum === "number") n = n.min(p.minimum)
    if (typeof p.maximum === "number") n = n.max(p.maximum)
    return n
  }
  if (p.type === "boolean") return z.boolean()
  if (p.type === "object") return z.record(z.string(), z.any())
  return z.string()
}

export function argsOf(properties, required = [], z = null) {
  if (!z) return { type: "object", properties, ...(required.length ? { required } : {}) }
  return Object.fromEntries(Object.entries(properties).map(([key, p]) => {
    const f = required.includes(key) ? field(z, p) : field(z, p).optional()
    return [key, p.description ? f.describe(p.description) : f]
  }))
}
