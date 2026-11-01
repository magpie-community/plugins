// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the long-form-writing category; magpie writes ~/.omo/omo.jsonc's top-level categories.writing.model
export const agent = {
  id: "omo-writing",
  name: "OmO · Writing",
  config: "~/.omo/omo.jsonc",
  model: "categories.writing.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.writing.model; a running omo session picks it up on restart.",
}
