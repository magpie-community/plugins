// PAT sign-in: exchange a Personal Access Token for a job token, bypassing
// the OAuth device flow. Tests the patSignIn function and the auth method.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

const SITES = [
  { name: "qoder", plugin: QoderAuthPlugin, openapi: "openapi.qoder.sh", web: "https://qoder.com" },
  { name: "qoder-cn", plugin: QoderCNAuthPlugin, openapi: "openapi.qoder.com.cn", web: "https://qoder.cn" },
]

async function plugin(site, auth) {
  let stored = auth
  const client = { auth: { set: async ({ body }) => (stored = body) } }
  const hooks = await site.plugin({ client })
  return { hooks, get: async () => stored }
}

for (const site of SITES) {
  test(`${site.name}: PAT auth method is listed`, async () => {
    const { hooks } = await plugin(site, null)
    const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
    expect(patMethod).toBeDefined()
    expect(patMethod.type).toBe("oauth")
    expect(patMethod.prompts).toHaveLength(1)
    expect(patMethod.prompts[0].key).toBe("pat")
    expect(patMethod.prompts[0].type).toBe("text")
  })

  test(`${site.name}: PAT auth method validates PAT format`, async () => {
    const { hooks } = await plugin(site, null)
    const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
    const validate = patMethod.prompts[0].validate
    expect(validate("pt-abc123")).toBeUndefined()
    expect(validate("invalid")).toContain("pt-")
    expect(validate("")).toContain("pt-")
  })

  test(`${site.name}: PAT sign-in exchanges token and returns credentials`, async () => {
    const calls = []
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url))
      calls.push(u.host + u.pathname)
      if (u.host === site.openapi && u.pathname === "/api/v1/jobToken/exchange") {
        const body = JSON.parse(init.body)
        expect(body.personal_token).toBe("pt-test123")
        return json({ token: "jt-pat", refresh_token: "jrt-pat", expires_in: 86400000 })
      }
      if (u.host === site.openapi && u.pathname === "/api/v1/userinfo") {
        return json({ id: "user-123", email: "test@example.com", name: "Test User" })
      }
      return new Response("", { status: 500 })
    }
    const { hooks } = await plugin(site, null)
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
    expect(result.deviceToken).toBe("")
    expect(result.machineId).toBeTruthy()
    expect(calls).toContain(`${site.openapi}/api/v1/jobToken/exchange`)
    expect(calls).toContain(`${site.openapi}/api/v1/userinfo`)
  })

  test(`${site.name}: PAT sign-in fails when exchange returns error`, async () => {
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 })
    const { hooks } = await plugin(site, null)
    const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
    const flow = patMethod.authorize({ pat: "pt-bad" })
    const err = await flow.callback().catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("PAT exchange")
    expect(err.message).toContain("401")
  })

  test(`${site.name}: PAT sign-in fails when no user id`, async () => {
    globalThis.fetch = async (url) => {
      const u = new URL(String(url))
      if (u.pathname === "/api/v1/jobToken/exchange") return json({ token: "jt-x", refresh_token: "jrt-x", expires_in: 86400000 })
      if (u.pathname === "/api/v1/userinfo") return json({ email: "no-id@example.com" })
      return new Response("", { status: 500 })
    }
    const { hooks } = await plugin(site, null)
    const patMethod = hooks.auth.methods.find((m) => m.label?.includes("PAT"))
    const flow = patMethod.authorize({ pat: "pt-no-id" })
    const err = await flow.callback().catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("user id")
  })
}
