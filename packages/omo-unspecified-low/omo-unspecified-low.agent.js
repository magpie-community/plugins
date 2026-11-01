// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the light fallback for unclassified requests; magpie writes ~/.omo/omo.jsonc's top-level categories.unspecified-low.model
export const agent = {
  id: "omo-unspecified-low",
  name: "OmO · Unspecified Low",
  config: "~/.omo/omo.jsonc",
  model: "categories.unspecified-low.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.unspecified-low.model; a running omo session picks it up on restart.",
}
