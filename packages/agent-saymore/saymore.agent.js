// Saymore consumes this scoped handoff on its next start; it does not
// automatically choose or enable a polishing provider.
export const agent = {
  id: "saymore",
  name: "Saymore",
  icon: "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/agent-saymore/assets/icon.png",
  summary: {
    en: "Choose a Magpie model for Saymore's text-polishing provider on macOS. Requires a Saymore release with Magpie handoff support.",
    zh: "在 macOS 版 Saymore 的文本润色服务中选择 Magpie 模型。需要支持 Magpie 配置导入的 Saymore 版本。",
  },
  bin: "saymore-desktop",
  dir: "~/Library/Application Support/Saymore",
  config: "~/Library/Application Support/Saymore/config.json",
  format: "json",
  model: "integrations.magpie.model",
  ua: ["saymore"],
  notice: "Connect or change the model while Saymore is closed, then reopen it and test the Magpie provider in Models → Text polishing.",
}

export function connect({ gateway }) {
  return {
    "integrations.magpie.base_url": gateway.v1,
    "integrations.magpie.api_key": gateway.key,
    "integrations.magpie.profile": "portable",
  }
}
