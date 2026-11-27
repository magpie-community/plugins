// zycode (https://github.com/zy1233/pi-python) reads its model from the
// [model] table of ~/.pi-python/agent.toml, and its keys from
// ~/.pi-python/local.env. magpie cannot edit TOML, so magpie writes the
// three values to local.env, where it can, and index.mjs puts them into
// the [model] table (see bridge.mjs).
export const agent = {
  id: "zycode",
  name: "zycode",
  bin: "zypi",
  dir: "~/.pi-python",
  config: "~/.pi-python/local.env",
  model: "MAGPIE_ZYCODE_MODEL",
  notice: "zycode reads its settings when it starts: restart it to use the new model.",
}

export function connect({ gateway }) {
  return {
    MAGPIE_ZYCODE_API_KEY: gateway.key,
    MAGPIE_ZYCODE_BASE_URL: gateway.v1,
  }
}
