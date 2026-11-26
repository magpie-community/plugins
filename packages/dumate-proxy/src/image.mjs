import { randomUUID } from "node:crypto"

const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|bmp|avif)(?:\?[^\s"'<>]*)?$/i
const BARE_URL = /https?:\/\/[^\s"'<>\])]+/gi
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const DATA_IMAGE = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g

const cleanUrl = (value) => String(value)
  .replace(/&amp;/g, "&")
  .replace(/\\_/g, "_")
  .replace(/[.,;，。；]+$/, "")

export function parseSize(size) {
  const match = /^\s*(\d+)\s*[xX×*]\s*(\d+)\s*$/.exec(String(size ?? ""))
  if (!match) return {}
  const width = Number.parseInt(match[1], 10)
  const height = Number.parseInt(match[2], 10)
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) ? { width, height } : {}
}

export function chatMessagesToPrompt(messages) {
  if (!Array.isArray(messages)) return ""
  const user = [...messages].reverse().find((message) => message?.role === "user") ?? messages.at(-1)
  const content = user?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => {
    if (typeof part === "string") return part
    if (part?.type === "text") return String(part.text ?? "")
    if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      return url ? `[参考图片] ${url}` : ""
    }
    return ""
  }).filter(Boolean).join("\n")
}

export function isImageModel(catalog, modelId) {
  if (!modelId) return false
  return catalog?.models?.[modelId]?.kind === "image" || /(?:image|draw|paint|生图|绘画)/i.test(modelId)
}

export function resolveImageModel(catalog, config, requested) {
  const requestedId = typeof requested === "string" ? requested : requested?.id
  if (requestedId && catalog?.models?.[requestedId]) {
    return catalog.models[requestedId]
  }
  const fallbackId = requestedId || config.defaultImageModel || catalog?.defaultImageModel || "dumate-image0.1"
  return catalog?.models?.[fallbackId] ?? {
    id: fallbackId,
    upstreamId: fallbackId,
    name: fallbackId,
    kind: "image",
    modalities: { input: ["text"], output: ["image"] },
  }
}

const IMAGE_EXTRA_KEYS = [
  "negative_prompt", "seed", "steps", "num_inference_steps", "guidance_scale", "cfg_scale",
  "style", "aspect_ratio", "image_size", "image", "images", "image_url", "strength",
  "sampler", "scheduler", "prompt_-upsampler", "extra",
]

export function buildImageUpstreamBody(request, model) {
  const prompt = String(request?.prompt ?? chatMessagesToPrompt(request?.messages) ?? "").trim()
  if (!prompt) {
    const error = new Error("缺少 prompt：生图请求必须提供 prompt")
    error.type = "invalid_request_error"
    error.status = 400
    throw error
  }

  const body = { model: model.upstreamId || model.id, prompt }
  const count = Number.parseInt(request?.n ?? "1", 10)
  if (Number.isSafeInteger(count) && count > 0) body.n = Math.min(count, 10)

  const { width, height } = parseSize(request?.size)
  if (width && height) {
    body.width = width
    body.height = height
    body.size = request.size
  }
  if (Number.isSafeInteger(request?.width) && Number.isSafeInteger(request?.height)) {
    body.width = request.width
    body.height = request.height
  }

  for (const key of IMAGE_EXTRA_KEYS) {
    if (request?.[key] !== undefined) body[key] = request[key]
  }
  return body
}

function looksLikeImageUrl(value) {
  return /^data:image\//i.test(value) || IMAGE_EXT.test(value)
}

function extractStrings(payload, out, seen, depth = 0) {
  if (depth > 10 || payload === null || payload === undefined) return
  if (typeof payload === "string") {
    if (seen.has(payload)) return
    seen.add(payload)
    for (const match of payload.matchAll(MARKDOWN_IMAGE)) pushImage(cleanUrl(match[1]), out)
    for (const match of payload.matchAll(DATA_IMAGE)) pushImage(match[0], out)
    for (const match of payload.matchAll(BARE_URL)) {
      const url = cleanUrl(match[0])
      if (looksLikeImageUrl(url)) pushImage(url, out)
    }
    return
  }
  if (Array.isArray(payload)) {
    for (const item of payload) extractStrings(item, out, seen, depth + 1)
    return
  }
  if (typeof payload !== "object") return
  if (seen.has(payload)) return
  seen.add(payload)

  const directKeys = ["url", "image_url", "imageUrl", "img_url", "link", "file_url", "download_url", "b64_json", "base64", "image_data", "image"]
  for (const key of directKeys) {
    const value = payload[key]
    if (typeof value === "string" && value) {
      if (key === "b64_json" || key === "base64" || key === "image_data") out.b64.add(value)
      else pushImage(cleanUrl(value), out)
    } else if (value && typeof value === "object") {
      extractStrings(value, out, seen, depth + 1)
    }
  }
  for (const [key, value] of Object.entries(payload)) {
    if (directKeys.includes(key)) continue
    if (key === "error" || key === "usage") continue
    extractStrings(value, out, seen, depth + 1)
  }
}

function pushImage(value, out) {
  if (!value) return
  if (/^data:image\//i.test(value)) out.b64.add(value)
  else if (/^https?:\/\//i.test(value)) out.urls.add(value)
}

export function extractImages(payload) {
  const out = { urls: new Set(), b64: new Set() }
  extractStrings(payload, out, new Set())
  return [
    ...[...out.urls].map((url) => ({ url })),
    ...[...out.b64].map((value) => value.startsWith("data:image/")
      ? { url: value, b64_json: value.slice(value.indexOf(",") + 1) }
      : { b64_json: value }),
  ]
}

function taskIdOf(payload) {
  return payload?.task_id ?? payload?.id ?? payload?.request_id ?? payload?.gd_id ?? undefined
}

export async function toOpenAIImages(payload, { model, responseFormat = "url" }, config, fetchImpl = fetch) {
  const created = Math.floor(Date.now() / 1000)
  const images = extractImages(payload)
  if (!images.length) {
    const status = payload?.status ?? (payload?.error ? "error" : "pending")
    return {
      status: status === "error" ? 502 : 202,
      body: {
        created,
        data: [],
        status,
        ...(taskIdOf(payload) ? { task_id: taskIdOf(payload) } : {}),
        ...(payload?.error ? { error: payload.error } : {}),
      },
    }
  }

  const data = []
  for (const image of images) {
    if (responseFormat === "b64_json") {
      let b64 = image.b64_json
      if (!b64 && image.url) {
        const response = await fetchImpl(image.url, {
          signal: AbortSignal.timeout(config.imageFetchTimeoutMs),
          headers: { "User-Agent": config.userAgent },
        })
        if (!response.ok) throw new Error(`下载生成图片失败: HTTP ${response.status}`)
        const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10)
        if (Number.isSafeInteger(declared) && declared > config.maxImageBytes) throw new Error("生成图片超过大小限制")
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength > config.maxImageBytes) throw new Error("生成图片超过大小限制")
        b64 = buffer.toString("base64")
      }
      data.push(b64 ? { b64_json: b64 } : { url: image.url })
    } else {
      data.push(image.url ? { url: image.url } : { b64_json: image.b64_json })
    }
  }

  return {
    status: 200,
    body: {
      created,
      model,
      data,
      ...(taskIdOf(payload) ? { task_id: taskIdOf(payload) } : {}),
    },
  }
}

export function toChatCompletion(payload, model, request) {
  if (payload?.choices?.length && !isImageModel({ models: { [model]: { kind: "image" } } }, "")) {
    return payload
  }
  const images = extractImages(payload)
  const content = images.length
    ? images.map((image, index) => image.url
      ? `![image-${index + 1}](${image.url})`
      : `![image-${index + 1}](data:image/png;base64,${image.b64_json})`).join("\n\n")
    : "生图请求已提交，但未从 DuMate 网关返回可识别的图片地址。"

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model || model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(images.length ? { images } : {}),
      },
      finish_reason: "stop",
    }],
    usage: payload?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ...(taskIdOf(payload) ? { task_id: taskIdOf(payload) } : {}),
  }
}

export function toChatSSE(completion, model) {
  const id = completion.id || `chatcmpl-${randomUUID()}`
  const created = completion.created || Math.floor(Date.now() / 1000)
  const content = completion.choices?.[0]?.message?.content ?? ""
  const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model: completion.model || model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
  return chunk({ role: "assistant", content }) + chunk({}, "stop") + "data: [DONE]\n\n"
}
