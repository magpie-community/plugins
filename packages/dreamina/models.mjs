import { getCliRunnerGen, runCli } from "./cli.mjs"

export const BASE_URL = "dreamina://local"
export const NPM_IMAGE = "@ai-sdk/openai-compatible"
export const NPM_VIDEO = "@ai-sdk/anthropic"
export const LIVE_META = Symbol.for("dreamina.liveMeta")

export class ModelParamError extends Error {
  constructor(message, code = "invalid_request_error") {
    super(message)
    this.name = "ModelParamError"
    this.status = 400
    this.code = code
  }
}

const IMAGE_MODALITIES = { input: ["text", "image"], output: ["image"] }
const VIDEO_MODALITIES = { input: ["text", "image"], output: ["video"] }

const STD_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "2:3", "3:2", "21:9"]
const EXT_RATIOS = ["1:1", "9:16", "16:9", "3:4", "4:3", "2:3", "3:2", "9:21", "21:9"]
const FULL_RATIOS = ["1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4", "9:21", "21:9", "1:3", "3:1"]
const SEEDANCE_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
const VIDU_RATIOS = ["16:9", "9:16", "3:4", "4:3", "1:1"]
const HAPPYHORSE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"]

function makeImageSpec({ id, name, aliases = [], ratios = STD_RATIOS, resolutions, maxI2iRefs = 10, maxT2iRefs = 0, maxBatchCount = 4 }) {
  return {
    id,
    name,
    type: "image",
    npm: NPM_IMAGE,
    aliases,
    ratios: [...ratios],
    resolutions: [...resolutions],
    defaultRatio: ratios.includes("1:1") ? "1:1" : ratios[0],
    defaultResolution: resolutions.includes("2K") ? "2K" : resolutions[0],
    maxBatchCount,
    modes: {
      t2i: { minRefs: 0, maxRefs: maxT2iRefs },
      i2i: { minRefs: 1, maxRefs: maxI2iRefs },
    },
    modalities: IMAGE_MODALITIES,
  }
}

function makeVideoSpec({ id, name, aliases = [], ratios = SEEDANCE_RATIOS, resolutions, minDuration, maxDuration, maxFirstLastRefs = 2, maxM2vRefs = 12, maxBatchCount = 4 }) {
  const defaultRes = resolutions.find((r) => r.toLowerCase() === "720p") ?? resolutions[0]
  return {
    id,
    name,
    type: "video",
    npm: NPM_VIDEO,
    aliases,
    ratios: [...ratios],
    resolutions: [...resolutions],
    defaultRatio: ratios.includes("16:9") ? "16:9" : ratios[0],
    defaultResolution: defaultRes,
    minDuration,
    maxDuration,
    defaultDuration: Math.min(Math.max(5, minDuration), maxDuration),
    maxBatchCount,
    modes: {
      t2v: { minRefs: 0, maxRefs: 0 },
      first_last_frame: { minRefs: 1, maxRefs: maxFirstLastRefs },
      m2v: maxM2vRefs > 0 ? { minRefs: 1, maxRefs: maxM2vRefs } : null,
    },
    modalities: VIDEO_MODALITIES,
  }
}

export const STATIC_IMAGE_SPECS = [
  makeImageSpec({ id: "seedream_5.5", name: "Seedream 5.5", aliases: ["5.5"], ratios: STD_RATIOS, resolutions: ["1.5K", "2K"], maxI2iRefs: 10, maxT2iRefs: 14 }),
  makeImageSpec({ id: "seedream_5.0_pro", name: "Seedream 5.0 Pro", aliases: ["5.0pro"], ratios: EXT_RATIOS, resolutions: ["1.5K", "2K", "4K"], maxI2iRefs: 10, maxT2iRefs: 14 }),
  makeImageSpec({ id: "seedream_5.0_lite", name: "Seedream 5.0 Lite", aliases: ["5.0lite"], ratios: STD_RATIOS, resolutions: ["2K", "4K"], maxI2iRefs: 6, maxT2iRefs: 0 }),
  makeImageSpec({ id: "seedream_4.7", name: "Seedream 4.7", aliases: ["4.7"], ratios: STD_RATIOS, resolutions: ["1K", "2K", "4K"], maxI2iRefs: 6, maxT2iRefs: 14 }),
  makeImageSpec({ id: "seedream_4.6", name: "Seedream 4.6", aliases: ["4.6"], ratios: STD_RATIOS, resolutions: ["2K", "4K"], maxI2iRefs: 6, maxT2iRefs: 14 }),
  makeImageSpec({ id: "high_aes_general_v50_flash", name: "Seedream 5.0 Flash", aliases: ["5.0flash"], ratios: STD_RATIOS, resolutions: ["1.5K", "2K"], maxI2iRefs: 10, maxT2iRefs: 0 }),
  makeImageSpec({ id: "jimeng_smart_image_v1", name: "Jimeng Smart Image v1", aliases: [], ratios: ["1:1", "3:4", "9:16", "16:9", "4:3", "2:3", "3:2", "21:9"], resolutions: ["1K", "2K", "4K"], maxI2iRefs: 4, maxT2iRefs: 0 }),
  makeImageSpec({ id: "jm_image_model_gg_bp_21", name: "Dreamina N-2.1", aliases: ["N-2.1"], ratios: STD_RATIOS, resolutions: ["1K", "2K", "4K"], maxI2iRefs: 14, maxT2iRefs: 0 }),
  makeImageSpec({ id: "jm_image_model_lib_s", name: "Dreamina Image 2.5 Pro", aliases: ["Image2.5Pro"], ratios: FULL_RATIOS, resolutions: ["1K", "2K", "4K"], maxI2iRefs: 16, maxT2iRefs: 0 }),
  makeImageSpec({ id: "jm_image_model_lib_f", name: "Dreamina Image 2.5 Flash", aliases: ["Image2.5Flash"], ratios: FULL_RATIOS, resolutions: ["1K", "2K", "4K"], maxI2iRefs: 16, maxT2iRefs: 0 }),
]

export const STATIC_VIDEO_SPECS = [
  makeVideoSpec({ id: "seedance_2.5", name: "Seedance 2.5", aliases: ["seedance2.5"], ratios: SEEDANCE_RATIOS, resolutions: ["480p", "720p", "1080p", "4k"], minDuration: 4, maxDuration: 30, maxFirstLastRefs: 2, maxM2vRefs: 50 }),
  makeVideoSpec({ id: "seedance_2.5_flash", name: "Seedance 2.5 Flash", aliases: ["seedance2.5_flash"], ratios: SEEDANCE_RATIOS, resolutions: ["480p", "720p"], minDuration: 4, maxDuration: 30, maxFirstLastRefs: 2, maxM2vRefs: 20 }),
  makeVideoSpec({ id: "seedance_2.0_vip", name: "Seedance 2.0 VIP", aliases: ["seedance2.0_vip"], ratios: SEEDANCE_RATIOS, resolutions: ["720p", "1080p", "4k"], minDuration: 4, maxDuration: 15, maxFirstLastRefs: 2, maxM2vRefs: 12 }),
  makeVideoSpec({ id: "seedance_2.0_fast_vip", name: "Seedance 2.0 Fast VIP", aliases: ["seedance2.0fast_vip"], ratios: SEEDANCE_RATIOS, resolutions: ["720p"], minDuration: 4, maxDuration: 15, maxFirstLastRefs: 2, maxM2vRefs: 12 }),
  makeVideoSpec({ id: "seedance_2.0_mini", name: "Seedance 2.0 Mini", aliases: ["seedance2.0mini"], ratios: SEEDANCE_RATIOS, resolutions: ["720p"], minDuration: 4, maxDuration: 15, maxFirstLastRefs: 2, maxM2vRefs: 12 }),
  makeVideoSpec({ id: "seedance_pro_fast", name: "Seedance 1.0 Pro Fast", aliases: ["seedance_1.0_fast", "seedance1.0fast"], ratios: SEEDANCE_RATIOS, resolutions: ["720p", "1080p"], minDuration: 5, maxDuration: 10, maxFirstLastRefs: 1, maxM2vRefs: 0 }),
  makeVideoSpec({ id: "dreamina_vidu_q3", name: "Vidu Q3", aliases: [], ratios: VIDU_RATIOS, resolutions: ["720p", "1080p"], minDuration: 4, maxDuration: 16, maxFirstLastRefs: 2, maxM2vRefs: 7 }),
  makeVideoSpec({ id: "dreamina_vidu_q2", name: "Vidu Q2", aliases: [], ratios: VIDU_RATIOS, resolutions: ["720p", "1080p"], minDuration: 4, maxDuration: 10, maxFirstLastRefs: 2, maxM2vRefs: 7 }),
  makeVideoSpec({ id: "wan_3.0", name: "Wan 3.0", aliases: ["wan3.0"], ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"], resolutions: ["720P", "1080P"], minDuration: 4, maxDuration: 15, maxFirstLastRefs: 2, maxM2vRefs: 20 }),
  makeVideoSpec({ id: "happyhorse_1.1", name: "HappyHorse 1.1", aliases: ["happyhorse1.1"], ratios: HAPPYHORSE_RATIOS, resolutions: ["720P", "1080P"], minDuration: 4, maxDuration: 15, maxFirstLastRefs: 1, maxM2vRefs: 9 }),
  makeVideoSpec({ id: "happyhorse_1.0", name: "HappyHorse 1.0", aliases: [], ratios: HAPPYHORSE_RATIOS, resolutions: ["720P", "1080P"], minDuration: 4, maxDuration: 15, maxFirstLastRefs: 1, maxM2vRefs: 9 }),
]

const STATIC_CATALOG = new Map(
  [...STATIC_IMAGE_SPECS, ...STATIC_VIDEO_SPECS].map((spec) => [spec.id, spec]),
)

export function staticSpecsMap() {
  const out = {}
  for (const [id, spec] of STATIC_CATALOG) {
    out[id] = structuredClone(spec)
  }
  return out
}

function formatDisplayName(id) {
  return String(id)
    .replace(/^jm_image_model_/, "Dreamina ")
    .replace(/^dreamina_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => (part.length <= 3 && /\d/.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ")
}

function parseCliModelItem(item, typeOverride) {
  const type = typeOverride || item?.type
  if (type !== "image" && type !== "video") return null
  const id = String(item?.model || "").trim()
  if (!id) return null
  const known = STATIC_CATALOG.get(id)
  const rawModes = Array.isArray(item?.modes) ? item.modes : []

  const ratiosSet = new Set()
  const resSet = new Set()
  const modes = {}
  let minDuration = Infinity
  let maxDuration = -Infinity
  let maxBatchCount = 0

  for (const m of rawModes) {
    const modeName = String(m?.name || "").trim()
    if (!modeName) continue
    const flags = Array.isArray(m?.flags) ? m.flags : []
    for (const fl of flags) {
      if (fl?.flag === "--ratio" && Array.isArray(fl.values)) {
        for (const v of fl.values) ratiosSet.add(String(v))
      } else if (fl?.flag === "--resolution" && Array.isArray(fl.values)) {
        for (const v of fl.values) resSet.add(String(v))
      } else if (fl?.flag === "--duration") {
        if (Number.isFinite(fl.min)) minDuration = Math.min(minDuration, fl.min)
        if (Number.isFinite(fl.max)) maxDuration = Math.max(maxDuration, fl.max)
      } else if (fl?.flag === "--count" && Number.isFinite(fl.max)) {
        maxBatchCount = Math.max(maxBatchCount, Math.trunc(fl.max))
      }
    }

    const refs = m?.references
    const refMin = Number.isFinite(refs?.min) ? refs.min : modeName === "t2i" || modeName === "t2v" ? 0 : 1
    const refMax = Number.isFinite(refs?.max) ? refs.max : 0
    if (modes[modeName]) {
      modes[modeName].minRefs = Math.min(modes[modeName].minRefs, refMin)
      modes[modeName].maxRefs = Math.max(modes[modeName].maxRefs, refMax)
    } else {
      modes[modeName] = { minRefs: refMin, maxRefs: refMax }
    }
  }

  const ratios = ratiosSet.size > 0 ? [...ratiosSet] : known?.ratios ?? ["1:1", "16:9", "9:16"]
  const resolutions = resSet.size > 0 ? [...resSet] : known?.resolutions ?? (type === "image" ? ["2K"] : ["720p"])
  const aliases = Array.isArray(item?.aliases) ? item.aliases.map(String) : known?.aliases ?? []

  if (type === "image") {
    return {
      id,
      name: known?.name ?? formatDisplayName(id),
      type: "image",
      npm: NPM_IMAGE,
      aliases,
      ratios,
      resolutions,
      defaultRatio: ratios.includes("1:1") ? "1:1" : ratios[0],
      defaultResolution: resolutions.includes("2K") ? "2K" : resolutions[0],
      maxBatchCount: maxBatchCount || known?.maxBatchCount || 4,
      modes: {
        t2i: modes.t2i ?? known?.modes?.t2i ?? { minRefs: 0, maxRefs: 0 },
        i2i: modes.i2i ?? known?.modes?.i2i ?? { minRefs: 1, maxRefs: 10 },
      },
      modalities: IMAGE_MODALITIES,
    }
  }

  const finalMinDur = Number.isFinite(minDuration) ? minDuration : known?.minDuration ?? 4
  const finalMaxDur = Number.isFinite(maxDuration) ? maxDuration : known?.maxDuration ?? 15
  const defaultRes = resolutions.find((r) => r.toLowerCase() === "720p") ?? resolutions[0]
  return {
    id,
    name: known?.name ?? formatDisplayName(id),
    type: "video",
    npm: NPM_VIDEO,
    aliases,
    ratios,
    resolutions,
    defaultRatio: ratios.includes("16:9") ? "16:9" : ratios[0],
    defaultResolution: defaultRes,
    minDuration: finalMinDur,
    maxDuration: finalMaxDur,
    defaultDuration: Math.min(Math.max(5, finalMinDur), finalMaxDur),
    maxBatchCount: maxBatchCount || known?.maxBatchCount || 4,
    modes: {
      t2v: modes.t2v ?? known?.modes?.t2v ?? { minRefs: 0, maxRefs: 0 },
      first_last_frame: modes.first_last_frame ?? known?.modes?.first_last_frame ?? { minRefs: 1, maxRefs: 2 },
      m2v: Object.prototype.hasOwnProperty.call(modes, "m2v") ? modes.m2v : known?.modes?.m2v ?? null,
    },
    modalities: VIDEO_MODALITIES,
  }
}

export function configModels(specsMap = null) {
  const source = specsMap ?? staticSpecsMap()
  const out = {}
  for (const [id, spec] of Object.entries(source)) {
    if (!spec || id === "__proto__") continue
    out[id] = {
      id,
      name: spec.name ?? id,
      provider: {
        npm: spec.npm ?? (spec.type === "video" ? NPM_VIDEO : NPM_IMAGE),
        api: BASE_URL,
      },
      status: "active",
      attachment: true,
      reasoning: false,
      tool_call: false,
      temperature: false,
      limit: {
        context: 32768,
        output: 4096,
      },
      cost: {
        input: 0,
        output: 0,
      },
      modalities: spec.modalities ?? (spec.type === "video" ? VIDEO_MODALITIES : IMAGE_MODALITIES),
      options: {},
    }
  }
  return out
}

export function openCodeModelOf(providerId, spec) {
  const isVideo = spec.type === "video" || spec.modalities?.output?.includes("video")
  const npm = spec.npm ?? (isVideo ? NPM_VIDEO : NPM_IMAGE)
  return {
    id: spec.id,
    providerID: providerId,
    name: spec.name ?? spec.id,
    api: {
      id: spec.id,
      url: BASE_URL,
      npm,
    },
    status: "active",
    limit: {
      context: 32768,
      output: 4096,
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: true,
      toolcall: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: isVideo
        ? { text: false, image: false, audio: false, video: true, pdf: false }
        : { text: false, image: true, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    options: {},
    headers: {},
    variants: {},
    release_date: "",
  }
}

const liveCache = new Map() // profile -> { gen, at, specs }
const CACHE_TTL_MS = 5 * 60 * 1000

export function clearLiveModelCache() {
  liveCache.clear()
}

export async function fetchLiveModels(profile = "default", opts = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const gen = getCliRunnerGen()
  const now = Date.now()
  if (opts.useCache !== false && !opts.fresh) {
    const cached = liveCache.get(safeProfile)
    if (cached && cached.gen === gen && now - cached.at < (opts.ttlMs ?? CACHE_TTL_MS)) {
      return cached.specs
    }
  }

  const timeoutMs = opts.timeoutMs ?? 15_000
  const [imgRes, vidRes] = await Promise.all([
    runCli(safeProfile, ["model", "list", "--type", "image"], { signal: opts.signal, timeoutMs, check: false }).catch((err) => ({ ok: false, error: { message: err?.message || String(err) } })),
    runCli(safeProfile, ["model", "list", "--type", "video"], { signal: opts.signal, timeoutMs, check: false }).catch((err) => ({ ok: false, error: { message: err?.message || String(err) } })),
  ])

  const out = {}
  let imgOk = false
  let vidOk = false
  const errors = []

  if (imgRes?.ok && Array.isArray(imgRes.data?.items) && imgRes.data.items.length > 0) {
    imgOk = true
    for (const item of imgRes.data.items) {
      const parsed = parseCliModelItem(item, "image")
      if (parsed) out[parsed.id] = parsed
    }
  } else {
    if (imgRes?.error?.message) errors.push(imgRes.error.message)
    for (const spec of STATIC_IMAGE_SPECS) out[spec.id] = structuredClone(spec)
  }

  if (vidRes?.ok && Array.isArray(vidRes.data?.items) && vidRes.data.items.length > 0) {
    vidOk = true
    for (const item of vidRes.data.items) {
      const parsed = parseCliModelItem(item, "video")
      if (parsed) out[parsed.id] = parsed
    }
  } else {
    if (vidRes?.error?.message) errors.push(vidRes.error.message)
    for (const spec of STATIC_VIDEO_SPECS) out[spec.id] = structuredClone(spec)
  }

  const fellBack = !imgOk && !vidOk
  Object.defineProperty(out, LIVE_META, {
    value: {
      live: imgOk || vidOk,
      fellBack,
      partialFallback: imgOk !== vidOk,
      error: errors.join("; "),
    },
    enumerable: false,
  })

  if (imgOk || vidOk) {
    liveCache.set(safeProfile, { gen, at: now, specs: out })
  }
  return out
}

function stripProviderPrefix(modelId) {
  const s = String(modelId ?? "").trim()
  if (!s) return ""
  return s.includes("/") ? s.split("/").pop() : s
}

export function findModelSpec(modelId, expectedType, catalog = null) {
  const raw = stripProviderPrefix(modelId)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const normalized = lower.replace(/-/g, "_")
  const candidates = catalog ? Object.values(catalog) : [...STATIC_IMAGE_SPECS, ...STATIC_VIDEO_SPECS]

  for (const spec of candidates) {
    if (expectedType && spec.type !== expectedType) continue
    if (spec.id === raw || spec.id.toLowerCase() === lower || spec.id.toLowerCase() === normalized) {
      return spec
    }
  }
  for (const spec of candidates) {
    if (expectedType && spec.type !== expectedType) continue
    for (const alias of spec.aliases ?? []) {
      const al = String(alias).toLowerCase()
      if (al === lower || al === normalized) return spec
    }
  }
  return null
}

function matchExactCase(value, allowed) {
  const target = String(value ?? "").trim().toLowerCase()
  if (!target) return null
  for (const item of allowed) {
    if (item.toLowerCase() === target) return item
  }
  return null
}

function parseWxH(size) {
  const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(String(size ?? ""))
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function ratioValue(r) {
  const [a, b] = String(r).split(":").map(Number)
  return a > 0 && b > 0 ? a / b : 1
}

function closestRatio(width, height, allowedRatios) {
  const target = width / height
  let best = allowedRatios[0]
  let bestDiff = Infinity
  for (const r of allowedRatios) {
    const diff = Math.abs(Math.log(target / ratioValue(r)))
    if (diff < bestDiff) {
      bestDiff = diff
      best = r
    }
  }
  return best
}

function pickNearestImageResolution(maxDim, allowed) {
  const order = maxDim >= 3072 ? ["4K", "2K", "1.5K", "1K"] : maxDim >= 1400 ? ["2K", "1.5K", "4K", "1K"] : ["1K", "1.5K", "2K", "4K"]
  for (const candidate of order) {
    const hit = matchExactCase(candidate, allowed)
    if (hit) return hit
  }
  return allowed[0]
}

function pickImageResolutionByQuality(quality, allowed) {
  const q = String(quality ?? "").trim().toLowerCase()
  if (q === "hd" || q === "high") {
    for (const c of ["4K", "2K", "1.5K", "1K"]) {
      const hit = matchExactCase(c, allowed)
      if (hit) return hit
    }
  }
  if (q === "low") {
    for (const c of ["1K", "1.5K", "2K", "4K"]) {
      const hit = matchExactCase(c, allowed)
      if (hit) return hit
    }
  }
  if (q === "medium" || q === "standard") {
    for (const c of ["2K", "1.5K", "1K", "4K"]) {
      const hit = matchExactCase(c, allowed)
      if (hit) return hit
    }
  }
  return null
}

function pickNearestVideoResolution(width, height, allowed) {
  const minDim = Math.min(width, height)
  const maxDim = Math.max(width, height)
  let order
  if (minDim >= 2160 || maxDim >= 3840) order = ["4k", "1080p", "720p", "480p"]
  else if (minDim >= 1080 || maxDim >= 1920) order = ["1080p", "720p", "4k", "480p"]
  else if (minDim >= 720 || maxDim >= 1280) order = ["720p", "1080p", "480p", "4k"]
  else order = ["480p", "720p", "1080p", "4k"]
  for (const candidate of order) {
    const hit = matchExactCase(candidate, allowed)
    if (hit) return hit
  }
  return allowed[0]
}

function countReqRefs(req) {
  let total = 0
  if (Array.isArray(req?.reference_images)) total += req.reference_images.length
  if (Array.isArray(req?.image)) total += req.image.length
  else if (req?.image != null) total += 1
  if (Array.isArray(req?.images)) total += req.images.length
  if (Array.isArray(req?.input_reference)) total += req.input_reference.length
  else if (req?.input_reference != null) total += 1
  if (req?.first_frame != null || req?.first_frame_image != null) total += 1
  if (req?.last_frame != null || req?.last_frame_image != null) total += 1
  return total
}

export function resolveImageParams(modelId, req = {}, refCountOrOpts = undefined, maybeOpts = {}) {
  const refCount = typeof refCountOrOpts === "number" ? refCountOrOpts : refCountOrOpts?.refCount ?? countReqRefs(req)
  const opts = typeof refCountOrOpts === "object" && refCountOrOpts !== null ? refCountOrOpts : maybeOpts
  const spec = findModelSpec(modelId, "image", opts?.catalog)
  if (!spec) {
    throw new ModelParamError(`Unknown or unsupported Dreamina image model: ${modelId || "(empty)"}`)
  }

  const mode = req.mode ? String(req.mode).trim() : refCount > 0 ? "i2i" : "t2i"
  if (mode !== "t2i" && mode !== "i2i") {
    throw new ModelParamError(`Invalid image mode "${mode}" for ${spec.id}. Use t2i or i2i.`)
  }
  const modeSpec = spec.modes[mode]
  if (!modeSpec) {
    throw new ModelParamError(`Model ${spec.id} does not support mode "${mode}".`)
  }
  if (refCount > 0 && mode === "i2i" && refCount > modeSpec.maxRefs) {
    throw new ModelParamError(`Model ${spec.id} supports at most ${modeSpec.maxRefs} reference images in i2i mode (got ${refCount}).`)
  }
  if (refCount === 0 && mode === "i2i") {
    throw new ModelParamError(`Model ${spec.id} in i2i mode requires at least 1 reference image.`)
  }

  const prompt = req.prompt != null ? String(req.prompt) : ""
  if (mode === "t2i" && !prompt.trim()) {
    throw new ModelParamError(`prompt is required for text-to-image generation on ${spec.id}.`)
  }

  let ratio = null
  let resolution = null

  const explicitRatio = req.ratio ?? req.aspect_ratio
  if (explicitRatio != null && String(explicitRatio).trim() !== "" && String(explicitRatio).trim().toLowerCase() !== "auto") {
    ratio = matchExactCase(explicitRatio, spec.ratios)
    if (!ratio) {
      throw new ModelParamError(`Unsupported ratio "${explicitRatio}" for ${spec.id}. Allowed: ${spec.ratios.join(", ")}`)
    }
  }

  const explicitRes = req.resolution
  if (explicitRes != null && String(explicitRes).trim() !== "" && String(explicitRes).trim().toLowerCase() !== "auto") {
    resolution = matchExactCase(explicitRes, spec.resolutions)
    if (!resolution) {
      throw new ModelParamError(`Unsupported resolution "${explicitRes}" for ${spec.id}. Allowed: ${spec.resolutions.join(", ")}`)
    }
  }

  const sizeRaw = req.size != null ? String(req.size).trim() : ""
  if (sizeRaw && sizeRaw.toLowerCase() !== "auto") {
    const asRatio = matchExactCase(sizeRaw, spec.ratios)
    const asRes = matchExactCase(sizeRaw, spec.resolutions)
    const dims = parseWxH(sizeRaw)
    if (asRatio) {
      ratio ??= asRatio
    } else if (asRes) {
      resolution ??= asRes
    } else if (dims) {
      ratio ??= closestRatio(dims.width, dims.height, spec.ratios)
      if (!resolution && !req.quality) {
        resolution = pickNearestImageResolution(Math.max(dims.width, dims.height), spec.resolutions)
      }
    } else {
      throw new ModelParamError(`Invalid size "${sizeRaw}" for ${spec.id}. Expected WxH, ratio (${spec.ratios.join(", ")}), or resolution (${spec.resolutions.join(", ")}).`)
    }
  }

  if (!resolution && req.quality != null && String(req.quality).trim().toLowerCase() !== "auto") {
    resolution = pickImageResolutionByQuality(req.quality, spec.resolutions)
  }

  ratio ??= spec.defaultRatio
  resolution ??= spec.defaultResolution

  const rawCount = req.n ?? req.count ?? 1
  const count = Number(rawCount)
  if (!Number.isInteger(count) || count < 1 || count > spec.maxBatchCount) {
    throw new ModelParamError(`Invalid count/n "${rawCount}" for ${spec.id}. Must be an integer from 1 to ${spec.maxBatchCount}.`)
  }

  return {
    model: spec.id,
    mode,
    prompt,
    ratio,
    resolution,
    count,
  }
}

export function resolveVideoParams(modelId, req = {}, refCount = 0, opts = {}) {
  const spec = findModelSpec(modelId, "video", opts?.catalog)
  if (!spec) {
    throw new ModelParamError(`Unknown or unsupported Dreamina video model: ${modelId || "(empty)"}`)
  }

  const effectiveRefs = Number.isInteger(refCount) ? refCount : countReqRefs(req)
  let mode = req.mode ? String(req.mode).trim() : null
  if (!mode) {
    if (effectiveRefs === 0) {
      mode = "t2v"
    } else if (effectiveRefs === 1) {
      mode = "first_last_frame"
    } else if (effectiveRefs === 2) {
      if ((spec.modes.first_last_frame?.maxRefs ?? 0) >= 2) mode = "first_last_frame"
      else if (spec.modes.m2v && effectiveRefs <= spec.modes.m2v.maxRefs) mode = "m2v"
      else throw new ModelParamError(`Model ${spec.id} supports at most ${spec.modes.first_last_frame?.maxRefs ?? 1} reference image(s).`)
    } else {
      if (spec.modes.m2v && effectiveRefs <= spec.modes.m2v.maxRefs) mode = "m2v"
      else throw new ModelParamError(`Model ${spec.id} does not support ${effectiveRefs} reference images.`)
    }
  }

  if (!["t2v", "first_last_frame", "m2v"].includes(mode) || !spec.modes[mode]) {
    throw new ModelParamError(`Model ${spec.id} does not support video mode "${mode}".`)
  }
  const modeSpec = spec.modes[mode]
  if (effectiveRefs < modeSpec.minRefs || effectiveRefs > modeSpec.maxRefs) {
    throw new ModelParamError(`Model ${spec.id} mode "${mode}" accepts ${modeSpec.minRefs}..${modeSpec.maxRefs} reference images (got ${effectiveRefs}).`)
  }

  const prompt = req.prompt != null ? String(req.prompt) : ""
  if (mode === "t2v" && !prompt.trim()) {
    throw new ModelParamError(`prompt is required for text-to-video generation on ${spec.id}.`)
  }

  let ratio = null
  let resolution = null

  const explicitRatio = req.ratio ?? req.aspect_ratio
  if (explicitRatio != null && String(explicitRatio).trim() !== "" && String(explicitRatio).trim().toLowerCase() !== "auto") {
    ratio = matchExactCase(explicitRatio, spec.ratios)
    if (!ratio) {
      throw new ModelParamError(`Unsupported ratio "${explicitRatio}" for ${spec.id}. Allowed: ${spec.ratios.join(", ")}`)
    }
  }

  const explicitRes = req.resolution
  if (explicitRes != null && String(explicitRes).trim() !== "" && String(explicitRes).trim().toLowerCase() !== "auto") {
    resolution = matchExactCase(explicitRes, spec.resolutions)
    if (!resolution) {
      throw new ModelParamError(`Unsupported resolution "${explicitRes}" for ${spec.id}. Allowed: ${spec.resolutions.join(", ")}`)
    }
  }

  const sizeRaw = req.size != null ? String(req.size).trim() : ""
  if (sizeRaw && sizeRaw.toLowerCase() !== "auto") {
    const asRatio = matchExactCase(sizeRaw, spec.ratios)
    const asRes = matchExactCase(sizeRaw, spec.resolutions)
    const dims = parseWxH(sizeRaw)
    if (asRatio) {
      ratio ??= asRatio
    } else if (asRes) {
      resolution ??= asRes
    } else if (dims) {
      ratio ??= closestRatio(dims.width, dims.height, spec.ratios)
      resolution ??= pickNearestVideoResolution(dims.width, dims.height, spec.resolutions)
    } else {
      throw new ModelParamError(`Invalid video size "${sizeRaw}" for ${spec.id}. Expected WxH, ratio (${spec.ratios.join(", ")}), or resolution (${spec.resolutions.join(", ")}).`)
    }
  }

  ratio ??= spec.defaultRatio
  resolution ??= spec.defaultResolution

  const rawDur = req.duration ?? req.seconds ?? spec.defaultDuration
  const duration = Number(rawDur)
  if (!Number.isInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    throw new ModelParamError(`Invalid duration/seconds "${rawDur}" for ${spec.id}. Allowed integer range: ${spec.minDuration}..${spec.maxDuration}s.`)
  }

  const rawCount = req.n ?? req.count ?? 1
  const count = Number(rawCount)
  const maxVideoCount = mode === "m2v" ? 1 : spec.maxBatchCount
  if (!Number.isInteger(count) || count < 1 || count > maxVideoCount) {
    throw new ModelParamError(`Invalid count "${rawCount}" for ${spec.id}. Must be 1..${maxVideoCount}.`)
  }

  return {
    model: spec.id,
    mode,
    prompt,
    ratio,
    resolution,
    duration,
    count,
  }
}
