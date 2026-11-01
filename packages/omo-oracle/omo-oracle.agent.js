// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the consultant for hard questions and design reviews; magpie writes ~/.omo/omo.jsonc's top-level agents.oracle.model
export const agent = {
  id: "omo-oracle",
  name: "OmO · Oracle",
  config: "~/.omo/omo.jsonc",
  model: "agents.oracle.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.oracle.model; a running omo session picks it up on restart.",
}
