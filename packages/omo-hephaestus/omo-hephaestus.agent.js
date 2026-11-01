// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the deep autonomous worker (OmO allows only GPT-family models there); magpie writes ~/.omo/omo.jsonc's top-level agents.hephaestus.model
export const agent = {
  id: "omo-hephaestus",
  name: "OmO · Hephaestus",
  config: "~/.omo/omo.jsonc",
  model: "agents.hephaestus.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.hephaestus.model; a running omo session picks it up on restart.",
}
