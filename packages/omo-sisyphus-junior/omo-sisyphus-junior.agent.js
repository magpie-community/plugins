// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the sub agent that executes without delegating; magpie writes ~/.omo/omo.jsonc's top-level agents.sisyphus-junior.model
export const agent = {
  id: "omo-sisyphus-junior",
  name: "OmO · Sisyphus Junior",
  config: "~/.omo/omo.jsonc",
  model: "agents.sisyphus-junior.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.sisyphus-junior.model; a running omo session picks it up on restart.",
}
