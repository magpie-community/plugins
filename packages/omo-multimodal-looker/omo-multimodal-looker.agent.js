// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the image looker for screenshots and design mockups; magpie writes ~/.omo/omo.jsonc's top-level agents.multimodal-looker.model
export const agent = {
  id: "omo-multimodal-looker",
  name: "OmO · Multimodal Looker",
  config: "~/.omo/omo.jsonc",
  model: "agents.multimodal-looker.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.multimodal-looker.model; a running omo session picks it up on restart.",
}
