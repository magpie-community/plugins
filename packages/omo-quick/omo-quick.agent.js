// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the quick-questions-and-small-tasks category; magpie writes ~/.omo/omo.jsonc's top-level categories.quick.model
export const agent = {
  id: "omo-quick",
  name: "OmO · Quick",
  config: "~/.omo/omo.jsonc",
  model: "categories.quick.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.quick.model; a running omo session picks it up on restart.",
}
