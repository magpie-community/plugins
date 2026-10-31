// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the deep-work low tier; magpie writes ~/.omo/omo.jsonc's top-level categories.deep-low.model
export const agent = {
  id: "omo-deep-low",
  name: "OmO · Deep Low",
  config: "~/.omo/omo.jsonc",
  model: "categories.deep-low.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.deep-low.model; a running omo session picks it up on restart.",
}
