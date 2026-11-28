const auto = "自动"
const ming = "mlx-community/Ming-3.0-tts-0.5B-8bit"
const formats = ["wav", "mp3", "flac", "aac", "opus"]
const loomvox = {
  [ming]: { voice: "default", instructions: true },
  "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit": { voice: "required", instructions: true },
  "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit": { instructions: "required" },
  "k2-fsa/OmniVoice": { instructions: true },
  "mimo-v2.5-tts": { voice: "default", instructions: true },
  "mimo-v2.5-tts-voicedesign": { instructions: "required" },
  "qwen-audio-3.0-tts-plus": { voice: "default", instructions: true },
  "qwen-audio-3.1-tts-next": {},
  "seed-audio-1.0-multilingual": { voice: "default" },
  "seed-audio-1.0": { voice: "default" },
}

function loomvoxRoute(id) {
  if (typeof id !== "string") return undefined
  const route = id.replace(/^(?:remote-magpie\/)+/, "")
  const prefix = "mlx-audio-tools/"
  if (!route?.startsWith(prefix)) return undefined
  const model = route.slice(prefix.length)
  return Object.hasOwn(loomvox, model) ? model : undefined
}

export function speechModel(model) {
  if (loomvoxRoute(model.id)) return true
  return model.native_endpoints?.some((endpoint) => endpoint === "/v1/audio/speech" || endpoint === "/audio/speech") === true
}

export function speechCapability(model) {
  const route = loomvoxRoute(model.route ?? model.ref)
  const profile = route && loomvox[route]
  const metadata = model.parameters
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new Error("Invalid speech supported_parameters.")
  }
  const params = []
  const defaults = { response_format: profile ? "wav" : "mp3" }
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
      if (key === "response_format" && rule.values.some((value) => !formats.includes(value))) {
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
    if (rule.required === true || profile?.[key] === "required") control.required = true
    if (typeof rule.description === "string") control.description = rule.description
    params.push(control)
  }
  if ((!profile || profile.voice) && !params.some((param) => param.key === "voice")) {
    const automatic = profile?.voice === "default"
    params.unshift({ key: "voice", title: "音色", type: "string",
      ...(automatic ? { default: "default" } : { required: true }) })
    if (automatic) defaults.voice = "default"
  }
  if (profile?.instructions && !params.some((param) => param.key === "instructions")) {
    params.push({ key: "instructions", title: "声音描述", type: "string",
      ...(profile.instructions === "required" ? { required: true } : {}) })
  }
  if (profile && metadata === undefined) params.push(
    { key: "response_format", title: "音频格式", type: "string", enum: formats, default: "wav" },
    { key: "speed", title: "语速", type: "number", min: 0.25, max: 4, default: 1 },
  )
  return { source: metadata ? "magpie" : profile ? "loomvox-openai-speech" : "openai-speech",
    transport: "speech", params, defaults, references: { min: 0, max: 0 }, ming: route === ming,
    requiredVoice: profile?.voice === "required" }
}
