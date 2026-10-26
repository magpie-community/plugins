// Adds magpie's models to Paseo's built-in claude provider, so the picker for
// a Claude Code agent in Paseo lists what magpie offers. Paseo merges
// agents.providers.claude.additionalModels into the provider's own catalog by
// id; the provider, its credentials and its other models are left alone.
// Paseo reads agents.providers at launch and on provider refresh, so an edited
// file needs `paseo daemon reload`.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

export const agent = {
  id: "paseo-models",
  name: "Paseo models",
  config: "~/.paseo/config.json",
  format: "json",
  dir: "~/.paseo",
  notice:
    "Magpie's models are added to Paseo's Claude provider. Run `paseo daemon reload` if the daemon is already running. 已把 Magpie 的模型加入 Paseo 的 Claude provider；daemon 已在运行时执行 `paseo daemon reload`。",
}

export function connect({ models }) {
  const additionalModels = models.map((m) => {
    const levels = (m.efforts || []).filter((e) => EFFORTS.includes(e))
    const model = {
      // Claude Code writes a 1M-context model as <id>[1m]; its /model does the same
      id: m.context >= 1000000 ? `${m.id}[1m]` : m.id,
      label: m.name || m.id,
    }
    if (levels.length > 0) {
      const dflt = levels.includes("high") ? "high" : levels[levels.length - 1]
      model.thinkingOptions = levels.map((e) => ({ id: e, label: e, isDefault: e === dflt }))
    }
    return model
  })
  // no models yet (nothing signed in): leave the key out rather than empty it
  return additionalModels.length > 0 ? { "agents.providers.claude.additionalModels": additionalModels } : {}
}
