import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

const subject = import("./index.mjs")

// what magpie hands a plugin; none of it is used here
const client = {
  app: { log: async () => {} },
  auth: { set: async () => {} },
  tui: { showToast: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

test("config declares the provider and its model", async () => {
  const { IndexTranslateAuthPlugin } = await subject
  const hooks = await IndexTranslateAuthPlugin({ client })
  const { auth } = hooks
  assert.equal(auth.provider, "index-translate")
  assert.equal(auth.methods.length, 1)
  assert.equal(auth.methods[0].type, "api")

  const cfg = { provider: {} }
  await hooks.config(cfg)
  const provider = cfg.provider["index-translate"]
  assert.equal(provider.name, "Index Translate")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.api, "https://index-translate.bilibili.com/v1")
  const model = provider.models["Index-Translate-35B-A3B"]
  assert.equal(model.name, "Index Translate 35B")
  assert.equal(model.free, true)
  assert.equal(model.limit.context, 32_768)
})

test("loader rewrites the body: thinking off, greedy decoding", async () => {
  const seen = []
  const server = createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    seen.push({ headers: req.headers, body: text })
    res.writeHead(200, { "content-type": "application/json" })
    res.end('{"choices":[{"message":{"content":"ok"}}]}')
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  try {
    const { IndexTranslateAuthPlugin } = await subject
    const hooks = await IndexTranslateAuthPlugin({ client })
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "any-string" }))
    assert.equal(loader.baseURL, "https://index-translate.bilibili.com/v1")

    // the host adds the key's header before the plugin's fetch runs,
    // and the plugin sends it on
    await loader.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer any-string" },
      body: JSON.stringify({ model: "Index-Translate-35B-A3B", messages: [] }),
    })
    assert.match(seen[0].headers.authorization, /^Bearer any-string$/)
    assert.equal(seen[0].body && JSON.parse(seen[0].body).chat_template_kwargs.enable_thinking, false)
    assert.equal(JSON.parse(seen[0].body).temperature, 0)

    // a caller's own choices stay
    await loader.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer any-string" },
      body: JSON.stringify({
        model: "Index-Translate-35B-A3B",
        messages: [],
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: true },
      }),
    })
    const second = JSON.parse(seen[1].body)
    assert.equal(second.temperature, 0.7)
    assert.equal(second.chat_template_kwargs.enable_thinking, true)

    // a body that isn't JSON goes through unchanged
    await loader.fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    })
    assert.equal(seen[2].body, "not json")
  } finally {
    server.close()
  }
})

test("loader without an API-key sign-in sends nothing of its own", async () => {
  const { IndexTranslateAuthPlugin } = await subject
  const hooks = await IndexTranslateAuthPlugin({ client })
  const loader = await hooks.auth.loader(async () => undefined)
  assert.deepEqual(loader, {})
})
