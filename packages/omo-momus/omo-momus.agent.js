// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the plan critic that wants strict logic; magpie writes ~/.omo/omo.jsonc's top-level agents.momus.model
export const agent = {
  id: "omo-momus",
  name: "OmO · Momus",
  config: "~/.omo/omo.jsonc",
  model: "agents.momus.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.momus.model; a running omo session picks it up on restart.",
}
