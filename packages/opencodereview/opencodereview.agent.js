// Open Code Review (Alibaba's `ocr` CLI) keeps its LLM selection in
// ~/.opencodereview/config.json: a top-level `provider` + `model` pair, with
// the endpoint under `custom_providers.<name>` (url / protocol / api_key).
// ocr reads that file on every run, so a new model takes effect on the next
// `ocr review` / `ocr scan`, with no restart.
//
// `connect` writes the whole custom_providers.magpie object as one key, not
// three leaf keys: leaf-only writes leave an empty magpie provider behind
// when there was none before, and magpie restores an object it replaced as
// one unit. The gateway serves Anthropic's /v1/messages on its base address,
// and ocr's anthropic protocol appends that path itself, so the address goes
// in as is, with no /v1 suffix, beside the key magpie keeps for ocr.
//
// magpie stashes the values it replaces and restores them on disconnect,
// removing the keys it created. Everything else in the file — your own
// providers, rules, settings — stays untouched.
export const agent = {
  id: "opencodereview",
  name: "Open Code Review",
  // ocr's own logo, on the Agents page and the plugin's row
  icon: "https://raw.githubusercontent.com/alibaba/open-code-review/main/imgs/logo.svg",
  // `ocr` on PATH; ~/.opencodereview also holds its rule.json and sessions
  bin: "ocr",
  dir: "~/.opencodereview",
  config: "~/.opencodereview/config.json",
  format: "json",
  model: "model",
  // ocr sends "open-code-review/v1.13.2 | claude"; magpie matches lowercase
  // prefixes, for requests that reach the gateway without ocr's key
  ua: ["open-code-review"],
  notice:
    "ocr reads its config on every run: the next ocr review / ocr scan uses the new model. ocr 每次运行都会读取配置：下一次 ocr review / ocr scan 即使用新模型。",
}

export function connect({ gateway }) {
  return {
    // make ocr's active provider the custom provider defined below
    provider: "magpie",
    // one object, so magpie stashes and restores the provider whole and no
    // empty magpie entry is left behind; the anthropic protocol has ocr call
    // <url>/v1/messages
    "custom_providers.magpie": {
      url: gateway.url,
      protocol: "anthropic",
      api_key: gateway.key,
    },
  }
}
