// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the native harness's pre-plan consultant; magpie writes ~/.omo/omo.jsonc's top-level agents.plan-consultant.model
export const agent = {
  id: "omo-plan-consultant",
  name: "OmO · Plan Consultant",
  config: "~/.omo/omo.jsonc",
  model: "agents.plan-consultant.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.plan-consultant.model; a running omo session picks it up on restart.",
}
