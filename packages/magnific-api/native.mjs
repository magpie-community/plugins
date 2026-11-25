// magpie's native image and video models: a short list of Magnific models
// served on the OpenAI Images and Videos APIs that magpie's gateway speaks.
// The agent tools reach every model; these are the ones a model picker shows.
import { buildBody, findModel } from "./catalog.mjs"
import { PROVIDER } from "./magnific.mjs"

const NPM = "@ai-sdk/openai-compatible"
export const API_BASE = `plugin://${PROVIDER}/v1`
// What the loader hands the host as base URL; fetch below answers every
// route itself, nothing is ever sent there.
export const LOCAL_BASE = `https://${PROVIDER}.invalid/v1`

export const NATIVE = [
  ["mystic", "Mystic", "mystic"],
  ["nano-banana-pro", "Nano Banana Pro", "text-to-image/nano-banana-pro"],
  ["nano-banana-2-1", "Nano Banana 2.1", "text-to-image/nano-banana-2-1"],
  ["gpt-image-2-5", "GPT Image 2.5", "text-to-image/gpt-image-2-5"],
  ["seedream-v5-pro", "Seedream 5.0 Pro", "text-to-image/seedream-v5-pro"],
  ["flux-2-pro", "Flux 2 Pro", "text-to-image/flux-2-pro"],
  ["flux-2-klein", "Flux 2 Klein", "text-to-image/flux-2-klein"],
  ["ideogram-4-5", "Ideogram 4.5", "text-to-image/ideogram-4-5"],
  ["recraft-v4-1", "Recraft V4.1", "text-to-image/recraft-v4-1"],
  ["z-image", "Z-Image", "text-to-image/z-image"],
  ["veo-3-1", "Veo 3.1", "text-to-video/veo-3-1"],
  ["veo-3-1-fast", "Veo 3.1 Fast", "text-to-video/veo-3-1-fast"],
  ["kling-v3-pro", "Kling 3 Pro", "video/kling-v3-pro"],
  ["kling-v3-std", "Kling 3 Standard", "video/kling-v3-std"],
  ["seedance-2-5-pro", "Seedance 2.5 Pro 1080p", "video/seedance-2-5-pro-1080p"],
  ["seedance-2-fast", "Seedance 2.0 Fast 720p", "video/seedance-2-fast-720p"],
  ["wan-3-0", "WAN 3.0", "video/wan-3-0"],
  ["wan-2-5-480p", "WAN 2.5 480p", "text-to-video/wan-2-5-t2v-480p"],
  ["runway-4-5", "Runway Gen 4.5", "text-to-video/runway-4-5"],
  ["ltx-2-fast", "LTX 2.0 Fast", "text-to-video/ltx-2-fast"],
].map(([id, name, model]) => ({ id, name: `Magnific · ${name}`, model, kind: findModel(model).kind }))

const outputs = (kind) => ({ text: false, image: kind === "image", audio: false, video: kind === "video", pdf: false })

// The provider entry the config hook declares.
export const providerConfig = (base = API_BASE) => ({
  name: "Magnific",
  npm: NPM,
  api: base,
  models: Object.fromEntries(NATIVE.map((m) => [m.id, {
    name: m.name,
    limit: { context: 1, output: 1 },
    tool_call: false,
    reasoning: false,
    modalities: { input: ["text"], output: [m.kind] },
  }])),
})

// The same models as the provider.models hook lists them.
export const providerModels = (base = API_BASE) => Object.fromEntries(NATIVE.map((m) => [m.id, {
  id: m.id,
  name: m.name,
  api: { id: m.id, url: base, npm: NPM },
  limit: { context: 1, output: 1 },
  capabilities: {
    temperature: false, reasoning: false, toolcall: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: outputs(m.kind),
  },
  modalities: { input: ["text"], output: [m.kind] },
  cost: { input: 0, output: 0 },
  status: "active",
  release_date: "",
  tool_call: false,
  reasoning: false,
}]))

const fail = (status, message) => Object.assign(new Error(message), { status })

function nativeOf(raw, kind) {
  const value = String(raw ?? "").trim()
  const id = value.startsWith(`${PROVIDER}/`) ? value.slice(PROVIDER.length + 1) : value
  const hit = NATIVE.find((m) => m.id === id && m.kind === kind)
  if (!hit) throw fail(400, `Unknown Magnific ${kind} model ${JSON.stringify(value)}; expected one of ${NATIVE.filter((m) => m.kind === kind).map((m) => m.id).join(", ")}`)
  return hit
}

// "1280x720", "16:9" or "widescreen_16_9" as width / height.
const ratioOf = (v) => {
  const m = String(v ?? "").match(/(\d+)\s*[x:_×]\s*(\d+)$/i)
  return m && +m[2] ? { w: +m[1], h: +m[2] } : null
}
const nearest = (values, want, measure) =>
  values.map((v) => [v, measure(v)]).filter(([, n]) => n !== null && Number.isFinite(n))
    .sort((a, b) => Math.abs(a[1] - want) - Math.abs(b[1] - want))[0]?.[0]

// An OpenAI images or videos request as the Magnific model's own body.
// Models name and spell size and length differently, so `size` goes to the
// closest aspect ratio (or width and height) the model has, `seconds` to its
// closest duration; `extra` carries the model's own parameters as they are.
export function translate(native, request) {
  const model = findModel(native.model)
  const params = { ...(request.extra && typeof request.extra === "object" ? request.extra : {}) }
  const size = ratioOf(request.size)
  if (request.size && !size) throw fail(400, `Unsupported size ${JSON.stringify(request.size)}; use WIDTHxHEIGHT or a ratio like 16:9`)
  if (size) {
    const key = ["aspect_ratio", "ratio"].find((k) => model.params[k]?.enum)
    if (key && params[key] === undefined) {
      const log = (r) => (r ? Math.log(r.w / r.h) : null)
      params[key] = nearest(model.params[key].enum, log(size), (v) => log(ratioOf(v)))
    } else if (!key && model.params.width && model.params.height && /x/i.test(String(request.size))) {
      params.width ??= size.w
      params.height ??= size.h
    }
  }
  const seconds = Number(request.seconds)
  const duration = model.params.duration
  if (request.seconds !== undefined && request.seconds !== "" && duration && params.duration === undefined) {
    if (!(seconds > 0)) throw fail(400, "seconds must be a positive number")
    const value = duration.enum ? nearest(duration.enum, seconds, Number) : Math.round(seconds)
    params.duration = duration.type === "string" ? String(value) : Number(value)
  }
  try { return { model, body: buildBody(model, request.prompt, params) } }
  catch (e) { throw fail(400, e.message) }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const STATUS = { CREATED: "queued", IN_PROGRESS: "in_progress", COMPLETED: "completed" }

const videoOf = (native, task, more = {}) => ({
  id: `${native.id}:${task.task.split(":").pop()}`,
  object: "video",
  model: native.id,
  created_at: Math.floor(Date.now() / 1000),
  status: task.failed ? "failed" : STATUS[task.status] ?? "in_progress",
  progress: task.done ? 100 : 0,
  ...more,
  ...(task.failed ? { error: { message: String(task.error ?? "Magnific could not generate this video") } } : {}),
})

function bodyOf(init) {
  const b = init?.body
  const text = typeof b === "string" ? b : ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8") : b instanceof ArrayBuffer ? Buffer.from(b).toString("utf8") : null
  let body
  try { body = text === null ? b : JSON.parse(text || "{}") } catch { throw fail(400, "The request body is not JSON") }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "The request body must be a JSON object")
  return body
}

// The fetch magpie's gateway calls for this account: OpenAI's
// POST /images/generations, POST /videos, GET /videos/{id} and
// GET /videos/{id}/content, answered from Magnific's task API.
export function nativeFetch(client, { fetch: send = fetch, imageWait = 280, pollMs } = {}) {
  const videoTask = (raw) => {
    const id = decodeURIComponent(raw)
    const cut = id.indexOf(":")
    if (cut < 1 || !/^[\w-]+$/.test(id.slice(cut + 1))) throw fail(400, `Invalid video id ${JSON.stringify(id)}`)
    const native = nativeOf(id.slice(0, cut), "video")
    return { native, model: findModel(native.model), taskId: id.slice(cut + 1) }
  }

  async function route(req, init = {}) {
    const { pathname } = new URL(String(req?.url ?? req))
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase()
    const signal = init?.signal ?? undefined

    if (method === "POST" && /\/images\/generations$/.test(pathname)) {
      const request = bodyOf(init)
      const native = nativeOf(request.model, "image")
      const { model, body } = translate(native, request)
      const n = Math.min(4, Math.max(1, Math.trunc(Number(request.n) || 1)))
      const data = (await Promise.all(Array.from({ length: n }, async () => {
        let task = await client.submit(model, body, signal)
        if (!task.done && !task.failed) task = await client.wait(model, task.task.split(":").pop(), imageWait, signal, pollMs)
        if (task.failed) throw fail(502, `Magnific could not generate this image${task.error ? `: ${task.error}` : ""}`)
        if (!task.done) throw fail(504, `Magnific was still generating after ${imageWait} seconds`)
        return Promise.all(task.urls.map(async (url) => {
          const res = await send(url, { signal })
          if (!res.ok) throw fail(502, `Downloading the image failed with ${res.status}`)
          return { b64_json: Buffer.from(await res.arrayBuffer()).toString("base64") }
        }))
      }))).flat()
      if (!data.length) throw fail(502, "Magnific returned no image")
      return json({ created: Math.floor(Date.now() / 1000), data })
    }

    if (method === "POST" && /\/videos$/.test(pathname)) {
      const request = bodyOf(init)
      for (const key of ["input_reference", "last_frame", "reference_images"]) {
        const v = request[key]
        if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) {
          throw fail(400, `${key} is not supported by the native Magnific video models (text to video only); use the magnific_generate tool for image-to-video`)
        }
      }
      const native = nativeOf(request.model, "video")
      const { model, body } = translate(native, request)
      const task = await client.submit(model, body, signal)
      return json(videoOf(native, task, {
        ...(request.size ? { size: String(request.size) } : {}),
        ...(body.duration !== undefined ? { seconds: String(body.duration) } : {}),
      }))
    }

    const content = method === "GET" && pathname.match(/\/videos\/([^/]+)\/content$/)
    if (content) {
      const { native, model, taskId } = videoTask(content[1])
      const task = await client.status(model, taskId, signal)
      if (!task.done || !task.urls.length) throw fail(task.failed ? 502 : 409, `Video ${native.id}:${taskId} is ${task.failed ? "failed" : "not ready yet"}`)
      const res = await send(task.urls[0], { signal })
      if (!res.ok || !res.body) throw fail(502, `Downloading the video failed with ${res.status}; results expire 30 minutes after generation`)
      const headers = { "content-type": res.headers.get("content-type") || "video/mp4" }
      if (res.headers.get("content-length")) headers["content-length"] = res.headers.get("content-length")
      return new Response(res.body, { status: 200, headers })
    }

    const status = method === "GET" && pathname.match(/\/videos\/([^/]+)$/)
    if (status) {
      const { native, model, taskId } = videoTask(status[1])
      return json(videoOf(native, await client.status(model, taskId, signal)))
    }

    throw fail(404, `Magnific has no route ${method} ${pathname}`)
  }

  return async (req, init) => {
    try { return await route(req, init) }
    catch (e) {
      if (init?.signal?.aborted) throw e
      const status = Number.isInteger(e.status) && e.status >= 400 ? e.status : 502
      return json({ error: { message: String(e.message ?? e), type: status < 500 ? "invalid_request_error" : "upstream_error" } }, status)
    }
  }
}
