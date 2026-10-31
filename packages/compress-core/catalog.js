// 压缩引擎目录 —— 逐字照搬 OmniRoute open-sse/services/compression/engineCatalog.ts
//
// This file holds the strategies that ship with the middleware PR: session-dedup,
// lite and headroom. Each one is lossless (isSafeDefault(id) === !lossy), so the
// safe preset is exactly these three, and each one is prefix-stable: once a
// message has been sent it is never rewritten (see engines/lite.js,
// engines/session-dedup.js and test/prefix-stability.test.mjs).
//
// The rest of OmniRoute's catalog (ccr, rtk, codex-responses, relevance, caveman,
// read-lifecycle, aggressive, ultra, ionizer, llm) is ported and tested, but it is
// not in this PR: adding an id here is what makes it reachable, and the entries
// land with their own review.
//
// 字段对齐 OmniRoute：
//   stackPriority 升序即执行顺序；isSafeDefault(id) === !lossy
//   label 用 OmniRoute 英文原名（用户要求「名字照搬」）
//   why 是本插件加的中文一句话；description 是 OmniRoute 原文

export const ENGINES = [
  {
    id: "session-dedup",
    fields: [
      { key: "minBlockChars", type: "number", label: "最小块字符", description: "小于这个长度的文本块不参与去重", defaultValue: 80, min: 20, max: 4000 },
      { key: "minJaccard", type: "number", label: "相似度阈值", description: "越高越保守，1 表示只合并完全相同的块", defaultValue: 0.85, min: 0.5, max: 1 },
      { key: "shingleSize", type: "number", label: "分片大小", description: "相似度计算的分片长度", defaultValue: 3, min: 2, max: 8 },
    ],
    label: "Session Dedup",
    description:
      "Lossless — elides only text already sent earlier in the same session; nothing is summarized or dropped. Negligible latency overhead.",
    why: "同一会话里已经发过的文本，后面再出现就换成引用；不总结也不丢内容。",
    stackPriority: 3,
    lossy: false,
    cacheImpact: "low",
    isSingleMode: false,
    levels: null,
    sampling: false,
    inputScope: "messages",
    available: true,
    requires: null,
  },
  {
    id: "lite",
    fields: [
      { key: "compressToolResults", type: "boolean", label: "压缩工具输出", description: "对 tool_result 做空白与格式清理", defaultValue: true },
      { key: "preserveSystemPrompt", type: "boolean", label: "保护系统提示词", description: "完全不碰 system 消息", defaultValue: false },
      { key: "maxToolLength", type: "number", label: "工具输出上限", description: "超过这个字符数的工具输出会被截断", defaultValue: 2000, min: 200, max: 20000 },
    ],
    label: "Lite Cleanup",
    description:
      "Safest mode (~15% savings, <1ms latency): whitespace/dedup/formatting cleanup only, zero semantic change. Always safe to leave on.",
    why: "只清空白、重复行和格式，零语义改动，永远可以开着（约 15%）。",
    stackPriority: 5,
    lossy: false,
    cacheImpact: "none",
    isSingleMode: true,
    levels: null,
    sampling: false,
    inputScope: "mixed",
    available: true,
    requires: null,
  },
  {
    id: "headroom",
    fields: [
      { key: "minRows", type: "number", label: "最小行数", description: "表格行数少于这个值就不压", defaultValue: 8, min: 2, max: 200 },
    ],
    label: "Headroom (GCF)",
    description:
      "Column-wise compaction of tabular JSON into [N rows] form while keeping the structure readable.",
    why: "把表格化的 JSON 按列压紧成 [N rows]，结构仍然可读。",
    stackPriority: 15,
    lossy: false,
    cacheImpact: "low",
    isSingleMode: false,
    levels: null,
    sampling: false,
    inputScope: "tool-results",
    available: true,
    requires: null,
  },
]

// stackPriority 升序 = 执行顺序
export const ORDER = ENGINES.slice().sort((a, b) => a.stackPriority - b.stackPriority).map((e) => e.id)

export const PRESET_NAMES = ["off", "safe", "custom", "all"]

const byId = new Map(ENGINES.map((e) => [e.id, e]))
export function engineById(id) {
  return byId.get(id) || null
}

// 稳妥档 = OmniRoute 的 isSafeDefault(id) === !lossy
export function isSafeDefault(engine) {
  return engine.lossy === false
}

export function presetStrategies(preset) {
  const out = {}
  for (const e of ENGINES) {
    if (preset === "off") out[e.id] = false
    else if (preset === "all") out[e.id] = true
    else if (preset === "safe") out[e.id] = e.available && isSafeDefault(e)
    else out[e.id] = e.available && isSafeDefault(e) // custom 的起点 = 稳妥
  }
  return out
}

function sameAs(strategies, target) {
  for (const e of ENGINES) {
    if ((strategies[e.id] === true) !== (target[e.id] === true)) return false
  }
  return true
}

export function detectPreset(strategies) {
  if (!strategies) return "safe"
  if (sameAs(strategies, presetStrategies("off"))) return "off"
  if (sameAs(strategies, presetStrategies("all"))) return "all"
  if (sameAs(strategies, presetStrategies("safe"))) return "safe"
  return "custom"
}

// 把旧版的驼峰键迁移到 OmniRoute 原名
const LEGACY_KEYS = { sessionDedup: "session-dedup" }
export function normalizeStrategies(strategies) {
  if (!strategies || typeof strategies !== "object") return null
  const out = {}
  for (const [key, value] of Object.entries(strategies)) {
    out[LEGACY_KEYS[key] || key] = value === true
  }
  return out
}