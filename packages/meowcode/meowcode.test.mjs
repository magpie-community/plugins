import { expect, test } from "bun:test"
import { agent, connect } from "./meowcode.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-meowcode" }

const models = [
  { id: "deepseek/pro", name: "DeepSeek Pro", context: 128000, output: 8192, images: false },
  { id: "kimi/k2", name: "Kimi K2", context: 256000, output: 16384, images: true },
]

test("says where MeowCode keeps the overlay magpie writes, and never it alone", () => {
  expect(agent).toMatchObject({
    id: "meowcode",
    config: "$APPDATA/MeowCode/agent/magpie.json",
    format: "json",
    model: "providerId",
    prefix: "magpie/",
    dir: "$APPDATA/MeowCode/agent",
    ua: ["meowcode"],
  })
  // base is only for an agent magpie starts, and MeowCode is not one
  expect(agent.base).toBeUndefined()
  expect(agent.launch).toBeUndefined()
  expect(agent.merge).toBeUndefined()
})

test("writes one provider per model, on the gateway's OpenAI-compatible endpoint", () => {
  const out = connect({ gateway, model: models[0], models })
  expect(out.magpieKey).toBe("magpie-meowcode")
  expect(out.providers).toEqual([
    {
      id: "magpie/deepseek/pro",
      name: "Magpie",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "deepseek/pro",
      displayName: "DeepSeek Pro",
      protocol: "openai-chat-completions",
      authStyle: "none",
      extraHeaders: { Authorization: "Bearer magpie-meowcode" },
      enabled: true,
      inputModalities: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    },
    {
      id: "magpie/kimi/k2",
      name: "Magpie",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "kimi/k2",
      displayName: "Kimi K2",
      protocol: "openai-chat-completions",
      authStyle: "none",
      extraHeaders: { Authorization: "Bearer magpie-meowcode" },
      enabled: true,
      inputModalities: ["text", "image"],
      contextWindow: 256000,
      maxTokens: 16384,
    },
  ])
})

test("names the model's id without magpie's prefix, which is the record's alone", () => {
  const out = connect({ gateway, model: models[1], models })
  expect(out.providers[1].model).toBe("kimi/k2")
  expect(out.providers[1].id).toBe("magpie/kimi/k2")
})

test("keeps the model magpie picked even when the catalog has not caught up", () => {
  const out = connect({ gateway, model: { id: "new/one" }, models: [] })
  expect(out.providers.map((p) => p.id)).toEqual(["magpie/new/one"])
  expect(out.providers[0].model).toBe("new/one")
  expect(out.providers[0].displayName).toBeUndefined()
})

test("leaves out what it has no answer for", () => {
  const out = connect({ gateway, model: null, models: [{ id: "plain" }] })
  expect(out.providers[0].displayName).toBeUndefined()
  expect(out.providers[0].contextWindow).toBeUndefined()
  expect(out.providers[0].maxTokens).toBeUndefined()
})
