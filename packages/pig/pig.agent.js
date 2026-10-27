// PiG reads providers from models.json and startup preferences from a separate
// settings.json. This connect-only agent owns the provider catalog alone.
export const agent = {
  id: "pig",
  name: "PiG",
  // PiG's own pixel-pig favicon from its site (MIT), as the app shows it.
  icon: "https://pi-in-go.dev/pig-favicon.svg",
  bin: "pig",
  dir: "~/.pig/agent",
  config: "~/.pig/agent/models.json",
  format: "json",
  notice: "Choose a Magpie model with /model in PiG. Startup settings are unchanged. 在 PiG 中用 /model 选择模型；启动设置保持原样。",
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

function modelEntry(model) {
  const efforts = model.efforts || []
  const entry = {
    id: model.id,
    name: model.name || model.id,
    input: model.images ? ["text", "image"] : ["text"],
    reasoning: efforts.length > 0,
  }
  // Unknown limits are left to PiG's defaults; zero is invalid in its schema.
  if (model.context > 0) entry.contextWindow = model.context
  // Match Magpie's Pi adapter: a published output limit cannot exceed its window.
  if (model.output > 0) entry.maxTokens = model.context > 0 ? Math.min(model.output, model.context) : model.output
  if (efforts.length > 0) {
    entry.thinkingLevelMap = {}
    for (const level of thinkingLevels) {
      const effort = level === "off" ? "none" : level
      entry.thinkingLevelMap[level] = efforts.includes(effort) ? effort : null
    }
  }
  return entry
}

export function connect({ gateway, models }) {
  // Stash and restore the provider as one unit. Leaf-only writes leave an
  // invalid empty provider after disconnect when no provider existed before.
  // Other provider IDs remain outside this plugin's ownership.
  return {
    "providers.magpie": {
      name: "Magpie",
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      // The public hook has no native-protocol field; Magpie translates Chat.
      api: "openai-completions",
      models: models.map(modelEntry),
    },
  }
}
