// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the pre-plan consultant that clarifies vague requirements; magpie writes ~/.omo/omo.jsonc's top-level agents.metis.model
export const agent = {
  id: "omo-metis",
  name: "OmO · Metis",
  config: "~/.omo/omo.jsonc",
  model: "agents.metis.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.metis.model; a running omo session picks it up on restart.",
}
