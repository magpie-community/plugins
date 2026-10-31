// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the fast explorer that finds files and searches code; magpie writes ~/.omo/omo.jsonc's top-level agents.explore.model
export const agent = {
  id: "omo-explore",
  name: "OmO · Explore",
  config: "~/.omo/omo.jsonc",
  model: "agents.explore.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.explore.model; a running omo session picks it up on restart.",
}
