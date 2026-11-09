export const agent = {
  id: "rhino9-ai",
  name: "Magpie-Rhino",
  dir: "~/.config/rhino9-magpie",
  config: "~/.config/rhino9-magpie/settings.json",
  format: "json",
  model: "model",
  ua: [],
  notice: "Install the companion Magpie-Rhino .yak and restart Rhino 9. Open Rhino's AI panel and choose Magpie alongside the native agents; no command is required. MagpieStandalone is the fallback. 安装配套 .yak 后重启 Rhino，直接打开 AI 面板选择 Magpie，无需输入命令。每轮跟随此处的模型、自定义组与策略。",
};

export function connect({ gateway, model } = {}) {
  if (!gateway?.url || !gateway?.key || !model?.id) {
    throw new Error("Select a Magpie model and an available gateway first.");
  }
  return { baseUrl: gateway.url, apiKey: gateway.key };
}
