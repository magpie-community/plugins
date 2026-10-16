// Type4Me (a macOS voice input app) keeps the model its LLM post-processing
// uses in ~/Library/Application Support/Type4Me/magpie-agent.json, a folder
// Type4Me and Type4Me Dev share, so one agent covers both builds. It talks to
// magpie's OpenAI Chat Completions endpoint, so magpie's model goes in as is,
// beside magpie's /v1 address and the key magpie keeps for Type4Me.
//
// Type4Me reads the file before each dictation: a new model takes effect on
// the next one, no restart. Type4Me may set the model itself, through
// `magpie type4me magpie/<model>`; it never changes the address or the key.
export const agent = {
  id: "type4me",
  name: "Type4Me",
  // Type4Me's own icon, on the Agents page and the plugin's row
  icon: "https://raw.githubusercontent.com/kchen0x/magpie-agent-type4me/main/assets/icon.png",
  // must match MagpieAgentFile.defaultURL in Type4Me
  config: "~/Library/Application Support/Type4Me/magpie-agent.json",
  format: "json",
  model: "model",
  // Type4Me has no command on PATH; its profile folder says it is installed
  dir: "~/Library/Application Support/Type4Me",
  ua: ["Type4Me"],
  notice: "Type4Me uses the new model on your next dictation. Type4Me 会在下一次语音输入时使用新模型。",
}

export function connect({ gateway }) {
  return {
    baseURL: gateway.v1,
    apiKey: gateway.key,
  }
}
