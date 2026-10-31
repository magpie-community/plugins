// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the always-on main agent that writes code and carries the long context; magpie writes ~/.omo/omo.jsonc's top-level agents.sisyphus.model
export const agent = {
  id: "omo-sisyphus",
  name: "OmO · Sisyphus",
  config: "~/.omo/omo.jsonc",
  model: "agents.sisyphus.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.sisyphus.model; a running omo session picks it up on restart.",
}
