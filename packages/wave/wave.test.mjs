import { expect, test } from "bun:test"
import { agent, connect } from "./wave.agent.js"

test("says where Wave keeps its model", () => {
  expect(agent).toMatchObject({
    id: "wave",
    config: "~/.config/waveterm/waveai.json",
    model: "magpie.ai:model",
    prefix: "",
  })
})

test("shows Wave's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon).toBe("https://github.com/wavetermdev.png")
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("writes the whole magpie mode, with display:name, and nothing else", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-wave" },
    model: { id: "v2ex/glm-5.3-flash", name: "GLM-5.3-Flash", images: false },
    models: [],
    agent: { id: "wave", config: "/Users/u/.config/waveterm/waveai.json" },
  })
  // a single "magpie" object, so switching off removes the mode entirely
  expect(Object.keys(out)).toEqual(["magpie"])
  expect(out.magpie).toEqual({
    "display:name": "Magpie",
    "ai:model": "v2ex/glm-5.3-flash",
    "ai:endpoint": "http://127.0.0.1:3425/v1/chat/completions",
    "ai:apitype": "openai-chat",
    "ai:apitoken": "magpie-wave",
    "ai:capabilities": ["tools"],
  })
})

test("declares images when the model takes them", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "magpie-wave" },
    model: { id: "zhipu/glm-5.3-flash", images: true },
  })
  expect(out.magpie["ai:capabilities"]).toEqual(["tools", "images"])
})
