// MiniMax Design (design.minimax.io) as a magpie agent.
//
// MiniMax Design's custom text models live in a plain JSON file:
//   Windows: %APPDATA%\@hilo\desktop\hub-config.json  (electron app id @hilo)
// under config.customModels.<entry-id>, each entry shaped like:
//   { protocol, providerName, baseUrl, apiKey, models: [{ id, contextWindow, maxOutputTokens, reasoningLevels }] }
// protocols Design understands: "openai-compatible" | "openai-responses" | "anthropic"
// magpie's gateway serves all three, so this plugin writes one entry pointing
// at magpie's OpenAI-compatible endpoint, and refreshes the model list
// automatically whenever magpie's models change (magpie re-calls connect).
//
// Design picks its model in its own UI, so this agent has no `model` key:
// the row is a switch, and connect is called without a model.
//
const dataDir = "~/.minimax-design"

export const agent = {
  id: "minimax-design",
  name: "MiniMax Design",
  icon: "https://design.minimax.io/favicon.ico",
  config: `${dataDir}/hub-config.json`,
  format: "json",
  dir: dataDir,
  library: {
    skills: "~/Movies/Hub/skills",
    mcp: `${dataDir}/ai-runtime/config-home/opencode/opencode.json`,
    mcpFormat: "opencode",
  },
  notice:
    "Quit MiniMax Design before changing models or MCP servers, then restart it（修改模型或 MCP 前退出，修改后重启）。Models with invalid IDs or context/output limits are omitted（ID 或上下文及输出上限无效的模型不导入）。",
}

// Design's model menu knows these reasoning levels; anything else magpie
// offers (none, minimal) is dropped rather than passed through.
const DESIGN_LEVELS = ["low", "medium", "high", "xhigh", "max"]

// magpie model fields -> Design's custom-model entry fields
function toDesignModel(m) {
  if (!m || typeof m.id !== "string" || !m.id ||
      m.id.startsWith("__hub_reasoning__") || /[\s\u0000-\u001f]/.test(m.id)) return null
  if (!Number.isSafeInteger(m.context) || m.context <= 0 ||
      !Number.isSafeInteger(m.output) || m.output <= 0 || m.output > m.context) return null
  const levels = (m.efforts || []).filter((l) => DESIGN_LEVELS.includes(l))
  return {
    id: m.id,
    contextWindow: m.context,
    maxOutputTokens: m.output,
    reasoningLevels: [...new Set(levels)],
  }
}

export function connect({ gateway, models }) {
  const list = []
  const seen = new Set()
  for (const m of models || []) {
    const d = toDesignModel(m)
    if (!d || seen.has(d.id)) continue
    seen.add(d.id)
    list.push(d)
  }
  if (!list.length) throw new Error("MiniMax Design needs a model with a valid ID and valid context and output limits.")
  const entries = {}
  for (let offset = 0; offset < list.length; offset += 50) {
    const suffix = offset === 0 ? "" : `-${offset / 50 + 1}`
    entries[`config.customModels.user-custom-magpie${suffix}`] = {
      protocol: "openai-compatible",
      providerName: "Magpie",
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      models: list.slice(offset, offset + 50),
    }
  }
  return entries
}
