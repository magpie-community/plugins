// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the architecture-design request category; magpie writes ~/.omo/omo.jsonc's top-level categories.architect.model
export const agent = {
  id: "omo-architect",
  name: "OmO · Architect",
  config: "~/.omo/omo.jsonc",
  model: "categories.architect.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.architect.model; a running omo session picks it up on restart.",
}
