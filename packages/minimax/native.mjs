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
//     plugin's fetch (plugin://<id>/v1/images/generations).
//   - video: models whose capabilities.output includes video, started at
//     the OpenAI-shaped videos API through the same fetch
//     (plugin://<id>/v1/videos).
//
// generate_image has no model id of its own in the live catalog, so the
// image model is listed as MiniMax-Image. Video models are the real
// submit_video_generation enums: MiniMax-H3, MiniMax-H3-Max, MiniMax-Hailuo-2.3.

import { callMatrixTool } from "./connector-tools.mjs"

const IMAGE_NPM = "@ai-sdk/openai-compatible"
const MATRIX = "connector__matrix__"

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
// and returns the parsed object (base_resp already checked).
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
// route, so the chat fetch can send the request on.
export async function handleMediaFetch(url, { method, body, signal } = {}, { request, siteId } = {}) {
  const route = mediaPath(url)
  if (!route) return null
  if (typeof request !== "function" || !siteId) {
    return errorResponse(500, "MiniMax Code media: missing request transport")
  }
  const verb = (method ?? "GET").toUpperCase()
  try {
    if (route.kind === "image.generations" || route.kind === "image.edits") {
      if (verb !== "POST") return errorResponse(405, "use POST to generate an image")
      return await generateImage(request, siteId, body, signal, route.kind === "image.edits")
    }
    if (route.kind === "video.create") {
      if (verb !== "POST") return errorResponse(405, "use POST to start a video")
      return await startVideo(request, siteId, body, signal)
    }
    if (verb !== "GET") return errorResponse(405, "use GET to read a video")
    if (route.kind === "video.get") return await getVideo(request, siteId, route.id, signal)
    return await videoContent(request, siteId, route.id, signal)
  } catch (e) {
    const status = e?.status && Number.isInteger(e.status) ? e.status : 502
    return errorResponse(status, e?.message ?? String(e))
  }
}

async function generateImage(request, siteId, body, signal, edits) {
  const req = jsonBody(body)
  const prompt = str(req.prompt)
  if (!prompt) throw Object.assign(new Error("prompt is required"), { status: 400 })
  const n = integer(req.n, 1)
  if (n < 1 || n > 10) throw Object.assign(new Error("n must be an integer from 1 to 10"), { status: 400 })
  const item = { prompt, n }
  const aspect = str(req.aspect_ratio) || aspectFromSize(req.size)
  if (aspect) item.aspect_ratio = aspect
  const area = areaOf(req)
  if (area) item.area = area
  const refs = referenceImages(req, edits)
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

async function startVideo(request, siteId, body, signal) {
  const req = jsonBody(body)
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
  const start = mediaUrl(req.input_reference ?? req.input_image)
  const end = mediaUrl(req.last_frame ?? req.last_frame_image)
  if (start) {
    args.input_image = start
    args.reference_type = "first_frame"
  }
  if (end) args.last_frame_image = end
  const refs = urlList(req.reference_images)
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
  const res = await fetch(url, { signal, redirect: "follow" })
  if (!res.ok) throw new Error("MiniMax video download: HTTP " + res.status)
  const headers = new Headers(res.headers)
  if (!headers.get("content-type")) headers.set("content-type", "video/mp4")
  return new Response(res.body, { status: 200, headers })
}

async function queryVideo(request, siteId, model, task, signal) {
  return callMatrixTool(request, siteId, "query_video_generation", { model, task_id: task }, { signal, timeoutMs: CALL_MS })
}

async function assetUrl(request, siteId, nodeId, signal) {
  const asset = await callMatrixTool(request, siteId, "get_asset_url", { node_id: nodeId }, { signal, timeoutMs: CALL_MS })
  const url = str(asset?.download_url ?? asset?.url ?? asset?.temp_url)
  if (!url) throw new Error("get_asset_url returned no download_url")
  return url
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

function referenceImages(req, edits) {
  const fromList = urlList(req.reference_images)
  if (fromList) return fromList
  const one = mediaUrl(req.image ?? req.image_url)
  if (one) return [one]
  if (edits && !one) throw Object.assign(new Error("image edits need a reference image URL (data URIs and local paths are not sent to MiniMax Code; upload first)"), { status: 400 })
  return undefined
}

function urlList(value) {
  if (!Array.isArray(value) || !value.length) return undefined
  const out = []
  for (const item of value) {
    const u = mediaUrl(item)
    if (!u) throw Object.assign(new Error("reference images must be HTTPS URLs (data URIs and local paths are not sent to MiniMax Code; upload first)"), { status: 400 })
    out.push(u)
  }
  return out
}

function mediaUrl(value) {
  if (typeof value === "string") {
    const url = value.trim()
    if (!url) return undefined
    if (url.startsWith("data:") || url.startsWith("file:") || /^[.]{0,2}\//.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      throw Object.assign(new Error("media must be an HTTPS URL (data URIs and local paths are not sent to MiniMax Code; upload first)"), { status: 400 })
    }
    return { url }
  }
  if (value && typeof value === "object") {
    const url = str(value.url)
    if (!url) return undefined
    const one = mediaUrl(url)
    if (value.mime_type) one.mime_type = value.mime_type
    return one
  }
  return undefined
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
  return undefined
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
  if (typeof body === "object" && !Array.isArray(body) && !(body instanceof Uint8Array) && !(typeof Buffer !== "undefined" && Buffer.isBuffer?.(body))) return body
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

// for tests
export const _native = { IMAGE_NPM, MATRIX, mediaPath, aspectFromSize, durationOf, resolutionOf, areaOf }
