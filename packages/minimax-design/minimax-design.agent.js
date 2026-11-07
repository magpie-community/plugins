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
// Windows only: config and dir lean on $APPDATA and $LOCALAPPDATA, which
// don't exist on macOS or Linux. See COMPATIBILITY.md.
export const agent = {
  id: "minimax-design",
  name: "MiniMax Design",
  icon: "https://design.minimax.io/favicon.ico",
  config: "$APPDATA/@hilo/desktop/hub-config.json",
  format: "json",
  dir: "$LOCALAPPDATA/Programs/MiniMax Design",
  notice:
    "Windows only 仅限 Windows — quit MiniMax Design before connecting, restart it after（连接前退出、连接后重启）",
}

// Design's model menu knows these reasoning levels; anything else magpie
// offers (none, minimal) is dropped rather than passed through.
const DESIGN_LEVELS = ["low", "medium", "high", "xhigh", "max"]

// magpie model fields -> Design's custom-model entry fields
function toDesignModel(m) {
  if (!m || !m.id) return null
  const out = { id: m.id }
  if (m.context) out.contextWindow = m.context
  if (m.output) out.maxOutputTokens = m.output
  const levels = (m.efforts || []).filter((l) => DESIGN_LEVELS.includes(l))
  if (levels.length) out.reasoningLevels = levels
  return out
}

// The entry goes as one key holding the whole object, so switching the agent
// off removes the entry itself — not five dotted keys whose emptied parent
// ("user-custom-magpie": {}) would stay behind in the file.
export function connect({ gateway, models }) {
  const list = []
  for (const m of models || []) {
    const d = toDesignModel(m)
    if (d) list.push(d)
  }
  return {
    "config.customModels.user-custom-magpie": {
      protocol: "openai-compatible",
      providerName: "Magpie",
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      models: list,
    },
  }
}
