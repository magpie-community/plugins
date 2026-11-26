export const TOOLS_BASE = "https://dumate-svc.baidu.com/gateway"
export const IMAGE_ENDPOINTS = {
  "dumate-image2.2": "/v2/tools/dumate/image_generate_v3/async",
  "dumate-image2.1": "/v2/tools/dumate/image_generate_v2/async",
  "dumate-image1.2": "/v2/tools/dumate/image_generate/async",
  "dumate-image0.1": "/v2/tools/dumate/image_generate_v3/async",
}
export const DEFAULT_IMAGE_MODEL = "dumate-image2.2"
const POLL_TIMEOUT_MS = Math.max(5000, Number(process.env?.DUMATE_MEDIA_POLL_TIMEOUT_MS) || 120000)
const POLL_INTERVAL_MS = Math.max(500, Number(process.env?.DUMATE_MEDIA_POLL_INTERVAL_MS) || 1500)

export function normalizeImageModel(model) {
  const value = String(model ?? "").trim().toLowerCase()
  if (IMAGE_ENDPOINTS[value]) return value
  return DEFAULT_IMAGE_MODEL
}

export function buildImagePayload(options = {}) {
  const prompt = String(options.prompt ?? "").trim()
  if (!prompt) throw new Error("prompt 不能为空")
  const model = normalizeImageModel(options.model)
  const payload = {
    query: prompt,
    model,
    quality: String(options.quality ?? "").toLowerCase() === "high" ? "high" : "low",
    maxImagesNum: Math.min(4, Math.max(1, Number(options.n) || 1)),
  }
  const size = String(options.size ?? "").trim()
  if (/^\d+x\d+$/i.test(size)) payload.size = size
  else {
    payload.resolution = ["1K", "2K", "4K"].includes(size.toUpperCase()) ? size.toUpperCase() : "2K"
    payload.aspectRatio = "1:1"
  }
  const images = Array.isArray(options.imageUrls) ? options.imageUrls.filter((url) => typeof url === "string" && url) : []
  if (images.length) payload.imageUrls = images
  return { model, path: IMAGE_ENDPOINTS[model], payload }
}

async function mediaRequest(token, method, path, body, fetchImpl, timeout = 30000) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Appbuilder-From": "openclaw",
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  const payload = body == null ? undefined : JSON.stringify(body)
  const response = await fetchImpl(`${TOOLS_BASE}${path}`, {
    method,
    headers,
    body: payload,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch {}
  if (response.status === 401 || response.status === 403) {
    const error = new Error(json?.message || `DuMate media HTTP ${response.status}`)
    error.signIn = "expired"
    throw error
  }
  if (!response.ok) throw new Error(json?.message || text.slice(0, 300) || `DuMate media HTTP ${response.status}`)
  if (json && json.code != null && String(json.code) !== "0" && json.code !== 0) {
    throw new Error(json.message || `DuMate media code ${json.code}`)
  }
  return json ?? {}
}

async function toDataUrl(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`下载生成图片失败: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return buffer.toString("base64")
}

export async function generateImage(options = {}, token, fetchImpl = fetch) {
  const built = buildImagePayload(options)
  const submitted = await mediaRequest(token, "POST", built.path, built.payload, fetchImpl, 60000)
  const taskId = submitted.task_id ?? submitted.data?.task_id
  if (!taskId) throw new Error("生图任务未返回 task_id")
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let last = submitted
  while (Date.now() < deadline) {
    const queryPath = `${built.path}?task_id=${encodeURIComponent(taskId)}`
    const result = await mediaRequest(token, "GET", queryPath, undefined, fetchImpl, 30000)
    last = result
    const data = result.data ?? result
    const rawUrls = Array.isArray(data.imageUrls) ? data.imageUrls
      : Array.isArray(data.images) ? data.images
        : []
    const urls = rawUrls.map((item) => typeof item === "string" ? item : String(item?.url ?? "")).filter(Boolean)
    const status = String(data.status ?? result.status ?? "").toLowerCase()
    if (urls.length) {
      const responseFormat = String(options.responseFormat ?? "url")
      const out = []
      for (const url of urls) {
        out.push(responseFormat === "b64_json" ? { b64_json: await toDataUrl(url, fetchImpl) } : { url })
      }
      return { model: built.model, created: Math.floor(Date.now() / 1000), data: out, taskId }
    }
    if (/fail|error|reject/.test(status)) throw new Error(data.message || `生图失败: ${status}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  const data = last?.data ?? last ?? {}
  throw new Error(`生图超时（${Math.round(POLL_TIMEOUT_MS / 1000)}s）${data?.task_id ? `，taskId=${data.task_id}` : ""}`)
}
