// TokenRhythm model catalog.
//
// Two live sources, both cheap to refetch and cached by the caller:
//   public  GET /api/models                    (unauthenticated; names, context, capabilities)
//   live    GET /v1/models   Bearer <model key> (what this credential may call)
// The public document is metadata, never entitlement: a model only enters the
// chat list when the authenticated /v1/models names it (or when we only have
// the public document for a keyless preview).

export const DEFAULT_CONTEXT = 262_144
export const DEFAULT_OUTPUT = 32_768

// Cold-start fallback only. The live public catalog is the authority; these
// are the chat ids the OpenSquilla presets were written against.
export const BOOT_MODELS = {
  "qwen3.7-flash": { context: 262_144, reasoning: true, tool: true, image: false },
  "deepseek-v4-flash-0731": { context: 1_048_576, reasoning: true, tool: true, image: false },
  "deepseek-v4-pro-0813": { context: 1_048_576, reasoning: true, tool: true, image: false },
  "kimi-k3": { context: 256_000, reasoning: true, tool: true, image: true },
}

const MODALITIES = ["text", "image", "audio", "video", "pdf", "file"]
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : undefined)
const bool = (v) => v === true

/** Normalize one public /api/models row. */
export function normalizePublic(row) {
  if (!row || typeof row !== "object") return null
  const id = text(row.id)
  if (!id) return null
  const caps = row.capabilities && typeof row.capabilities === "object" ? row.capabilities : {}
  const pc = row.protocolCapabilities && typeof row.protocolCapabilities === "object" ? row.protocolCapabilities : {}
  const openai = pc.openai && typeof pc.openai === "object" ? pc.openai : {}
  const mods = list(row.modalities) ?? []
  const hasMod = (m) => mods.includes(m)
  const reasoningMode = text(row.reasoningMode)
  const reasoning =
    bool(caps.reasoning) ||
    row.supportsReasoning === true ||
    reasoningMode === "optional" ||
    reasoningMode === "required" ||
    reasoningMode === "always"
  const tool = bool(caps.tools) || row.supportsTools === true
  const vision = bool(caps.vision) || row.supportsVision === true
  const image = vision || hasMod("image")
  const audio = bool(caps.audio) || hasMod("audio")
  const video = bool(caps.video) || hasMod("video")
  const file = bool(caps.file) || hasMod("file") || hasMod("pdf")
  // Pure chain: text is always accepted, the rest follow each capability flag.
  const inputs = ["text", ...[
    [image, "image"],
    [audio, "audio"],
    [video, "video"],
    [file, "file"],
  ].filter(([on]) => on).map(([, modality]) => modality)]
  const openaiAvailable = openai.available !== false
  const effective = row.effectiveAvailable !== false
  return {
    id,
    name: text(row.name) ?? text(row.providerDisplayName) ?? id,
    type: text(row.type) ?? "chat",
    status: text(row.status) ?? "online",
    context: num(row.contextWindow) ?? DEFAULT_CONTEXT,
    output: num(row.maxOutputTokens) ?? DEFAULT_OUTPUT,
    reasoning,
    tool,
    image,
    audio,
    video,
    file,
    inputs,
    effective,
    openai: caps.openai === false ? false : bool(caps.openai) || openaiAvailable,
  }
}

export function publicRowsOf(payload) {
  const rows =
    payload?.data?.models ??
    (Array.isArray(payload?.data) ? payload.data : undefined) ??
    payload?.models ??
    []
  return (Array.isArray(rows) ? rows : []).map(normalizePublic).filter(Boolean)
}

/** One authenticated /v1/models row (OpenAI list or TokenRhythm envelope). */
export function normalizeLive(row) {
  if (!row || typeof row !== "object") return null
  const id = text(row.id) ?? text(row.model) ?? text(row.name)
  if (!id) return null
  return {
    id,
    name: text(row.name),
    context: num(row.contextWindow ?? row.context_window ?? row.context_length ?? row.contextLength ?? row.context ?? row.contextTokens),
    output: num(row.maxOutputTokens ?? row.max_output_tokens ?? row.max_output_length ?? row.maxOutputLength ?? row.output ?? row.outputTokens),
  }
}

export function liveRowsOf(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return rows.map(normalizeLive).filter(Boolean)
}

const BAD_STATUS = new Set(["offline", "disabled", "deprecated", "retired"])

export function isChatCandidate(meta, live) {
  if (!meta?.id) return false
  if (meta.type && meta.type !== "chat") return false
  if (meta.status && BAD_STATUS.has(meta.status)) return false
  if (meta.effective === false) return false
  if (meta.openai === false) return false
  if (live && live.id && meta.id !== live.id) return false
  return true
}

/** magpie provider.models / config model shape. */
export function modelOf({ id, name, context, output, inputs, reasoning, tool, image, audio, video, file }) {
  const input = inputs?.length ? inputs : ["text"]
  const inputFlags = Object.fromEntries(MODALITIES.map((k) => [k, input.includes(k)]))
  const attach = input.some((k) => k !== "text")
  return {
    name: name ?? id,
    reasoning: reasoning === true,
    tool_call: tool === true,
    attachment: attach,
    modalities: { input, output: ["text"] },
    limit: { context: context || DEFAULT_CONTEXT, output: output || DEFAULT_OUTPUT },
    capabilities: {
      reasoning: reasoning === true,
      toolcall: tool === true,
      attachment: attach,
      input: inputFlags,
      output: { text: true },
    },
  }
}

function minimalMeta(live) {
  return {
    id: live.id,
    name: live.name ?? live.id,
    type: "chat",
    status: "online",
    context: live.context ?? DEFAULT_CONTEXT,
    output: live.output ?? DEFAULT_OUTPUT,
    reasoning: false,
    tool: false,
    image: false,
    audio: false,
    video: false,
    file: false,
    inputs: ["text"],
    effective: true,
    openai: true,
  }
}

/**
 * Merge public metadata with the authenticated live list.
 * requireLive=true  -> only ids the credential may call (provider.models)
 * requireLive=false -> public chat preview (cold start / keyless)
 */
export function mergeRows(publicRows, liveRows, { requireLive = true } = {}) {
  const byId = new Map()
  for (const m of publicRows ?? []) if (m?.id) byId.set(m.id, m)
  const out = []
  if (requireLive) {
    for (const live of liveRows ?? []) {
      if (!live?.id) continue
      const meta = byId.get(live.id) ?? minimalMeta(live)
      if (!isChatCandidate(meta, live)) continue
      out.push({ id: live.id, model: modelOf({ ...meta, context: live.context ?? meta.context, output: live.output ?? meta.output }) })
    }
    return out
  }
  for (const meta of publicRows ?? []) {
    if (!isChatCandidate(meta, null)) continue
    out.push({ id: meta.id, model: modelOf(meta) })
  }
  return out
}

async function fetchJson(url, { fetchImpl, headers = {}, timeoutMs = 20_000 } = {}) {
  const f = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch
  if (typeof f !== "function") throw new Error("fetch is unavailable")
  const res = await f(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await res.text().catch(() => "")
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch { json = null }
  if (!res.ok) {
    const e = new Error("HTTP " + res.status)
    e.status = res.status
    e.httpStatus = res.status
    throw e
  }
  if (json && typeof json === "object" && "code" in json && json.code !== 0) {
    const e = new Error(String(json.error ?? json.code))
    e.code = String(json.error ?? json.code)
    throw e
  }
  return json
}

export async function fetchPublicModels({ url, fetchImpl, timeoutMs } = {}) {
  return fetchJson(url, { fetchImpl, timeoutMs })
}

export async function fetchLiveModels({ baseURL, apiKey, fetchImpl, timeoutMs } = {}) {
  if (!baseURL || !apiKey) throw new Error("model catalog needs baseURL and apiKey")
  return fetchJson(baseURL.replace(/\/$/, "") + "/models", {
    fetchImpl,
    headers: { authorization: "Bearer " + apiKey },
    timeoutMs,
  })
}

export function createCatalog({ fetchLive, fetchMeta } = {}) {
  let metaPromise = null
  const metaRows = () => {
    if (!metaPromise) {
      metaPromise = Promise.resolve()
        .then(() => fetchMeta())
        .then(publicRowsOf)
        .catch((e) => {
          metaPromise = null
          throw e
        })
    }
    return metaPromise
  }
  return {
    async forKey(key) {
      const [livePayload, meta] = await Promise.all([fetchLive(key), metaRows().catch(() => [])])
      const live = liveRowsOf(livePayload)
      return mergeRows(meta, live, { requireLive: true })
    },
    async publicRows() {
      const meta = await metaRows()
      return mergeRows(meta, [], { requireLive: false })
    },
    async modelsObject(key) {
      const rows = key ? await this.forKey(key) : await this.publicRows()
      return Object.fromEntries(rows.map((r) => [r.id, r.model]))
    },
  }
}

export function bootModels() {
  const out = {}
  for (const [id, boot] of Object.entries(BOOT_MODELS)) {
    out[id] = modelOf({
      id,
      name: id,
      context: boot.context,
      output: DEFAULT_OUTPUT,
      inputs: boot.image ? ["text", "image"] : ["text"],
      reasoning: boot.reasoning,
      tool: boot.tool,
      image: boot.image,
    })
  }
  return out
}
