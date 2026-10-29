import { test, expect } from "bun:test"
import StringAIPlugin from "./index.mjs"

test("未登录时声明协议但不编造账号可用模型", async () => {
  const hooks = await StringAIPlugin()
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider["string-ai"]).toEqual({name: "String AI", npm: "@ai-sdk/openai-compatible", api: "https://www.string.ink/v1", models: {}})
  expect(await hooks.provider.models(cfg.provider["string-ai"], {})).toEqual({})
})

test("配置保留用户模型并统一规范 baseURL", async () => {
  const hooks = await StringAIPlugin({}, {baseURL: "https://example.com/"})
  const cfg = {provider: {"string-ai": {models: {custom: {name: "Custom"}}, options: {timeout: 1000}}}}
  await hooks.config(cfg)
  expect(cfg.provider["string-ai"].api).toBe("https://example.com/v1")
  expect(cfg.provider["string-ai"].models).toEqual({custom: {name: "Custom"}})
  expect(cfg.provider["string-ai"].options).toEqual({timeout: 1000})
})
