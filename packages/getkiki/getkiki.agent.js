// Kiki as a Magpie agent.
//
// Kiki runs pi (1.5.0) on its own data folder, ~/kiki-data:
//   - engine/models.json is pi's models file; connect writes a "magpie" provider
//     there (Magpie's gateway + every model Magpie gives Kiki).
//   - .env holds MODEL=<provider>/<model>, the model Kiki starts on (Kiki's own
//     model menu writes the same line). startup points Magpie at it, with the
//     "magpie/" prefix so Kiki asks pi for provider "magpie", model "<id>".
// Turning the row off in Magpie puts both files back as they were.
//
// Kiki 用 pi（1.5.0），数据在 ~/kiki-data：engine/models.json 是 pi 的模型文件，
// connect 往里写一个 magpie 供应商；.env 的 MODEL 是 Kiki 默认用的模型。
// 在 Magpie 里关掉开关，两个文件都还原。

export const agent = {
  // "kiki" is taken in Magpie's market by another project (X-T-E-R/kiki), so this one is "getkiki".
  id: "getkiki",
  name: "Kiki (getkiki.ai)",
  icon: "https://getkiki.ai/favicon.svg",
  // Kiki is a Mac app with no command on PATH: its data folder says it is installed.
  dir: "~/kiki-data",
  config: "~/kiki-data/engine/models.json",
  format: "json",
  prefix: "magpie/",
  startup: {
    config: "~/kiki-data/.env",
    format: "env",
    model: "MODEL",
  },
  notice:
    "Kiki reads its model when it starts: quit Kiki (⌘Q) and open it again. Magpie's models are also in Kiki's own model menu. " +
    "Kiki 启动时读模型：⌘Q 退出再打开就用上了。Kiki 自己的模型菜单里也能直接选 Magpie 的模型。",
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
  // Unknown limits are left to pi's defaults; zero is invalid in its schema.
  if (model.context > 0) entry.contextWindow = model.context
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
  // The provider is written and restored as one unit, so turning the row off
  // leaves no empty provider behind; Kiki's other providers are not touched.
  return {
    "providers.magpie": {
      name: "Magpie",
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      // Magpie's gateway translates Chat Completions to whatever each model speaks.
      api: "openai-completions",
      models: (models || []).map(modelEntry),
    },
  }
}
