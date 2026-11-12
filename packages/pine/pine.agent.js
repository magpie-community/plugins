// Pine (github.com/pmndrs/pine) runs on pi's SDK, so it keeps its model servers
// in pi's own file, ~/.pine/models.json, and the model a new session starts on
// in ~/.pine/pine.json as defaults.model, written "provider/model-id".
//
// magpie therefore writes the gateway as one provider, "magpie", in models.json,
// and the model it picked into pine.json. Pine reads a reference at the first
// "/", so magpie's model id "deepseek/deepseek-chat" is the model id inside the
// provider "magpie" — exactly the id the gateway answers to.
//
// An agent that names a model of its own in agents/<id>/agent.json overrides
// defaults.model; /model in Pine writes there. Magpie's row is the default, not
// that agent's own choice.
export const agent = {
  id: "pine",
  name: "Pine",
  // Pine's own logo from its repository (MIT), as the project shows it
  icon: "https://raw.githubusercontent.com/pmndrs/pine/main/docs/images/logo-light.svg",
  bin: "pine",
  dir: "~/.pine",
  config: "~/.pine/models.json",
  format: "json",
  prefix: "magpie/",
  // the model a new session starts on, kept apart from connect's providers
  startup: {
    config: "~/.pine/pine.json",
    format: "json",
    model: "defaults.model",
  },
  // pine gives every agent the skills in its home's skills/ folder
  library: { skills: "~/.pine/skills" },
  notice: "New Pine conversations start on this model; /model in Pine still switches, and restarting Pine makes the daemon read the new provider. 新开的对话用这个模型；Pine 里的 /model 仍可切换；重启 pine 让守护进程读到新的 provider。",
}

// pi's thinking levels, lowest first
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

// one of magpie's models as an entry of pi's models.json
function modelEntry(model) {
  const efforts = model.efforts ?? []
  const entry = {
    id: model.id,
    name: model.name || model.id,
    input: model.images ? ["text", "image"] : ["text"],
    // pi offers its thinking levels for a model that reasons only; the map
    // then says which level is sent as which, and hides the others
    reasoning: efforts.length > 0,
  }
  // unknown limits are left out, never written as 0: pi would take the model
  // for a 128K one and cap every reply at 16384 tokens
  if (model.context > 0) entry.contextWindow = model.context
  if (model.output > 0) entry.maxTokens = model.context > 0 ? Math.min(model.output, model.context) : model.output
  if (entry.reasoning) {
    entry.thinkingLevelMap = {}
    for (const level of LEVELS) {
      const sent = level === "off" ? "none" : level
      entry.thinkingLevelMap[level] = efforts.includes(sent) ? sent : null
    }
  }
  return entry
}

export function connect({ gateway, models }) {
  // one object, so magpie stashes and puts back the whole provider: written
  // leaf by leaf, stepping out would leave an empty provider where there was
  // no provider before, and Pine would fail to read it
  return {
    "providers.magpie": {
      name: "Magpie",
      baseUrl: gateway.v1,
      // the gateway translates for a provider that speaks another API
      api: "openai-responses",
      apiKey: gateway.key,
      // a function tool left without "strict" is taken for a strict-mode schema
      // by OpenAI's Responses API; pi-ai says strict: false there only when
      // the compat asks it to
      compat: { supportsStrictMode: true },
      models: models.map(modelEntry),
    },
  }
}
