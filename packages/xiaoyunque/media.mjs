import { VendorError } from "./api.mjs"

const RATIOS = new Map([[0, "adaptive"], [2, "16:9"], [3, "9:16"], [4, "4:3"], [5, "3:4"], [6, "1:1"], [7, "2:1"], [8, "2.35:1"], [9, "1.85:1"], [10, "1.125:2.436"], [11, "3:2"], [12, "2:3"], [13, "21:9"]])
const own = (value, key) => Object.hasOwn(value, key)
const fail = (message) => { throw new VendorError(message) }
const canonical = (value) => String(value).toLowerCase()

function referenceCapabilities(model) {
  const limits = {}
  for (const key of ["image_total_limit", "video_total_limit", "audio_total_limit", "total_limit"]) {
    if (model[key] == null) continue
    const value = Number(model[key])
    if (model[key] === "" || typeof model[key] === "boolean" || !Number.isSafeInteger(value) || value < 0) fail("模型参考素材数量配置无效。")
    limits[key] = value
  }
  const modes = model.creation_mode_config?.modes ?? []
  const input = {}
  const modeTypes = {
    text_to_video: [], first_last_frame: ["image"],
    reference_generation: ["image", "video", "audio"],
    video_edit: ["image", "video", "audio"], video_extend: ["image", "video", "audio"],
  }
  const enabledModes = modes.filter((mode) => mode.enabled !== false)
  const hasUnknownMode = enabledModes.some((mode) => !own(modeTypes, mode.key))
  for (const type of ["image", "video", "audio"]) {
    const limit = limits[`${type}_total_limit`]
    if ((model.kind === "image" && type !== "image") || limit === 0 || limits.total_limit === 0) {
      input[type] = false
      continue
    }
    const possible = enabledModes.filter((mode) => modeTypes[mode.key]?.includes(type) &&
      !(type === "image" && mode.key === "first_last_frame" && model.is_support_first_frame_image === false) &&
      !mode.validation_policy?.forbidden_input_types?.includes(type))
    if (model.kind === "video" && modes.length && !possible.length && !hasUnknownMode) {
      input[type] = false
      continue
    }
    const supportsByLimit = limit > 0 && (model.kind === "image" || !modes.length || possible.length > 0)
    const supportsFirstFrame = type === "image" && model.is_support_first_frame_image === true &&
      (!modes.length || possible.some((mode) => mode.key === "first_last_frame"))
    const supportsVideoMaterial = type === "video" && possible.some((mode) => mode.enabled === true &&
      (mode.validation_policy?.required_video_count > 0 || mode.validation_policy?.accepted_video_sources?.includes("material")))
    if (supportsByLimit || supportsFirstFrame || supportsVideoMaterial) input[type] = true
  }
  const referenceModes = []
  if (model.kind === "video" && input.image !== false) {
    const frames = modes.find((mode) => mode.key === "first_last_frame")
    const reference = modes.find((mode) => mode.key === "reference_generation")
    if (model.is_support_first_frame_image === true && (!modes.length || (frames && frames.enabled !== false)) &&
        !frames?.validation_policy?.forbidden_input_types?.includes("image")) {
      referenceModes.push(model.is_support_last_frame_image === true ? "first-last-frame" : "first-frame")
    }
    if (limits.image_total_limit > 0 && (!modes.length || (reference && reference.enabled !== false)) &&
        !reference?.validation_policy?.forbidden_input_types?.includes("image")) referenceModes.push("reference")
  }
  const noReferenceModes = modes.length > 0 && enabledModes.every((mode) =>
    ["text_to_video", "video_edit", "video_extend"].includes(mode.key))
  return { input, limits, referenceModes, noReferenceModes }
}

function explicitCapabilities(model) {
  return Object.fromEntries(["supports_seed", "is_support_first_frame_image", "is_support_last_frame_image"]
    .filter((key) => typeof model[key] === "boolean").map((key) => [key, model[key]]))
}

function modelRatios(model) {
  const dimension = model.parameter_config?.dimensions?.find((entry) => entry.key === "ratio")
  const values = dimension ? (dimension.option_list ?? []).filter((option) => !option.disabled).map((option) => Number(option.value)) :
    model.supported_ratio_list ?? []
  return [...new Set(values.filter((value) => RATIOS.has(value)).map((value) => RATIOS.get(value)))]
}

export function modelRows(rows) {
  return Object.fromEntries(rows.filter((model) => model.disabled !== true).map((model) => {
    const image = model.kind === "image"
    const id = image ? model.name : model.key
    const references = referenceCapabilities(model)
    const supported = {}
    const ratioDimension = model.parameter_config?.dimensions?.find((dimension) => dimension.key === "ratio")
    const ratios = modelRatios(model)
    if (ratios.length) {
      supported.aspect_ratio = { type: "enum", values: ratios }
      const defaultRatio = model.parameter_config?.default_combination?.ratio ?? ratioDimension?.default_value ?? model.default_ratio
      const label = RATIOS.get(Number(defaultRatio))
      if (defaultRatio != null && !ratioDimension?.active_when_any?.length && ratios.includes(label)) supported.aspect_ratio.default = label
    }
    for (const dimension of model.parameter_config?.dimensions ?? []) {
      const key = { resolution: "resolution", duration: "seconds", effort: "quality" }[dimension.key]
      if (!key) continue
      function normalizeValue(value) {
        if (key === "seconds") return Number(value)
        if (image && key === "resolution") return value.toUpperCase()
        if (key === "quality") return value.toLowerCase()
        return value
      }
      const values = dimension.option_list?.filter((option) => !option.disabled).map((option) => option.value)
      if (values?.length) {
        supported[key] = { type: "enum", values: values.map(normalizeValue),
          ...(key === "quality" ? { title: dimension.label || "推理强度" } : {}) }
      } else if (!dimension.option_list?.length && dimension.range_config) {
        const range = dimension.range_config
        supported[key] = { type: "range", min: Number(range.min_value), max: Number(range.max_value), step: Number(range.step ?? 1) }
      }
      const rawDefault = model.parameter_config?.default_combination?.[dimension.key] ?? dimension.default_value
      const parameter = supported[key]
      if (rawDefault == null || !parameter || dimension.active_when_any?.length) continue
      const textValue = key === "quality" || (image && key === "resolution")
      const value = normalizeValue(textValue ? String(rawDefault) : rawDefault)
      const validRange = parameter.type === "range" && Number.isFinite(value) &&
        value >= parameter.min && value <= parameter.max && (value - parameter.min) % parameter.step === 0
      if (parameter.values?.includes(value) || validRange) {
        parameter.default = value
      }
    }
    const mediaRequest = image ? { size: "aspect-resolution" } : {}
    if (!image) {
      if (references.referenceModes.length || references.input.image === false || references.noReferenceModes) mediaRequest.reference_modes = references.referenceModes
      const frames = model.creation_mode_config?.modes?.find((mode) => mode.key === "first_last_frame")
      if (references.referenceModes.some((mode) => mode.startsWith("first-")) && frames?.ratio_policy?.value_mode === "smart") mediaRequest.frame_ratio = "auto"
    }
    if (references.input.image === false) supported.input_references = { type: "range", min: 0, max: 0 }
    else if (references.input.image === true && references.limits.image_total_limit !== undefined) {
      supported.input_references = { type: "range", min: 0, max: references.limits.image_total_limit }
    }
    let attachment
    if (Object.values(references.input).includes(true)) attachment = true
    else if (Object.keys(references.input).length === 3) attachment = false
    return [id, {
      id, providerID: "xiaoyunque", name: model.name,
      temperature: false, reasoning: false, tool_call: false,
      ...(attachment !== undefined ? { attachment } : {}),
      modalities: { output: [model.kind] },
      supported_parameters: supported,
      media_request: mediaRequest,
      api: { id, url: "https://xyq.jianying.com/v1", npm: "@ai-sdk/openai-compatible" },
      status: "active", headers: {}, options: {}, limit: { context: 0, output: 0 }, variants: {},
      capabilities: {
        temperature: false, reasoning: false, toolcall: false,
        ...(attachment !== undefined ? { attachment } : {}),
        input: { text: true, ...references.input, pdf: false },
        output: { text: false, image, video: !image, audio: false, pdf: false },
        ...references.limits,
        ...(Array.isArray(model.supported_ratio_list) ? { supported_ratio_list: model.supported_ratio_list } : {}),
        ...(model.default_ratio != null ? { default_ratio: model.default_ratio } : {}),
        ...explicitCapabilities(model),
        ...(model.parameter_config ? { parameter_config: model.parameter_config } : {}),
        ...(model.creation_mode_config ? { creation_mode_config: model.creation_mode_config } : {}),
      },
    }]
  }))
}

export function describeModel(model) {
  const dimensions = model.parameter_config?.dimensions ?? []
  const references = referenceCapabilities(model)
  const fieldTypes = { reference_images: "image", reference_videos: "video", reference_audios: "audio", input_reference: "image", last_frame: "image" }
  const videoModes = {
    text_to_video: { parameters: {}, input_fields: [] },
    reference_generation: { parameters: { task_type: "reference" }, input_fields: ["reference_images", "reference_videos", "reference_audios"] },
    first_last_frame: { parameters: { generate_type: 1 }, input_fields: ["input_reference", "last_frame"] },
    video_edit: { parameters: { task_type: "edit" }, input_fields: ["reference_videos"] },
    video_extend: { parameters: { task_type: "extend" }, input_fields: ["reference_videos"] },
  }
  return {
    name: model.name, kind: model.kind, disabled: model.disabled === true, ...(model.kind === "video" ? { id: model.key } : {}),
    parameters: dimensions.filter((dimension) => ["ratio", "resolution", "effort", "duration", "seed"].includes(dimension.key)),
    ratios: modelRatios(model),
    parameter_config: model.parameter_config,
    capabilities: explicitCapabilities(model),
    creation_modes: (model.creation_mode_config?.modes ?? []).map((mode) => {
      if (model.kind !== "video" || !Object.hasOwn(videoModes, mode.key)) return { ...mode }
      const request = videoModes[mode.key]
      const input_fields = request.input_fields.filter((field) => {
        const type = fieldTypes[field]
        return references.input[type] !== false &&
          !mode.validation_policy?.forbidden_input_types?.includes(type) &&
          !(field === "input_reference" && model.is_support_first_frame_image === false) &&
          !(field === "last_frame" && model.is_support_last_frame_image === false)
      })
      return { ...mode, request: { ...request, input_fields } }
    }),
    limits: Object.fromEntries(Object.entries(model).filter(([key]) => /(?:limit|size|duration)/.test(key) && key !== "supported_duration_list")),
  }
}

function sourceOf(value) {
  if (typeof value === "string" && value) return value
  if (value && typeof value.image_url === "string") return value.image_url
  if (value && typeof value.image_url?.url === "string") return value.image_url.url
  if (value && typeof value.url === "string") return value.url
  fail("参考媒体必须是 data URL 或 HTTPS 地址。")
}

function references(body, key) {
  if (!own(body, key)) return []
  const value = body[key]
  return (Array.isArray(value) ? value : [value]).map(sourceOf)
}

function integer(value, name) {
  const result = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(result)) fail(`${name} 必须为整数。`)
  return result
}

function validateDimensions(model, params) {
  const dimensions = model.parameter_config?.dimensions ?? []
  const values = { ...params, duration: params.seconds }
  const defaults = { ...Object.fromEntries(dimensions.filter((dimension) => dimension.default_value != null)
    .map((dimension) => [dimension.key, dimension.default_value])), ...model.parameter_config?.default_combination }
  const effective = { ...defaults, ...params }
  if (params.seconds !== undefined) effective.duration = params.seconds
  function equal(key, left, right) {
    if (key === "ratio") {
      left = RATIOS.get(Number(left)) ?? left
      right = RATIOS.get(Number(right)) ?? right
    }
    return canonical(left) === canonical(right)
  }
  for (const dimension of dimensions) {
    if (!["ratio", "resolution", "effort", "duration"].includes(dimension.key)) continue
    const value = values[dimension.key]
    if (value === undefined) continue
    const conditions = dimension.active_when_any
    if (Array.isArray(conditions) && conditions.length) {
      const active = conditions.some((condition) => Object.entries(condition).every(([key, allowed]) => {
        if (effective[key] === undefined) return true
        const options = Array.isArray(allowed) ? allowed : [allowed]
        return options.some((entry) => equal(key, entry, effective[key]))
      }))
      if (!active) fail(`参数 ${dimension.key} 在当前组合下不适用。`)
    }
    const options = dimension.option_list
    if (Array.isArray(options) && (options.length || !dimension.range_config) &&
        !options.some((option) => !option.disabled && equal(dimension.key, option.value, value))) {
      fail(`模型不支持 ${dimension.key}=${value}。请查看当前模型参数。`)
    }
    const range = dimension.range_config
    if (range && (typeof value !== "number" ||
        (range.min_value !== undefined && value < Number(range.min_value)) ||
        (range.max_value !== undefined && value > Number(range.max_value)) ||
        (range.step > 0 && (value - Number(range.min_value ?? 0)) % Number(range.step) !== 0))) {
      fail(`参数 ${dimension.key} 超出模型范围。`)
    }
  }
  const configuration = model.parameter_config
  if (configuration?.need_available_combinations && Array.isArray(configuration.available_combinations)) {
    const keys = (configuration.combination_dimension_keys ?? []).filter((key) => values[key] !== undefined)
    if (keys.length && !configuration.available_combinations.some((combination) =>
      !combination.disabled && keys.every((key) => equal(key, combination.option_values?.[key], values[key])))) {
      fail("模型不支持所选参数组合。")
    }
  }
}

export function normalizeRequest(kind, body, model) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("生成请求必须是对象。")
  const overrides = []
  if (body.size !== undefined && body.size !== "auto") {
    if (body.ratio !== undefined) overrides.push("size 的比例由 ratio 覆盖")
    if (body.resolution !== undefined) overrides.push("size 的分辨率由 resolution 覆盖")
  }
  if (kind === "video" && body.seconds !== undefined && body.duration !== undefined) overrides.push("seconds 由 duration 覆盖")
  if (kind === "image" && typeof body.size === "string" && body.size.includes("@")) {
    const match = /^(auto|[1-9]\d*(?:\.\d+)?:[1-9]\d*(?:\.\d+)?)@(auto|\d+(?:\.\d+)?K)$/.exec(body.size)
    if (!match) fail("size 比例／分辨率格式不正确。")
    const [, ratio, resolution] = match
    body = { ...body, size: undefined }
    if (ratio !== "auto" && body.ratio === undefined) body.ratio = ratio
    if (resolution !== "auto" && body.resolution === undefined) body.resolution = resolution
  }
  const common = ["model", "prompt", "team_id"]
  const supported = kind === "image" ?
    ["n", "size", "quality", "resolution", "effort", "ratio", "images", "image", "image[]", "reference_images", "background", "output_format", "mask", "markup", "complexity", "response_format"] :
    ["seconds", "duration", "size", "ratio", "resolution", "image", "input_reference", "last_frame", "images", "reference_images", "reference_videos", "reference_audios", "generate_type", "task_type", "seed", "draft", "draft_task_id"]
  const unknown = Object.keys(body).filter((key) => !common.includes(key) && !supported.includes(key))
  if (unknown.length) fail(`小云雀不支持参数：${unknown.join("、")}。`)
  if (kind === "video" && body.draft_task_id !== undefined) {
    if (typeof body.draft_task_id !== "string" || !body.draft_task_id.trim()) fail("draft_task_id 须为原始样片任务 ID。")
    if (model.key !== "Seedance_2.5_draft") fail("样片升级必须继续使用 Seedance_2.5_draft，不能切换模型。")
    const ignoredParameters = ["prompt", ...supported.filter((key) => key !== "draft_task_id")]
      .filter((key) => body[key] !== undefined)
    return {
      prompt: "", params: { draft_task_id: body.draft_task_id }, images: [], videos: [], audios: [],
      adaptation: { stage: "draft_upgrade", ignored_parameters: ignoredParameters, message: "升级继承原样片设置；附带的创作参数不生效，参考素材不读取或上传。" },
    }
  }
  for (const key of ["mask", "markup", "complexity"]) if (body[key] !== undefined) fail(`小云雀不支持 ${key}。`)
  if (body.background !== undefined && body.background !== "auto") fail("小云雀未提供透明或不透明背景控制。")
  if (body.output_format !== undefined) fail("小云雀未提供输出格式转换，请使用原始产物。")
  if (body.response_format !== undefined && !["url", "b64_json"].includes(body.response_format)) fail("不支持该图片响应格式。")
  if (body.size !== undefined && (typeof body.size !== "string" || !body.size)) fail("size 须为有效尺寸或比例。")
  if (body.ratio !== undefined && (!["string", "number"].includes(typeof body.ratio) || body.ratio === "")) fail("ratio 须为有效比例。")
  const draftPreview = kind === "video" && model.key === "Seedance_2.5_draft"
  const prompt = body.prompt ?? ""
  if (typeof prompt !== "string" || !prompt.trim()) fail("请提供生成提示词。")
  const params = {}
  let ratio = body.ratio
  if (body.size && body.size !== "auto") {
    const pixels = /^(\d+)x(\d+)$/.exec(body.size)
    if (pixels) {
      const width = Number(pixels[1])
      const height = Number(pixels[2])
      if (!width || !height) fail("size 宽高须大于 0。")
      ratio ??= [...RATIOS.values()].find((candidate) => {
        const pair = candidate.split(":").map(Number)
        return pair.length === 2 && Math.abs(width / height - pair[0] / pair[1]) < 0.002
      })
      if (!ratio) fail("size 比例不在小云雀支持范围，请使用明确比例。")
      if (kind === "video" && !draftPreview && body.resolution === undefined) {
        params.resolution = `${Math.min(width, height)}p`
      }
    } else ratio ??= body.size
  }
  if (ratio !== undefined) {
    if (kind === "image") {
      const enumerated = typeof ratio === "number" || /^\d+$/.test(String(ratio)) ? Number(ratio) :
        [...RATIOS].find(([, label]) => label === ratio)?.[0]
      if (!RATIOS.has(enumerated)) fail("图片比例不支持。")
      params.ratio = enumerated
    } else {
      if (!RATIOS.has(Number(ratio)) && ![...RATIOS.values()].includes(ratio)) fail("视频比例不支持。")
      params.ratio = RATIOS.get(Number(ratio)) ?? ratio
    }
  }
  if (body.resolution !== undefined && !draftPreview) {
    if (typeof body.resolution !== "string" || !body.resolution) fail("resolution 须为模型支持的分辨率。")
    params.resolution = kind === "image" ? body.resolution.toUpperCase() : body.resolution
  }
  if (kind === "image") {
    if (body.effort !== undefined && body.quality !== undefined && body.quality !== "auto") fail("quality 和 effort 请只填写一项。")
    if (body.effort === null || body.quality === null) fail("图片推理强度须为字符串。")
    const effort = body.effort ?? (body.quality !== "auto" ? body.quality : undefined)
    if (effort !== undefined) {
      if (typeof effort !== "string") fail("图片推理强度须为字符串。")
      params.effort = effort.toLowerCase()
      if (!model.parameter_config?.dimensions?.some((dimension) => dimension.key === "effort")) fail("当前图片模型未开放推理强度参数。")
    }
    if (body.n !== undefined) {
      params.n = integer(body.n, "图片数量")
      if (params.n < 1 || params.n > 4) fail("图片数量须为 1–4。")
    }
  } else {
    if (body.seconds !== undefined || body.duration !== undefined) {
      params.seconds = integer(body.duration !== undefined ? body.duration : body.seconds, "视频时长")
      if (params.seconds < 1) fail("视频时长须大于 0。")
    }
    for (const key of ["generate_type", "seed"]) if (body[key] !== undefined) params[key] = integer(body[key], key)
    if (params.seed !== undefined && model.supports_seed === false) {
      fail("当前模型不支持 seed。")
    }
    if (params.generate_type !== undefined && ![0, 1].includes(params.generate_type)) fail("generate_type 只能为 0 或 1。")
    if (body.task_type !== undefined) {
      if (!["reference", "edit", "extend", "auto"].includes(body.task_type)) fail("task_type 不支持。")
      params.task_type = body.task_type
    }
    if (body.draft !== undefined) {
      if (typeof body.draft !== "boolean") fail("draft 须为布尔值。")
      params.draft = body.draft
    }
  }
  if (kind === "video" && body.image !== undefined && body.input_reference !== undefined) fail("image 和 input_reference 均表示首帧，请只填写一项。")
  const images = [...references(body, "images"), ...(kind === "image" ? references(body, "image") : []), ...references(body, "image[]"), ...references(body, "reference_images")]
  const first = kind === "video" && body.image !== undefined ? references(body, "image") : references(body, "input_reference")
  const last = references(body, "last_frame")
  if (first.length > 1 || last.length > 1) fail("首帧、尾帧各只能提供一张图片。")
  if (last.length && !first.length) fail("尾帧需要同时提供首帧。")
  if ((first.length || last.length) && images.length) fail("首尾帧与参考图片请使用一种输入方式。")
  if (kind === "video" && first.length && params.generate_type === 0) fail("首帧输入与 generate_type=0 冲突。")
  images.unshift(...first, ...last)
  if (first.length) params.generate_type = 1
  if (kind === "video" && params.generate_type === 1) {
    if (images.length && model.is_support_first_frame_image === false) fail("当前模型不支持首帧输入。")
    if (images.length > 1 && model.is_support_last_frame_image === false) fail("当前模型不支持尾帧输入。")
  }
  if (kind === "video" && params.generate_type === 1 && ["reference", "edit", "extend"].includes(params.task_type)) {
    fail("首尾帧与 task_type 模式冲突，请只选择一种模式。")
  }
  const videos = references(body, "reference_videos")
  const audios = references(body, "reference_audios")
  if (kind === "video" && params.draft === true && model.key !== "Seedance_2.5_draft") {
    fail("Draft 样片必须使用 Seedance_2.5_draft。")
  }
  if (draftPreview) {
    if (params.draft === false) fail("Draft 升级请提供原始 draft_task_id。")
    params.draft = true
  }
  if (kind === "image" && (videos.length || audios.length)) fail("图片生成仅支持参考图片。")
  const referenceSupport = referenceCapabilities(model)
  const counts = { image: images.length, video: videos.length, audio: audios.length }
  for (const [type, count] of Object.entries(counts)) {
    const limit = referenceSupport.limits[`${type}_total_limit`]
    if (limit !== undefined && count > limit) fail(`参考${type}数量超过模型上限。`)
    if (count && referenceSupport.input[type] === false) fail(`当前模型未开放参考${type}，不支持该素材类型。`)
  }
  if (referenceSupport.limits.total_limit !== undefined && images.length + videos.length + audios.length > referenceSupport.limits.total_limit) fail("参考素材总数超过模型上限。")
  if (kind === "image" && params.ratio !== undefined && !model.parameter_config?.dimensions?.some((dimension) => dimension.key === "ratio") &&
      Array.isArray(model.supported_ratio_list) && !model.supported_ratio_list.includes(params.ratio)) fail("模型不支持所选比例。")
  if (kind === "video") {
    const modes = model.creation_mode_config?.modes ?? []
    let modeKey = "reference_generation"
    if (params.generate_type === 1) modeKey = "first_last_frame"
    else if (params.task_type === "edit") modeKey = "video_edit"
    else if (params.task_type === "extend") modeKey = "video_extend"
    else if (params.task_type !== "reference" && !images.length && !videos.length && !audios.length &&
        modes.some((mode) => mode.key === "text_to_video")) modeKey = "text_to_video"
    const mode = modes.find((entry) => entry.key === modeKey)
    if (modes.length && !mode) fail("当前模型未提供所选创作模式。")
    if (mode?.enabled === false) fail("当前模型未开放所选创作模式。")
    if (["edit", "extend"].includes(params.task_type) && videos.length !== 1) fail("视频编辑或延长须提供一条参考视频。")
    if (params.generate_type === 1 && (!images.length || images.length > 2 || videos.length || audios.length)) fail("首尾帧模式仅接受一张或两张图片。")
    if (mode?.ratio_policy?.value_mode === "smart" && params.ratio !== undefined && params.ratio !== "adaptive") fail("所选模式自动沿用素材比例，仅支持 adaptive。")
    if (mode?.duration_policy === "smart_disabled" && params.seconds !== undefined) fail("所选模式自动沿用素材时长，不能指定 seconds。")
    if (model.key === "Seedance_2.0_mini_lite" && params.ratio === undefined &&
        params.generate_type !== 1 && !params.draft_task_id && !["edit", "extend"].includes(params.task_type)) {
      fail("Seedance 2.0 Mini 体验版需要视频比例，请填写 ratio（例如 16:9）或 size。")
    }
    const forbidden = mode?.validation_policy?.forbidden_input_types ?? []
    if (Object.entries(counts).some(([type, count]) => count && forbidden.includes(type))) fail("所选模式不支持该参考素材类型。")
    const requiredVideoCount = mode?.validation_policy?.required_video_count
    if (requiredVideoCount > 0 && videos.length !== requiredVideoCount) fail(`所选模式须提供 ${requiredVideoCount} 条参考视频。`)
    if (params.ratio !== undefined && mode?.ratio_policy?.value_mode !== "smart" &&
        !model.parameter_config?.dimensions?.some((dimension) => dimension.key === "ratio") && Array.isArray(model.supported_ratio_list) &&
        !model.supported_ratio_list.some((ratio) => RATIOS.get(ratio) === params.ratio)) fail("模型不支持所选视频比例。")
  }
  validateDimensions(model, params)
  let adaptation
  if (draftPreview) {
    adaptation = {
      stage: "draft_preview",
      ignored_parameters: body.resolution !== undefined ? ["resolution"] : [],
      message: "Draft 模型自动生成 480p 样片；size 仅用于比例，分辨率由服务端固定。",
    }
  }
  if (overrides.length) {
    adaptation ??= { stage: "parameter_override" }
    adaptation.message = [adaptation.message, ...overrides].filter(Boolean).join("；")
  }
  return { prompt, params, images, videos, audios, ...(adaptation ? { adaptation } : {}) }
}

export function buildSubmission(kind, normalized, model, assets) {
  const { prompt, params } = normalized
  if (kind === "image") {
    const settings = { image_model: model.key }
    for (const [key, value] of Object.entries(params)) settings[({ effort: "image_effort", n: "generate_image_count" }[key] ?? key)] = value
    return {
      agent_name: "pippit_nest_agent", message: prompt, platform: "magpie", general_agent_settings: settings,
      ...(assets.images.length ? { asset_ids: assets.images } : {}),
    }
  }
  const settings = { model: model.key, prompt }
  for (const [key, value] of Object.entries(params)) settings[key === "seconds" ? "duration_sec" : key] = value
  for (const key of ["images", "videos", "audios"]) if (assets[key].length) settings[key] = assets[key].map((id) => ({ pippit_asset_id: id }))
  return { agent_name: "pippit_video_part_agent", call_source: "pippit_cli", message: prompt, platform: "magpie", video_part_tool_param: settings }
}

export function parseRun(data, runId) {
  const root = typeof data === "string" ? JSON.parse(data) : data
  const thread = root.thread
  if (!Array.isArray(thread?.run_list)) fail("小云雀任务响应缺少 run_list。")
  const run = thread.run_list.find((entry) => entry.run_id === runId)
  if (!run) fail("小云雀未返回原任务的 run_id。")
  const status = ({ 1: "running", 2: "running", 3: "succeeded", 4: "failed", 5: "canceled", 7: "running", 8: "running" })[run.state] ?? "unknown"
  const result = { status, rawState: run.state, images: [], videos: [] }
  const consumption = Object.fromEntries(["actual_deduct_credits", "returned_credits"].flatMap((key) => {
    const raw = run.credit_consumption?.[key]
    const value = typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [[key, value]] : []
  }))
  if (Object.keys(consumption).length) result.credit_consumption = consumption
  if (status === "failed") result.error = run.error_message || run.error_msg || run.errmsg
  for (const entry of run.entry_list ?? []) {
    for (const part of entry.artifact?.content ?? []) {
      if (!["biz/x_data_image", "biz/x_data_video", "biz/x_data_predict_info"].includes(part.sub_type)) continue
      const value = typeof part.data === "string" ? JSON.parse(part.data) : part.data
      if (part.sub_type === "biz/x_data_predict_info") {
        if (typeof value?.predict_duration === "number" && Number.isFinite(value.predict_duration) && value.predict_duration >= 0) {
          result.predict_duration_ms = value.predict_duration
        }
        continue
      }
      if (value?.error_message && !result.error) result.error = value.error_message
      if (part.sub_type === "biz/x_data_image" && value?.image?.url) result.images.push({ url: value.image.url, ...mediaDetails(value.image) })
      if (part.sub_type === "biz/x_data_video" && value?.video?.download_url) {
        const video = value.video
        result.videos.push({
          url: video.download_url,
          ...mediaDetails(video),
          ...(typeof video.draft === "boolean" ? { draft: video.draft } : {}),
          ...(video.draft_task_id ? { draftTaskId: video.draft_task_id } : {}),
        })
      }
    }
  }
  if (status === "failed" && !result.error) result.error = "小云雀生成失败。"
  if (status === "succeeded" && !result.images.length && !result.videos.length) fail("小云雀任务已结束，但未返回可下载产物。")
  return result
}

function mediaDetails(media) {
  return Object.fromEntries(["width", "height", "duration_ms"].flatMap((key) => {
    const value = media[key] ?? media.metadata?.[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? [[key, value]] : []
  }))
}

export function encodeTask(task) {
  return `xyq1_${Buffer.from(JSON.stringify(task)).toString("base64url")}`
}

export function decodeTask(id) {
  if (typeof id !== "string" || !/^xyq1_[A-Za-z0-9_-]+$/.test(id) || id.length > 8192) fail("小云雀任务 ID 无效。")
  let task
  try {
    task = JSON.parse(Buffer.from(id.slice(5), "base64url").toString("utf8"))
  } catch {
    fail("小云雀任务 ID 无法解析。")
  }
  if (!task || !["image", "video"].includes(task.kind) ||
      ["thread", "run", "model", "team", "account"].some((key) => typeof task[key] !== "string" || !task[key]) ||
      !/^(0|[1-9]\d*)$/.test(task.team) || !/^[a-f0-9]{24}$/.test(task.account)) fail("小云雀任务记录不完整。")
  return task
}
