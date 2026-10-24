import assert from "node:assert/strict"
import test from "node:test"
import { Loomy } from "./index.mjs"
import { parseSessionInput, rewriteDeepseekImages, sessionFromPaste } from "./core.mjs"

test("deepseek images become the marker the model reads", () => {
  const body = {
    model: "deepseek-v4-flash-0731",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      },
    ],
  }
  const rewritten = rewriteDeepseekImages(body)
  assert.deepEqual(rewritten.messages[0].content, [
    { type: "text", text: "What is this?\n<image_base64>QUJD</image_base64>" },
  ])
  assert.equal(rewriteDeepseekImages(rewritten), rewritten)
})

test("non-deepseek images stay as OpenAI image_url", () => {
  const body = {
    model: "glm-5.3-flash",
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    ],
  }
  assert.equal(rewriteDeepseekImages(body), body)
})

test("a session paste becomes an OAuth account without a refresh token", () => {
  const auth = sessionFromPaste("a-loomy-session-value-long-enough")
  assert.equal(auth.type, "oauth")
  assert.equal(auth.access, "a-loomy-session-value-long-enough")
  assert.equal(auth.refresh, "")
  assert.ok(auth.expires > Date.now())
})

test("an exported account keeps its session and identity", () => {
  const auth = parseSessionInput(JSON.stringify({
    provider: "loomy",
    auth: { accessToken: "a-loomy-session-value-long-enough", userid: "user-7", phone: "13800138000" },
  }))
  assert.equal(auth.access, "a-loomy-session-value-long-enough")
  assert.equal(auth.accountId, "user-7")
  assert.equal(auth.phone, "13800138000")
})

test("paste sign-in saves OAuth, not an API key", async () => {
  const plugin = await Loomy()
  assert.deepEqual(plugin.auth.methods.map((m) => m.label), ["Paste Loomy login"])
  const paste = plugin.auth.methods[0]
  assert.equal(paste.type, "oauth")
  const action = await paste.authorize({ login: JSON.stringify({
    provider: "loomy",
    auth: { accessToken: "a-loomy-session-value-long-enough", userid: "user-8" },
  }) })
  const saved = await action.callback()
  assert.equal(action.method, "auto")
  assert.equal(saved.type, "success")
  assert.equal(saved.access, "a-loomy-session-value-long-enough")
  assert.equal(saved.accountId, "user-8")
})

test("config declares the provider before the first sign-in", async () => {
  const hooks = await Loomy()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  assert.equal(cfg.provider.loomy.npm, "@ai-sdk/openai-compatible")
  assert.ok(cfg.provider.loomy.models["DeepSeek-V4.1-Flash"])
})

