// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the deepest-thinking category for hard problems; magpie writes ~/.omo/omo.jsonc's top-level categories.ultrabrain.model
export const agent = {
  id: "omo-ultrabrain",
  name: "OmO · Ultrabrain",
  config: "~/.omo/omo.jsonc",
  model: "categories.ultrabrain.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.ultrabrain.model; a running omo session picks it up on restart.",
}
