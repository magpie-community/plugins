// ChatCut Desktop reads this dedicated connection when a new Magpie session
// starts. It never changes ~/.codex or another client's model settings.
export const agent = {
  id: "chatcut",
  name: "ChatCut",
  dir: "~/.config/chatcut",
  config: "~/.config/chatcut/magpie.json",
  format: "json",
  model: "model",
  ua: ["chatcut"],
  notice: "Choose Magpie in ChatCut Desktop. Its model menu can switch models in the current conversation. 在 ChatCut 桌面端选择 Magpie，可在模型菜单中切换当前对话的模型。",
}

// The gateway supplies its real address and ChatCut-specific caller key.
export function connect({ gateway, model }) {
  return {
    version: 1,
    baseUrl: gateway.v1,
    apiKey: gateway.key,
    contextWindow: model.context > 0 ? model.context : null,
  }
}
