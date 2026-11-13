export const apiVersion = 1
const capability = null

export function buildSubmit(request) {
  const body = { model: capability?.requestModel ?? request.model, prompt: request.prompt }
  const params = {}
  for (const [key, value] of Object.entries(request.params)) {
    if (value === undefined || value === "" || value === "自动" || value === "auto") continue
    params[key] = value
  }
  let mode = "首帧"
  if (capability) {
    if (request.images.length < capability.references.min || request.images.length > capability.references.max) {
      throw new Error(`参考图数量应为 ${capability.references.min}–${capability.references.max} 张。`)
    }
    if (capability.promptMax && request.prompt.length > capability.promptMax) throw new Error("提示词超过模型长度限制。")
    for (const [key, value] of Object.entries(params)) {
      const rule = capability.params.find((parameter) => parameter.key === key)
      if (!rule || (rule.type === "string" && typeof value !== "string") ||
          (rule.type === "integer" && !Number.isInteger(value)) ||
          (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) ||
          (rule.enum && !rule.enum.includes(value)) ||
          (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) {
        throw new Error(`模型不支持参数 ${key}=${String(value)}。请重新选择。`)
      }
    }
    for (const rule of capability.params) {
      if (rule.required && params[rule.key] === undefined && capability.defaults?.[rule.key] === undefined) {
        throw new Error(`请填写${rule.title}。`)
      }
    }
    if (capability.transport === "speech") {
      if (request.type !== "speech") throw new Error("该模型只支持语音合成。")
      if (request.images.length || request.videos?.length || request.audios?.length) throw new Error("该语音接口不接受参考媒体。")
      const speech = { ...capability.defaults, ...params }
      if (Object.values(speech).some((value) => typeof value === "string" && !value.trim())) throw new Error("语音参数不能为空。")
      if (capability.ming && speech.voice !== "default" && speech.instructions) throw new Error("Ming 音色和声音描述只能选择一项。")
      if (capability.ming && speech.voice !== "default" &&
          !/^(?:US|UK)_[A-Z][a-z]+$|^[\u4e00-\u9fff][\u4e00-\u9fff_]*$/.test(speech.voice)) {
        throw new Error("Ming 音色名格式不正确；留为 default 可自动选择。")
      }
      return { method: "POST", path: "/audio/speech", response: "binary",
        body: { model: request.model, input: request.prompt, ...speech } }
    }
    mode = params.referenceMode || (request.images.length > 1 ? capability.defaultMode : "首帧")
    if (request.images.length && !capability.modes.includes(mode) && request.type === "video") throw new Error("模型不支持该参考图用途。")
    if (request.type === "video" && ((mode === "首帧" && request.images.length > 1) || (mode === "首尾帧" && request.images.length !== 2))) {
      throw new Error(mode === "首尾帧" ? "首尾帧需要按顺序提供两张图。" : "首帧模式只接受一张图。")
    }
    if (mode === "主体参考" && !request.images.length) throw new Error("主体参考模式需要参考图。")
    if (mode === "主体参考" && capability.referenceSecondsMax && params.seconds > capability.referenceSecondsMax) {
      throw new Error(`主体参考模式最多支持 ${capability.referenceSecondsMax} 秒。`)
    }
    if (mode === "主体参考" && params.resolution && capability.referenceResolutions &&
        !capability.referenceResolutions.includes(params.resolution)) throw new Error("主体参考模式最高支持 720p。")
    if (capability.transport === "minimax-video" && request.images.length && mode !== "主体参考" && params.ratio) {
      throw new Error("首帧/首尾帧自动沿用图片比例，请将比例设为自动。")
    }
    if (capability.presets && params.preset) Object.assign(body, capability.presets[params.preset])
    if (capability.transport === "minimax-image") {
      if (params.ratio) body.size = params.ratio
      if (params.resolution) body.quality = { "1K": "low", "2K": "medium", "4K": "high" }[params.resolution]
    }
    if (capability.transport === "minimax-video") {
      if (params.resolution) body.size = params.resolution
      if (params.ratio) body.ratio = params.ratio
    }
    if (capability.transport === "grok-video") {
      if (params.resolution) {
        if (request.images.length && !params.ratio) throw new Error("指定分辨率时，请同时选择比例；全部留为自动可沿用参考图。")
        const ratio = (params.ratio || "16:9").split(":").map(Number)
        const short = Number.parseInt(params.resolution, 10)
        const unit = short / Math.min(...ratio)
        body.size = `${Math.round(ratio[0] * unit)}x${Math.round(ratio[1] * unit)}`
      } else if (params.ratio) body.size = params.ratio
    }
  }
  if (params.size) body.size = params.size
  if (request.type === "image") {
    body.n = 1
    body.response_format = "b64_json"
    if (request.images.length) body.images = request.images.map((image) => ({ image_url: image.dataUrl }))
    return { method: "POST", path: request.images.length ? "/images/edits" : "/images/generations", body }
  }
  if (request.type !== "video") throw new Error("Magpie supports image and video generation here.")
  if (params.seconds !== undefined) body.seconds = String(params.seconds)
  if (capability?.hailuo && body.size === "1080P" && body.seconds !== undefined && body.seconds !== "6") {
    throw new Error("Hailuo 1080P 只支持 6 秒。")
  }
  if (request.images.length) {
    if (mode === "主体参考") body.reference_images = request.images.map((image) => image.dataUrl)
    else {
      body.input_reference = request.images[0].dataUrl
      if (mode === "首尾帧") body.last_frame = request.images[1].dataUrl
    }
  }
  return { method: "POST", path: "/videos", body }
}

export function parseSubmit(response, request) {
  if (response.body?.error) return { error: response.body.error.message || "Magpie rejected the request." }
  if (request.type === "speech") {
    const mime = response.headers?.["content-type"]?.split(";")[0]?.trim()
    if (response.body?.$binary !== true || response.body.size <= 0 ||
        !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac",
          "audio/aac", "audio/ogg", "audio/opus", "application/ogg"].includes(mime)) {
      return { error: "Magpie 未返回可播放的音频文件。请检查语音接口和输出格式。" }
    }
    return { outputs: [{ responseBody: true }] }
  }
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
