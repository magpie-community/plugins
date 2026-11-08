export const agent = {
  id: "rhino9-ai",
  name: "Rhino 9 · Magpie",
  dir: "~/.config/rhino9-magpie",
  config: "~/.config/rhino9-magpie/settings.json",
  format: "json",
  model: "model",
  ua: [],
  notice: "Install the companion RhinoMagpie .yak package once, then run Magpie in Rhino 9. Its native Magpie panel follows this model or routing group on each new turn. 先安装配套 Rhino 插件，在 Rhino 9 输入 Magpie 打开独立面板；每轮跟随此处选择的模型、自定义组及策略。",
};

export function connect({ gateway, model } = {}) {
  if (!gateway?.url || !gateway?.key || !model?.id) {
    throw new Error("Select a Magpie model and an available gateway first.");
  }
  return { baseUrl: gateway.url, apiKey: gateway.key };
}
