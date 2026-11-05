// 模型目录：TokenPlan 的聊天模型清单。
//
// 事实来源分两层，且**两层都是活的**：
//   1. `GET /v1/models`（API Key）：这个 Key 真能调用的模型——权威的"有谁"；
//   2. `GET /api/tokenplan/v1/public/models`（无需登录）：上下文、输入类型、
//      能力、协议与墨点单价——权威的"长什么样"。
//
// 官网文档的模型表与 live 不一致（文档多出已下线的 id），所以这里**不硬编码
// 模型表**：boot 清单只用于冷启动兜底，真实清单永远来自接口。决策模型
// （SystemOne）不是聊天接口，永不进入聊天清单。思考档位不做：平台明确
// 不支持通过请求参数开关/调整思考强度。

export const DEFAULT_CONTEXT = 262_144
// 文档与公共接口都没给最大输出；P0 用真实账号实测后更新。给一个保守值，
// 让 agent 能请求的输出不被人为放大。
export const DEFAULT_OUTPUT = 32_768

// 冷启动兜底清单（登录前 / 两次读取都失败时）。只列官方文档与 live 列表
// 都确认过的 id；有一个 id 在本仓库的抓包里始终被脱敏，宁缺毋滥，不硬编码。
// `free` 是文档口径的限时免费（价格 0），运行时以接口价格为准。
// `rate` 是输入价归一化（1000 墨点/1M = x1），展示用，不参与计费。
export const BOOT_MODELS = {
  "Agents-A1": { context: 262_144, reasoning: false, tool: true, image: true, free: true },
  "Atria-Dawn": { context: 524_288, reasoning: false, tool: false, image: false, free: true },
  "Sage-A1.5": { context: 524_288, reasoning: false, tool: true, image: true, free: true },
  "intern-s2": { context: 262_144, reasoning: false, tool: true, image: true, free: true },
  "deepseek-v4.1-flash-1017": { context: 1_048_576, reasoning: true, tool: true, image: true, rate: 1 },
  "glm-5.3": { context: 1_048_576, reasoning: true, tool: true, image: false, rate: 8 },
  "minimax-m3": { context: 1_048_576, reasoning: true, tool: true, image: false, rate: 2.1 },
  "qwen3.8-27b": { context: 262_144, reasoning: true, tool: true, image: true, rate: 0.8 },
}

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : undefined)

/** 归一化一条公共元数据记录（兼容中英文能力字段）。 */
export function normalizePublic(row) {
  if (!row || typeof row !== "object") return null
  const id = text(row.id)
  if (!id) return null
  const caps = list(row.capabilities) ?? []
  const capsEn = list(row.capabilities_en) ?? []
  const has = (zh, en) => caps.includes(zh) || capsEn.includes(en)
  // 价格字段缺失或非法 ≠ 价格为 0：只有两个字段都是有限的非负数、且都为 0，
  // 才敢标免费，否则一条缺价格的记录会被误标 free，用户以为不扣墨点。
  const priceOf = (v) => {
    if (v === null || v === undefined) return undefined
    if (typeof v === "string" && !v.trim()) return undefined
    const n = typeof v === "number" ? v : Number(String(v).trim())
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const inputPrice = priceOf(row.input_uncached_price)
  const outputPrice = priceOf(row.output_price)
  const hasPrice = inputPrice !== undefined && outputPrice !== undefined
  return {
    id,
    name: text(row.display_name) ?? text(row.display_name_en) ?? id,
    type: text(row.model_type) ?? "chat",
    inputs: list(row.input_types) ?? ["text"],
    context: num(row.context_length) ?? DEFAULT_CONTEXT,
    reasoning: has("深度思考", "Reasoning"),
    tool: has("工具调用", "Tool calling"),
    ...(hasPrice ? { free: inputPrice === 0 && outputPrice === 0 } : {}),
    ...(inputPrice > 0 ? { rate: Math.round((inputPrice / 1000) * 10) / 10 } : {}),
    protocols: new Set(list(row.supported_protocols) ?? []),
    marketing: text(row.marketing_label) ?? "",
  }
}

/** 从各式信封里取公共模型数组（{data:{models:[…]}} / {data:[…]} / 裸数组）。 */
export function publicRowsOf(payload) {
  const rows =
    payload?.data?.models ??
    (Array.isArray(payload?.data) ? payload.data : undefined) ??
    payload?.models ??
    []
  return (Array.isArray(rows) ? rows : []).map(normalizePublic).filter(Boolean)
}

/** 一条 live 目录行（/v1/models 的 data[]），兼容文档示例之外的字段。 */
export function normalizeLive(row) {
  if (!row || typeof row !== "object") return null
  const id = text(row.id) ?? text(row.model_id)
  if (!id) return null
  return {
    id,
    context: num(row.context_length ?? row.contextLength),
    output: num(row.max_output_length ?? row.maxOutputLength ?? row.max_output_tokens),
    inputs: list(row.input_modalities ?? row.inputModalities),
    features: list(row.supported_features ?? row.supportedFeatures) ?? [],
  }
}

export function liveRowsOf(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.map(normalizeLive).filter(Boolean)
}

const MODALITIES = ["text", "image", "audio", "video", "pdf"]

/**
 * 一条模型，magpie 的 provider.models / config 两处用的形状。没有 variants：
 * 平台不支持思考档位，给了也是无效选择器。
 * `free`/`rate` 是 magpie 专有展示字段（模型选择器徽标），OpenCode 忽略。
 */
export function modelOf({ id, name, context, output, inputs, reasoning, tool, image, free, rate }) {
  const input = inputs?.length ? inputs : ["text"]
  const inputFlags = Object.fromEntries(MODALITIES.map((k) => [k, input.includes(k)]))
  const attach = input.some((k) => k !== "text")
  return {
    name,
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
    ...(free ? { free: true } : {}),
    ...(rate ? { rate } : {}),
  }
}

/** boot 清单的一条（config 的冷启动兜底）。 */
export function bootModelOf(id, boot = BOOT_MODELS[id]) {
  if (!boot) return null
  return modelOf({
    id,
    name: id,
    context: boot.context,
    output: DEFAULT_OUTPUT,
    inputs: boot.image ? ["text", "image"] : ["text"],
    reasoning: boot.reasoning,
    tool: boot.tool,
    image: boot.image,
    free: boot.free,
    rate: boot.rate,
  })
}

export function bootModels() {
  const out = {}
  for (const id of Object.keys(BOOT_MODELS)) {
    const m = bootModelOf(id)
    if (m) out[id] = m
  }
  return out
}

/** 是否值得列成聊天模型：live 有它，且（有元数据时）它真支持 openai_chat。 */
export function isChatCandidate(live, meta) {
  if (!live?.id) return false
  if (meta && meta.type === "decision") return false
  if (meta && meta.protocols.size && !meta.protocols.has("openai_chat")) return false
  return true
}

/** 一条目录合并结果 → provider.models 返回的一条。 */
export function mergeModel(live, meta) {
  const id = live?.id ?? meta?.id
  if (!id) return null
  const inputs = meta?.inputs ?? live?.inputs
  const reasoning = meta ? meta.reasoning : (live?.features ?? []).includes("reasoning")
  const tool = meta ? meta.tool : (live?.features ?? []).includes("tools")
  const image = inputs ? inputs.includes("image") : false
  return modelOf({
    id,
    name: meta?.name ?? id,
    context: meta?.context ?? live?.context,
    output: live?.output ?? DEFAULT_OUTPUT,
    inputs,
    reasoning,
    tool,
    image,
    free: meta?.free,
    rate: meta?.rate,
  })
}

/**
 * 拉一次、按 Key 分桶缓存的模型目录。
 *
 * 缓存必须按 API Key 分桶：provider.models 是按账号调用的，A 账号的清单
 * 不能给 B 账号用；公共元数据没有账号，全局缓存一段即可。并发请求不 join
 * 别的账号的 in-flight。失败时保留该 Key 上次成功的清单；空清单做短负缓存，
 * 避免新 Key 生效前的风暴。
 */
export function createCatalog({ fetchLive, fetchMeta, refreshMs = 6 * 3600_000, metaTtlMs = 10 * 60_000, negativeMs = 30_000 } = {}) {
  let metaRows = null
  let metaAt = 0
  const buckets = new Map()

  async function meta() {
    const now = Date.now()
    if (metaRows && now - metaAt < metaTtlMs) return metaRows
    const rows = await fetchMeta()
    if (rows.length) {
      metaRows = rows
      metaAt = now
    }
    return metaRows ?? []
  }

  function bucketFor(apiKey) {
    let b = buckets.get(apiKey)
    if (!b) buckets.set(apiKey, (b = { rows: null, rawAt: 0, inflight: null, emptyAt: 0 }))
    return b
  }

  return {
    /** 最近一次成功的公共元数据（没有则 null）；boot 兜底用。 */
    async meta() {
      return meta()
    },
    /** 这个 Key 的可聊模型：[{ id, meta, live }]，失败抛错。 */
    async forKey(apiKey) {
      if (!apiKey) throw new Error("没有 API Key")
      const b = bucketFor(apiKey)
      const now = Date.now()
      if (b.rows && now - b.rawAt < refreshMs) return b.rows
      if (b.inflight) return b.inflight
      if (b.emptyAt && now - b.emptyAt < negativeMs) return b.rows ?? []
      b.inflight = (async () => {
        try {
          const live = await fetchLive(apiKey)
          const metas = await meta().catch(() => [])
          const byId = new Map(metas.map((m) => [m.id, m]))
          const rows = live
            .map((l) => ({ live: l, meta: byId.get(l.id) }))
            .filter(({ live, meta }) => isChatCandidate(live, meta))
            .map(({ live, meta }) => ({ id: live.id, live, meta, model: mergeModel(live, meta) }))
            .filter((r) => r.model)
          if (rows.length) {
            b.rows = rows
            b.rawAt = Date.now()
            b.emptyAt = 0
          } else {
            b.emptyAt = Date.now()
          }
          return rows.length ? rows : (b.rows ?? [])
        } catch (e) {
          if (b.rows) return b.rows
          throw e
        } finally {
          b.inflight = null
        }
      })()
      return b.inflight
    },
  }
}
