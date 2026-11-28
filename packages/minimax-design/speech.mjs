const auto = "自动"
const ming = "mlx-audio-tools/mlx-community/Ming-3.0-tts-0.5B-8bit"

export function speechModel(model) {
  let route = model.id
  if (model.owned_by === "remote-magpie") {
    while (route?.startsWith("remote-magpie/")) route = route.slice("remote-magpie/".length)
  }
  if (route === ming) return true
  return model.native_endpoints?.some((endpoint) => endpoint === "/v1/audio/speech" || endpoint === "/audio/speech") === true
}

export function speechCapability(model) {
  let route = model.ref
  if (model.owner === "remote-magpie") {
    while (route.startsWith("remote-magpie/")) route = route.slice("remote-magpie/".length)
  }
  const local = route === ming
  const metadata = model.parameters
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new Error("Invalid speech supported_parameters.")
  }
  const params = []
  const defaults = local ? { voice: "default", response_format: "wav" } : { response_format: "mp3" }
  const titles = { voice: "音色", response_format: "音频格式", speed: "语速", instructions: "声音描述" }
  for (const key of Object.keys(titles)) {
    const rule = metadata?.[key]
    if (rule === undefined) continue
    let control
    if (key === "speed" && rule.type === "range" && Number.isFinite(rule.min) &&
        Number.isFinite(rule.max) && rule.min > 0 && rule.max >= rule.min) {
      control = { key, title: titles[key], type: "number", min: rule.min, max: rule.max }
    } else if (key !== "speed" && rule.type === "enum" && Array.isArray(rule.values) && rule.values.length &&
        rule.values.every((value) => typeof value === "string" && value.trim() && value !== auto)) {
      if (key === "response_format" && rule.values.some((value) => !["mp3", "wav", "flac", "aac", "opus"].includes(value))) {
        throw new Error("Speech formats must be playable audio containers.")
      }
      control = { key, title: titles[key], type: "string", enum: rule.values }
    } else if (["voice", "instructions"].includes(key) && rule.type === "string") {
      control = { key, title: titles[key], type: "string" }
    } else throw new Error(`Unsupported speech parameter schema: ${key}.`)
    if (control.enum && rule.default === undefined) {
      control.default = control.enum[0]
      defaults[key] = control.enum[0]
    }
    if (rule.default !== undefined) {
      if ((control.type === "string" && (typeof rule.default !== "string" || !rule.default.trim())) ||
          (control.type === "number" && (!Number.isFinite(rule.default) || rule.default < rule.min || rule.default > rule.max)) ||
          (control.enum && !control.enum.includes(rule.default))) throw new Error(`Invalid speech default: ${key}.`)
      control.default = rule.default
      defaults[key] = rule.default
    }
    if (rule.required === true) control.required = true
    params.push(control)
  }
  if (!params.some((param) => param.key === "voice")) {
    params.unshift({ key: "voice", title: "音色", type: "string",
      ...(local ? { default: "default" } : { required: true }) })
  }
  if (params.some((param) => param.key === "voice" && !param.enum && param.default === undefined)) delete defaults.voice
  if (local && metadata === undefined) params.push(
    { key: "response_format", title: "音频格式", type: "string", enum: ["wav", "mp3", "flac", "aac", "opus"], default: "wav" },
    { key: "speed", title: "语速", type: "number", min: 0.25, max: 4, default: 1 },
    { key: "instructions", title: "声音描述", type: "string" },
  )
  return { source: metadata ? "magpie" : local ? "loomvox-openai-speech-2026-11-13" : "openai-speech",
    transport: "speech", params, defaults, references: { min: 0, max: 0 }, ming: local }
}
