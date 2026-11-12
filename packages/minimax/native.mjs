// Magpie-native image generation, video generation, and web search for
// MiniMax Code. These use the same MiniMax Code APIs as the plugin's named
// tools (the Matrix connector for image and video, /mavis/api/v1/mcp/web_search
// for search). Magpie lists them in Settings → Images / Video / Web search
// and serves them through /mcp/magpie/image, its videos API, and
// /mcp/magpie/web-search, so an agent can drop the separate MiniMax tools.
//
// The named tools stay; this is additive.
//
// How Magpie finds them:
//   - web search: the plugin search hook ({search: {<id>: {name, auth, execute}}}),
//     listed beside Tavily and the rest, signed in as this provider.
//   - image: a model that gives images alone, spoken with
//     @ai-sdk/openai-compatible, drawn at the OpenAI images API through this
//     plugin's fetch (plugin://<id>/v1/images/generations and /images/edits).
//   - video: models whose capabilities.output includes video, started at
//     the OpenAI-shaped videos API through the same fetch
//     (plugin://<id>/v1/videos).
//
// generate_image has no model id of its own in the live catalog, so the
// image model is listed as MiniMax-Image. Video models are the real
// submit_video_generation enums: MiniMax-H3, MiniMax-H3-Max, MiniMax-Hailuo-2.3.
//
// Magpie's plugin drawer that isn't Codex or SenseNova sends edits as
// multipart/form-data (image bytes, optional mask). generate_image takes
// no mask, so a mask part is refused with a 400 rather than drawn from as
// one more reference image. A local video frame
// arrives as a data: URL. Those bytes are uploaded through the live
// catalog's upload_temp_url flow (a signed form, then a POST of the
// file) before generate_image / submit_video_generation. HTTPS URLs are
// passed through. get_asset_url is retried briefly while the URL still
// has /visible/, the watermarked rendition reported in #974.

import { callMatrixTool, _internal as matrix } from "./connector-tools.mjs"

const IMAGE_NPM = "@ai-sdk/openai-compatible"
const MATRIX = "connector__matrix__"
const LIST_MS = 30 * 1000
const UPLOAD_MS = 55 * 1000
const MAX_UPLOAD = 64 * 1024 * 1024
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"])

export const IMAGE_MODEL_ID = "MiniMax-Image"
export const VIDEO_MODEL_IDS = Object.freeze(["MiniMax-H3", "MiniMax-H3-Max", "MiniMax-Hailuo-2.3"])

const VIDEO_NAMES = {
  "MiniMax-H3": "MiniMax H3",
  "MiniMax-H3-Max": "MiniMax H3 Max",
  "MiniMax-Hailuo-2.3": "MiniMax Hailuo 2.3",
}

const VIDEO_DEFAULTS = {
  "MiniMax-H3": { duration: 6, resolution: "2K" },
  "MiniMax-H3-Max": { duration: 6, resolution: "768P" },
  "MiniMax-Hailuo-2.3": { duration: 6, resolution: "768P" },
}

export const MEDIA_MODEL_IDS = Object.freeze([IMAGE_MODEL_ID, ...VIDEO_MODEL_IDS])

const emptyCost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const emptyCache = { input: 0, output: 0, cache: { read: 0, write: 0 } }

// mediaConfigModels are the image and video models added to the provider
// config (and kept when the live chat list is used), so Magpie can offer
// them in Settings → Images and Video.
export function mediaConfigModels() {
  const out = {
    [IMAGE_MODEL_ID]: {
      name: "MiniMax Image",
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
  for (const id of VIDEO_MODEL_IDS) {
    out[id] = {
      name: VIDEO_NAMES[id],
      reasoning: false,
      tool_call: false,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["video"] },
      limit: { context: 0, output: 0 },
      cost: { ...emptyCost },
      variants: {},
    }
  }
  return out
}

// mediaModelOf is one media model as provider.models returns it (OpenCode
// internal form). Image models name @ai-sdk/openai-compatible so Magpie
// lists them as drawers; video models only need output.video.
export function mediaModelOf(site, provider, m) {
  const image = m.outputs[0] === "image"
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: site.llm + "/mavis/api/v1/llm/v1", npm: image ? IMAGE_NPM : "@ai-sdk/anthropic" },
    status: "active",
    headers: {},
    options: {},
    cost: emptyCache,
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: true,
      toolcall: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: false, image, audio: false, video: !image, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export function mediaModels(site, provider) {
  const conf = mediaConfigModels()
  return Object.fromEntries(MEDIA_MODEL_IDS.map((id) => {
    const c = conf[id]
    return [id, mediaModelOf(site, provider, { id, name: c.name, outputs: c.modalities.output })]
  }))
}

// withMediaModels appends the image and video models after the chat list,
// replacing any same-id row the live catalog may one day include.
export function withMediaModels(chat, site, provider) {
  return { ...chat, ...mediaModels(site, provider) }
}

// ---- web search hook ----------------------------------------------------------

const SEARCH_BAGS = ["organic", "results", "news", "videos", "places", "shopping", "web"]

// pagesFrom maps MiniMax Code's web_search payload to Magpie search pages
// ({title, url, text, age}).
export function pagesFrom(payload) {
  const out = []
  const seen = new Set()
  const push = (row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return
    const url = str(row.url ?? row.link ?? row.href)
    const title = str(row.title ?? row.name) || url
    if (!url && !title) return
    const key = url || title
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      title,
      url,
      text: str(row.text ?? row.content ?? row.snippet ?? row.description ?? row.summary),
      age: str(row.age ?? row.date ?? row.published_time ?? row.published),
    })
  }
  if (Array.isArray(payload)) {
    payload.forEach(push)
    return out
  }
  if (!payload || typeof payload !== "object") return out
  let any = false
  for (const key of SEARCH_BAGS) {
    if (Array.isArray(payload[key])) {
      payload[key].forEach(push)
      any = true
    }
  }
  if (!any && payload.data && typeof payload.data === "object") return pagesFrom(payload.data)
  return out
}

// createSearchHook is the plugin search hook for one MiniMax Code site.
// post(access, path, body, opts) POSTs a JSON body with that access token
// and returns the parsed object (base_resp already checked). A throw from
// post should carry a numeric status (401, 402, 403, 429) when the API
// refused the account, so Magpie can rest it for search.
export function createSearchHook(site, post) {
  return {
    [site.id]: {
      name: site.name,
      auth: site.id,
      async execute({ query, count } = {}, ctx = {}) {
        const q = typeof query === "string" ? query.trim() : ""
        if (!q) throw new Error("query is required")
        const a = await ctx.getAuth?.()
        if (!a?.access) throw new Error("not signed in to " + site.name)
        const body = { query: q }
        if (Number.isInteger(count) && count > 0) body.count = count
        ctx.abort?.throwIfAborted?.()
        const env = await post(a.access, "/mavis/api/v1/mcp/web_search", body, { signal: ctx.abort, timeoutMs: 120000 })
        const { base_resp: _b, statusInfo: _s, ...payload } = env && typeof env === "object" ? env : {}
        return pagesFrom(payload)
      },
    },
  }
}

// ---- OpenAI images / videos API through the plugin's fetch --------------------

const GEN_MS = 10 * 60 * 1000
const CALL_MS = 55 * 1000

// mediaPath is the OpenAI-shaped images or videos route on url, or null
// when the request is ordinary chat and should go on to MiniMax Code.
export function mediaPath(url) {
  let path
  try {
    path = new URL(url, "http://local").pathname
  } catch {
    return null
  }
  if (path.endsWith("/images/generations")) return { kind: "image.generations" }
  if (path.endsWith("/images/edits")) return { kind: "image.edits" }
  if (path.endsWith("/videos")) return { kind: "video.create" }
  const got = /\/videos\/([^/]+)(?:\/(content))?$/.exec(path)
  if (!got) return null
  let id
  try { id = decodeURIComponent(got[1]) } catch { id = got[1] }
  return { kind: got[2] === "content" ? "video.content" : "video.get", id }
}

// handleMediaFetch answers an OpenAI images or videos request by calling
// MiniMax Code's Matrix tools. It returns null when url is not a media
// route, so the chat fetch can send the request on. headers must include
// the request Content-Type when the body is multipart/form-data, as Magpie
// sends it for /images/edits.
export async function handleMediaFetch(url, { method, body, headers, signal } = {}, { request, siteId } = {}) {
  const route = mediaPath(url)
  if (!route) return null
  if (typeof request !== "function" || !siteId) {
    return errorResponse(500, "MiniMax Code media: missing request transport")
  }
  const verb = (method ?? "GET").toUpperCase()
  try {
    if (route.kind === "image.generations" || route.kind === "image.edits") {
      if (verb !== "POST") return errorResponse(405, "use POST to generate an image")
      return await generateImage(request, siteId, body, headers, signal, route.kind === "image.edits")
    }
    if (route.kind === "video.create") {
      if (verb !== "POST") return errorResponse(405, "use POST to start a video")
      return await startVideo(request, siteId, body, headers, signal)
    }
    if (verb !== "GET") return errorResponse(405, "use GET to read a video")
    if (route.kind === "video.get") return await getVideo(request, siteId, route.id, signal)
    return await videoContent(request, siteId, route.id, signal)
  } catch (e) {
    const status = e?.status && Number.isInteger(e.status) ? e.status : 502
    return errorResponse(status, e?.message ?? String(e))
  }
}

async function generateImage(request, siteId, body, headers, signal, edits) {
  const input = await mediaInput(body, headers)
  const req = input.fields
  const prompt = str(req.prompt)
  if (!prompt) throw Object.assign(new Error("prompt is required"), { status: 400 })
  const n = integer(req.n, 1)
  if (n < 1 || n > 10) throw Object.assign(new Error("n must be an integer from 1 to 10"), { status: 400 })
  const item = { prompt, n }
  const aspect = str(req.aspect_ratio) || aspectFromSize(req.size)
  if (aspect) item.aspect_ratio = aspect
  const area = areaOf(req)
  if (area) item.area = area
  const refs = await referenceImages(request, siteId, req, input.files, signal, edits)
  if (refs) item.reference_images = refs
  const result = await callMatrixTool(request, siteId, "generate_image", { requests: [item] }, { signal, timeoutMs: GEN_MS })
  const items = Array.isArray(result?.success_items) ? result.success_items : []
  if (!items.length) throw new Error("MiniMax Image returned no images")
  const data = []
  for (const row of items) {
    const node = str(row?.node_id)
    if (!node) throw new Error("MiniMax Image returned no node_id")
    data.push({ url: await assetUrl(request, siteId, node, signal) })
  }
  return jsonResponse({ created: Math.floor(Date.now() / 1000), data })
}

async function startVideo(request, siteId, body, headers, signal) {
  const req = (await mediaInput(body, headers)).fields
  const model = str(req.model)
  if (!VIDEO_MODEL_IDS.includes(model)) {
    throw Object.assign(new Error("model must be one of " + VIDEO_MODEL_IDS.join(", ")), { status: 400 })
  }
  const prompt = str(req.prompt)
  if (!prompt) throw Object.assign(new Error("prompt is required"), { status: 400 })
  const defaults = VIDEO_DEFAULTS[model]
  const duration = durationOf(req.seconds, defaults.duration, model)
  const args = { model, prompt, duration }
  const resolution = resolutionOf(req.size, defaults.resolution, model)
  if (resolution) args.resolution = resolution
  const ratio = str(req.ratio) || aspectFromSize(req.size)
  if (ratio && ratio !== "auto") args.ratio = ratio
  const start = await resolveMedia(request, siteId, req.input_reference ?? req.input_image, signal)
  const end = await resolveMedia(request, siteId, req.last_frame ?? req.last_frame_image, signal)
  if (start) {
    args.input_image = start
    args.reference_type = "first_frame"
  }
  if (end) args.last_frame_image = end
  const refs = await resolveMediaList(request, siteId, req.reference_images, signal)
  if (refs) args.reference_images = refs
  const result = await callMatrixTool(request, siteId, "submit_video_generation", args, { signal, timeoutMs: CALL_MS })
  const task = str(result?.task_id ?? result?.taskId ?? result?.id)
  if (!task) throw new Error("MiniMax video returned no task_id")
  return jsonResponse({
    id: encodeVideoId(model, task),
    object: "video",
    created_at: Math.floor(Date.now() / 1000),
    status: "queued",
    progress: 0,
    model,
    seconds: String(duration),
  })
}

async function getVideo(request, siteId, id, signal) {
  const { model, task } = decodeVideoId(id)
  const result = await queryVideo(request, siteId, model, task, signal)
  const status = videoStatus(result)
  const obj = {
    id,
    object: "video",
    created_at: integer(result?.created_at, Math.floor(Date.now() / 1000)),
    status: status.openai,
    progress: status.progress,
    model,
  }
  if (result?.duration != null) obj.seconds = String(result.duration)
  if (status.openai === "failed") {
    obj.error = { code: str(result?.error_code ?? result?.code) || "failed", message: str(result?.error_message ?? result?.message ?? result?.failure) || "the video failed" }
  }
  return jsonResponse(obj)
}

async function videoContent(request, siteId, id, signal) {
  const { model, task } = decodeVideoId(id)
  const result = await queryVideo(request, siteId, model, task, signal)
  const status = videoStatus(result)
  if (status.openai !== "completed") {
    throw Object.assign(new Error("the video is not ready yet (" + status.openai + ")"), { status: 409 })
  }
  const node = str(result?.node_id ?? result?.success_items?.[0]?.node_id)
  if (!node) throw new Error("MiniMax video returned no node_id")
  const url = await assetUrl(request, siteId, node, signal)
  const res = await _native.fetch(url, { signal, redirect: "follow" })
  if (!res.ok) throw new Error("MiniMax video download: HTTP " + res.status)
  const headers = new Headers(res.headers)
  // fetch has already decoded the body: passing these on would have the
  // client decode it again, or expect the encoded length
  headers.delete("content-encoding")
  headers.delete("content-length")
  if (!headers.get("content-type")) headers.set("content-type", "video/mp4")
  return new Response(res.body, { status: 200, headers })
}

async function queryVideo(request, siteId, model, task, signal) {
  return callMatrixTool(request, siteId, "query_video_generation", { model, task_id: task }, { signal, timeoutMs: CALL_MS })
}

// assetUrl asks get_asset_url, and retries for a short while when the
// answer still has /visible/ (the watermarked rendition #974 reports
// right after a generation). If the wait runs out, the last URL is
// returned as-is.
async function assetUrl(request, siteId, nodeId, signal) {
  const deadline = Date.now() + _native.visibleWaitMs
  let url = ""
  for (;;) {
    const asset = await callMatrixTool(request, siteId, "get_asset_url", { node_id: nodeId }, { signal, timeoutMs: CALL_MS })
    url = str(asset?.download_url ?? asset?.url ?? asset?.temp_url)
    if (!url) throw new Error("get_asset_url returned no download_url")
    if (!url.includes("/visible/") || Date.now() >= deadline) return url
    const wait = Math.min(_native.visibleStepMs, Math.max(0, deadline - Date.now()))
    if (!wait) return url
    await _native.sleep(wait, signal)
  }
}

export function encodeVideoId(model, task) {
  return model + "::" + task
}

export function decodeVideoId(id) {
  const split = String(id ?? "").indexOf("::")
  if (split <= 0) throw Object.assign(new Error("not a MiniMax Code video id"), { status: 404 })
  const model = id.slice(0, split)
  const task = id.slice(split + 2)
  if (!VIDEO_MODEL_IDS.includes(model) || !task) throw Object.assign(new Error("not a MiniMax Code video id"), { status: 404 })
  return { model, task }
}

export function videoStatus(result) {
  const raw = str(result?.status ?? result?.task_status ?? result?.state ?? result?.taskStatus).toLowerCase()
  if (raw === "succeeded" || raw === "success" || raw === "completed" || raw === "done") return { openai: "completed", progress: 100 }
  if (raw === "failed" || raw === "error" || raw === "cancelled" || raw === "canceled" || raw === "expired") return { openai: "failed", progress: integer(result?.progress, 0) }
  if (raw === "running" || raw === "processing" || raw === "in_progress" || raw === "generating") {
    const p = integer(result?.progress, 0)
    return { openai: "in_progress", progress: p > 0 && p < 100 ? p : 50 }
  }
  return { openai: "queued", progress: integer(result?.progress, 0) }
}

async function referenceImages(request, siteId, req, files, signal, edits) {
  // generate_image has no mask input: a mask uploaded as a reference image
  // would be drawn from as one more picture, so it is refused, the way
  // magpie refuses mask edits for drawers that can't take one.
  if ((files ?? []).some((f) => f.field === "mask"))
    throw Object.assign(new Error("MiniMax Image does not support mask edits"), { status: 400 })
  const parts = (files ?? []).filter((f) => f.field === "image" || f.field === "image[]")
  if (parts.length) {
    const out = []
    for (const part of parts) out.push(await uploadBytes(request, siteId, part, signal))
    return out
  }
  const fromList = await resolveMediaList(request, siteId, req.reference_images, signal)
  if (fromList) return fromList
  const one = await resolveMedia(request, siteId, req.image ?? req.image_url, signal)
  if (one) return [one]
  if (edits) throw Object.assign(new Error("image edits need a reference image"), { status: 400 })
  return undefined
}

async function resolveMediaList(request, siteId, value, signal) {
  if (!Array.isArray(value) || !value.length) return undefined
  const out = []
  for (const item of value) {
    const u = await resolveMedia(request, siteId, item, signal)
    if (!u) throw Object.assign(new Error("reference images must be HTTPS or data: URLs"), { status: 400 })
    out.push(u)
  }
  return out
}

async function resolveMedia(request, siteId, value, signal) {
  const ref = mediaRef(value)
  if (!ref) return undefined
  if (ref.url.startsWith("data:")) {
    const file = parseDataUrl(ref.url)
    if (ref.mime_type) file.mime = normalizeMime(ref.mime_type) || file.mime
    return uploadBytes(request, siteId, file, signal)
  }
  return ref
}

// mediaRef reads one media argument: an HTTPS URL (kept as-is) or a
// data: URL (uploaded later). Other schemes, including http: and file:,
// are refused.
export function mediaRef(value) {
  if (typeof value === "string") {
    const url = value.trim()
    if (!url) return undefined
    if (url.startsWith("data:")) return { url }
    if (url.startsWith("file:") || /^[.]{0,2}\//.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url) || !/^https:/i.test(url)) {
      throw Object.assign(new Error("media must be an HTTPS URL or a data: URL"), { status: 400 })
    }
    return { url }
  }
  if (value && typeof value === "object") {
    const url = str(value.url)
    if (!url) return undefined
    const one = mediaRef(url)
    const mime = maybeMime(value.mime_type)
    if (mime) one.mime_type = mime
    return one
  }
  return undefined
}

async function uploadBytes(request, siteId, file, signal) {
  const bytes = file?.bytes
  if (!bytes || !bytes.length) throw Object.assign(new Error("the reference image was empty"), { status: 400 })
  if (bytes.length > MAX_UPLOAD) throw Object.assign(new Error("the reference image is larger than 64 MB"), { status: 400 })
  const mime = normalizeMime(file.mime) || "application/octet-stream"
  const filename = str(file.filename) || filenameOf(mime)
  const signed = await requestUpload(request, siteId, { bytes, mime, filename }, signal)
  if (signed.maxBytes != null && bytes.length > signed.maxBytes) {
    throw new Error("the reference image is larger than the upload limit (" + signed.maxBytes + " bytes)")
  }
  if (signed.uploadHost) await postSignedUpload(signed, { bytes, mime, filename }, signal)
  else if (!signed.sentBytes) throw new Error("upload_temp_url returned no upload_host")
  const url = str(signed.tempUrl)
  if (!url) throw new Error("upload_temp_url returned no temp_url")
  const out = { url }
  const mt = maybeMime(mime)
  if (mt) out.mime_type = mt
  return out
}

async function requestUpload(request, siteId, file, signal) {
  const cat = await matrix.catalog(request, siteId, signal)
  const entry = findUpload(cat)
  let schema = {}
  if (entry.input_schema_json) {
    try {
      const v = JSON.parse(entry.input_schema_json)
      if (v && typeof v === "object" && !Array.isArray(v)) schema = v
    } catch {
      throw new Error("MiniMax connector list: malformed input_schema_json")
    }
  }
  const { args, sentBytes } = uploadArgsFromSchema(schema, file)
  const result = await matrix.invoke(request, siteId, entry, args, signal, UPLOAD_MS)
  return { ...parseSignedUpload(result), sentBytes }
}

function findUpload(cat) {
  const match = cat.tools.find((t) => {
    const run = t.runtime_tool_name ?? ""
    const prov = t.provider_tool_name ?? ""
    return run === MATRIX + "upload_temp_url" || run.endsWith("__upload_temp_url") || prov === "upload_temp_url" || /(?:^|_)upload_temp_url$/.test(prov)
  })
  if (match) return match
  return matrix.find(cat, MATRIX + "upload_temp_url")
}

function uploadArgsFromSchema(schema, file) {
  const props = schema && typeof schema === "object" ? schema.properties ?? {} : {}
  const names = Object.keys(props)
  const pick = (...cands) => cands.find((n) => names.includes(n))
  const args = {}
  const fn = pick("filename", "file_name", "name", "fileName")
  if (fn) args[fn] = file.filename
  const mt = pick("mime_type", "mimeType", "content_type", "contentType", "mime")
  if (mt) args[mt] = file.mime
  const sz = pick("size_bytes", "size", "bytes", "content_length")
  if (sz) args[sz] = file.bytes.length
  const dataKey = pick("data", "content", "content_base64", "bytes_base64", "file_base64", "base64")
  if (dataKey) args[dataKey] = Buffer.from(file.bytes).toString("base64")
  if (!names.length) return { args: { filename: file.filename, mime_type: file.mime }, sentBytes: false }
  if (!Object.keys(args).length) {
    if (pick("file_path", "path", "local_path")) {
      throw new Error("upload_temp_url on this account takes a local path, which the plugin cannot supply")
    }
    return { args: { filename: file.filename, mime_type: file.mime }, sentBytes: false }
  }
  return { args, sentBytes: Boolean(dataKey) }
}

function parseSignedUpload(value) {
  let raw = value
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) } catch { raw = null }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.result_json === "string") {
    try {
      const inner = JSON.parse(raw.result_json)
      if (inner && typeof inner === "object") raw = inner
    } catch {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("upload_temp_url returned no upload form")
  if (raw.code !== undefined && Number(raw.code) !== 0) {
    throw new Error("upload_temp_url: " + (str(raw.message) ?? "request failed") + " (code=" + raw.code + ")")
  }
  const uploadHost = str(raw.upload_host ?? raw.uploadHost ?? raw.upload_url ?? raw.uploadUrl)
  const tempUrl = str(raw.temp_url ?? raw.tempUrl ?? raw.url)
  const fields = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? raw.fields : {}
  const normalized = {}
  for (const [key, item] of Object.entries(fields)) if (typeof item === "string") normalized[key] = item
  const fileFieldName = str(raw.file_field_name ?? raw.fileFieldName) || "file"
  const maxBytes = Number.isFinite(Number(raw.max_bytes ?? raw.maxBytes)) ? Number(raw.max_bytes ?? raw.maxBytes) : null
  return { uploadHost, tempUrl, fields: normalized, fileFieldName, maxBytes }
}

async function postSignedUpload(signed, file, signal) {
  if (!allowedUploadHost(signed.uploadHost)) {
    throw new Error("upload_temp_url returned an upload host that is not HTTPS")
  }
  const form = new FormData()
  for (const [key, item] of Object.entries(signed.fields)) form.append(key, item)
  form.append(signed.fileFieldName, new Blob([file.bytes], { type: file.mime }), file.filename)
  const abort = AbortSignal.any([AbortSignal.timeout(UPLOAD_MS), ...(signal ? [signal] : [])])
  let res
  try {
    res = await _native.fetch(signed.uploadHost, { method: "POST", body: form, signal: abort, redirect: "follow" })
  } catch (e) {
    abort.throwIfAborted?.()
    throw new Error("MiniMax upload: " + (e?.message ?? String(e)))
  }
  if (!res.ok) throw new Error("MiniMax upload: HTTP " + res.status)
}

function allowedUploadHost(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === "https:"
}

function parseDataUrl(url) {
  const m = /^data:([^,]*),(.*)$/s.exec(url)
  if (!m) throw Object.assign(new Error("media data: URL is malformed"), { status: 400 })
  const meta = m[1]
  const payload = m[2]
  const isB64 = /;base64(?:;|$)/i.test(";" + meta)
  const mime = normalizeMime(meta.replace(/;base64$/i, "").replace(/;base64;/ig, ";").replace(/;charset=[^;]*/ig, "").replace(/^;|;$/g, "")) || "application/octet-stream"
  let bytes
  try {
    bytes = isB64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload))
  } catch {
    throw Object.assign(new Error("media data: URL isn't valid"), { status: 400 })
  }
  if (!bytes.length) throw Object.assign(new Error("the reference image was empty"), { status: 400 })
  return { bytes: new Uint8Array(bytes), mime, filename: filenameOf(mime), field: "image" }
}

async function mediaInput(body, headers) {
  if (body && typeof FormData !== "undefined" && body instanceof FormData) return fromFormData(body)
  const ct = getHeader(headers, "content-type")
  const mime = ct.split(";")[0].trim().toLowerCase()
  if (mime === "multipart/form-data") return fromMultipart(body, ct)
  return { fields: jsonBody(body), files: [] }
}

async function fromMultipart(body, contentType) {
  const bytes = await bytesOf(body)
  const res = new Response(bytes, { headers: { "content-type": contentType } })
  let form
  try {
    form = await res.formData()
  } catch {
    throw Object.assign(new Error("request body must be multipart form data"), { status: 400 })
  }
  return fromFormData(form)
}

async function fromFormData(form) {
  const fields = {}
  const files = []
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      if (fields[name] === undefined) fields[name] = value
      continue
    }
    const bytes = new Uint8Array(await value.arrayBuffer())
    const mime = normalizeMime(value.type) || sniffMime(bytes)
    const filename = str(value.name) || filenameOf(mime)
    files.push({ field: name, bytes, mime, filename })
  }
  return { fields, files }
}

async function bytesOf(body) {
  if (body == null || body === "") return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  throw Object.assign(new Error("request body must be a JSON object or multipart form data"), { status: 400 })
}

function getHeader(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return headers.get(name) ?? ""
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? (v[0] ?? "") : (v ?? "")
  }
  return ""
}

function normalizeMime(value) {
  const v = String(value ?? "").trim().toLowerCase()
  if (!v || v === "application/octet-stream") return ""
  if (v === "image/jpg") return "image/jpeg"
  return v
}

function maybeMime(value) {
  const v = normalizeMime(value)
  return IMAGE_MIMES.has(v) ? v : undefined
}

function filenameOf(mime) {
  const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif" }[normalizeMime(mime)] ?? ""
  return "image" + ext
}

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return "application/octet-stream"
}

function aspectFromSize(size) {
  const s = str(size)
  if (!s) return undefined
  if (/^\d+:\d+$/.test(s) || s === "auto" || s === "adaptive") return s === "adaptive" ? "adaptive" : s
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s)
  if (!m) return undefined
  const w = Number(m[1]), h = Number(m[2])
  if (!w || !h) return undefined
  const g = gcd(w, h)
  return w / g + ":" + h / g
}

function areaOf(req) {
  const a = str(req.area)
  if (a === "1K" || a === "2K" || a === "4K") return a
  const q = str(req.quality).toLowerCase()
  if (q === "low") return "1K"
  if (q === "medium") return "2K"
  if (q === "high" || q === "xhigh" || q === "max") return "4K"
  return areaFromSize(req.size)
}

// areaFromSize maps an OpenAI-style size (1024x1024, …) onto MiniMax's
// area tier, so Magpie's usual square doesn't fall through to the vendor
// 4K default.
function areaFromSize(size) {
  const s = str(size)
  if (s === "1K" || s === "2K" || s === "4K") return s
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s)
  if (!m) return undefined
  const long = Math.max(Number(m[1]), Number(m[2]))
  if (!long) return undefined
  if (long <= 1280) return "1K"
  if (long <= 2560) return "2K"
  return "4K"
}

function resolutionOf(size, fallback, model) {
  const s = str(size)
  if (!s) return fallback
  const u = s.toUpperCase()
  if (["480P", "768P", "1080P", "2K"].includes(u)) return clampResolution(u, model)
  if (/480|640/.test(u)) return clampResolution("480P", model)
  if (/1080|1920/.test(u)) return clampResolution(model === "MiniMax-Hailuo-2.3" ? "1080P" : "2K", model)
  if (/2K|1440|2560/.test(u)) return clampResolution("2K", model)
  if (/720|768|1280/.test(u)) return clampResolution("768P", model)
  return fallback
}

function clampResolution(value, model) {
  const allowed = {
    "MiniMax-H3": ["768P", "2K"],
    "MiniMax-H3-Max": ["480P", "768P"],
    "MiniMax-Hailuo-2.3": ["768P", "1080P"],
  }[model] ?? [value]
  return allowed.includes(value) ? value : allowed[allowed.length - 1]
}

function durationOf(seconds, fallback, model) {
  let n = fallback
  if (seconds != null && seconds !== "") {
    const v = typeof seconds === "number" ? seconds : Number(seconds)
    if (!Number.isFinite(v)) throw Object.assign(new Error("seconds must be a number"), { status: 400 })
    n = Math.round(v)
  }
  const limits = {
    "MiniMax-H3": [4, 15],
    "MiniMax-H3-Max": [5, 15],
    "MiniMax-Hailuo-2.3": [6, 10],
  }[model] ?? [1, 15]
  if (model === "MiniMax-Hailuo-2.3") return n >= 10 ? 10 : 6
  return Math.min(limits[1], Math.max(limits[0], n))
}

function jsonBody(body) {
  if (body == null || body === "") return {}
  if (typeof body === "object" && !Array.isArray(body) && !(body instanceof Uint8Array) && !(typeof Buffer !== "undefined" && Buffer.isBuffer?.(body)) && !(body instanceof ArrayBuffer)) return body
  const text = typeof body === "string" ? body : new TextDecoder().decode(body)
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error()
    return v
  } catch {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 })
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}

function errorResponse(status, message) {
  return jsonResponse({ error: { message, type: status >= 500 ? "api_error" : "invalid_request_error" } }, status)
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : ""
}

function integer(v, fallback) {
  if (typeof v === "number" && Number.isInteger(v)) return v
  if (typeof v === "string" && v.trim() && Number.isInteger(Number(v))) return Number(v)
  return fallback
}

function gcd(a, b) {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"))
      return
    }
    const t = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// for tests
export const _native = {
  IMAGE_NPM, MATRIX, mediaPath, aspectFromSize, durationOf, resolutionOf, areaOf, areaFromSize, mediaRef,
  visibleWaitMs: 8000, visibleStepMs: 1000, sleep,
  // the upload POST and the video download; tests swap in a fake
  fetch: (...args) => globalThis.fetch(...args),
}
