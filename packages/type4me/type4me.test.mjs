import { expect, test } from "bun:test"
import { agent, connect } from "./type4me.agent.js"

test("says where Type4Me keeps its model", () => {
  expect(agent).toMatchObject({
    id: "type4me",
    config: "~/Library/Application Support/Type4Me/magpie-agent.json",
    format: "json",
    model: "model",
    dir: "~/Library/Application Support/Type4Me",
  })
  // Type4Me sends magpie's model id as is
  expect(agent.prefix).toBeUndefined()
})

test("shows Type4Me's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon).toBe("https://raw.githubusercontent.com/kchen0x/magpie-agent-type4me/main/assets/icon.png")
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("tells the user when a new model takes effect, in English and Chinese", () => {
  expect(agent.notice).toContain("next dictation")
  expect(agent.notice).toContain("下一次语音输入")
})

test("points Type4Me at magpie's /v1 with its own key, and leaves the model to magpie", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-type4me" },
    model: { id: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
    models: [],
    agent: { id: "type4me", config: "/Users/u/Library/Application Support/Type4Me/magpie-agent.json" },
  })
  expect(out).toEqual({
    baseURL: "http://127.0.0.1:3425/v1",
    apiKey: "magpie-type4me",
  })
})
