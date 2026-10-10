import { expect, test } from "bun:test"
import { agent, connect } from "./bub.agent.js"

const input = {
  gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-bub" },
  model: { id: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
  models: [],
  agent: { id: "bub", config: "/home/u/.bub/config.yml" },
}

test("says where Bub keeps its model", () => {
  expect(agent).toMatchObject({ id: "bub", config: "~/.bub/config.yml", model: "model", prefix: "magpie:" })
})

test("adds magpie as a provider of Bub's own, with Bub's own key", () => {
  expect(connect(input)["providers.magpie"]).toEqual({
    type: "openai",
    api_base: "http://127.0.0.1:3425/v1",
    api_key: "magpie-bub",
  })
})

test("writes the provider whole, so putting it back never leaves one without a type", () => {
  const out = connect(input)
  expect(Object.keys(out)).toContain("providers.magpie")
  expect(out["providers.magpie"].type).toBe("openai")
})

test("names each field of the provider too, for magpie to tell one changed by hand", () => {
  const out = connect(input)
  for (const [key, value] of Object.entries(out["providers.magpie"])) expect(out[`providers.magpie.${key}`]).toBe(value)
  expect(Object.keys(out)).toHaveLength(4)
})

test("leaves the model and the user's other providers to magpie", () => {
  const keys = Object.keys(connect(input))
  expect(keys).not.toContain("model")
  expect(keys.every((k) => k === "providers.magpie" || k.startsWith("providers.magpie."))).toBe(true)
})
