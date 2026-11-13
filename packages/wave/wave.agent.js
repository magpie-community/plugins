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
  // detection: the wsh CLI, or Wave's config directory
  bin: "wsh",
  dir: "~/.config/waveterm",
  config: "~/.config/waveterm/waveai.json",
  format: "json",
  // the model magpie picks, inside the mode object (Wave's ai:model)
  model: "magpie.ai:model",
  // Wave passes ai:model as-is to the gateway, so no prefix
  prefix: "",
  ua: ["waveterm", "wave"],
  notice:
    "Wave reads waveai.json live; pick the Magpie mode in Wave AI's mode dropdown once, or run `wsh setconfig waveai:defaultmode=magpie`. Wave 实时读取 waveai.json；在 Wave AI 面板的模式下拉里选一次 Magpie，或执行 `wsh setconfig waveai:defaultmode=magpie`。",
}

// Wave's thinking levels are just low/medium/high; pick the closest a
// model's efforts offer, or leave the mode without one.
function thinkingLevel(model) {
  const efforts = model?.efforts || []
  for (const level of ["medium", "high", "low"]) {
    if (efforts.includes(level)) return level
  }
  return undefined
}

export function connect({ gateway, model }) {
  const caps = model?.images ? ["tools", "images"] : ["tools"]
  const name = model?.name || model?.id
  const mode = {
    "display:name": name ? `Magpie · ${name}` : "Magpie",
    "display:order": 1,
    // FontAwesome's bird, the closest it has to a magpie
    "display:icon": "crow",
    "ai:model": model?.id ?? "",
    "ai:endpoint": gateway.v1 + "/chat/completions",
    "ai:apitype": "openai-chat",
    "ai:apitoken": gateway.key,
    "ai:capabilities": caps,
  }
  const thinking = thinkingLevel(model)
  if (thinking) mode["ai:thinkinglevel"] = thinking
  return {
    // one whole object, so a disconnect takes the mode out with it
    magpie: mode,
  }
}
