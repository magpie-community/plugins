import { expect, test } from "bun:test"
import { agent, connect } from "./aider.agent.js"

test("says where Aider keeps its model", () => {
  expect(agent).toMatchObject({ id: "aider", config: "~/.aider.conf.yml", model: "model", prefix: "openai/" })
})

test("points Aider at magpie with its own key", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-aider" },
    model: { id: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
    models: [],
    agent: { id: "aider", config: "/home/u/.aider.conf.yml" },
  })
  expect(out).toEqual({
    "openai-api-base": "http://127.0.0.1:3425/v1",
    "openai-api-key": "magpie-aider",
    "show-model-warnings": false,
  })
})
