// 模型目录：网页端模型选择器（model-show）在售的 23 个模型，全部有倍率。
// 上下文窗口/最大输出/输入模态取自两处厂商配置，按下面的优先级：
//   1. API Key 的模型配置（/organization/getApiKeyConfigDetail 的 openClawProviders）——
//      booksgpt、deepseek-v4-flash、deepseek-v4-pro 是 1M/384K；qwen3.7-plus 是 983616/131072。
//   2. 桌面客户端的生产配置（~/.mobook-harness/profiles/<profile>/cordis.patch.yml）——
//      其余模型 262144/131072/65536 这类上限来自这里。
// 倍率会随登录实时用 model-show 刷新；这张表是未登录/接口失败时的启动值。
// 目录里只有这 23 个：网关 /v1/models 返回 62 个 id，但平台只给这 23 个公布倍率，
// 其余是历史/内部别名（-l3、-unsafe、旧版本号），放进选择器只会显示成没有倍率的条目。

export const CATALOG = [
  { id: 'eco', name: '快速', rate: 0.11, context: 983616, output: 131072, image: true },
  { id: 'booksgpt', name: '均衡', rate: 0.32, context: 1048576, output: 393216, image: true },
  { id: 'ultra', name: '极致', rate: 0.56, context: 983616, output: 131072, image: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-Flash', rate: 0.03, context: 1048576, output: 393216, image: true },
  { id: 'doubao-seed-2-1-pro-260628', name: 'Doubao-Seed-2.1-Pro', rate: 0.36, context: 262144, output: 131072, image: true },
  { id: 'doubao-seed-2-1-turbo-260628', name: 'Doubao-Seed-2.1-Turbo', rate: 0.18, context: 262144, output: 262144, image: true },
  { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao-Seed-2.0-Pro', rate: 0.29, context: 262144, output: 131072, image: true },
  { id: 'qwen4-max', name: 'Qwen4-Max', rate: 0.46, context: 983616, output: 131072, image: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', rate: 0.56, context: 983616, output: 131072, image: true },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', rate: 0.04, context: 983616, output: 131072, image: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', rate: 0.06, context: 983616, output: 131072, image: true },
  { id: 'kimi-k3.1-pro-highspeed', name: 'Kimi-K3.1-Pro-HighSpeed', rate: 1.56, context: 262144, output: 131072, image: true },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', rate: 0.78, context: 262144, output: 131072, image: true },
  { id: 'kimi-k3', name: 'Kimi-K3', rate: 1.18, context: 262144, output: 131072, image: true },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', rate: 0.36, context: 262144, output: 131072, image: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', rate: 0.36, context: 262144, output: 131072, image: true },
  { id: 'hy4', name: 'Tencent-Hy4', rate: 0.28, context: 262144, output: 65536, image: true },
  { id: 'hy4-flash', name: 'Tencent-Hy4-Flash', rate: 0.03, context: 262144, output: 65536, image: true },
  { id: 'glm-5.3', name: 'GLM-5.3', rate: 0.41, context: 262144, output: 131072, image: false },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', rate: 0.04, context: 262144, output: 131072, image: true },
  { id: 'glm-5.2', name: 'GLM-5.2', rate: 0.41, context: 262144, output: 131072, image: false },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', rate: 0.42, context: 1048576, output: 393216, image: false },
  { id: 'minimax-m3', name: 'MiniMax-M3', rate: 0.11, context: 262144, output: 131072, image: true },
]

// DEFAULT_LIMITS 新上架但表里没有的模型用它兜底。
export const DEFAULT_LIMITS = { context: 262144, output: 131072 }

// modelRow 把目录条目变成 OpenCode/Magpie 的模型定义。
// 输入图片按厂商配置声明；输出只有文本。reasoning 先保守为 false，
// 免得客户端发出网关不认的 reasoning 参数。
export function modelRow(entry) {
  const id = String(entry?.id ?? '').trim()
  const context = Number(entry?.context) > 0 ? Number(entry.context) : DEFAULT_LIMITS.context
  const output = Number(entry?.output) > 0 ? Number(entry.output) : DEFAULT_LIMITS.output
  const reasoning = entry?.reasoning === true
  const image = entry?.image === true
  const rate = Number(entry?.rate)
  return {
    id,
    name: String(entry?.name ?? id).trim() || id,
    limit: { context, output },
    reasoning,
    tool_call: false,
    ...(Number.isFinite(rate) && rate > 0 ? { rate } : {}),
    modalities: { input: image ? ['text', 'image'] : ['text'], output: ['text'] },
    capabilities: {
      reasoning,
      toolcall: false,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
  }
}

export function bootstrapModels() {
  const out = {}
  for (const entry of CATALOG) out[entry.id] = modelRow(entry)
  return out
}

// curatedModels 以这张表为准，用实时的 model-show 覆盖显示名与倍率；
// 平台新上架的模型（表里没有）按默认窗口收进来，倍率取实时的。
export function curatedModels(show) {
  const live = show instanceof Map ? show : new Map()
  const out = {}
  for (const entry of CATALOG) {
    const meta = live.get(entry.id)
    const liveRate = meta?.multiplier
    out[entry.id] = modelRow({
      ...entry,
      name: String(meta?.name ?? entry.name),
      rate: liveRate != null && Number.isFinite(Number(liveRate)) ? Number(liveRate) : entry.rate,
    })
  }
  for (const [id, meta] of live) {
    if (out[id]) continue
    out[id] = modelRow({ id, name: meta?.name ?? id, rate: Number(meta?.multiplier) })
  }
  return out
}

// allModels 在“显示全部模型”选项打开时用：在售的 23 个保留真实倍率与窗口，
// 其余历史/内部别名（-l3、-unsafe、旧版本号）按默认窗口收进来，倍率能拿到就拿。
// 这些 id 没有公开的上下文/倍率，默认 262144 / 131072（桌面客户端生产配置的常见值）。
export function allModels(ids, show) {
  const live = show instanceof Map ? show : new Map()
  const out = curatedModels(live)
  for (const id of Array.isArray(ids) ? ids : []) {
    const value = String(id ?? '').trim()
    if (!value || /^test-/i.test(value) || out[value]) continue
    const meta = live.get(value)
    out[value] = modelRow({ id: value, name: meta?.name ?? value, rate: Number(meta?.multiplier) })
  }
  return out
}