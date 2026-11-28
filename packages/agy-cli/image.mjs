import fs from "node:fs"
import path from "node:path"
import { OneshotAgyError, runOneshotAgySession } from "./oneshot-acp.mjs"

export const IMAGE_MODEL_ID = "gemini-3.1-flash-image"
export const IMAGE_MODEL_NAME = "Gemini 3.1 Flash Image"
const IMAGE_NPM = "@ai-sdk/openai-compatible"
const IMAGE_AGENT_NAME = "magpie-agy-image"
const IMAGE_OUTPUT_PREFIX = "magpie_generated"
const MAX_REFERENCE_IMAGES = 3
const MAX_DRAWINGS = 4
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024
const DEFAULT_IMAGE_TIMEOUT_MS = 8 * 60 * 1000

// Supported aspect ratios in agy's built-in generate_image schema.
export const AGY_ASPECT_RATIOS = Object.freeze(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"])

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
}

const emptyCost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const emptyCacheCost = { input: 0, output: 0, cache: { read: 0, write: 0 } }

// Provider config entry so Magpie and OpenCode see the image model before and
// after account catalog discovery.
export function imageConfigModels() {
  return {
    [IMAGE_MODEL_ID]: {
      name: IMAGE_MODEL_NAME,
      reasoning: false,
      tool_call: false,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["image"] },
      limit: { context: 0, output: 0 },
      cost: { ...emptyCost },
      variants: {},
      provider: { npm: IMAGE_NPM },
    },
  }
}

// Runtime catalog entry returned from provider.models().
// npm: @ai-sdk/openai-compatible + output: { text: false, image: true } tells
// Magpie's DrawersOf / pluginImagesOnly to route /v1/images/generations and
// /v1/images/edits (plus Magpie's generate_image MCP tool) through this
// plugin's loader.fetch.
export function imageModelEntry(providerID) {
  return {
    id: IMAGE_MODEL_ID,
    providerID,
    name: IMAGE_MODEL_NAME,
    npm: IMAGE_NPM,
    api: { id: IMAGE_MODEL_ID, url: "agy://local", npm: IMAGE_NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { ...emptyCacheCost },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: true,
      toolcall: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: false, image: true, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export function imageRoute(requestUrl) {
  let pathname = ""
  try {
    pathname = new URL(String(requestUrl || ""), "http://local").pathname
  } catch {
    return null
  }
  if (/\/images\/generations\/?$/i.test(pathname)) return "generations"
  if (/\/images\/edits\/?$/i.test(pathname)) return "edits"
  return null
}

// Magic-byte sniffing for the four image formats Gemini/agy accepts.
export function sniffImageMime(data) {
  const buf = typeof data === "string" ? Buffer.from(data.slice(0, 24), "base64") : data
  if (!buf || buf.length < 4) return null
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return "image/gif"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp"
  return null
}

// Maps an explicit aspect_ratio or OpenAI size ("1024x1024", "1536x1024",
// "1792x1024", "16:9", "auto", …) to the closest supported agy AspectRatio,
// or "" when unset / "auto" so edits preserve natural proportions unless asked.
export function pickAspectRatio(fields = {}) {
  const raw = String(fields.aspect_ratio || fields.size || "").trim()
  if (!raw || /^(?:auto|adaptive|default)$/i.test(raw)) return ""
  if (AGY_ASPECT_RATIOS.includes(raw)) return raw

  let numeric = null
  const colon = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(raw)
  if (colon) {
    const w = Number(colon[1])
    const h = Number(colon[2])
    if (w > 0 && h > 0) numeric = w / h
  } else {
    const dims = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw)
    if (dims) {
      const w = Number(dims[1])
      const h = Number(dims[2])
      if (w > 0 && h > 0) numeric = w / h
    }
  }
  if (!numeric || !Number.isFinite(numeric)) return ""

  let best = "1:1"
  let bestDist = Infinity
  for (const candidate of AGY_ASPECT_RATIOS) {
    const [cw, ch] = candidate.split(":").map(Number)
    const dist = Math.abs(Math.log(numeric / (cw / ch)))
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

function getHeader(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return headers.get(name) ?? ""
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")
  }
  return ""
}

async function readRawBodyBytes(fetchInput, init) {
  const body = init?.body
  if (body !== undefined && body !== null) {
    if (typeof FormData !== "undefined" && body instanceof FormData) return body
    if (typeof body === "string") return new TextEncoder().encode(body)
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
    if (typeof Response !== "undefined") {
      return new Uint8Array(await new Response(body).arrayBuffer())
    }
  }
  if (fetchInput && typeof fetchInput.arrayBuffer === "function") {
    return new Uint8Array(await fetchInput.arrayBuffer())
  }
  if (fetchInput && typeof fetchInput.text === "function") {
    return new TextEncoder().encode(await fetchInput.text())
  }
  return new Uint8Array()
}

function decodeImageString(value) {
  const raw = String(value ?? "").trim()
  if (!raw) throw new OneshotAgyError(400, "reference image is empty", { noRetry: true })
  if (/^https?:\/\//i.test(raw)) {
    throw new OneshotAgyError(400, "reference image must be uploaded as file bytes or a data: URL, not a remote URL", { noRetry: true })
  }
  let payload = raw
  let isBase64 = true
  if (/^data:/i.test(raw)) {
    const comma = raw.indexOf(",")
    if (comma < 0) throw new OneshotAgyError(400, "invalid data: URL in reference image", { noRetry: true })
    const meta = raw.slice(5, comma)
    payload = raw.slice(comma + 1)
    isBase64 = /;base64(?:;|$)/i.test(meta)
  } else if (!/^[A-Za-z0-9+/=\s_-]+$/.test(raw)) {
    throw new OneshotAgyError(400, "reference image must be a data: URL or base64 image data", { noRetry: true })
  }
  let buf
  try {
    buf = isBase64
      ? Buffer.from(payload.replace(/\s+/g, ""), "base64")
      : Buffer.from(decodeURIComponent(payload))
  } catch {
    throw new OneshotAgyError(400, "reference image base64 data is invalid", { noRetry: true })
  }
  return validateImageBytes(buf)
}

function decodeImageItem(item) {
  if (typeof item === "string") return decodeImageString(item)
  if (item && typeof item === "object") {
    const candidate = item.image_url?.url ?? item.image_url ?? item.url ?? item.b64_json ?? item.data
    if (typeof candidate === "string") return decodeImageString(candidate)
  }
  throw new OneshotAgyError(400, "unsupported reference image entry", { noRetry: true })
}

function validateImageBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!buf.length) throw new OneshotAgyError(400, "reference image is empty", { noRetry: true })
  if (buf.length > MAX_REFERENCE_BYTES) {
    throw new OneshotAgyError(400, "reference image exceeds the 32 MB limit", { noRetry: true })
  }
  const mimeType = sniffImageMime(buf)
  if (!mimeType) {
    const head = buf.subarray(0, 8).toString("hex")
    throw new OneshotAgyError(400, `reference image is not a valid PNG, JPEG, GIF or WebP image (first bytes: ${head})`, { noRetry: true })
  }
  return { bytes: buf, mimeType, ext: EXT_BY_MIME[mimeType] || ".png" }
}

async function parseMultipartImageRequest(rawOrForm, contentType) {
  let form
  if (typeof FormData !== "undefined" && rawOrForm instanceof FormData) {
    form = rawOrForm
  } else {
    try {
      form = await new Response(rawOrForm, { headers: { "content-type": contentType } }).formData()
    } catch {
      throw new OneshotAgyError(400, "request body could not be parsed as multipart/form-data", { noRetry: true })
    }
  }
  const fields = {}
  const references = []
  for (const [name, value] of form.entries()) {
    const key = String(name || "").trim()
    if (key === "mask" || key === "mask[]") {
      if (typeof value !== "string" || value.trim() !== "") {
        throw new OneshotAgyError(400, "agy image editing does not support mask inpainting; omit mask and describe the edit in prompt", { noRetry: true })
      }
      continue
    }
    if (typeof value === "string") {
      if (key === "image" || key === "image[]" || key === "images" || key === "images[]" || key === "reference_images" || key === "reference_images[]") {
        if (value.trim()) references.push(decodeImageString(value))
        continue
      }
      if (fields[key] === undefined) fields[key] = value
      continue
    }
    const buf = Buffer.from(await value.arrayBuffer())
    if (key === "image" || key === "image[]" || key === "images" || key === "images[]" || key === "reference_images" || key === "reference_images[]") {
      references.push(validateImageBytes(buf))
    }
  }
  return { fields, references }
}

function parseJsonImageRequest(rawBytes) {
  const text = Buffer.from(rawBytes).toString("utf8").trim()
  if (!text) throw new OneshotAgyError(400, "request body is empty", { noRetry: true })
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new OneshotAgyError(400, "request body must be valid JSON or multipart/form-data", { noRetry: true })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OneshotAgyError(400, "request body must be a JSON object", { noRetry: true })
  }
  if (parsed.mask != null && parsed.mask !== "" && parsed.mask !== false) {
    throw new OneshotAgyError(400, "agy image editing does not support mask inpainting; omit mask and describe the edit in prompt", { noRetry: true })
  }
  const references = []
  for (const key of ["image", "images", "reference_images"]) {
    const val = parsed[key]
    if (val == null || val === "") continue
    const items = Array.isArray(val) ? val : [val]
    for (const item of items) references.push(decodeImageItem(item))
  }
  return { fields: parsed, references }
}

export async function parseImageRequest(routeKind, fetchInput, init = {}) {
  const headers = init?.headers ?? fetchInput?.headers
  const contentType = getHeader(headers, "content-type")
  const raw = await readRawBodyBytes(fetchInput, init)
  const isMultipart = (typeof FormData !== "undefined" && raw instanceof FormData) ||
    /^multipart\/form-data\b/i.test(contentType.trim())

  const { fields, references } = isMultipart
    ? await parseMultipartImageRequest(raw, contentType)
    : parseJsonImageRequest(raw)

  const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : ""
  if (!prompt) throw new OneshotAgyError(400, "prompt is required", { noRetry: true })

  const rawN = fields.n === undefined || fields.n === null || fields.n === "" ? 1 : Number(fields.n)
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_DRAWINGS) {
    throw new OneshotAgyError(400, `n must be an integer from 1 to ${MAX_DRAWINGS}`, { noRetry: true })
  }

  if (routeKind === "edits" && references.length === 0) {
    throw new OneshotAgyError(400, "at least one reference image is required for /images/edits", { noRetry: true })
  }
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new OneshotAgyError(400, `agy generate_image supports at most ${MAX_REFERENCE_IMAGES} reference images (got ${references.length})`, { noRetry: true })
  }

  const responseFormat = typeof fields.response_format === "string" ? fields.response_format.trim().toLowerCase() : "b64_json"
  if (responseFormat && responseFormat !== "b64_json") {
    throw new OneshotAgyError(400, "agy image generation supports response_format \"b64_json\" only", { noRetry: true })
  }

  return {
    prompt,
    n: rawN,
    ratio: pickAspectRatio(fields),
    references,
    responseFormat: "b64_json",
  }
}

function imageAgentDefinition() {
  const lines = [
    "---",
    `name: ${IMAGE_AGENT_NAME}`,
    "description: Generates or edits an image with the built-in image generator",
    "mainAgent: true",
    "subagent: false",
    "tools:",
    "  - generate_image",
    "  - invoke_subagent",
    "  - view_file",
    "inheritMcp: false",
    "inheritCustomizations: false",
  ]
  if (process.env.AGY_BRIDGE_MINIMAL_AGENT === "1") lines.push("excludeDefaultComponents: true")
  lines.push(
    "---",
    "Follow the user's image generation instructions strictly. Use only the built-in image generation capability and never fabricate files.",
    "",
  )
  return lines.join("\n")
}

export function buildImagePrompt({ prompt, ratio, refPaths }) {
  const lines = [
    "Generate the image described below, then stop.",
    "",
    "Rules:",
    `- Call \`generate_image\` directly, exactly once, setting \`ImageName\` to \`${IMAGE_OUTPUT_PREFIX}\`. Only if \`generate_image\` is not directly in your tools, delegate once to the built-in \`image-generator\` subagent via \`invoke_subagent\` (asking it to name the output \`${IMAGE_OUTPUT_PREFIX}\`). Never call both.`,
  ]
  if (ratio) {
    lines.push(`- Set \`AspectRatio\` to \`${ratio}\` (pass it to \`generate_image\`, or state it in the subagent's prompt).`)
  }
  if (refPaths.length > 0) {
    lines.push("- Pass every path under Reference images below verbatim to `generate_image` as `ImagePaths` (if delegating to `image-generator`, instruct it to open each one with `view_file` first and then pass the exact paths in `ImagePaths`).")
  }
  lines.push(
    "- Do not run shell commands and do not write or modify any files yourself.",
    "- If the image generation tool is unavailable to this account, say in one line that image generation is unavailable and stop.",
    "- Keep your final text reply to one short line; the generated image file is collected from disk.",
  )
  if (refPaths.length > 0) {
    lines.push("", "Reference images:")
    for (const ref of refPaths) lines.push(`- ${ref}`)
  }
  lines.push("", "Description:", prompt, "")
  return lines.join("\n")
}

function isInsideDir(candidatePath, baseDir) {
  if (typeof candidatePath !== "string" || !candidatePath.trim() || !baseDir) return false
  const win = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(baseDir)
  const p = win ? path.win32 : path.posix
  const norm = (v) => {
    const resolved = p.resolve(v)
    return win ? resolved.toLowerCase() : resolved
  }
  const rel = p.relative(norm(baseDir), norm(candidatePath.trim()))
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel)
}

function requestedReadPaths(toolCall, parenArg = "") {
  const out = []
  for (const bag of [toolCall?.args, toolCall?.rawInput, toolCall?.input]) {
    if (!bag || typeof bag !== "object") continue
    for (const key of ["AbsolutePath", "FilePath", "TargetFile", "path", "file_path", "file"]) {
      if (typeof bag[key] === "string" && bag[key].trim()) out.push(bag[key])
    }
  }
  if (Array.isArray(toolCall?.locations)) {
    for (const loc of toolCall.locations) {
      if (typeof loc?.path === "string" && loc.path.trim()) out.push(loc.path)
    }
  }
  if (!out.length && typeof parenArg === "string" && parenArg.trim()) {
    out.push(parenArg.trim().replace(/^['"]|['"]$/g, ""))
  }
  return out
}

function requestedImagePaths(toolCall) {
  const out = []
  for (const bag of [toolCall?.args, toolCall?.rawInput, toolCall?.input]) {
    if (!bag || typeof bag !== "object") continue
    if (Array.isArray(bag.ImagePaths)) {
      for (const p of bag.ImagePaths) if (typeof p === "string") out.push(p)
    }
  }
  return out
}

function requestedSubagentNames(toolCall, parenArg = "") {
  const out = []
  for (const bag of [toolCall?.args, toolCall?.rawInput, toolCall?.input]) {
    if (!bag || typeof bag !== "object") continue
    for (const key of ["SubagentName", "subagent_name", "AgentName", "agent_name", "subagent", "agent", "name"]) {
      if (typeof bag[key] === "string" && bag[key].trim()) out.push(bag[key].trim())
    }
  }
  if (typeof parenArg === "string" && parenArg.trim()) {
    out.push(parenArg.trim().replace(/^['"]|['"]$/g, ""))
  }
  return out
}

// Strict permission gate for the throwaway image session: only generate_image,
// invoke_subagent(image-generator), and view_file/read_file inside wd may run.
export function isAllowedImagePermission(toolCall, wd) {
  const direct = String(toolCall?.name || toolCall?.toolName || "").trim()
  let name = direct.toLowerCase()
  let parenArg = ""
  if (!name && typeof toolCall?.title === "string") {
    const clean = toolCall.title.trim().replace(/\?$/, "")
    const fnMatch = /^(?:Run\s+)?(generate_image|invoke_subagent|view_file|read_file)(?:\((.*)\))?$/is.exec(clean)
    if (fnMatch) {
      name = fnMatch[1].toLowerCase()
      parenArg = fnMatch[2] ?? ""
    } else {
      const readMatch = /^Read\s+(.+)$/is.exec(clean)
      if (readMatch) {
        name = "read_file"
        parenArg = readMatch[1] ?? ""
      }
    }
  }
  if (!name) return false
  if (name === "invoke_subagent") {
    const targets = requestedSubagentNames(toolCall, parenArg)
    return targets.length > 0 && targets.every((t) => t.toLowerCase() === "image-generator")
  }
  if (name === "generate_image") {
    const paths = requestedImagePaths(toolCall)
    return paths.every((p) => isInsideDir(p, wd))
  }
  if (name === "view_file" || name === "read_file") {
    const paths = requestedReadPaths(toolCall, parenArg)
    return paths.length > 0 && paths.every((p) => isInsideDir(p, wd))
  }
  return false
}

export function isImageUnavailableReply(reply) {
  const lower = String(reply ?? "").toLowerCase()
  if (!lower.includes("image") || !lower.includes("generat")) return false
  return ["unavailable", "not available", "isn't available", "is not offered", "not offered", "cannot access"].some(
    (phrase) => lower.includes(phrase),
  )
}

export async function collectBrainImages(brainDir) {
  let entries
  try {
    entries = await fs.promises.readdir(brainDir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue
    const fullPath = path.join(brainDir, entry.name)
    try {
      const [stat, bytes] = await Promise.all([
        fs.promises.stat(fullPath),
        fs.promises.readFile(fullPath),
      ])
      const mimeType = sniffImageMime(bytes)
      if (mimeType) {
        candidates.push({ name: entry.name, bytes, mimeType, mtimeMs: stat.mtimeMs })
      }
    } catch {}
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  return candidates
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return Buffer.compare(a, b) === 0
}

// Prefer outputs matching the requested ImageName prefix (magpie_generated) so
// a copied reference image or view_file artifact in brain/ cannot win by mtime.
// When references are present (/images/edits), never return a file whose bytes
// match a reference image and never fall back to unprefixed files, since a
// viewed copy may not be byte-identical. Keep the unprefixed fallback for
// /images/generations where there are no references.
export function pickBrainImage(images, { references = [] } = {}) {
  if (!Array.isArray(images) || !images.length) return null
  const hasRefs = Array.isArray(references) && references.length > 0
  const filtered = hasRefs
    ? images.filter((img) => !references.some((ref) => sameBytes(img?.bytes, ref?.bytes ?? ref)))
    : images
  if (!filtered.length) return null
  const preferred = filtered.filter((img) => String(img?.name || "").toLowerCase().startsWith(IMAGE_OUTPUT_PREFIX))
  if (preferred.length) return preferred.at(-1) || null
  if (hasRefs) return null
  return filtered.at(-1) || null
}

function configuredImageTimeout() {
  const raw = Number(process.env.AGY_BRIDGE_IMAGE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IMAGE_TIMEOUT_MS
}

async function runOneImageAgy(parsed, deps, signal) {
  return runOneshotAgySession({
    label: "image generation",
    tempPrefix: "magpie-agy-image-",
    agentName: IMAGE_AGENT_NAME,
    agentDefinition: imageAgentDefinition(),
    driverEnvVar: "AGY_BRIDGE_IMAGE_DRIVER",
    timeoutMs: configuredImageTimeout(),
    signal,
    deps,
    setupWorkdir: async (wd) => {
      const refPaths = []
      for (let i = 0; i < parsed.references.length; i++) {
        const ref = parsed.references[i]
        const refPath = path.join(wd, `ref_${i + 1}${ref.ext}`)
        await fs.promises.writeFile(refPath, ref.bytes, { mode: 0o600 })
        refPaths.push(refPath)
      }
      return { refPaths }
    },
    buildPrompt: ({ refPaths }) => buildImagePrompt({ prompt: parsed.prompt, ratio: parsed.ratio, refPaths }),
    isAllowedPermission: (toolCall, wd) => isAllowedImagePermission(toolCall, wd),
    afterPrompt: async ({ sessionId, agyDir, promptResult }) => {
      const brainDir = path.join(agyDir, "brain", sessionId)
      const images = await collectBrainImages(brainDir)
      const chosen = pickBrainImage(images, { references: parsed.references })
      if (!chosen) return { ok: false }
      const usage = promptResult?.usage
      const inputTokens = Number(usage?.inputTokens ?? 0) + Number(usage?.cachedReadTokens ?? 0)
      const outputTokens = Number(usage?.outputTokens ?? 0)
      return {
        ok: true,
        value: {
          image: chosen,
          inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0,
          outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0,
        },
      }
    },
    isUnavailableReply: isImageUnavailableReply,
    unavailableMessage: () => "this Antigravity account is not offered image generation",
    emptyFallbackMessage: (trimmedReply, trimmedErr) => {
      const reason = trimmedErr || trimmedReply
      return reason
        ? `Antigravity returned no generated image (${reason.slice(0, 240)})`
        : "Antigravity returned no generated image"
    },
  })
}

export async function handleImageFetch(routeKind, fetchInput, init = {}, deps = {}) {
  const { jsonError } = deps
  const respondError = (status, message, opts) => (
    typeof jsonError === "function"
      ? jsonError(status, message, opts?.code, { headers: opts?.headers, noRetry: opts?.noRetry })
      : new Response(JSON.stringify({ error: { message, type: status === 400 ? "invalid_request_error" : "api_error" } }), {
          status,
          headers: { "Content-Type": "application/json" },
        })
  )

  const method = String(init?.method ?? fetchInput?.method ?? "POST").toUpperCase()
  if (method !== "POST") {
    return respondError(405, "use POST for /images/generations and /images/edits", { noRetry: true })
  }

  let parsed
  try {
    parsed = await parseImageRequest(routeKind, fetchInput, init)
  } catch (err) {
    return respondError(err?.statusCode ?? 400, err?.message || String(err), { noRetry: true })
  }

  const signal = init?.signal ?? fetchInput?.signal
  const batchController = parsed.n > 1 ? new AbortController() : null
  const onCallerAbort = batchController ? () => batchController.abort() : null
  if (batchController && signal) {
    if (signal.aborted) batchController.abort()
    else signal.addEventListener("abort", onCallerAbort, { once: true })
  }
  const runSignal = batchController ? batchController.signal : signal
  const tasks = Array.from({ length: parsed.n }, () =>
    runOneImageAgy(parsed, deps, runSignal).catch((err) => {
      batchController?.abort()
      throw err
    }),
  )
  try {
    const runs = await Promise.all(tasks)
    const totalInput = runs.reduce((sum, r) => sum + r.inputTokens, 0)
    const totalOutput = runs.reduce((sum, r) => sum + r.outputTokens, 0)
    const payload = {
      created: Math.floor(Date.now() / 1000),
      data: runs.map(({ image }) => ({
        b64_json: image.bytes.toString("base64"),
        media_type: image.mimeType,
      })),
      ...(totalInput || totalOutput ? { usage: { input_tokens: totalInput, output_tokens: totalOutput } } : {}),
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    batchController?.abort()
    if (tasks.length > 1) await Promise.allSettled(tasks)
    return respondError(err?.statusCode ?? 502, err?.message || String(err), {
      code: err?.code,
      headers: err?.headers,
      noRetry: Boolean(err?.noRetry),
    })
  } finally {
    if (onCallerAbort) signal?.removeEventListener("abort", onCallerAbort)
  }
}
