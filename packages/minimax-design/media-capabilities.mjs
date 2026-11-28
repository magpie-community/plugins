import { mediaConstraints } from "./media-constraints.mjs"
import { speechCapability } from "./speech.mjs"

const auto = "自动"
const designReferenceLimit = 16
const inlineReferenceMB = 20
const commonRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]
const grokRatios = [...commonRatios, "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"]
function select(key, title, values) {
  const options = values.filter((value) => value !== "auto" && value !== "adaptive")
  return { key, title, type: "string", enum: [auto, ...new Set(options)], default: auto }
}
const range = (key, title, min, max) => ({ key, title, type: "integer", min, max })
const pixels = ["1024x1024", "1536x1024", "1024x1536", "2048x1152", "1152x2048", "2048x2048", "3840x2160", "2160x3840"]

function pixelTier(size) {
  const longEdge = Math.max(...size.split("x").map(Number))
  if (longEdge < 512) return `${longEdge / 1024}K`
  return `${Math.round(longEdge / 1024 * 2) / 2}K`
}

export function bundledMediaProfile(model, route, imageInput) {
  if (route.startsWith("image-models/rightimage/")) route = route.slice("image-models/".length)
  const separator = route.indexOf("/")
  const provider = route.slice(0, separator)
  const modelID = route.slice(separator + 1)
  const minimaxKey = ["minimax", "minimax-cn"].includes(provider)
  const capability = { source: "unknown", transport: "generic",
    params: [],
    references: { min: 0, max: imageInput ? 1 : 0 }, modes: model.type === "video" ? ["首帧"] : [],
    defaultMode: "首帧" }
  if (route === "minimax-code/MiniMax-Image" && model.type === "image") {
    Object.assign(capability, { source: "minimax-matrix-2026-11-11", transport: "minimax-image",
      params: [select("ratio", "比例", [...commonRatios, "21:9", "9:21", "3:1", "1:3"]),
        select("resolution", "分辨率", ["1K", "2K", "4K"])],
      references: { min: 0, max: imageInput ? 16 : 0 }, maxMB: 64 })
  } else if (minimaxKey && model.type === "image" && ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"].includes(modelID)) {
    Object.assign(capability, { source: "magpie-minimax-api", transport: "minimax-h3-image",
      params: [select("ratio", "比例", [...commonRatios, "21:9", "9:21", "3:1", "1:3"]),
        select("resolution", "清晰度", ["1K", "2K", "4K"]),
        select("output_format", "输出格式", ["png", "jpeg", "webp"])],
      references: { min: 0, max: imageInput ? 16 : 0 } })
  } else if (minimaxKey && model.type === "image" && ["image-01", "image-01-live"].includes(modelID)) {
    const live = modelID === "image-01-live"
    Object.assign(capability, { source: "magpie-minimax-api", transport: "minimax-legacy-image",
      params: [select("ratio", "比例", live ? commonRatios : [...commonRatios, "21:9"])],
      references: { min: 0, max: imageInput ? 1 : 0 } })
    if (model.ref === route) {
      capability.params.push(range("seed", "随机种子", 0, 4294967295),
        { key: "prompt_optimizer", title: "提示词优化", type: "boolean" },
        { key: "aigc_watermark", title: "生成水印", type: "boolean" })
    }
  } else if (model.type === "video" && (
    (provider === "minimax-code" && ["MiniMax-H3", "MiniMax-H3-Max", "MiniMax-Hailuo-2.3"].includes(modelID)) ||
    (minimaxKey && ["MiniMax-H3", "MiniMax-H3-Max", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite"].includes(modelID))
  )) {
    const hailuo = modelID === "MiniMax-Hailuo-2.3"
    const max = modelID === "MiniMax-H3-Max"
    const resolutions = {
      "MiniMax-H3": minimaxKey ? ["480P", "768P", "2K"] : ["768P", "2K"], "MiniMax-H3-Max": ["480P", "768P"],
      "MiniMax-H3-Highspeed": ["480P", "768P"], "MiniMax-H3-Lite": ["768P", "480P"],
    }
    const subjects = !hailuo && (!max || minimaxKey)
    Object.assign(capability, { source: "minimax-matrix-2026-11-03", transport: "minimax-video",
      params: hailuo ? [select("resolution", "清晰度", ["768P", "1080P"]),
        { key: "seconds", title: "时长", type: "integer", enum: [6, 10] }] : [
        select("ratio", "比例", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
        select("resolution", "分辨率", resolutions[modelID]),
        range("seconds", "时长（秒）", max ? 5 : 4, 15)],
      hailuo, minimaxKey,
      references: { min: 0, max: imageInput ? (hailuo ? 1 : subjects ? 9 : 2) : 0 },
      modes: hailuo ? ["首帧"] : ["首帧", "首尾帧"],
      defaultMode: subjects ? "主体参考" : "首尾帧", maxMB: 30, promptMax: hailuo ? 3000 : 7000 })
    if (subjects) capability.modes.push("主体参考")
    if (minimaxKey) capability.modes.push("尾帧")
    if (minimaxKey && max) {
      capability.params.push(select("prompt_expansion_mode", "提示词扩展", ["disabled", "balanced", "quality"]))
    }
  } else if (["grok/grok-imagine-video", "grok/grok-imagine-video-1.5"].includes(route) && model.type === "video") {
    const newer = route.endsWith("-1.5")
    Object.assign(capability, { source: "magpie-grok-2026-11-13", transport: "grok-video",
      params: [select("ratio", "比例", commonRatios),
        select("resolution", "分辨率", newer ? ["480p", "720p", "1080p"] : ["480p", "720p"]),
        range("seconds", "时长（秒）", 1, 15)],
      references: { min: 0, max: imageInput ? (newer ? 14 : 7) : 0 },
      modes: ["首帧", "主体参考"], defaultMode: "主体参考", referenceSecondsMax: newer ? 15 : 10,
      referenceResolutions: ["480p", "720p"] })
  } else if (["grok/grok-imagine-image", "grok/grok-imagine-image-quality", "xai/grok-imagine-image"].includes(route) && model.type === "image") {
    Object.assign(capability, { source: "magpie-grok-2026-11-13", params: [select("ratio", "比例", grokRatios)] })
  } else if (["qwen-cn", "bailian-token-plan"].includes(provider) && /^(?:qwen-image|wan2\.7-image)/.test(modelID ?? "") && model.type === "image") {
    Object.assign(capability, { source: "qwencloud-2026-11-13",
      params: [select("size", "尺寸", ["1328x1328", "1664x928", "928x1664", "1472x1104", "1104x1472", "1584x1056", "1056x1584", "2048x2048"])] })
  } else if (["rightimage/gpt-image-2", "rightimage/gpt-image-2.5-flare", "rightimage/gpt-image-2.5-sunburst",
    "rightimage/gpt-image-2.6-flare", "rightimage/gpt-image-2.6-sunburst"].includes(route) && model.type === "image") {
    Object.assign(capability, { source: "rightapi-2026-11-13", params: [select("size", "尺寸", pixels)] })
  } else if (["rightimage/gemini-nano-banana-2.1", "rightimage/gemini-3-pro-image-preview"].includes(route) && model.type === "image") {
    capability.source = "gateway-default-only"
    capability.params = []
  }
  return capability
}

export function mediaCapability(model) {
  if (model.type === "speech") return speechCapability(model)
  const imageInput = model.images || model.parameters?.input_references?.max > 0
  let route = model.route ?? (model.requestModel ?? model.ref).replace(/^(?:remote-magpie\/)+/, "")
  if (model.requestModel && model.mediaRequest?.size === "pixels") route = model.ref.replace(/^(?:remote-magpie\/)+/, "")
  const capability = bundledMediaProfile(model, route, imageInput)
  if (/^(?:minimax|minimax-cn|minimax-code)\//.test(route)) capability.minimaxErrors = true
  const ark = model.type === "video" && model.mediaRequest?.video === "ark"
  const metadata = model.parameters
  if (model.mediaRequest !== undefined) {
    const mapping = model.mediaRequest
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) ||
        (mapping.size !== undefined && !["pixels", "aspect-resolution"].includes(mapping.size)) ||
        (mapping.video !== undefined && !ark) ||
        (mapping.prompt !== undefined && !["required", "optional"].includes(mapping.prompt)) ||
        (mapping.prompt === "optional" && !ark) ||
        (mapping.outputs_per_task !== undefined && (model.type !== "image" ||
          !Number.isSafeInteger(mapping.outputs_per_task) || mapping.outputs_per_task < 1 || mapping.outputs_per_task > 4)) ||
        (mapping.frame_ratio !== undefined && mapping.frame_ratio !== "auto") ||
        (mapping.reference_modes !== undefined && (model.type !== "video" || !Array.isArray(mapping.reference_modes) ||
          mapping.reference_modes.some((mode) => !["first-frame", "first-last-frame", "reference"].includes(mode))))) {
      throw new Error("Invalid media_request mapping.")
    }
    capability.promptUse = mapping.prompt ?? "required"
    if (mapping.outputs_per_task !== undefined) capability.outputsPerTask = mapping.outputs_per_task
    if (mapping.reference_modes !== undefined && capability.transport === "generic") {
      const modes = { "first-frame": "首帧", "first-last-frame": "首尾帧", reference: "主体参考" }
      capability.modes = [...new Set(mapping.reference_modes.map((mode) => modes[mode]))]
      if (capability.modes.includes("首尾帧")) capability.modes.unshift("首帧")
      capability.defaultMode = capability.modes.includes("主体参考") ? "主体参考" : capability.modes.at(-1)
      const declaredMax = metadata?.input_references?.max ?? (imageInput ? 1 : 0)
      let mappedMax = 0
      if (capability.modes.includes("主体参考")) mappedMax = designReferenceLimit
      else if (capability.modes.includes("首尾帧")) mappedMax = 2
      else if (capability.modes.includes("首帧")) mappedMax = 1
      capability.references.max = Math.min(declaredMax, mappedMax)
      capability.frameRatio = mapping.frame_ratio
    }
  }
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid media supported_parameters.")
    if (route.startsWith("openrouter/") && model.type === "image") {
      const ratios = metadata.aspect_ratio
      const resolutions = metadata.resolution
      for (const parameter of [ratios, resolutions]) {
        if (parameter !== undefined && (parameter?.type !== "enum" || !Array.isArray(parameter.values) ||
            !parameter.values.every((value) => typeof value === "string"))) throw new Error("Invalid OpenRouter media enum.")
      }
      capability.params = []
      capability.transport = "openrouter-image"
      for (const ratio of ratios?.values ?? []) {
        if (ratio === "auto") continue
        if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(ratio)) throw new Error("Invalid media aspect ratio.")
      }
      if (ratios?.values.length) capability.params.push(select("ratio", "比例", ratios.values))
      const tiers = model.imageOnly ? resolutions?.values.filter((value) => ["2K", "4K"].includes(value)) ?? [] : []
      if (tiers.length) {
        capability.params.push(select("resolution", "清晰度", tiers))
        capability.pixelRatios = [...commonRatios, "21:9"]
      }
      capability.source = model.parameterSource ?? "magpie"
    }
    if (model.mediaRequest?.size === "aspect-resolution" && model.type === "image") {
      capability.transport = "image-size"
    }
    for (const [key, title] of [["aspect_ratio", "比例"], ["resolution", "清晰度"]]) {
      if (metadata[key] === undefined || capability.transport === "openrouter-image") continue
      const parameter = metadata[key]
      if (parameter?.type !== "enum" || !Array.isArray(parameter.values) || !parameter.values.length ||
          !parameter.values.every((value) => typeof value === "string" && value.length && value !== auto)) {
        throw new Error(`Unsupported media parameter schema: ${key}.`)
      }
      const mapped = key === "aspect_ratio" ? "ratio" : "resolution"
      if (key === "resolution" && capability.transport === "generic" && model.type === "image") continue
      if (key === "aspect_ratio" && parameter.values.some((value) => !["auto", "adaptive"].includes(value) &&
          !/^[1-9]\d*(?:\.\d+)?:[1-9]\d*(?:\.\d+)?$/.test(value))) {
        throw new Error("Invalid media aspect ratio.")
      }
      if (key === "resolution" && !["generic", "image-size"].includes(capability.transport)) {
        const transferable = ["minimax-image", "minimax-h3-image"].includes(capability.transport) ? ["1K", "2K", "4K"] :
          capability.transport === "minimax-video" ? ["480P", "768P", "1080P", "2K"] : ["480p", "720p", "1080p"]
        if (parameter.values.some((value) => value !== "auto" && !transferable.includes(value))) throw new Error("Media resolution has no verified gateway mapping.")
      }
      capability.params = capability.params.filter((entry) => entry.key !== mapped && entry.key !== "preset")
      capability.params.push(select(mapped, title, parameter.values))
      capability.source = model.parameterSource ?? "magpie"
    }
    for (const [key, title] of [["size", "尺寸"], ["seconds", "时长（秒）"], ["quality", "画质"],
      ["background", "背景"], ["output_format", "输出格式"], ["complexity", "推理强度"]]) {
      if (metadata[key] === undefined) continue
      if (["quality", "background", "complexity"].includes(key) &&
          (model.type !== "image" || !["generic", "image-size"].includes(capability.transport))) continue
      if (key === "output_format" && (model.type !== "image" ||
          !["generic", "image-size", "minimax-h3-image"].includes(capability.transport))) continue
      const parameter = metadata[key]
      if (parameter?.title !== undefined && (typeof parameter.title !== "string" || !parameter.title.trim())) {
        throw new Error(`Invalid media parameter title: ${key}.`)
      }
      let control
      if (key === "seconds" && parameter?.type === "enum") {
        if (!Array.isArray(parameter.values) || !parameter.values.length ||
            !parameter.values.every((value) => {
              if (typeof value === "string" && !/^(?:-1|[1-9]\d*)$/.test(value)) return false
              if (typeof value !== "string" && typeof value !== "number") return false
              return Number.isSafeInteger(Number(value)) && (Number(value) >= 1 || (ark && Number(value) === -1))
            })) {
          throw new Error("Unsupported media parameter schema: seconds.")
        }
        control = { key, title, type: "integer", enum: [...new Set(parameter.values.map(Number))] }
      } else if (parameter?.type === "enum" && Array.isArray(parameter.values) && parameter.values.length > 0 &&
          parameter.values.every((value) => typeof value === "string" && value.length > 0 && value !== auto)) {
        control = select(key, parameter.title ?? title, parameter.values)
      } else if (key === "seconds" && parameter?.type === "range" && Number.isInteger(parameter.min) &&
          Number.isInteger(parameter.max) && parameter.min >= 1 && parameter.max >= parameter.min) {
        const step = parameter.step ?? 1
        if (!Number.isInteger(step) || step < 1 || parameter.max - parameter.min > 300) throw new Error("Unsupported media duration range.")
        control = { ...range(key, title, parameter.min, parameter.max), step }
      } else throw new Error(`Unsupported media parameter schema: ${key}.`)
      capability.params = capability.params.filter((entry) => entry.key !== key &&
        !(key === "size" && ["ratio", "resolution", "preset"].includes(entry.key)) &&
        !(key === "seconds" && entry.key === "preset"))
      capability.params.push(control)
      capability.source = model.parameterSource ?? "magpie"
    }
    if (metadata.generate_audio !== undefined && model.type === "video" && capability.transport === "generic") {
      const parameter = metadata.generate_audio
      if (parameter?.type !== "boolean" ||
          (parameter.default !== undefined && typeof parameter.default !== "boolean")) {
        throw new Error("Unsupported media parameter schema: generate_audio.")
      }
      capability.params.push({ key: "generate_audio", title: "声音", type: "boolean",
        ...(parameter.default !== undefined ? { default: parameter.default } : {}) })
      capability.source = model.parameterSource ?? "magpie"
    }
    if (ark) {
      for (const [key, title] of [["watermark", "水印"], ["seed", "随机种子"]]) {
        const parameter = metadata[key]
        if (parameter === undefined) continue
        if (key === "watermark" && parameter?.type === "boolean") {
          capability.params.push({ key, title, type: "boolean" })
        } else if (key === "seed" && parameter?.type === "range" && Number.isSafeInteger(parameter.min) &&
            Number.isSafeInteger(parameter.max) && parameter.min <= parameter.max) {
          capability.params.push(range(key, title, parameter.min, parameter.max))
        } else throw new Error(`Unsupported Ark parameter schema: ${key}.`)
      }
      if (metadata.reference_video_url !== undefined) {
        if (metadata.reference_video_url?.type !== "string") throw new Error("Invalid Ark reference_video_url schema.")
        capability.params.push({ key: "reference_video_url", title: "参考视频地址", type: "string" })
      }
      const rule = metadata.input_audios
      if (rule !== undefined) {
        if (rule?.type !== "range" || !Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) ||
            rule.min < 0 || rule.max < rule.min || rule.max > designReferenceLimit) {
          throw new Error("Invalid Ark input_audios limits.")
        }
        capability.audioReferences = { min: rule.min, max: rule.max }
      }
    }
    const references = metadata.input_references
    if (references !== undefined) {
      if (references?.type !== "range" || !Number.isSafeInteger(references.min) || !Number.isSafeInteger(references.max) ||
          references.min < 0 || references.max < references.min) {
        throw new Error("Invalid media input_references schema.")
      }
      capability.sourceReferences = { min: references.min, max: references.max }
      let max = Math.min(references.max, designReferenceLimit)
      if (model.type === "video") max = Math.min(max, capability.references.max)
      if (references.min > max) throw new Error("Media reference requirements exceed the verified gateway mapping.")
      capability.references = { min: references.min, max }
      capability.referenceSource = model.parameterSource ?? "magpie"
      capability.source = model.parameterSource ?? "magpie"
    }
  }
  if (ark) capability.ark = true
  const totalLimit = model.sourceCapabilities?.total_limit
  if (totalLimit !== undefined && totalLimit !== null) {
    if (!Number.isSafeInteger(totalLimit) || totalLimit < 0) throw new Error("Invalid media total reference limit.")
    capability.references.max = Math.min(capability.references.max, totalLimit)
    if (capability.references.min > capability.references.max) throw new Error("Media reference requirements exceed the total limit.")
  }
  if (model.type === "video" && capability.references.max > 0 && capability.modes.length > 1) {
    capability.params.push(select("referenceMode", "参考图用途", capability.modes))
  }
  const sizes = capability.params.find((parameter) => parameter.key === "size")?.enum?.filter((value) => value !== auto)
  if (model.type === "image" && sizes?.length && sizes.every((value) => /^[1-9]\d*x[1-9]\d*$/.test(value))) {
    const choices = {}
    for (const size of sizes) {
      const [width, height] = size.split("x").map(Number)
      let unit = width
      let remainder = height
      while (remainder) {
        const next = unit % remainder
        unit = remainder
        remainder = next
      }
      const nearest = commonRatios.map((value) => {
        const [horizontal, vertical] = value.split(":").map(Number)
        return { value, error: Math.abs(width / height / (horizontal / vertical) - 1) }
      }).sort((left, right) => left.error - right.error)[0]
      const ratio = nearest.error < 0.015 ? nearest.value : `${width / unit}:${height / unit}`
      choices[ratio] ??= []
      if (!choices[ratio].includes(size)) choices[ratio].push(size)
    }
    capability.pixelSizes = {}
    for (const [ratio, sizes] of Object.entries(choices)) {
      const counts = new Map()
      for (const size of sizes) {
        const tier = pixelTier(size)
        counts.set(tier, (counts.get(tier) ?? 0) + 1)
      }
      capability.pixelSizes[ratio] = Object.fromEntries(sizes.map((size) => {
        const tier = pixelTier(size)
        const label = counts.get(tier) > 1 ? `${tier} (${size})` : tier
        return [label, size]
      }))
    }
    capability.params = capability.params.filter((parameter) => !["size", "ratio", "resolution"].includes(parameter.key))
    const tiers = [...new Set(Object.values(capability.pixelSizes).flatMap(Object.keys))]
      .sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right))
    capability.params.unshift(select("ratio", "比例", Object.keys(choices)),
      select("resolution", "清晰度", tiers))
  }
  capability.params = capability.params.map((parameter) => {
    if (parameter.key === "resolution" && !capability.pixelSizes) return { ...parameter, title: "清晰度" }
    if (parameter.key === "ratio") return { ...parameter, key: "aspect_ratio" }
    if (parameter.key === "seconds") {
      const step = parameter.step ?? 1
      const values = parameter.enum ?? Array.from(
        { length: Math.floor((parameter.max - parameter.min) / step) + 1 },
        (_, index) => parameter.min + index * step)
      return { key: "duration", title: parameter.title, type: "string", enum: values.map(String) }
    }
    if (parameter.key === "referenceMode") {
      const modes = { "首帧": "first-last-frame", "首尾帧": "first-last-frame", "主体参考": "reference", "尾帧": "last-frame" }
      return { ...parameter, key: "image_mode", enum: [...new Set(parameter.enum.map((value) => modes[value] ?? value))] }
    }
    return parameter
  })
  const defaults = {}
  for (const parameter of capability.params) {
    const schema = metadata?.[parameter.key === "duration" ? "seconds" : parameter.key]
    if (typeof schema?.description === "string") parameter.description = schema.description
    if (schema?.required === true) parameter.required = true
    if (schema?.default === undefined) continue
    const value = parameter.key === "duration" ? String(schema.default) : schema.default
    const automatic = value === "auto" || value === "adaptive"
    if (parameter.enum) {
      if (!parameter.enum.includes(automatic ? auto : value) || (schema.values && !schema.values.includes(schema.default))) {
        throw new Error(`Invalid media default: ${parameter.key}.`)
      }
    } else if (parameter.type === "integer" ? !Number.isSafeInteger(value) || value < parameter.min || value > parameter.max
      : typeof value !== parameter.type) throw new Error(`Invalid media default: ${parameter.key}.`)
    parameter.default = automatic || (parameter.key === "aspect_ratio" && capability.frameRatio === "auto") ? auto : value
    if (value !== "auto" && !(model.type === "image" && value === "adaptive")) defaults[parameter.key] = value
  }
  if (capability.pixelSizes && metadata?.size?.default !== undefined) {
    const value = metadata.size.default
    if (value !== "auto") {
      const choice = Object.entries(capability.pixelSizes).flatMap(([ratio, tiers]) =>
        Object.entries(tiers).filter(([, size]) => size === value).map(([tier]) => ({ aspect_ratio: ratio, resolution: tier })))[0]
      if (!choice) throw new Error("Invalid media default: size.")
      Object.assign(defaults, choice)
      for (const parameter of capability.params) if (choice[parameter.key]) parameter.default = choice[parameter.key]
    }
  }
  if (Object.keys(defaults).length) capability.defaults = defaults
  const constraints = mediaConstraints(model, capability)
  if (constraints) capability.constraints = constraints
  return capability
}

export function mediaSpec(capability) {
  const references = {}
  if (capability.references.max) references.image = capability.references
  if (capability.audioReferences?.max) references.audio = capability.audioReferences
  if (Object.keys(references).length) references.maxMB = Math.min(capability.maxMB ?? inlineReferenceMB, inlineReferenceMB)
  return { version: 1, prompt: { use: capability.promptUse ?? "required",
    ...(capability.promptMax ? { maxLength: capability.promptMax } : {}) }, references,
    params: capability.params }
}
