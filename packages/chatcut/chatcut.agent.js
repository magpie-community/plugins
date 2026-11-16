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
  notice: "Choose Magpie in ChatCut Desktop and start a new chat after changing the model. 在 ChatCut 桌面端选择 Magpie，修改模型后开始新对话。",
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
