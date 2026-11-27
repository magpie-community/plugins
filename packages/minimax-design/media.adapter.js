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
    const audio = capability.audioReferences ?? { min: 0, max: 0 }
    const audioCount = request.audios?.length ?? 0
    if (request.videos?.length || audioCount < audio.min || audioCount > audio.max) {
      throw new Error(request.videos?.length || !audio.max ? "该模型不接受参考媒体。" : `参考音频数量应为 ${audio.min}–${audio.max}。`)
    }
    if (capability.promptMax && request.prompt.length > capability.promptMax) throw new Error("提示词超过模型长度限制。")
    for (const [key, value] of Object.entries(params)) {
      const rule = capability.params.find((parameter) => parameter.key === key)
      if (!rule || (rule.type === "string" && typeof value !== "string") ||
          (rule.type === "integer" && !Number.isInteger(value)) ||
          (rule.type === "boolean" && typeof value !== "boolean") ||
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
      const speech = { ...capability.defaults, ...params }
      if (Object.values(speech).some((value) => typeof value === "string" && !value.trim())) throw new Error("语音参数不能为空。")
      if (capability.requiredVoice && (!speech.voice || speech.voice === "default")) throw new Error("请填写有效的音色。")
      if (capability.ming && speech.voice && speech.voice !== "default" && speech.instructions) throw new Error("Ming 音色和声音描述只能选择一项。")
      if (capability.ming && speech.voice && speech.voice !== "default" &&
          !/^(?:US|UK)_[A-Z][a-z]+$|^[\u4e00-\u9fff][\u4e00-\u9fff_]*$/.test(speech.voice)) {
        throw new Error("Ming 音色名格式不正确；留为 default 可自动选择。")
      }
      return { method: "POST", path: "/audio/speech", response: "binary",
        body: { model: request.model, input: request.prompt, ...speech } }
    }
    const explicit = new Set(Object.keys(params))
    Object.assign(params, { ...capability.defaults, ...params })
    if (request.images.length && (request.images.length > 1 || !capability.modes.includes("首帧"))) {
      mode = capability.defaultMode
    }
    if (params.image_mode === "reference") mode = "主体参考"
    if (params.image_mode === "first-last-frame") mode = request.images.length > 1 ? "首尾帧" : "首帧"
    if (params.image_mode === "last-frame") mode = "尾帧"
    if (request.images.length && mode !== "主体参考" &&
        (capability.transport === "minimax-video" || capability.frameRatio === "auto") && !explicit.has("aspect_ratio")) {
      delete params.aspect_ratio
    }
    if (capability.constraints) {
      const rules = capability.constraints
      const values = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value).toLowerCase()]))
      const effective = { ...rules.defaults, ...values }
      for (const condition of rules.conditions) {
        if (values[condition.key] !== undefined && !condition.any.some((selection) =>
          Object.entries(selection).every(([key, allowed]) => effective[key] === undefined || allowed.includes(effective[key])))) {
          throw new Error(`${condition.title}在当前参数组合下不适用。请重新选择。`)
        }
      }
      const selectedKeys = rules.keys?.filter((key) => effective[key] !== undefined) ?? []
      if (selectedKeys.length && !rules.combinations.some((selection) =>
        selectedKeys.every((key) => selection[key] === effective[key]))) {
        throw new Error("模型不支持所选参数组合。请重新选择。")
      }
    }
    params.ratio = params.aspect_ratio
    if (params.duration !== undefined) params.seconds = Number(params.duration)
    if (capability.pixelSizes) {
      if (params.resolution && !params.ratio) throw new Error("指定清晰度时，请同时选择比例。")
      if (params.ratio) {
        const choices = capability.pixelSizes[params.ratio]
        const size = params.resolution ? choices[params.resolution] : Object.values(choices)[0]
        if (!size) throw new Error("模型不支持所选比例和清晰度组合。请重新选择。")
        body.size = size
      }
    }
    if (params.ratio && capability.transport === "generic" && !capability.pixelSizes) body.size = params.ratio
    if (capability.transport === "generic" && request.type === "video" && params.resolution) body.resolution = params.resolution
    if (params.quality) body.quality = params.quality
    if (params.background) body.background = params.background
    if (params.output_format) body.output_format = params.output_format
    if (params.complexity) body.complexity = params.complexity
    if (params.generate_audio !== undefined) body.generate_audio = params.generate_audio
    if (capability.transport === "image-size" && (params.ratio || params.resolution)) {
      body.size = `${params.ratio ?? "auto"}@${params.resolution ?? "auto"}`
    }
    if (capability.transport === "openrouter-image") {
      if (params.resolution && params.ratio) {
        if (capability.pixelRatios && !capability.pixelRatios.includes(params.ratio)) {
          throw new Error("当前网关无法同时传递该比例和清晰度。请将清晰度设为自动。")
        }
        const sides = params.ratio.split(":").map(Number)
        const scale = Number.parseFloat(params.resolution) * 1024 / Math.max(...sides)
        body.size = `${Math.round(sides[0] * scale)}x${Math.round(sides[1] * scale)}`
      } else if (params.resolution) {
        throw new Error("指定清晰度时，请同时选择比例。")
      } else body.size = params.ratio
    }
    if (request.images.length && !capability.modes.includes(mode) && request.type === "video") throw new Error("模型不支持该参考图用途。")
    if (mode === "尾帧" && request.images.length !== 1) throw new Error("尾帧模式需要一张参考图。")
    if (request.type === "video" && ((mode === "首帧" && request.images.length > 1) || (mode === "首尾帧" && request.images.length !== 2))) {
      throw new Error(mode === "首尾帧" ? "首尾帧需要按顺序提供两张图。" : "首帧模式只接受一张图。")
    }
    if (mode === "主体参考" && !request.images.length) throw new Error("主体参考模式需要参考图。")
    if (mode === "主体参考" && capability.referenceSecondsMax && params.seconds > capability.referenceSecondsMax) {
      throw new Error(`主体参考模式最多支持 ${capability.referenceSecondsMax} 秒。`)
    }
    if (mode === "主体参考" && params.resolution && capability.referenceResolutions &&
        !capability.referenceResolutions.includes(params.resolution)) throw new Error("主体参考模式最高支持 720p。")
    if ((capability.transport === "minimax-video" || capability.frameRatio === "auto") &&
        request.images.length && mode !== "主体参考" && params.ratio) {
      throw new Error("首帧/首尾帧自动沿用图片比例，请将比例设为自动。")
    }
    if (capability.presets && params.preset) Object.assign(body, capability.presets[params.preset])
    if (capability.transport === "minimax-image") {
      if (params.ratio) body.size = params.ratio
      if (params.resolution) body.quality = { "1K": "low", "2K": "medium", "4K": "high" }[params.resolution]
    }
    if (capability.transport === "minimax-h3-image") {
      if (params.ratio && params.resolution) {
        const [width, height] = params.ratio.split(":").map(Number)
        const scale = Math.round(Number.parseInt(params.resolution, 10) * 1024 / Math.sqrt(width * height))
        body.size = `${width * scale}x${height * scale}`
      } else if (params.ratio || params.resolution) body.size = params.ratio ?? params.resolution
    }
    if (capability.transport === "minimax-legacy-image") {
      if (params.ratio) body.size = params.ratio
      for (const key of ["seed", "prompt_optimizer", "aigc_watermark"]) {
        if (params[key] !== undefined) body[key] = params[key]
      }
    }
    if (capability.transport === "minimax-video") {
      if (params.resolution) body[capability.minimaxKey ? "resolution" : "size"] = params.resolution
      if (params.ratio) body.ratio = params.ratio
      if (params.prompt_expansion_mode) body.extra = { prompt_expansion_mode: params.prompt_expansion_mode }
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
    body.n = capability?.outputsPerTask ?? 1
    body.response_format = "b64_json"
    if (request.images.length) body.images = request.images.map((image) => ({ image_url: image.dataUrl }))
    return { method: "POST", path: request.images.length ? "/images/edits" : "/images/generations", body }
  }
  if (request.type !== "video") throw new Error("Magpie supports image and video generation here.")
  if (params.seconds !== undefined) body.seconds = String(params.seconds)
  if (capability?.hailuo && body.size === "1080P" && body.seconds !== undefined && body.seconds !== "6") {
    throw new Error("Hailuo 1080P 只支持 6 秒。")
  }
  if (capability?.ark) {
    const content = (request.audios ?? []).map((reference) =>
      ({ type: "audio_url", audio_url: { url: reference.dataUrl }, role: "reference_audio" }))
    if (params.reference_video_url) {
      const url = params.reference_video_url.trim()
      if (!/^(?:https?:\/\/[^/\s]+(?:\/\S*)?|asset:\/\/[^\s/]+)$/.test(url)) {
        throw new Error("参考视频需使用公网 HTTP(S) 地址或方舟素材 ID。")
      }
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" })
    }
    if (capability.promptUse === "optional" && !request.prompt?.trim() && !request.images.length && !content.length) {
      throw new Error("请填写提示词或提供参考媒体。")
    }
    if (content.length) body.content = content
    for (const key of ["watermark", "seed"]) if (params[key] !== undefined) body[key] = params[key]
  }
  if (request.images.length) {
    if (mode === "主体参考") body.reference_images = request.images.map((image) => image.dataUrl)
    else if (mode === "尾帧") body.last_frame = request.images[0].dataUrl
    else {
      body.input_reference = request.images[0].dataUrl
      if (mode === "首尾帧") body.last_frame = request.images[1].dataUrl
    }
  }
  return { method: "POST", path: "/videos", body }
}

export function parseSubmit(response, request) {
  if (response.body?.error) {
    const { message, ...refusal } = parseError(response)
    return { error: message, ...refusal }
  }
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
    const base64 = image.b64_json
    if (typeof base64 === "string" && base64) outputs.push({ base64,
      ...(typeof image.mime_type === "string" && image.mime_type.startsWith("image/") ? { mime: image.mime_type } : {}) })
    else if (typeof image.url === "string" && image.url) outputs.push({ url: image.url })
    else return { error: "Magpie returned an unreadable image." }
  }
  if (capability?.outputsPerTask > 1 && outputs.length !== capability.outputsPerTask) {
    return { error: `Magpie returned ${outputs.length} images; ${capability.outputsPerTask} were expected.` }
  }
  return { outputs }
}

export function buildPoll(task) {
  return { method: "GET", path: `/videos/${encodeURIComponent(task.id)}` }
}

export function parsePoll(response, task) {
  const body = response.body
  if (body?.error) {
    const { message, code } = parseError(response)
    return { status: "failed", message, ...(code ? { code } : {}) }
  }
  if (body?.status === "queued" || body?.status === "in_progress") {
    return { status: "running", ...(typeof body.progress === "number" ? { progress: body.progress / 100 } : {}) }
  }
  if (body?.status === "completed") {
    return { status: "done", outputs: [{ fetch: { method: "GET", path: `/videos/${encodeURIComponent(task.id)}/content` } }] }
  }
  return { status: "failed", message: `Magpie video task status: ${String(body?.status)}.` }
}

export function parseError(response) {
  const error = response.body?.error
  const detail = response.body?.detail
  const message = [error?.message, error, detail?.message, detail, response.body?.message]
    .find((value) => typeof value === "string" && value.trim()) || `Magpie returned HTTP ${response.status}.`
  const rawCode = error?.code ?? error?.type ?? detail?.code
  const legacyCode = capability?.minimaxErrors && (rawCode == null || rawCode === "api_error")
    ? message.split(" (tried first:", 1)[0].match(/\((\d{3,5})\)\s*$/)?.[1] : undefined
  const code = legacyCode ?? (typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode).slice(0, 64) : undefined)
  const quota = (code === "1008" && capability?.minimaxErrors) || [code, error?.type].some((value) =>
    ["insufficient_quota", "insufficient_balance", "insufficient_balance_error", "quota_exceeded", "2061", "2068"].includes(value))
  const status = response.status
  const kind = quota || status === 402 ? "noQuota" : status === 401 || status === 403 ? "unauthorized" :
    status === 408 || status === 429 || status >= 500 ? "retry" : "rejected"
  return { message, ...(code ? { code } : {}), kind }
}
