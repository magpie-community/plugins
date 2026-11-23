// src/models.mjs —— 模型目录
//
// ⚠ 事实边界（照 tianxi 的规矩写清楚）：
//   · **id 与倍率是上游事实**：来自 0.6.7 客户端的模型选择器（2026-11-20 截图），
//     网关就是按这些 id 路由的，倍率是 New API 的 model ratio。
//   · **context / output 是插件估计**：网关不提供 /v1/models（该端点被上游关掉，
//     实测 404 feature_not_supported），所以上下文只能按家族给保守值。
//     上游若改了，改这里即可 —— 不要把插件常量说成「厂商限制」。
//     契约允许 limit.context 缺省（0 时宿主去模型库查），但我们的 id 不在模型库里，
//     查不到就是 0 = 未知，不如给一个保守估计；**保守值不等于上游事实**。
//   · `rate` 也是上游事实：客户端模型选择器上的倍率，原样给宿主的倍率胶囊。

import { GATEWAY_BASE, SDK } from "./config.mjs"

const K = 1024

/**
 * 上游模型目录（顺序 = 客户端里的分组顺序）。
 *
 * `access: "pro"` 是**实测标注**：该模型只对 Pro 会员开放，免费账号调用只会拿到
 * "This model is exclusive to Pro"。magpie 的模型条目没有这个字段（宿主的归一化
 * 只读 id/name/reasoning/attachment/tool_call/modalities/limit/cost/... ），
 * 所以它**只留在源码里当注释**，不会塞进返回给宿主的表 —— 对外说明写在 README。
 */
export const CATALOG = [
  // ── 默认 lite 档 ─────────────────────────────────────────────
  { id: "lite", name: "Lite 模式", ratio: 0.1, vendor: "floatboat", context: 128 * K, output: 16 * K },

  // ── DeepSeek ────────────────────────────────────────────────
  { id: "deepseek-v4.1-flash", name: "DeepSeek-v4.1-flash", ratio: 0.1, vendor: "deepseek", context: 128 * K, output: 32 * K },
  { id: "deepseek-v4-pro", name: "DeepSeek-v4-pro", ratio: 0.3, vendor: "deepseek", context: 128 * K, output: 32 * K, reasoning: true },

  // ── Gemini ──────────────────────────────────────────────────
  { id: "gemini-3.8-flash", name: "Gemini-3.8-flash", ratio: 0.25, vendor: "google", context: 1_000 * K, output: 64 * K, vision: true },
  { id: "gemini-4-hydrogen", name: "Gemini-4-hydrogen", ratio: 0.6, vendor: "google", context: 1_000 * K, output: 64 * K, vision: true, access: "pro" },
  { id: "gemini-4-argon", name: "Gemini-4-argon", ratio: 0.8, vendor: "google", context: 1_000 * K, output: 64 * K, vision: true, access: "pro" },
  { id: "gemini-4-neon", name: "Gemini-4-neon", ratio: 1, vendor: "google", context: 1_000 * K, output: 64 * K, vision: true },
  { id: "gemini-4-carbon", name: "Gemini-4-carbon", ratio: 1.5, vendor: "google", context: 1_000 * K, output: 64 * K, vision: true },

  // ── OpenAI 系 ───────────────────────────────────────────────
  { id: "gpt-6.2-sol", name: "GPT-6.2-sol", ratio: 0.8, vendor: "openai", context: 400 * K, output: 32 * K, vision: true, reasoning: true },
  { id: "gpt-6.1-sol", name: "GPT-6.1-sol", ratio: 0.8, vendor: "openai", context: 400 * K, output: 32 * K, vision: true, reasoning: true },
  { id: "gpt-6.2-astra", name: "GPT-6.2-astra", ratio: 3.2, vendor: "openai", context: 400 * K, output: 32 * K, vision: true, reasoning: true },
  { id: "gpt-6-astra", name: "GPT-6-astra", ratio: 4, vendor: "openai", context: 400 * K, output: 32 * K, vision: true, reasoning: true, access: "pro" },

  // ── Anthropic ───────────────────────────────────────────────
  { id: "claude-sonnet-5.5", name: "Claude-sonnet-5.5", ratio: 0.8, vendor: "anthropic", context: 200 * K, output: 64 * K, vision: true, access: "pro" },
]

/** 别名：客户端里也出现过这些名字（bundle 常量 / 旧版本缓存），统一收敛到上面的 id */
const ALIASES = new Map([
  ["deepseek-v4-flash", "deepseek-v4.1-flash"],
  ["deepseek-flash", "deepseek-v4.1-flash"],
  ["auto", "lite"],
  ["default", "lite"],
])

/** 把宿主/用户给的名字收敛到上游 id；认不出来就原样返回（让网关自己报错） */
export function resolveModelId(raw) {
  const key = String(raw ?? "").trim()
  if (!key) return "lite"
  return ALIASES.get(key.toLowerCase()) ?? key
}

/**
 * magpie 的 model 条目。
 *
 * ⚠ 同一张表要喂两条**形状不同**的路径，所以字段是两套并集（宿主各读自己那套，
 * 不认识的一律忽略，不会报错）：
 *
 *   ① config 钩子里的静态表 —— 宿主过 `info()`，读**顶层**的
 *      `reasoning` / `attachment` / `tool_call` / `modalities` / `limit` / `cost` / `rate`。
 *      写进 `capabilities` 里的一律不读（那是 OpenCode 的 Model 形状）。
 *   ② `provider.models` 的返回值 —— 宿主**原样**当 Model 用（只补 id / providerID），
 *      读 `capabilities.{temperature,reasoning,attachment,toolcall,input,output}` 与 `api`。
 *
 * 只写一套的后果都不报错、只是能力少一块：①漏 `tool_call` → 工具调用静默为假；
 * ①漏 `attachment` → 收不了图；②漏 `input.{五个模态}` → 宿主按 models.dev 同名模型投票。
 */
function toModelEntry(m) {
  const vision = m.vision === true
  const reasoning = m.reasoning === true
  // 五个模态键必须显式布尔：省掉 image ≠ 不支持，而是「厂商未表态」
  const capsIn = { text: true, image: vision, audio: false, video: false, pdf: false }
  const capsOut = { text: true, image: false, audio: false, video: false, pdf: false }
  return {
    // ── 两条路径共用 ────────────────────────────────────────────
    id: m.id,
    name: m.name,
    // 上游 id 就是 key 本身（网关按 id 路由），所以不给 apiId 覆盖
    status: "active",
    // 倍率（客户端实测）→ 宿主画「x0.3」胶囊；不是美元价格
    rate: m.ratio,
    // 计费在上游：用户看到的是「积分 × 倍率」，cost 全 0 是因为我们拿不到美元价
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // ⚠ 插件估计值（见文件头），不是上游下发的限制
    limit: { context: m.context, output: m.output },

    // ── ① config 钩子那条路径读的顶层平字段 ────────────────────
    reasoning,
    attachment: vision,
    tool_call: true,
    modalities: {
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },

    // ── ② provider.models 返回的 Model 形状 ────────────────────
    api: { id: m.id, url: GATEWAY_BASE, npm: SDK },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: vision,
      toolcall: true,
      input: capsIn,
      output: capsOut,
      interleaved: false,
    },
  }
}

/** config 钩子用的静态表（未登录时也要有内容） */
export function staticModelTable() {
  const out = {}
  for (const m of CATALOG) out[m.id] = toModelEntry(m)
  return out
}
