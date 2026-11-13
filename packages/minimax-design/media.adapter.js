export const apiVersion = 1

export function buildSubmit(request) {
  const body = { model: request.model, prompt: request.prompt }
  if (request.params.size) body.size = request.params.size
  if (request.type === "image") {
    body.n = 1
    body.response_format = "b64_json"
    if (request.images.length) body.images = request.images.map((image) => ({ image_url: image.dataUrl }))
    return { method: "POST", path: request.images.length ? "/images/edits" : "/images/generations", body }
  }
  if (request.type !== "video") throw new Error("Magpie supports image and video generation here.")
  if (request.params.seconds !== undefined) body.seconds = String(request.params.seconds)
  if (request.images.length) body.input_reference = request.images[0].dataUrl
  return { method: "POST", path: "/videos", body }
}

export function parseSubmit(response, request) {
  if (response.body?.error) return { error: response.body.error.message || "Magpie rejected the request." }
  if (request.type === "video") {
    if (typeof response.body?.id !== "string" || !response.body.id) return { error: "Magpie returned no video task ID." }
    return { taskId: response.body.id }
  }
  const images = response.body?.data
  if (!Array.isArray(images) || !images.length) return { error: "Magpie returned no image." }
  const outputs = []
  for (const image of images) {
    if (typeof image.b64_json === "string" && image.b64_json) outputs.push({ base64: image.b64_json })
    else if (typeof image.url === "string" && image.url) outputs.push({ url: image.url })
    else return { error: "Magpie returned an unreadable image." }
  }
  return { outputs }
}

export function buildPoll(task) {
  return { method: "GET", path: `/videos/${encodeURIComponent(task.id)}` }
}

export function parsePoll(response, task) {
  const body = response.body
  if (body?.error) return { status: "failed", message: body.error.message || "Magpie video generation failed." }
  if (body?.status === "queued" || body?.status === "in_progress") {
    return { status: "running", ...(typeof body.progress === "number" ? { progress: body.progress / 100 } : {}) }
  }
  if (body?.status === "completed") {
    return { status: "done", outputs: [{ fetch: { method: "GET", path: `/videos/${encodeURIComponent(task.id)}/content` } }] }
  }
  return { status: "failed", message: `Magpie video task status: ${String(body?.status)}.` }
}

export function parseError(response) {
  return { message: response.body?.error?.message || `Magpie returned HTTP ${response.status}.` }
}
