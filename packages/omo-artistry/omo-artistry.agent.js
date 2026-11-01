// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the creative/writing request category; magpie writes ~/.omo/omo.jsonc's top-level categories.artistry.model
export const agent = {
  id: "omo-artistry",
  name: "OmO · Artistry",
  config: "~/.omo/omo.jsonc",
  model: "categories.artistry.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.artistry.model; a running omo session picks it up on restart.",
}
