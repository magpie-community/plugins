const auto = "自动"
const commonRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]
const grokRatios = [...commonRatios, "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"]
const select = (key, title, values) => ({ key, title, type: "string", enum: [auto, ...values], default: auto })
const range = (key, title, min, max) => ({ key, title, type: "integer", min, max })
const pixels = ["1024x1024", "1536x1024", "1024x1536", "2048x1152", "1152x2048", "2048x2048", "3840x2160", "2160x3840"]

export async function enrichMediaParameters(models) {
  for (const model of models) {
    if (model.owner !== "openrouter" || model.type !== "image" || !model.ref.startsWith("openrouter/") ||
        model.parameters !== undefined) continue
    const upstream = model.ref.slice("openrouter/".length)
    const response = await fetch(`https://openrouter.ai/api/v1/images/models/${upstream.split("/").map(encodeURIComponent).join("/")}/endpoints`,
      { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`OpenRouter media parameters returned HTTP ${response.status}.`)
    const body = await response.json()
    if (!Array.isArray(body.endpoints) || !body.endpoints.length) throw new Error("OpenRouter returned no media endpoints.")
    const parameters = body.endpoints.map((endpoint) => endpoint.supported_parameters)
    if (parameters.some((entry) => !entry || typeof entry !== "object")) throw new Error("OpenRouter returned no media parameter schema.")
    const merged = {}
    for (const key of ["aspect_ratio", "resolution"]) {
      const entries = parameters.map((entry) => entry[key])
      if (entries.some((entry) => entry === undefined)) continue
      if (entries.some((entry) => entry.type !== "enum" || !Array.isArray(entry.values) ||
          !entry.values.every((value) => typeof value === "string"))) throw new Error(`Invalid OpenRouter ${key} schema.`)
      const values = entries[0].values.filter((value) => entries.every((entry) => entry.values.includes(value)))
      if (values.length) merged[key] = { type: "enum", values }
    }
    const references = parameters.map((entry) => entry.input_references)
    if (references.some((entry) => entry !== undefined && (entry?.type !== "range" ||
        !Number.isInteger(entry.min) || !Number.isInteger(entry.max) || entry.min < 0 || entry.max < entry.min))) {
      throw new Error("Invalid OpenRouter reference limits.")
    }
    if (references.every((entry) => entry?.type === "range" && Number.isInteger(entry.min) && Number.isInteger(entry.max))) {
      merged.input_references = { type: "range", min: Math.max(...references.map((entry) => entry.min)),
        max: Math.min(...references.map((entry) => entry.max), 16) }
    }
    model.parameters = merged
    model.parameterSource = "openrouter-endpoints"
  }
  return models
}

export function mediaCapability(model) {
  let route = model.ref
  if (model.owner === "remote-magpie") {
    while (route.startsWith("remote-magpie/")) route = route.slice("remote-magpie/".length)
  }
  const capability = { source: "unknown", transport: "generic",
    params: [{ key: "size", title: "尺寸（可选）", type: "string" },
      ...(model.type === "video" ? [{ key: "seconds", title: "时长（秒，可选）", type: "integer", min: 1 }] : [])],
    references: { min: 0, max: model.images ? 1 : 0 }, modes: model.type === "video" ? ["首帧"] : [],
    defaultMode: "首帧" }
  if (route === "minimax-code/MiniMax-Image" && model.type === "image") {
    Object.assign(capability, { source: "minimax-matrix-2026-11-11", transport: "minimax-image",
      params: [select("ratio", "比例", [...commonRatios, "21:9", "9:21", "3:1", "1:3"]),
        select("resolution", "分辨率", ["1K", "2K", "4K"])],
      references: { min: 0, max: model.images ? 16 : 0 }, maxMB: 64 })
  } else if (["minimax-code/MiniMax-H3", "minimax-code/MiniMax-H3-Max", "minimax-code/MiniMax-Hailuo-2.3"].includes(route) && model.type === "video") {
    const hailuo = route.endsWith("Hailuo-2.3")
    const max = route.endsWith("H3-Max")
    Object.assign(capability, { source: "minimax-matrix-2026-11-03", transport: "minimax-video",
      params: hailuo ? [select("preset", "分辨率 / 时长", ["768P · 6秒", "768P · 10秒", "1080P · 6秒"])] : [
        select("ratio", "比例", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
        select("resolution", "分辨率", max ? ["480P", "768P"] : ["768P", "2K"]),
        range("seconds", "时长（秒）", max ? 5 : 4, 15)],
      hailuo, presets: hailuo ? {
        "768P · 6秒": { size: "768P", seconds: "6" }, "768P · 10秒": { size: "768P", seconds: "10" },
        "1080P · 6秒": { size: "1080P", seconds: "6" },
      } : undefined,
      references: { min: 0, max: model.images ? (hailuo ? 1 : max ? 2 : 9) : 0 },
      modes: hailuo ? ["首帧"] : max ? ["首帧", "首尾帧"] : ["首帧", "首尾帧", "主体参考"],
      defaultMode: max ? "首尾帧" : "主体参考", maxMB: 30, promptMax: hailuo ? 3000 : 7000 })
  } else if (["grok/grok-imagine-video", "grok/grok-imagine-video-1.5"].includes(route) && model.type === "video") {
    const newer = route.endsWith("-1.5")
    Object.assign(capability, { source: "magpie-grok-2026-11-13", transport: "grok-video",
      params: [select("ratio", "比例", commonRatios),
        select("resolution", "分辨率", newer ? ["480p", "720p", "1080p"] : ["480p", "720p"]),
        range("seconds", "时长（秒）", 1, 15)],
      references: { min: 0, max: model.images ? (newer ? 14 : 7) : 0 },
      modes: ["首帧", "主体参考"], defaultMode: "主体参考", referenceSecondsMax: newer ? 15 : 10,
      referenceResolutions: ["480p", "720p"] })
  } else if (["grok/grok-imagine-image", "grok/grok-imagine-image-quality", "xai/grok-imagine-image"].includes(route) && model.type === "image") {
    Object.assign(capability, { source: "magpie-grok-2026-11-13", params: [select("size", "比例", grokRatios)] })
  } else if (["qwen-cn/qwen-image-3.0-pro", "bailian-token-plan/qwen-image-3.0-pro"].includes(route) && model.type === "image") {
    Object.assign(capability, { source: "qwencloud-2026-11-13",
      params: [select("size", "尺寸", ["1328x1328", "1664x928", "928x1664", "1472x1104", "1104x1472", "1584x1056", "1056x1584", "2048x2048"])] })
  } else if (["rightimage/gpt-image-2", "rightimage/gpt-image-2.5-flare", "rightimage/gpt-image-2.5-sunburst",
    "rightimage/gpt-image-2.6-flare", "rightimage/gpt-image-2.6-sunburst"].includes(route) && model.type === "image") {
    Object.assign(capability, { source: "rightapi-2026-11-13", params: [select("size", "尺寸", pixels)] })
  } else if (["rightimage/gemini-nano-banana-2.1", "rightimage/gemini-3-pro-image-preview"].includes(route)) {
    capability.source = "gateway-default-only"
    capability.params = []
  }
  const metadata = model.parameters
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid media supported_parameters.")
    if (model.owner === "openrouter" && model.type === "image") {
      const ratios = metadata.aspect_ratio
      const resolutions = metadata.resolution
      for (const parameter of [ratios, resolutions]) {
        if (parameter !== undefined && (parameter?.type !== "enum" || !Array.isArray(parameter.values) ||
            !parameter.values.every((value) => typeof value === "string"))) throw new Error("Invalid OpenRouter media enum.")
      }
      capability.params = []
      const presets = {}
      for (const ratio of ratios?.values ?? []) {
        if (ratio === "auto") continue
        if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(ratio)) throw new Error("Invalid media aspect ratio.")
        presets[ratio] = { size: ratio }
        if ([...commonRatios, "21:9"].includes(ratio) && resolutions?.values.includes("2K")) {
          const sides = ratio.split(":").map(Number)
          const scale = 2048 / Math.max(...sides)
          presets[`${ratio} · 2K`] = { size: `${Math.round(sides[0] * scale)}x${Math.round(sides[1] * scale)}` }
        }
      }
      capability.presets = presets
      if (Object.keys(presets).length) capability.params.push(select("preset", "比例 / 分辨率", Object.keys(presets)))
      capability.source = model.parameterSource ?? "magpie"
    }
    for (const [key, title] of [["aspect_ratio", "比例"], ["resolution", "分辨率"]]) {
      if (metadata[key] === undefined || model.owner === "openrouter") continue
      const parameter = metadata[key]
      if (parameter?.type !== "enum" || !Array.isArray(parameter.values) || !parameter.values.length ||
          !parameter.values.every((value) => typeof value === "string" && value.length && value !== auto)) {
        throw new Error(`Unsupported media parameter schema: ${key}.`)
      }
      const mapped = key === "aspect_ratio" ? (capability.transport === "generic" ? "size" : "ratio") : "resolution"
      if (key === "resolution" && capability.transport === "generic") continue
      if (key === "aspect_ratio" && parameter.values.some((value) => value !== "auto" &&
          !/^[1-9]\d*(?:\.\d+)?:[1-9]\d*(?:\.\d+)?$/.test(value))) {
        throw new Error("Invalid media aspect ratio.")
      }
      if (key === "resolution") {
        const transferable = capability.transport === "minimax-image" ? ["1K", "2K", "4K"] :
          capability.transport === "minimax-video" ? ["480P", "768P", "1080P", "2K"] : ["480p", "720p", "1080p"]
        if (parameter.values.some((value) => value !== "auto" && !transferable.includes(value))) throw new Error("Media resolution has no verified gateway mapping.")
      }
      capability.params = capability.params.filter((entry) => entry.key !== mapped && entry.key !== "preset")
      capability.params.push(select(mapped, title, parameter.values))
      capability.source = model.parameterSource ?? "magpie"
    }
    for (const [key, title] of [["size", "尺寸"], ["seconds", "时长（秒）"]]) {
      if (metadata[key] === undefined) continue
      const parameter = metadata[key]
      let control
      if (parameter?.type === "enum" && Array.isArray(parameter.values) && parameter.values.length > 0 &&
          parameter.values.every((value) => typeof value === "string" && value.length > 0 && value !== auto)) {
        control = select(key, title, parameter.values)
      } else if (key === "seconds" && parameter?.type === "range" && Number.isInteger(parameter.min) &&
          Number.isInteger(parameter.max) && parameter.min >= 1 && parameter.max >= parameter.min) {
        control = range(key, title, parameter.min, parameter.max)
      } else if (key === "seconds" && parameter?.type === "enum" && Array.isArray(parameter.values) &&
          parameter.values.length > 0 && parameter.values.every((value) => Number.isInteger(value) && value >= 1)) {
        control = { key, title, type: "integer", enum: parameter.values }
      } else throw new Error(`Unsupported media parameter schema: ${key}.`)
      capability.params = capability.params.filter((entry) => entry.key !== key &&
        !(key === "size" && ["ratio", "resolution", "preset"].includes(entry.key)) &&
        !(key === "seconds" && entry.key === "preset"))
      capability.params.push(control)
      capability.source = model.parameterSource ?? "magpie"
    }
    const references = metadata.input_references
    if (references !== undefined) {
      if (references?.type !== "range" || !Number.isInteger(references.min) || !Number.isInteger(references.max) ||
          references.min < 0 || references.max < references.min || references.max > 16) {
        throw new Error("Invalid media input_references schema.")
      }
      if (references.min > 0 && !model.images) throw new Error("Media reference requirements contradict input modalities.")
      capability.references = { min: references.min, max: model.images ? references.max : 0 }
      capability.source = model.parameterSource ?? "magpie"
    }
  }
  if (model.type === "video" && capability.references.max > 0 && capability.modes.length > 1) {
    capability.params.push(select("referenceMode", "参考图用途", capability.modes))
  }
  return capability
}

export function mediaSpec(capability) {
  return { version: 1, prompt: { use: "required", ...(capability.promptMax ? { maxLength: capability.promptMax } : {}) },
    references: capability.references.max ? { image: capability.references,
      ...(capability.maxMB ? { maxMB: capability.maxMB } : {}) } : {},
    params: capability.params }
}
