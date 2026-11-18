import test from "node:test"
import assert from "node:assert/strict"
import { QuWorkProvider } from "./index.mjs"

test("config declares the QuWork provider and models", async () => {
  const hooks = await QuWorkProvider({})
  const cfg = { provider: {} }
  await hooks.config(cfg)
  assert.equal(cfg.provider.quwork.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.quwork.api, "https://llm.quwork.cn/v1")
  assert.ok(Object.keys(cfg.provider.quwork.models).length >= 10)
})

test("three sign-in methods, a loader and usage", async () => {
  const hooks = await QuWorkProvider({})
  assert.equal(hooks.auth.provider, "quwork")
  assert.equal(hooks.auth.methods.length, 3)
  assert.equal(hooks.auth.methods[0].type, "oauth")
  assert.ok(hooks.auth.methods[0].label.includes("浏览器登录"))
  assert.equal(typeof hooks.auth.methods[0].authorize, "function")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
})

test("the browser login page is served under a secret path", async () => {
  const hooks = await QuWorkProvider({})
  const desc = await hooks.auth.methods[0].authorize(undefined, {})
  try {
    assert.match(desc.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\/$/)
    const res = await fetch(desc.url)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes("QuWork 登录"))
    assert.ok(html.includes("api/send-code"))
  } finally {
    desc.close?.()
  }
})
