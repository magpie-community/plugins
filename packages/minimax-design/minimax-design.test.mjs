import { expect, test } from "bun:test"
import { agent, connect } from "./minimax-design.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-minimax-design" }

test("says where Design keeps its custom models, and that it is Windows only", () => {
  expect(agent).toMatchObject({
    id: "minimax-design",
    config: "$APPDATA/@hilo/desktop/hub-config.json",
    format: "json",
  })
  expect(agent.model).toBeUndefined()
  expect(agent.notice).toContain("Windows only")
})

test("shows Design's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon).toBe("https://design.minimax.io/favicon.ico")
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("writes the entry as one key holding the whole object", () => {
  const out = connect({ gateway, models: [] })
  expect(Object.keys(out)).toEqual(["config.customModels.user-custom-magpie"])
  expect(out["config.customModels.user-custom-magpie"]).toEqual({
    protocol: "openai-compatible",
    providerName: "Magpie",
    baseUrl: "http://127.0.0.1:3425/v1",
    apiKey: "magpie-minimax-design",
    models: [],
  })
})

test("maps magpie's model fields onto Design's", () => {
  const out = connect({
    gateway,
    models: [{ id: "workbuddy/deepseek-v4.1-flash", context: 1000000, output: 128000, efforts: ["low", "high", "max"] }],
  })
  expect(out["config.customModels.user-custom-magpie"].models).toEqual([
    { id: "workbuddy/deepseek-v4.1-flash", contextWindow: 1000000, maxOutputTokens: 128000, reasoningLevels: ["low", "high", "max"] },
  ])
})

test("drops reasoning levels Design doesn't know, and omits the field when nothing is left", () => {
  const out = connect({
    gateway,
    models: [
      { id: "a", efforts: ["none", "minimal", "xhigh"] },
      { id: "b", efforts: ["none"] },
    ],
  })
  const models = out["config.customModels.user-custom-magpie"].models
  expect(models[0]).toEqual({ id: "a", reasoningLevels: ["xhigh"] })
  expect(models[1]).toEqual({ id: "b" })
})

test("drops models without an id, and null or missing model entries", () => {
  const out = connect({
    gateway,
    models: [null, {}, { id: "" }, { id: "kept" }, undefined],
  })
  expect(out["config.customModels.user-custom-magpie"].models).toEqual([{ id: "kept" }])
})

test("models: undefined gives an entry with an empty list", () => {
  const out = connect({ gateway, models: undefined })
  expect(out["config.customModels.user-custom-magpie"].models).toEqual([])
})
