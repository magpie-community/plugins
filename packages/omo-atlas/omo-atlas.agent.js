// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the head orchestrator: judgment first, short outputs; magpie writes ~/.omo/omo.jsonc's top-level agents.atlas.model
export const agent = {
  id: "omo-atlas",
  name: "OmO · Atlas",
  config: "~/.omo/omo.jsonc",
  model: "agents.atlas.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.atlas.model; a running omo session picks it up on restart.",
}
