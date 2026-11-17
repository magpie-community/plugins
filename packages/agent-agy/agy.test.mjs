import { expect, test } from "bun:test"
import { agent, connect, own } from "./agy.agent.js"

test("says where agy keeps its model, and how it is started", () => {
  expect(agent).toMatchObject({
    id: "agy",
    config: "~/.gemini/antigravity-cli/magpie-settings.json",
    base: "~/.gemini/antigravity-cli/settings.json",
    format: "json",
    model: "model",
    prefix: "magpie/",
    bin: "agy",
    launch: {
      env: { GEMINI_API_KEY: "{key}", GOOGLE_GEMINI_BASE_URL: "{url}" },
      model: "--model",
      args: { "--settings": "{config}" },
      plain: ["remote-control", "--remote-control", "-remote-control"],
    },
  })
  expect(agent.merge).toBeUndefined()
})

test("carries the user's own custom models from settings.json beside magpie's", () => {
  const base = {
    customModelsConfig: {
      customModels: {
        "my-claude": { apiProvider: "API_PROVIDER_ANTHROPIC", modelName: "claude-sonnet-4-5" },
        "magpie/old": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "old" },
      },
    },
  }
  const out = connect({ model: { id: "deepseek/pro" }, models: [{ id: "deepseek/pro" }], base })
  expect(out["customModelsConfig.customModels"]).toEqual({
    "my-claude": { apiProvider: "API_PROVIDER_ANTHROPIC", modelName: "claude-sonnet-4-5" },
    "magpie/deepseek/pro": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "deepseek/pro" },
  })
})

test("lists magpie's models as agy's Gemini models", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-agy" },
    model: { id: "deepseek/pro" },
    models: [{ id: "deepseek/pro" }, { id: "deepseek/flash" }],
  })
  expect(out).toEqual({
    modelProvider: "gemini",
    "customModelsConfig.customModels": {
      "magpie/deepseek/pro": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "deepseek/pro" },
      "magpie/deepseek/flash": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "deepseek/flash" },
    },
  })
})

test("the user's own models go to their own provider", () => {
  const base = {
    customModelsConfig: {
      customModels: {
        "magpie/deepseek/pro": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "deepseek/pro" },
        "my-claude": { apiProvider: "API_PROVIDER_ANTHROPIC", modelName: "claude-sonnet-4-5" },
        "my-gpt": { apiProvider: "API_PROVIDER_OPENAI", modelName: "gpt-5" },
      },
    },
  }
  expect(own({ base, model: "gemini-3-pro" })).toEqual([
    { value: "gemini-3-pro", model: "gemini-3-pro", direct: "Google" },
    { value: "my-claude", model: "claude-sonnet-4-5", direct: "Anthropic" },
    { value: "my-gpt", model: "gpt-5", direct: "OpenAI" },
  ])
  expect(own({ base, model: "my-gpt" }).map((o) => o.value)).toEqual(["my-claude", "my-gpt"])
  expect(own({ base: {}, model: "" })).toEqual([])
})
