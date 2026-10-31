// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the plan writer: long structured output; magpie writes ~/.omo/omo.jsonc's top-level agents.prometheus.model
export const agent = {
  id: "omo-prometheus",
  name: "OmO · Prometheus",
  config: "~/.omo/omo.jsonc",
  model: "agents.prometheus.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.prometheus.model; a running omo session picks it up on restart.",
}
