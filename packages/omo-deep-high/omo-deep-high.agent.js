// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the deep-work high tier; magpie writes ~/.omo/omo.jsonc's top-level categories.deep-high.model
export const agent = {
  id: "omo-deep-high",
  name: "OmO · Deep High",
  config: "~/.omo/omo.jsonc",
  model: "categories.deep-high.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.deep-high.model; a running omo session picks it up on restart.",
}
