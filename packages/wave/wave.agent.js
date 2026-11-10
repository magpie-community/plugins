// Wave Terminal (waveterm) keeps its AI modes in ~/.config/waveterm/waveai.json.
// We give Wave one fixed mode, "magpie", managed as a whole object: connect
// returns the full mode — display:name included, which Wave's schema requires
// — and magpie writes it as one key, so switching off removes "magpie"
// entirely and leaves the user's own modes as they were. The model magpie
// picks is written separately as magpie.ai:model.
export const agent = {
  id: "wave",
  name: "Wave",
  icon: "https://github.com/wavetermdev.png",
  // detection: Wave's config directory exists
  dir: "~/.config/waveterm",
  config: "~/.config/waveterm/waveai.json",
  format: "json",
  // the model magpie picks, inside the mode object (Wave's ai:model)
  model: "magpie.ai:model",
  // Wave passes ai:model as-is to the gateway, so no prefix
  prefix: "",
}

export function connect({ gateway, model }) {
  const caps = model?.images ? ["tools", "images"] : ["tools"]
  return {
    // one whole object, so a disconnect takes the mode out with it
    magpie: {
      "display:name": "Magpie",
      "ai:model": model?.id ?? "",
      "ai:endpoint": gateway.v1 + "/chat/completions",
      "ai:apitype": "openai-chat",
      "ai:apitoken": gateway.key,
      "ai:capabilities": caps,
    },
  }
}
