export const agent = {
  id: "bub",
  name: "Bub",
  bin: "bub",
  dir: "~/.bub",
  config: "~/.bub/config.yml",
  model: "model",
  prefix: "magpie:",
  notice: "Bub reads its settings at start-up: restart bub gateway and open bub chat sessions to use the new model. This needs a Bub that reads providers (bubbuild/bub#343, after 0.5.0); an older one fails every turn on a magpie: model.",
}

export function connect({ gateway }) {
  const provider = { type: "openai", api_base: gateway.v1, api_key: gateway.key }
  const out = { "providers.magpie": provider }
  for (const [key, value] of Object.entries(provider)) out[`providers.magpie.${key}`] = value
  return out
}
