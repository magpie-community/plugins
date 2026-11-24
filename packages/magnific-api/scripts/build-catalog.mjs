// Builds catalog.json from Magnific's OpenAPI spec: one entry per image or
// video generation endpoint, with its status path and request parameters.
//   bun scripts/build-catalog.mjs [spec.yaml | url]
const SPEC = "https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml"
const src = process.argv[2] ?? SPEC
const text = /^https?:/.test(src) ? await (await fetch(src)).text() : await Bun.file(src).text()
const doc = Bun.YAML.parse(text)

const FAMILIES = /^\/v1\/ai\/(mystic$|(text-to-image|image-to-video|text-to-video|reference-to-video|video|video-edit)\/)/
// Not generations: it registers a reusable element.
const SKIP = new Set(["/v1/ai/video/kling-advanced-custom-elements"])
// Status paths the spec does not pair with their POST path by name.
const STATUS = {
  "/v1/ai/video/kling-v2-6-motion-control-pro": "/v1/ai/image-to-video/kling-v2-6",
  "/v1/ai/video/kling-v2-6-motion-control-std": "/v1/ai/image-to-video/kling-v2-6",
}

const deref = (o) => {
  while (o && typeof o === "object" && o.$ref) o = o.$ref.split("/").slice(1).reduce((t, p) => t[p], doc)
  return o
}
const fields = (schema) => {
  const s = deref(schema) ?? {}
  const props = {}, required = new Set(s.required ?? [])
  for (const sub of s.allOf ?? []) {
    const f = fields(sub)
    Object.assign(props, f.props)
    f.required.forEach((r) => required.add(r))
  }
  // Alternatives (text-to-video or image-to-video bodies of one endpoint):
  // every field is allowed, none of them is required on its own.
  for (const sub of [...(s.oneOf ?? []), ...(s.anyOf ?? [])]) {
    for (const [k, v] of Object.entries(fields(sub).props)) props[k] ??= v
  }
  for (const [k, v] of Object.entries(s.properties ?? {})) props[k] = deref(v) ?? {}
  return { props, required }
}
const oneLine = (s, max = 220) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}
const param = (p, required) => {
  const out = {}
  if (typeof p.type === "string") out.type = p.type
  if (required) out.required = true
  if (Array.isArray(p.enum)) out.enum = p.enum
  if (p.default !== undefined && typeof p.default !== "object") out.default = p.default
  for (const k of ["minimum", "maximum", "minItems", "maxItems"]) if (typeof p[k] === "number") out[k] = p[k]
  const items = deref(p.items)
  if (items?.type) out.items = items.type
  const text = [p.description, items?.description].filter(Boolean).join(" ")
  if (/base64/i.test(text)) out.base64 = true
  if (p.description) out.description = oneLine(p.description)
  return out
}
const statusPaths = new Set(Object.keys(doc.paths).filter((p) => p.endsWith("/{task-id}") && doc.paths[p].get))
const statusOf = (path) => {
  if (STATUS[path]) return STATUS[path]
  for (let p = path; ; ) {
    if (statusPaths.has(`${p}/{task-id}`)) return p
    const dash = p.lastIndexOf("-")
    if (dash <= p.lastIndexOf("/")) return null
    p = p.slice(0, dash)
  }
}

const models = {}, skipped = []
for (const [path, item] of Object.entries(doc.paths)) {
  if (!FAMILIES.test(path) || !item.post || SKIP.has(path)) continue
  const status = statusOf(path)
  const schema = item.post.requestBody?.content?.["application/json"]?.schema
  if (!status || !schema) { skipped.push(path); continue }
  const { props, required } = fields(schema)
  delete props.webhook_url
  const id = path.slice("/v1/ai/".length)
  models[id] = {
    name: oneLine(item.post.summary, 100),
    kind: /^(mystic|text-to-image)/.test(id) ? "image" : "video",
    path,
    status,
    params: Object.fromEntries(Object.entries(props).map(([k, p]) => [k, param(p, required.has(k))])),
  }
}
await Bun.write(new URL("../catalog.json", import.meta.url), JSON.stringify({ source: SPEC, models }, null, 1) + "\n")
const count = (kind) => Object.values(models).filter((m) => m.kind === kind).length
console.log(`catalog.json: ${count("image")} image, ${count("video")} video models; skipped: ${skipped.join(", ") || "none"}`)
