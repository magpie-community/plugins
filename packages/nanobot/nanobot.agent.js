// Magpie runs this descriptor in moejs. The Bun companion applies its intent
// to nanobot's config and consumes the Library's separate MCP output.
export const agent = {
  id: "nanobot",
  name: "nanobot",
  // Official app mark; Magpie fetches and caches this URL, as for PiG.
  icon: "https://raw.githubusercontent.com/HKUDS/nanobot/main/webui/public/brand/nanobot_mark.svg",
  bin: "nanobot",
  dir: "~/.nanobot",
  config: "~/.config/magpie-nanobot/connection.json",
  format: "json",
  model: "model",
  ua: ["nanobot"],
  notice: "Keep Magpie running and wait for the adapter. Restart nanobot to load MCP changes; existing sessions may keep their own model. 保持 Magpie 运行并等待同步；MCP 变更后重启 nanobot，已有会话可能保留自己的模型。",
  library: {
    mcp: "~/.config/magpie-nanobot/mcp.json",
    mcpFormat: "claude",
    // nanobot loads workspace/skills; Library owns linking/copying and removal.
    skills: "~/.nanobot/workspace/skills",
  },
}

export function connect({ gateway, model }) {
  if (!gateway?.v1 || !gateway?.key || !model?.id) throw new Error("Choose a Magpie model with an available gateway.")
  const info = {}
  if (Number.isSafeInteger(model.context) && model.context > 0) info.context = model.context
  if (Number.isSafeInteger(model.output) && model.output > 0) info.output = model.context > 0 ? Math.min(model.output, model.context) : model.output
  if (typeof model.images === "boolean") info.images = model.images
  return { baseURL: gateway.v1, gatewayKey: gateway.key, modelInfo: info }
}
