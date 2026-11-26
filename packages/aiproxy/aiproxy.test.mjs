import test from "node:test"
import assert from "node:assert/strict"
import { _internal, AiProxyPlugin } from "./index.mjs"

const base = "https://aiproxy.example.test"

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function auth(extra = {}) {
  return {
    type: "api",
    key: "aiproxy-test-key",
    metadata: {
      baseURL: base,
      email: "owner@example.test",
      password: "password",
      ...extra,
    },
  }
}

test("parses AiProxy entitlement windows and wallet balance", () => {
  const result = _internal.parseEntitlements({
    balance_usd: 12.5,
    plans: [{
      plan: {
        id: "plan-1",
        name: "Starter",
        active: true,
        quota_limits: { window_hours: 5 },
      },
      remaining: {
        metric: "cost_usd",
        daily_used: 4,
        daily_limit: 10,
        weekly_used: 20,
        weekly_limit: 100,
      },
      resets: {
        daily: "2030-01-02T00:00:00Z",
        weekly: "2030-01-06T00:00:00Z",
      },
    }],
  })
  assert.equal(result.plan, "Starter")
  assert.equal(result.windows.length, 2)
  assert.equal(result.windows[0].used, 40)
  assert.equal(result.windows[0].unit, "USD")
  assert.equal(result.windows[0].resetsAt, "2030-01-02T00:00:00.000Z")
})

test("accepts nested weekly quota fields used by newer AiProxy builds", () => {
  const result = _internal.parseEntitlements({
    plans: [{
      plan: { name: "Nested plan" },
      remaining: {
        metric: "cost_usd",
        weekly: {
          used: 7.5,
          limit: 25,
          resetAt: "2030-01-08T00:00:00Z",
        },
      },
      resets: {},
    }],
  })
  assert.equal(result.windows.length, 1)
  assert.equal(result.windows[0].window, "weekly")
  assert.equal(result.windows[0].used, 30)
  assert.equal(result.windows[0].resetsAt, "2030-01-08T00:00:00.000Z")
})

test("logs in, reads entitlements, and persists the session cookie", async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/auth/login")) {
      return response({ ok: true }, 200, { "set-cookie": "session=abc; Path=/; HttpOnly" })
    }
    if (String(url).endsWith("/user/me")) {
      assert.equal(new Headers(init.headers).get("cookie"), "session=abc")
      return response({ email: "owner@example.test", balance_usd: 12.5 })
    }
    if (String(url).endsWith("/user/entitlements")) {
      assert.equal(new Headers(init.headers).get("cookie"), "session=abc")
      return response({
        plans: [{
          plan: { name: "Starter", active: true },
          remaining: { metric: "requests", daily_used: 3, daily_limit: 10 },
        }],
      })
    }
    throw new Error(`unexpected ${url}`)
  }
  let saved
  const plugin = _internal.createPlugin({
    fetchImpl,
    client: { auth: { set: async ({ body }) => { saved = body } } },
  })
  const result = await plugin.auth.usage(async () => auth())
  assert.equal(result.plan, "Starter")
  assert.equal(result.balance, "$12.50")
  assert.equal(result.windows[0].used, 30)
  assert.equal(calls.filter((item) => item.url.endsWith("/auth/login")).length, 1)
  assert.equal(saved.key, "aiproxy-test-key")
  assert.equal(saved.metadata.cookies, "session=abc")
})

test("authorize returns an API credential without exposing secrets in errors", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/auth/login")) return response({}, 401)
    throw new Error("unexpected")
  }
  const plugin = _internal.createPlugin({ fetchImpl })
  const method = plugin.auth.methods[0]
  const result = await method.authorize({
    baseURL: base,
    apiKey: "k".repeat(8),
    email: "owner@example.test",
    password: "test-password",
  })
  assert.equal(result.type, "failed")
  assert.match(result.error, /登录|会话|重新登录/)
  assert.doesNotMatch(result.error, /k{8}|test-password/)
})

test("offers custom-site password and browser-cookie login methods", async () => {
  const plugin = _internal.createPlugin({ fetchImpl: async () => response({}) })
  assert.equal(plugin.auth.methods.length, 2)
  assert.equal(plugin.provider.name, "AI Proxy")
  assert.match(plugin.auth.methods[0].label, /自定义站点/)
  assert.match(plugin.auth.methods[1].label, /Cookie/)
  assert.equal(plugin.auth.methods.every((method) => method.prompts.some((item) => item.key === "baseURL")), true)
  assert.equal(plugin.auth.methods.every((method) => method.prompts.some((item) => item.key === "protocolOverride")), true)
})

test("manual protocol selection overrides automatic detection", () => {
  assert.equal(_internal.protocolNpm({ metadata: { protocolOverride: "chat", protocols: { responses: true } } }), "@ai-sdk/openai-compatible")
  assert.equal(_internal.protocolNpm({ metadata: { protocolOverride: "responses", protocols: { chat: true } } }), "@ai-sdk/openai")
  assert.equal(_internal.protocolNpm({ metadata: { protocolOverride: "auto", protocols: { responses: true } } }), "@ai-sdk/openai")
})

test("exposes post-login protocol switches", async () => {
  const plugin = _internal.createPlugin({
    fetchImpl: async () => response({ data: [{ id: "gpt-test" }] }),
    magpie: { option: (_provider, key) => key === "force_responses" },
  })
  assert.deepEqual(plugin.auth.options.map((option) => option.key), ["force_chat", "force_responses"])
  const models = await plugin.provider.models({ id: "aiproxy", models: {} }, { auth: auth({ protocols: { chat: true } }) })
  assert.equal(models["gpt-test"].api.npm, "@ai-sdk/openai")
})

test("configures the provider display name as AI Proxy", async () => {
  const plugin = _internal.createPlugin({ fetchImpl: async () => response({}) })
  const cfg = { provider: {} }
  await plugin.config(cfg)
  assert.equal(cfg.provider.aiproxy.name, "AI Proxy")
  assert.equal(cfg.provider.aiproxy.npm, "@ai-sdk/openai-compatible")
})

test("validates public HTTPS and allows local HTTP endpoints", () => {
  assert.equal(_internal.validateBaseURL("https://api.example.com"), undefined)
  assert.match(_internal.validateBaseURL("http://api.example.com"), /HTTPS/)
  assert.equal(_internal.validateBaseURL("http://127.0.0.1:8080"), undefined)
  assert.equal(_internal.validateBaseURL("http://192.168.1.20:8080"), undefined)
  assert.match(_internal.validateBaseURL("https://user:" + "pass" + "@example.com"), /不能包含/)
})

test("browser-cookie login supports a session obtained through 2FA or SSO", async () => {
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), `${base}/api/v1/user/me`)
    assert.equal(new Headers(init.headers).get("cookie"), "session=sso")
    return response({ email: "sso@example.test" })
  }
  const plugin = _internal.createPlugin({ fetchImpl })
  const result = await plugin.auth.methods[1].authorize({
    baseURL: base,
    apiKey: "k".repeat(8),
    cookies: "session=sso",
  })
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "sso@example.test")
  assert.equal(result.metadata.cookies, "session=sso")
})

test("model catalog uses the configured AiProxy API key", async () => {
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), `${base}/v1/models`)
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer aiproxy-test-key")
    return response({ data: [{ id: "gpt-test", name: "GPT Test" }] })
  }
  const plugin = _internal.createPlugin({ fetchImpl })
  const models = await plugin.provider.models({ id: "aiproxy", models: {} }, { auth: auth() })
  assert.equal(models["gpt-test"].providerID, "aiproxy")
  assert.equal(models["gpt-test"].api.url, `${base}/v1`)
})

test("detects Responses without spending a model request", async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith("/v1/models")) return response({ data: [] })
    if (String(url).endsWith("/v1/responses")) return response({}, 401)
    return response({}, 404)
  }
  const protocols = await _internal.detectProtocols(fetchImpl, auth())
  assert.deepEqual(protocols, { chat: true, responses: true })
  assert.equal(calls.some((url) => url.endsWith("/v1/chat/completions")), false)
})

test("caches a short quota read and includes admin upstream windows", async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url))
    const path = new URL(String(url)).pathname
    if (path === "/api/v1/user/me") return response({ email: "admin@example.test", role: "admin", balance_usd: 4 })
    if (path === "/api/v1/user/entitlements") return response({ plans: [] })
    if (path === "/api/v1/admin/quota") {
      return response({
        groups: [{
          accounts: [{
            id: "upstream-1",
            name: "Dingding",
            quota: { windows: [{ name: "Weekly", used_percent: 12, limit: 100, unit: "USD" }] },
          }],
        }],
      })
    }
    throw new Error(`unexpected ${url}`)
  }
  const plugin = _internal.createPlugin({ fetchImpl })
  const getAuth = async () => auth({ cookies: "session=admin" })
  const first = await plugin.auth.usage(getAuth)
  const second = await plugin.auth.usage(getAuth)
  assert.equal(first.windows.at(-1).name, "上游 · Dingding · Weekly")
  assert.equal(second.windows.at(-1).used, 12)
  assert.equal(calls.filter((url) => url.endsWith("/user/me")).length, 1)
  assert.equal(calls.filter((url) => url.endsWith("/admin/quota")).length, 1)
})
