// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the visual-engineering category (UI, charts); magpie writes ~/.omo/omo.jsonc's top-level categories.visual-engineering.model
export const agent = {
  id: "omo-visual-engineering",
  name: "OmO · Visual Engineering",
  config: "~/.omo/omo.jsonc",
  model: "categories.visual-engineering.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level categories.visual-engineering.model; a running omo session picks it up on restart.",
}
