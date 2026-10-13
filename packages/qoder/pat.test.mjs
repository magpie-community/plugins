// PAT sign-in: exchange a Personal Access Token for a job token, bypassing
// the OAuth device flow. PAT is only offered on the global site (qoder.com),
// not on Qoder CN (which uses device chat directly).
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

async function plugin(auth) {
  let stored = auth
  const client = { auth: { set: async ({ body }) => (stored = body) } }
  const hooks = await QoderAuthPlugin({ client })
  return { hooks, get: async () => stored }
}

test("qoder: PAT auth method is listed", async () => {
  const { hooks } = await plugin(null)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  expect(patMethod).toBeDefined()
  expect(patMethod.type).toBe("oauth")
  expect(patMethod.prompts).toHaveLength(1)
  expect(patMethod.prompts[0].key).toBe("pat")
  expect(patMethod.prompts[0].type).toBe("password")
})

test("qoder-cn: PAT auth method is NOT listed", async () => {
  const client = { auth: { set: async () => {} } }
  const hooks = await QoderCNAuthPlugin({ client })
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  expect(patMethod).toBeUndefined()
})

test("qoder: PAT auth method validates PAT format", async () => {
  const { hooks } = await plugin(null)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  const validate = patMethod.prompts[0].validate
  expect(validate("pt-abc123")).toBeUndefined()
  expect(validate("invalid")).toContain("pt-")
  expect(validate("")).toContain("pt-")
})

test("qoder: PAT sign-in exchanges token and returns credentials", async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    calls.push(u.host + u.pathname)
    if (u.host === "openapi.qoder.sh" && u.pathname === "/api/v1/jobToken/exchange") {
      const body = JSON.parse(init.body)
      expect(body.personal_token).toBe("pt-test123")
      return json({ token: "jt-pat", refresh_token: "jrt-pat", expires_in: 86400000, expires_at: new Date(Date.now() + 86400000).toISOString(), refresh_token_expires_at: new Date(Date.now() + 172800000).toISOString(), refresh_token_expires_in: 172800000 })
    }
    if (u.host === "openapi.qoder.sh" && u.pathname === "/api/v1/userinfo") {
      return json({ id: "user-123", email: "test@example.com", name: "Test User" })
    }
    return new Response("", { status: 500 })
  }
  const { hooks } = await plugin(null)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  const flow = patMethod.authorize({ pat: "pt-test123" })
  expect(flow.url).toContain("account/integrations")
  expect(flow.method).toBe("auto")
  const result = await flow.callback()
  expect(result.type).toBe("success")
  expect(result.access).toBe("jt-pat")
  expect(result.refresh).toBe("jrt-pat")
  expect(result.uid).toBe("user-123")
  expect(result.email).toBe("test@example.com")
  expect(result.patAuth).toBe(true)
  expect(result.pat).toBe("pt-test123")
  expect(result.deviceToken).toBe("")
  expect(result.machineId).toBeTruthy()
  expect(calls).toContain("openapi.qoder.sh/api/v1/jobToken/exchange")
  expect(calls).toContain("openapi.qoder.sh/api/v1/userinfo")
})

test("qoder: PAT sign-in reads alternate response fields", async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/v1/jobToken/exchange") {
      return json({ access_token: "jt-alt", refreshToken: "jrt-alt", expire_time: new Date(Date.now() + 7200_000).toISOString() })
    }
    if (u.pathname === "/api/v1/userinfo") {
      return json({ id: "user-alt", email: "alt@example.com" })
    }
    return new Response("", { status: 500 })
  }
  const { hooks } = await plugin(null)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  const result = await patMethod.authorize({ pat: "pt-alt" }).callback()
  expect(result.access).toBe("jt-alt")
  expect(result.refresh).toBe("jrt-alt")
  expect(result.expires).toBeGreaterThan(Date.now())
  expect(result.expires).toBeLessThanOrEqual(Date.now() + 7200_000)
})

test("qoder: PAT sign-in fails when Qoder refuses the PAT", async () => {
  globalThis.fetch = async () => new Response("Bad request", { status: 400 })
  const { hooks } = await plugin(null)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  const flow = patMethod.authorize({ pat: "pt-bad" })
  const err = await flow.callback().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toContain("refused the PAT")
})

test("qoder: PAT sign-in fails when no user id", async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/v1/jobToken/exchange") return json({ token: "jt-x", refresh_token: "jrt-x", expires_in: 86400000 })
    if (u.pathname === "/api/v1/userinfo") return json({ email: "no-id@example.com" })
    return new Response("", { status: 500 })
  }
  const { hooks } = await plugin(null)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  const flow = patMethod.authorize({ pat: "pt-no-id" })
  const err = await flow.callback().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toContain("user id")
})

test("qoder: PAT re-exchanged when job refresh lapses", async () => {
  let exchangeCount = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/v1/jobToken/exchange") {
      exchangeCount++
      return json({ token: `jt-exchange-${exchangeCount}`, refresh_token: `jrt-exchange-${exchangeCount}`, expires_in: 86400000 })
    }
    if (u.pathname === "/api/v1/userinfo") {
      return json({ id: "user-re", email: "re@example.com" })
    }
    if (u.pathname === "/api/v1/jobToken/refresh") {
      return json({ message: "refresh token expired" }, 401)
    }
    return new Response("", { status: 500 })
  }
  const initial = {
    type: "oauth",
    access: "jt-old",
    refresh: "jrt-old",
    expires: Date.now() - 1000,
    uid: "user-re",
    email: "re@example.com",
    accountId: "re@example.com",
    name: "",
    machineId: "machine-1",
    deviceToken: "",
    deviceRefresh: "",
    patAuth: true,
    pat: "pt-reexchange",
  }
  const { hooks, get } = await plugin(initial)
  const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
  const flow = patMethod.authorize({ pat: "pt-reexchange" })
  const result = await flow.callback()
  expect(result.access).toBe("jt-exchange-1")
  expect(result.pat).toBe("pt-reexchange")
  expect(exchangeCount).toBe(1)
})
