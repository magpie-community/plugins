import { expect, test } from "bun:test"
import { agent, connect } from "./kilo.agent.js"

test("says where Kilo keeps its model", () => {
  expect(agent).toMatchObject({
    id: "kilo",
    config: "~/.config/kilo/kilo.jsonc",
    format: "json",
    model: "model",
    prefix: "magpie/",
  })
})

test("shows Kilo's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.magpie.icon).toBe(agent.icon)
  expect(pkg.magpie.agent).toBe("./kilo.agent.js")
})

test("points Kilo at magpie as an OpenAI-compatible provider", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-kilo" },
    model: { id: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
    models: [
      { id: "deepseek/deepseek-flash", name: "DeepSeek Flash", context: 1000000, output: 393216, efforts: ["high", "max"] },
      { id: "trae-cn/glm-5.3-flash", name: "GLM 5.3 Flash", context: 200000, output: 32000 },
    ],
    agent: { id: "kilo", config: "/home/u/.config/kilo/kilo.jsonc" },
  })
  expect(out).toEqual({
    "provider.magpie": {
      name: "magpie",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:3425/v1", apiKey: "magpie-kilo" },
      models: {
        "deepseek/deepseek-flash": {
          name: "DeepSeek Flash",
          tool_call: true,
          variants: { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
          limit: { context: 1000000, output: 393216 },
        },
        "trae-cn/glm-5.3-flash": {
          name: "GLM 5.3 Flash",
          tool_call: true,
          variants: {},
          limit: { context: 200000, output: 32000 },
        },
      },
    },
  })
})

test("writes a provider with no models when magpie offers none", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "k" },
    models: [],
    agent: { id: "kilo", config: "/home/u/.config/kilo/kilo.jsonc" },
  })
  expect(out["provider.magpie"].models).toEqual({})
})

const gateway = { v1: "http://127.0.0.1:3425/v1", key: "k" }
const catalogFor = (models) => connect({ gateway, models })["provider.magpie"].models

test("declares image inputs only for image-capable models", () => {
  const catalog = catalogFor([
    { id: "vision", images: true },
    { id: "text", images: false },
    { id: "unspecified" },
  ])
  expect(catalog.vision.attachment).toBe(true)
  expect(catalog.vision.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
  for (const id of ["text", "unspecified"]) {
    expect(catalog[id]).not.toHaveProperty("attachment")
    expect(catalog[id]).not.toHaveProperty("modalities")
  }
})

test("orders and deduplicates the model's own reasoning levels without changing the input", () => {
  const efforts = ["ultra", "max", "high", "medium", "low", "minimal", "none", "xhigh", "max"]
  const original = [...efforts]
  const { variants } = catalogFor([{ id: "reasoner", efforts }]).reasoner
  expect(Object.keys(variants)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
  for (const level of Object.keys(variants)) {
    expect(variants[level]).toEqual({ reasoningEffort: level })
  }
  expect(efforts).toEqual(original)
})

test("keeps unrecognized reasoning levels after known levels", () => {
  const { variants } = catalogFor([{ id: "reasoner", efforts: ["custom", "max", "high", "custom"] }]).reasoner
  expect(Object.keys(variants)).toEqual(["high", "max", "custom"])
  expect(variants.custom).toEqual({ reasoningEffort: "custom" })
})

test("writes empty variants for models without reasoning levels", () => {
  const catalog = catalogFor([{ id: "empty", efforts: [] }, { id: "missing" }])
  for (const model of Object.values(catalog)) {
    expect(model.variants).toEqual({})
    expect(model).not.toHaveProperty("reasoning")
  }
})

test("omits limits for unknown context windows and preserves known limits", () => {
  const catalog = catalogFor([
    { id: "missing", output: 100 },
    { id: "zero", context: 0, output: 100 },
    { id: "negative", context: -1 },
    { id: "known", context: 200000, output: 32000 },
    { id: "unknown-output", context: 200000 },
  ])
  for (const id of ["missing", "zero", "negative"]) {
    expect(catalog[id]).not.toHaveProperty("limit")
  }
  expect(catalog.known.limit).toEqual({ context: 200000, output: 32000 })
  expect(catalog["unknown-output"].limit).toEqual({ context: 200000, output: 0 })
})

test("returns the provider as one restorable key even when the model catalog is omitted", () => {
  const out = connect({ gateway })
  expect(Object.keys(out)).toEqual(["provider.magpie"])
  expect(out["provider.magpie"]).toEqual({
    name: "magpie",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: gateway.v1, apiKey: gateway.key },
    models: {},
  })
})
