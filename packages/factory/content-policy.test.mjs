// doubl4door (Discord, factory 0.1.34): Claude Code on Factory's Opus got
// 403 "This request was blocked by Factory's usage policy check" with code
// content_policy_rejected, and the plugin's hint spoke of the org's model
// policy and plan. droid 0.245.0 tells this refusal apart by its code (and
// only without an x-factory-upstream-error header) and says the check reads
// the whole conversation. So the plugin says that, and doesn't ask whoami
// for an org and send the same refused conversation again.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { contentRefused, explain } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const messages = "https://api.factory.ai/api/llm/a/v1/messages"
const noOrg = {
  type: "oauth",
  access: "tok",
  refresh: "r",
  expires: Date.now() + 3_600_000,
  accountId: "d@example.com",
  activeOrganizationId: "",
  region: "",
  premBaseHost: "",
}

async function refused(body, headers = {}) {
  const seen = []
  let asked = 0
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    // whoami names no org before the first request, and one after it
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: asked++ ? "fac_K" : "", email: "d@example.com", region: "" }))
    return new Response(body, { status: 403, headers: { "content-type": "application/json", ...headers } })
  }
  let saved = { ...noOrg }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  const req = `{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`
  const res = await l.fetch(messages, { method: "POST", headers: { "content-type": "application/json" }, body: req })
  return { res, text: await res.text(), seen }
}

const policy = (where) =>
  JSON.stringify(
    where === "top"
      ? { code: "content_policy_rejected", detail: "This request was blocked by Factory's usage policy check." }
      : { error: { code: "content_policy_rejected", message: "This request was blocked by Factory's usage policy check." } },
  )

for (const where of ["top", "error"]) {
  test(`a content_policy_rejected 403 (${where}) is said for what it is and not sent again`, async () => {
    const { res, text, seen } = await refused(policy(where))
    expect(res.status).toBe(403)
    expect(seen.filter((p) => p === "/api/llm/a/v1/messages").length).toBe(1)
    expect(seen.filter((p) => p === "/api/cli/whoami").length).toBeLessThan(2)
    expect(text).toContain("content_policy_rejected")
    expect(text).toContain("reads the whole conversation")
    expect(text).not.toContain("model policy")
  })
}

test("any other 403 to an account with no org still asks whoami and tries again", async () => {
  const { seen, text } = await refused(JSON.stringify({ detail: "Forbidden" }))
  expect(seen.filter((p) => p === "/api/cli/whoami").length).toBe(2)
  expect(seen.filter((p) => p === "/api/llm/a/v1/messages").length).toBe(2)
  expect(text).not.toContain("reads the whole conversation")
})

test("the code is Factory's only without an upstream error header", () => {
  const h = (o) => new Headers(o)
  expect(contentRefused(403, policy("top"), h({}))).toBe(true)
  expect(contentRefused(403, policy("top"), h({ "x-factory-upstream-error": "1" }))).toBe(false)
  expect(contentRefused(400, policy("top"), h({}))).toBe(false)
  expect(contentRefused(403, "Forbidden", h({}))).toBe(false)
  expect(contentRefused(403, '{"error":{"code":"permission_denied"}}', h({}))).toBe(false)
  expect(explain(403, policy("error"), h({}))).toContain("start a new session")
  expect(explain(403, policy("error"), h({ "x-factory-upstream-error": "1" }))).toContain("model policy")
})
