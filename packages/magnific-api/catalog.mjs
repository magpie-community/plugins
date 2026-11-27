// The model catalog (catalog.json, generated from Magnific's OpenAPI spec)
// and the checks that turn a tool call into a request body.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const models = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")).models
const MAX_FILE = 25 * 1024 * 1024

export function findModel(id) {
  const want = String(id ?? "").trim().replace(/^\/?(v1\/ai\/)?/, "")
  if (models[want]) return { id: want, ...models[want] }
  const hits = Object.keys(models).filter((k) => k.split("/").pop() === want)
  if (hits.length === 1) return { id: hits[0], ...models[hits[0]] }
  if (hits.length > 1) throw new Error(`Model "${want}" is ambiguous, use one of: ${hits.join(", ")}`)
  const near = Object.keys(models).filter((k) => want && k.includes(want)).slice(0, 12)
  throw new Error(`Unknown model "${want}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Call magnific_models to list models.`)
}

export function listModels({ kind, search } = {}) {
  const words = String(search ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(models)
    .filter(([id, m]) => (!kind || m.kind === kind) && words.every((w) => `${id} ${m.name}`.toLowerCase().includes(w)))
    .map(([id, m]) => ({ id, kind: m.kind, name: m.name }))
}

const localPath = (v) => {
  if (typeof v !== "string" || !/^(\/|~\/|\.\.?\/|file:\/\/)/.test(v)) return null
  const path = v.startsWith("file://") ? fileURLToPath(v) : resolve(v.replace(/^~(?=\/)/, homedir()))
  return existsSync(path) && statSync(path).isFile() ? path : null
}

const typeOk = (type, v) =>
  type === "string" ? typeof v === "string"
  : type === "integer" ? Number.isInteger(v)
  : type === "number" ? typeof v === "number" && Number.isFinite(v)
  : type === "boolean" ? typeof v === "boolean"
  : type === "array" ? Array.isArray(v)
  : type === "object" ? !!v && typeof v === "object" && !Array.isArray(v)
  : true

// The request body for a model, or an Error naming every argument that is
// wrong: catching it here costs no credits and tells the agent what to send.
export function buildBody(model, prompt, params = {}) {
  const body = { ...params }
  if (prompt !== undefined && prompt !== "") body.prompt = prompt
  const spec = model.params, problems = []
  for (const [key, value] of Object.entries(body)) {
    const p = spec[key]
    if (!p) { problems.push(`unknown parameter "${key}"`); continue }
    if (value === null || value === undefined) { delete body[key]; continue }
    if (!typeOk(p.type, value)) { problems.push(`"${key}" must be ${p.type}`); continue }
    if (p.enum && !p.enum.includes(value)) { problems.push(`"${key}" must be one of ${p.enum.join(", ")}`); continue }
    const encode = (v) => {
      const path = localPath(v)
      if (!path) return v
      if (!p.base64) { problems.push(`"${key}" needs a public https URL, this model does not take local files (${v})`); return v }
      if (statSync(path).size > MAX_FILE) { problems.push(`"${key}": ${v} is larger than 25 MB`); return v }
      return readFileSync(path).toString("base64")
    }
    body[key] = Array.isArray(value) ? value.map(encode) : encode(value)
  }
  for (const [key, p] of Object.entries(spec)) if (p.required && body[key] === undefined) problems.push(`"${key}" is required`)
  if (problems.length) {
    throw new Error(`${model.id}: ${problems.join("; ")}. Parameters: ${Object.keys(spec).join(", ")}. Call magnific_models with model="${model.id}" for details.`)
  }
  return body
}
