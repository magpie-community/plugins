import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { QuWorkProvider, _internal } from "./index.mjs"

const { createPlugin } = _internal

test("config declares the QuWork provider and models", async () => {
  const hooks = await QuWorkProvider({})
  const cfg = { provider: {} }
  await hooks.config(cfg)
  assert.equal(cfg.provider.quwork.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.quwork.api, "https://llm.quwork.cn/v1")
  assert.ok(Object.keys(cfg.provider.quwork.models).length >= 10)
})

test("the setup page links to QuWork and both official sign-in and model key methods are registered", async () => {
  const hooks = await QuWorkProvider({})
  const page = readFileSync(new URL("./page/index.html", import.meta.url), "utf8")
  assert.equal(hooks.auth.provider, "quwork")
  assert.deepEqual(hooks.auth.methods.map((method) => method.type), ["oauth", "api"])
  assert.match(page, /href="https:\/\/quwork\.cn\/" target="_self"/)
  assert.doesNotMatch(page, /<input\b|<form\b/i)
  assert.equal(hooks.auth.methods[1].prompts[0].type, "password")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
})

test("official browser sign-in reads the website session and uses a returned model key", async () => {
  const calls = []
  const hooks = createPlugin({
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization })
      return Response.json({ data: [] })
    },
    browser: {
      find: () => true,
      open: async () => ({
        credentials: async () => ({ webToken: "web-token", llmToken: "sk-browser" }),
        close: async () => {},
      }),
    },
  })
  const desc = await hooks.auth.methods[0].authorize()
  assert.equal(desc.opened, true)
  assert.equal(desc.method, "auto")
  assert.deepEqual(await desc.callback(), {
    type: "success",
    key: "sk-browser",
    metadata: { source: "browser", accessToken: "web-token", modelKey: true },
  })
  assert.deepEqual(calls, [{ url: "https://llm.quwork.cn/v1/models", authorization: "Bearer sk-browser" }])
})

test("the loader sends the active key only to the model gateway and rejects redirects", async () => {
  const calls = []
  const hooks = createPlugin({ fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return Response.json({ data: [] })
  } })
  let auth = { type: "api", key: "sk-test" }
  const options = await hooks.auth.loader(async () => auth)
  assert.equal(options.apiKey, "quwork")
  assert.equal(options.baseURL, "https://llm.quwork.cn/v1")
  await assert.rejects(
    () => options.fetch("https://example.com/v1/models"),
    /仅用于 QuWork 模型网关/,
  )
  assert.equal(calls.length, 0)
  auth = { type: "api", key: "sk-test-updated" }
  await options.fetch(`${options.baseURL}/models`)
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer sk-test-updated")
  assert.equal(calls[0].init.redirect, "error")
})

test("key setup validates only the model key with a read-only request", async () => {
  const calls = []
  const hooks = createPlugin({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method ?? "GET", authorization: init.headers.authorization })
      return Response.json({ data: [] })
    },
  })
  const method = hooks.auth.methods[1]
  assert.equal((await method.authorize({ key: "000000" })).type, "failed")
  assert.equal(calls.length, 0)
  assert.deepEqual(await method.authorize({ key: " sk-test " }), {
    type: "success",
    key: "sk-test",
    metadata: { source: "pasted" },
  })
  assert.deepEqual(calls, [{ url: "https://llm.quwork.cn/v1/models", method: "GET", authorization: "Bearer sk-test" }])
})

test("quota is scoped to legacy accounts and deduplicates concurrent reads", async () => {
  const calls = []
  const hooks = createPlugin({ fetchImpl: async (_url, init) => {
    const authorization = init.headers.authorization
    calls.push(authorization)
    const points = authorization === "Bearer first-access" ? "42.5" : 0
    return Response.json({ success: true, data: { points_entitlement: { total_points: points, limited_points: 0 } } })
  } })
  const forAccount = (accessToken) => async () => ({ type: "api", key: "sk-test", metadata: { source: "browser", accessToken } })
  const first = forAccount("first-access")
  assert.deepEqual((await Promise.all([hooks.auth.usage(first), hooks.auth.usage(first)])).map((value) => value.balance), [
    "42.5 积分（限时 0）", "42.5 积分（限时 0）",
  ])
  assert.equal((await hooks.auth.usage(forAccount("second-access"))).balance, "0 积分（限时 0）")
  const keyOnly = await hooks.auth.usage(async () => ({ type: "api", key: "sk-test", metadata: { source: "pasted" } }))
  assert.match(keyOnly.error, /官方入口查看账号积分/)
  assert.deepEqual(calls, ["Bearer first-access", "Bearer second-access"])
})

test("quota treats missing data, expired credentials and refusals as distinct states", async () => {
  const fixtures = [
    [200, { success: true, data: { points_entitlement: { total_points: null } } }, "kept", /有效的积分/],
    [401, { token: "not-for-display" }, "kept", /旧版积分凭据已失效/],
    [403, { error: "not-for-display" }, "kept", /拒绝查询/],
    [429, { error: "not-for-display" }, "kept", /限制了积分查询/],
  ]
  for (const [status, payload, signIn, message] of fixtures) {
    const hooks = createPlugin({ fetchImpl: async () => Response.json(payload, { status }) })
    const result = await hooks.auth.usage(async () => ({
      type: "api", key: "sk-test", metadata: { source: "browser", accessToken: "fixture-access" },
    }))
    assert.equal(result.balance, undefined)
    assert.equal(result.signIn, signIn)
    assert.match(result.error, message)
    assert.doesNotMatch(result.error, /not-for-display/)
  }
})
