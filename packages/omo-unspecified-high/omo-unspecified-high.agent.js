// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the high fallback for unclassified requests; magpie writes ~/.omo/omo.jsonc's top-level categories.unspecified-high.model
export const agent = {
  id: "omo-unspecified-high",
  name: "OmO · Unspecified High",
  config: "~/.omo/omo.jsonc",
  model: "categories.unspecified-high.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.unspecified-high.model; a running omo session picks it up on restart.",
}
