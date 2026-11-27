import { afterEach, describe, expect, test } from "bun:test"
import { PackyCodeBalancePlugin } from "./index.mjs"

const TOKEN = "inert-test-system-access-token"
const USER_ID = "123456"
const AUTH = {
  type: "api",
  key: TOKEN,
  metadata: { userId: USER_ID, consoleHost: "www.packyapi.ai" },
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
})

function captureFetch(handler) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return handler(String(input), init)
  }
  return calls
}

describe("PackyAPI account-balance provider", () => {
  test("declares a usage-only provider without replacing user configuration", async () => {
    const hooks = await PackyCodeBalancePlugin()
    const existing = { provider: { "packycode-balance": { name: "My Packy account" } } }
    await hooks.config(existing)
    expect(existing.provider["packycode-balance"].name).toBe("My Packy account")

    const fresh = {}
    await hooks.config(fresh)
    expect(fresh.provider["packycode-balance"]).toEqual({
      name: "PackyAPI account balance",
      models: {},
    })
    expect(hooks.auth.loader).toBeFunction()
    expect(hooks.auth.methods[0].keyless).toBe(true)
  })

  test("validates the system token and user ID at sign-in without persisting a duplicate token", async () => {
    const calls = captureFetch(() => response(200, { success: true, data: { quota: 6_500_000 } }))
    const hooks = await PackyCodeBalancePlugin()
    const method = hooks.auth.methods[0]
    expect(method.prompts.map((prompt) => prompt.key)).toEqual(["consoleHost", "systemAccessToken", "userId"])
    expect(method.prompts[1].type).toBe("password")

    const inputs = { consoleHost: "www.packyapi.ai", systemAccessToken: TOKEN, userId: USER_ID }
    const saved = await method.authorize(inputs)
    expect(saved).toEqual({
      type: "success",
      key: TOKEN,
      metadata: { systemAccessToken: undefined, userId: USER_ID, consoleHost: "www.packyapi.ai" },
    })
    const persisted = JSON.parse(JSON.stringify({ ...inputs, ...saved.metadata }))
    expect(persisted).toEqual({ userId: USER_ID, consoleHost: "www.packyapi.ai" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://www.packyapi.ai/api/user/self")
    expect(calls[0].init.method).toBe("GET")
    expect(calls[0].init.redirect).toBe("error")
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.get("new-api-user")).toBe(USER_ID)
  })

  test("does not save credentials until the account quota is valid", async () => {
    const hooks = await PackyCodeBalancePlugin()
    const method = hooks.auth.methods[0]
    const inputs = { consoleHost: "www.packyapi.ai", systemAccessToken: TOKEN, userId: USER_ID }

    captureFetch(() => response(200, { success: true, data: {} }))
    const missing = await method.authorize(inputs)
    expect(missing.type).toBe("failed")
    expect(missing.error).toContain("invalid account quota")
    expect(missing.error).not.toContain(TOKEN)

    captureFetch(() => response(200, { success: true, data: { quota: -1 } }))
    const negative = await method.authorize(inputs)
    expect(negative.type).toBe("failed")
    expect(negative.error).toContain("negative account quota")
    expect(negative.error).not.toContain(TOKEN)
  })

  test("gives actionable 403 guidance without exposing the response body", async () => {
    captureFetch(() => response(403, { message: `private response ${TOKEN}` }))
    const hooks = await PackyCodeBalancePlugin()
    const denied = await hooks.auth.methods[0].authorize({
      consoleHost: "www.packyapi.ai",
      systemAccessToken: TOKEN,
      userId: USER_ID,
    })

    expect(denied.type).toBe("failed")
    expect(denied.error).toContain("HTTP 403")
    expect(denied.error).toContain("selected host")
    expect(denied.error).toContain("user ID")
    expect(denied.error).toContain("system token")
    expect(denied.error).not.toContain(TOKEN)
  })

  test("reads /api/user/self and converts non-negative account quota to USD", async () => {
    const calls = captureFetch((url) => {
      expect(url).toBe("https://www.packyapi.ai/api/user/self")
      return response(200, {
        success: true,
        message: "",
        data: { quota: 6_500_000, used_quota: 1_000_000, group: "default" },
      })
    })
    const hooks = await PackyCodeBalancePlugin()
    const usage = await hooks.auth.usage(async () => AUTH)
    expect(calls).toHaveLength(1)
    expect(usage.windows).toEqual([{ name: "Account balance", balance: 13, unit: "USD" }])
    expect(usage.error).toBeUndefined()
    expect(usage.user).toBeUndefined()
  })

  test("supports the console host supplied by the user and rejects an invalid host before sending credentials", async () => {
    const calls = captureFetch(() => response(200, { success: true, data: { quota: 500_000 } }))
    const hooks = await PackyCodeBalancePlugin()
    const method = hooks.auth.methods[0]
    const ok = await method.authorize({ consoleHost: "www.packyapi.com", systemAccessToken: TOKEN, userId: USER_ID })
    expect(ok.type).toBe("success")
    expect(calls[0].url).toBe("https://www.packyapi.com/api/user/self")

    calls.length = 0
    const bad = await method.authorize({ consoleHost: "attacker.example", systemAccessToken: TOKEN, userId: USER_ID })
    expect(bad.type).toBe("failed")
    expect(bad.error).not.toContain(TOKEN)
    expect(calls).toHaveLength(0)
  })

  test("does not reinterpret a negative quota as a positive balance", async () => {
    captureFetch(() => response(200, { success: true, data: { quota: -1, used_quota: 10 } }))
    const hooks = await PackyCodeBalancePlugin()
    const usage = await hooks.auth.usage(async () => AUTH)
    expect(usage.windows).toBeUndefined()
    expect(usage.error).toContain("negative account quota")
  })

  test("surfaces HTTP and malformed-quota errors without response bodies or credentials", async () => {
    captureFetch(() => response(401, { message: `rejected ${TOKEN}` }))
    const hooks = await PackyCodeBalancePlugin()
    const denied = await hooks.auth.usage(async () => AUTH)
    expect(denied.signIn).toBe("expired")
    expect(denied.error).toContain("HTTP 401")
    expect(denied.error).not.toContain(TOKEN)

    captureFetch(() => response(200, { success: true, data: { quota: "6500000" } }))
    const malformed = await hooks.auth.usage(async () => AUTH)
    expect(malformed.error).toContain("invalid account quota")
    expect(malformed.windows).toBeUndefined()
  })

  test("keeps server error bodies out of user-facing errors", async () => {
    captureFetch(() => response(500, { message: `private body ${TOKEN}` }))
    const hooks = await PackyCodeBalancePlugin()
    const usage = await hooks.auth.usage(async () => AUTH)
    expect(usage.error).toBe("PackyAPI account endpoint returned HTTP 500.")
    expect(usage.error).not.toContain(TOKEN)
  })
})
