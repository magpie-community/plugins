// A key Command Code turns away marks the account signed out, so magpie
// passes over it and its row offers Sign in again (blue12345655 on
// Discord: a signed-out account stayed "signed in", its card saying only
// "Unauthorized", with no Sign in again). The refusal is Command Code's
// own, as api.commandcode.ai answered an unknown key on every path
// (2026-10-29): 401 {"success":false,"error":{"code":"UNAUTHORIZED",...}}.
// A 401 or 403 whoami still takes (a model, a plan) keeps the account.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
})

const REFUSED = JSON.stringify({
  success: false,
  error: { code: "UNAUTHORIZED", status: 401, message: "Invalid 'Authorization' header or token.", docs: "https://commandcode.ai/docs/reference/errors/unauthorized" },
})
const refused = () => new Response(REFUSED, { status: 401, headers: { "Content-Type": "application/json" } })
const PROVIDER_REFUSED = JSON.stringify({ error: { message: "Invalid 'Authorization' header or token.", type: "authentication_error", code: "UNAUTHORIZED" } })

// serve answers each path with replies[path], a function; whoami as
// whoami says, and anything else 404
function serve(replies, whoami) {
  const seen = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    seen.push(path)
    if (path === "/alpha/whoami") return whoami()
    return replies[path]?.() ?? new Response("", { status: 404 })
  }
  return seen
}

const me = () => Response.json({ user: { userName: "me" } })
const api = { type: "api", key: "revoked-key", metadata: { email: "me", plan: "Pro", planId: "individual-pro" } }

test("usage: a key Command Code refuses everywhere is signed out, in magpie's words", async () => {
  serve({ "/alpha/billing/credits": refused, "/alpha/billing/subscriptions": refused }, refused)
  const u = await (await CommandCodePlugin()).auth.usage(async () => api)
  expect(u).toEqual({ signIn: "expired", error: "Command Code's sign-in has expired; sign in again", windows: [] })
  // magpie's signInGone (internal/provider/plugin_usage.go) reads it so
  expect(/sign-in has (expired|lapsed)|sign in again/i.test(u.error)).toBe(true)
})

test("usage: credits refused while whoami takes the key keeps the account", async () => {
  serve({ "/alpha/billing/credits": () => new Response("", { status: 403 }) }, me)
  const u = await (await CommandCodePlugin()).auth.usage(async () => api)
  expect(u.signIn).toBe("kept")
  expect(u.error).toBe("Forbidden")
})

test("usage: whoami failing another way (a 500) keeps the account", async () => {
  serve({ "/alpha/billing/credits": refused }, () => new Response("", { status: 500 }))
  expect((await (await CommandCodePlugin()).auth.usage(async () => api)).signIn).toBe("kept")
})

test("usage: a clean read takes the mark off, as the CLI signed in again", async () => {
  serve({ "/alpha/billing/credits": () => Response.json({ credits: { monthlyCredits: 10 } }) }, me)
  expect((await (await CommandCodePlugin()).auth.usage(async () => api)).signIn).toBe("renewed")
})

async function ask(plan, path, reply, whoami) {
  const seen = serve({ [path]: reply }, whoami)
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "revoked-key", metadata: { plan } }))
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
  })
  return { status: res.status, signIn: res.headers.get("X-Magpie-Sign-In"), body: await res.text(), seen }
}

test("a request: the Provider API's 401 for a key whoami refuses says expired, the answer as it came", async () => {
  const r = await ask("Pro", "/provider/v1/chat/completions", () => new Response(PROVIDER_REFUSED, { status: 401 }), refused)
  expect(r.status).toBe(401)
  expect(r.signIn).toBe("expired")
  expect(r.body).toBe(PROVIDER_REFUSED)
})

test("a request: Go's 401 for a key whoami refuses says expired", async () => {
  const r = await ask("Go", "/alpha/generate", refused, refused)
  expect(r).toMatchObject({ status: 401, signIn: "expired" })
})

test("a request: a 401 whoami doesn't confirm keeps the account", async () => {
  const r = await ask("Pro", "/provider/v1/chat/completions", () => new Response(PROVIDER_REFUSED, { status: 401 }), me)
  expect(r).toMatchObject({ status: 401, signIn: "kept" })
})

test("a request: a model the plan lacks (403) keeps the account, and whoami isn't asked", async () => {
  const body = JSON.stringify({ error: { message: "MODEL_NOT_IN_PLAN: Claude Opus 5.5 available in Provider and above plans" } })
  const r = await ask("Pro", "/provider/v1/chat/completions", () => new Response(body, { status: 403 }), refused)
  expect(r).toMatchObject({ status: 403, signIn: "kept" })
  expect(r.seen).not.toContain("/alpha/whoami")
})

test("a request that goes through keeps the account, and whoami isn't asked", async () => {
  const r = await ask("Pro", "/provider/v1/chat/completions", () => Response.json({}), refused)
  expect(r).toMatchObject({ status: 200, signIn: "kept" })
  expect(r.seen).not.toContain("/alpha/whoami")
})
