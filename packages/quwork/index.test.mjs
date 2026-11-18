import test from "node:test"
import assert from "node:assert/strict"
import { QuWorkProvider, _internal } from "./index.mjs"

const { createPlugin } = _internal

function submit(session, path, body, origin = new URL(session.url).origin) {
  return fetch(new URL(`api/${path}`, session.url), {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

test("config declares the QuWork provider and models", async () => {
  const hooks = await QuWorkProvider({})
  const cfg = { provider: {} }
  await hooks.config(cfg)
  assert.equal(cfg.provider.quwork.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.quwork.api, "https://llm.quwork.cn/v1")
  assert.ok(Object.keys(cfg.provider.quwork.models).length >= 10)
})

test("interactive sign-in and authorized keys are the only methods", async () => {
  const hooks = await QuWorkProvider({})
  assert.equal(hooks.auth.provider, "quwork")
  assert.deepEqual(hooks.auth.methods.map((method) => method.type), ["oauth", "api"])
  assert.ok(hooks.auth.methods[0].label.includes("浏览器登录"))
  assert.equal(typeof hooks.auth.methods[0].authorize, "function")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
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

test("the browser login page is served under a secret path", async () => {
  const hooks = await QuWorkProvider({})
  const desc = await hooks.auth.methods[0].authorize(undefined, {})
  try {
    assert.match(desc.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\/$/)
    const res = await fetch(desc.url)
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)
    const html = await res.text()
    assert.ok(html.includes("QuWork 登录"))
    assert.ok(html.includes("api/send-code"))
  } finally {
    desc.close?.()
  }
})

test("the local login API rejects a request without the page origin", async () => {
  let calls = 0
  const hooks = createPlugin({ fetchImpl: async () => { calls += 1; throw new Error("unexpected request") } })
  const desc = await hooks.auth.methods[0].authorize(undefined, {})
  try {
    const endpoint = new URL("api/send-code", desc.url)
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13800000000", captcha: "test" }),
    })
    assert.equal(res.status, 403)
    assert.equal((await submit(desc, "send-code", {}, "https://example.com")).status, 403)
    assert.equal(calls, 0)
  } finally {
    desc.close?.()
  }
})

test("browser sign-in enforces the SMS flow and keeps credentials out of browser responses", async () => {
  const calls = []
  const hooks = createPlugin({
    getDeviceIdentifier: () => "fixture-device",
    fetchImpl: async (url) => {
      const target = new URL(url)
      calls.push(target.pathname)
      if (target.pathname.endsWith("/sendVerifyCode")) return Response.json({ success: true, data: { token: "not-for-browser" } })
      if (target.pathname.endsWith("/client/login")) {
        return Response.json({ success: true, data: { token: "fixture-access", llm_token: "sk-fixture", user: { phone: "private" } } })
      }
      if (target.pathname.endsWith("/models")) return Response.json({ data: [] })
      throw new Error("unexpected request")
    },
  })
  const session = await hooks.auth.methods[0].authorize()
  const phone = "13800000000"
  try {
    assert.equal((await submit(session, "login", { phone, code: "123456" })).status, 400)
    assert.equal(calls.length, 0)
    const response = await submit(session, "send-code", { phone, captcha: "fixture" })
    assert.deepEqual(await response.json(), { success: true })
    assert.equal((await submit(session, "send-code", { phone, captcha: "fixture" })).status, 429)
    const login = await submit(session, "login", { phone, code: "123456" })
    assert.deepEqual(await login.json(), { success: true })
    assert.equal((await submit(session, "login", { phone, code: "123456" })).status, 410)
    assert.deepEqual(await session.callback(), {
      type: "success",
      key: "sk-fixture",
      metadata: { source: "browser", accessToken: "fixture-access" },
    })
    assert.equal(calls.length, 3)
  } finally {
    session.close()
  }
})

test("cancelling the sign-in callback closes the local page", async () => {
  const hooks = await QuWorkProvider({})
  const session = await hooks.auth.methods[0].authorize()
  try {
    const page = await fetch(session.url)
    assert.equal(page.status, 200)
    await page.text()
    const controller = new AbortController()
    const pending = session.callback(undefined, { signal: controller.signal })
    controller.abort()
    assert.equal((await pending).type, "failed")
    await assert.rejects(() => fetch(session.url))
  } finally {
    session.close()
  }
})

test("quota is scoped to browser accounts and deduplicates concurrent reads", async () => {
  const calls = []
  const hooks = createPlugin({ fetchImpl: async (_url, init) => {
    const authorization = init.headers.authorization
    calls.push(authorization)
    const points = authorization === "Bearer first-access" ? "42.5" : 0
    return Response.json({ success: true, data: { points_entitlement: { total_points: points, limited_points: 0 } } })
  } })
  const forAccount = (accessToken) => async () => ({ type: "api", key: "sk-fixture", metadata: { source: "browser", accessToken } })
  const first = forAccount("first-access")
  assert.deepEqual((await Promise.all([hooks.auth.usage(first), hooks.auth.usage(first)])).map((value) => value.balance), [
    "42.5 积分（限时 0）", "42.5 积分（限时 0）",
  ])
  assert.equal((await hooks.auth.usage(forAccount("second-access"))).balance, "0 积分（限时 0）")
  assert.match((await hooks.auth.usage(async () => ({ type: "api", key: "sk-fixture" }))).error, /仅有模型密钥/)
  assert.deepEqual(calls, ["Bearer first-access", "Bearer second-access"])
})

test("quota treats missing data, expired credentials and refusals as distinct states", async () => {
  const fixtures = [
    [200, { success: true, data: { points_entitlement: { total_points: null } } }, "kept", /有效的积分/],
    [401, { token: "not-for-display" }, "expired", /凭据已失效/],
    [403, { error: "not-for-display" }, "kept", /拒绝查询/],
    [429, { error: "not-for-display" }, "kept", /限制了积分查询/],
  ]
  for (const [status, payload, signIn, message] of fixtures) {
    const hooks = createPlugin({ fetchImpl: async () => Response.json(payload, { status }) })
    const result = await hooks.auth.usage(async () => ({
      type: "api", key: "sk-fixture", metadata: { source: "browser", accessToken: "fixture-access" },
    }))
    assert.equal(result.balance, undefined)
    assert.equal(result.signIn, signIn)
    assert.match(result.error, message)
    assert.doesNotMatch(result.error, /not-for-display/)
  }
})
