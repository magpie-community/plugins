import assert from "node:assert/strict"
import StringAIPlugin from "./index.mjs"
import { browserLogin } from "./lib/login.mjs"
import { readAccount } from "./lib/account.mjs"
import { SITE } from "./lib/account.mjs"

const realFetch = globalThis.fetch
const requests = []
let require2FA = false
let failKeys = false
let emptyKeys = false
let removeClaude = false
const json = (data) => Response.json({ code: 0, data })
const activeKey = (id, key, platform) => ({ id, key, status: "active", group_id: id, name: key, group: { name: platform, platform } })

// 上游响应按网页接口契约提供；本地登录页使用真实 HTTP 请求。
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input)
  if (url.hostname === "127.0.0.1") return realFetch(input, init)
  const headers = new Headers(init.headers)
  const token = headers.get("authorization")
  const body = init.body ? JSON.parse(init.body) : undefined
  requests.push({ url, token, body })
  if (url.origin === "https://models.dev") return Response.json({})
  assert.equal(url.origin, SITE)
  if (url.pathname === "/api/v1/auth/login") {
    assert.equal(body.password, "test-password")
    if (require2FA) return json({ requires_2fa: true, temp_token: "temporary" })
    return json({ access_token: "session-a", refresh_token: "refresh-a", expires_in: 3600 })
  }
  if (url.pathname === "/api/v1/auth/login/2fa") {
    assert.deepEqual(body, { temp_token: "temporary", totp_code: "123456" })
    return json({ access_token: "session-a", refresh_token: "refresh-a", expires_in: 3600 })
  }
  if (url.pathname === "/api/v1/auth/refresh") {
    assert.equal(body.refresh_token, "refresh-a")
    return json({ access_token: "session-renewed", refresh_token: "refresh-renewed", expires_in: 7200 })
  }
  if (url.pathname === "/api/v1/auth/me") {
    return json({ id: token === "Bearer session-b" ? 2 : 1, email: "user@example.com", balance: 10 })
  }
  if (url.pathname === "/api/v1/keys") {
    if (failKeys) return Response.json({ code: "UNAUTHORIZED", message: "登录过期" }, { status: 401 })
    if (emptyKeys) return json({ items: [], pages: 0 })
    if (token === "Bearer session-b") return json({ items: [activeKey(3, "sk-account-b", "openai")], pages: 1 })
    if (url.searchParams.get("page") === "1") {
      return json({ items: [activeKey(1, "sk-openai", "openai"), { ...activeKey(4, "sk-disabled", "openai"), status: "inactive" }], pages: 2 })
    }
    return json({ items: [
      ...(removeClaude ? [] : [activeKey(2, "sk-claude", "anthropic")]),
      { ...activeKey(5, "sk-hidden", "anthropic"), is_hidden: true },
      { ...activeKey(6, "sk-expired", "anthropic"), expires_at: "2020-01-01T00:00:00Z" },
    ], pages: 2 })
  }
  if (url.pathname === "/v1/models") {
    const ids = token === "Bearer sk-claude" ? ["claude-example", "shared-model"] : ["gpt-example", "shared-model"]
    return Response.json({ data: ids.map((id) => ({ id })) })
  }
  if (url.pathname === "/v1/usage") return Response.json({ mode: "unrestricted", balance: 10 })
  if (url.pathname === "/v1/responses" || url.pathname === "/v1/messages") {
    assert.equal(headers.get("x-api-key"), token.slice(7))
    return Response.json({ usedKey: token, model: body.model })
  }
  throw new Error(`未预期的请求: ${url.pathname}`)
}

const authA = { type: "oauth", access: "session-a", refresh: "refresh-a", expires: Date.now() + 3600000, metadata: { userId: 1 } }
const authB = { ...authA, access: "session-b", metadata: { userId: 2 } }

try {
  const account = await readAccount(authA.access)
  assert.deepEqual(account.keys.map((item) => item.key), ["sk-openai", "sk-claude"])
  assert.equal(account.keys[1].groupId, 2)

  const module = await import("./index.mjs")
  assert.deepEqual(Object.keys(module), ["default"])
  const plugin = await StringAIPlugin()
  assert.equal(plugin.auth.single, true)
  assert.equal(plugin.auth.methods[0].type, "oauth")
  const models = await plugin.provider.models({ models: {} }, { auth: authA })
  assert.deepEqual(Object.keys(models), ["gpt-example", "shared-model", "claude-example"])
  assert.equal(JSON.stringify(models).includes("sk-"), false)
  const loaderA = await plugin.auth.loader(async () => authA)
  const send = async (loader, model) => (await loader.fetch(`${SITE}/v1/responses`, {
    method: "POST", headers: {}, body: JSON.stringify({ model }),
  })).json()
  assert.equal((await send(loaderA, "claude-example")).usedKey, "Bearer sk-claude")
  assert.equal((await send(loaderA, "shared-model")).usedKey, "Bearer sk-openai")

  await plugin.provider.models({ models: {} }, { auth: authB })
  const loaderB = await plugin.auth.loader(async () => authB)
  assert.equal((await send(loaderB, "gpt-example")).usedKey, "Bearer sk-account-b")
  assert.equal((await send(loaderA, "gpt-example")).usedKey, "Bearer sk-openai")
  await assert.rejects(loaderA.fetch("https://example.com/v1/responses", { body: "{}" }), /超出供应商范围/)
  await assert.rejects(send(loaderA, "unknown-model"), /未找到模型/)

  removeClaude = true
  await plugin.provider.models({ models: {} }, { auth: authA })
  await assert.rejects(send(loaderA, "claude-example"), /未找到模型/)
  removeClaude = false
  const usage = await plugin.auth.usage(async () => authA)
  assert.equal(usage.balance, "$10.00")
  assert.equal(usage.user, "user@example.com")
  assert.equal(usage.error, undefined)
  const renewed = await plugin.auth.refresh(authA)
  assert.equal(renewed.access, "session-renewed")
  assert.equal(renewed.refresh, "refresh-renewed")

  failKeys = true
  await assert.rejects(plugin.provider.models({ models: {} }, { auth: authA }), /登录过期/)
  const expired = await plugin.auth.usage(async () => authA)
  assert.equal(expired.signIn, "expired")
  failKeys = false
  emptyKeys = true
  await assert.rejects(readAccount(authA.access), /没有可用 API Key/)
  emptyKeys = false

  for (const twoFactor of [false, true]) {
    require2FA = twoFactor
    const login = await browserLogin()
    try {
      const url = new URL(login.url)
      const html = await (await realFetch(url.origin)).text()
      assert.match(html, /type="password"/)
      const post = (body, state = url.hash.slice(1), origin = url.origin) => realFetch(`${url.origin}/login`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Login-State": state, Origin: origin }, body: JSON.stringify(body),
      })
      assert.equal((await post({}, "wrong-state")).status, 403)
      assert.equal((await post({}, url.hash.slice(1), "https://example.com")).status, 403)
      const response = await post({ email: "user@example.com", password: "test-password" })
      assert.equal(response.status, 200)
      const body = await response.json()
      if (twoFactor) {
        assert.equal(body.requires2FA, true)
        assert.equal((await post({ code: "12" })).status, 400)
        const verified = await post({ code: "123456" })
        assert.equal((await verified.json()).keyCount, 2)
      } else assert.equal(body.keyCount, 2)
      const saved = await login.callback()
      assert.equal(saved.type, "success")
      assert.equal(saved.access, "session-a")
      assert.equal(saved.accountId, "user@example.com")
      assert.equal(JSON.stringify(saved).includes("test-password"), false)
      assert.equal(JSON.stringify(saved).includes("sk-"), false)
    } finally {
      login.cancel()
    }
  }

  const legacy = await plugin.auth.loader(async () => ({ type: "api", key: "sk-openai" }))
  assert.equal((await send(legacy, "gpt-example")).usedKey, "Bearer sk-openai")
  console.log("通过：账号登录、两步验证、分页同步、停用和过期过滤、刷新凭据、模型路由、账号隔离、删除同步、余额和原有 API Key 登录。")
} finally {
  globalThis.fetch = realFetch
}
