// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the native harness's plan reviewer; magpie writes ~/.omo/omo.jsonc's top-level agents.plan-reviewer.model
export const agent = {
  id: "omo-plan-reviewer",
  name: "OmO · Plan Reviewer",
  config: "~/.omo/omo.jsonc",
  model: "agents.plan-reviewer.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.plan-reviewer.model; a running omo session picks it up on restart.",
}
