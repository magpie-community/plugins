export const agent = {
  id: "rhino9-ai",
  name: "Rhino 9 AI",
  dir: "~/.config/rhino9-magpie",
  config: "~/.config/rhino9-magpie/settings.json",
  format: "json",
  model: "model",
  ua: [],
  notice: "Launch Rhino with RhinoMagpie.exe, then choose Claude / Opus (latest) in its AI panel. Restart that Rhino instance after changing models. 使用专用启动器打开 Rhino，在 AI 面板选 Claude / Opus (latest)；切换模型后重新启动。",
};

export function connect({ gateway, model } = {}) {
  if (!gateway?.url || !gateway?.key || !model?.id) {
    throw new Error("Select a Magpie model and an available gateway first.");
  }
  return { baseUrl: gateway.url, apiKey: gateway.key };
}
