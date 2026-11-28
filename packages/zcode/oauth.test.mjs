// A ready poll without an OAuth access token is an error said plainly.
// The poll answers zai.access_token (the OAuth token /api/auth/z/login
// exchanges) beside token (ZCode's session JWT, kept for the gift plans);
// a ready answer carrying only the JWT used to fold into "ZCode sign-in:
// unexpected answer ready". Nothing leaves the machine: fetch is a fake.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})
const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
beforeEach(() => {
  globalThis.fetch = async () => { throw new Error("no network in tests") }
  _internal.routes.clear()
  _internal.blocked.clear()
})

const ok = (data) => Response.json({ code: 0, data })
const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const now = Math.trunc(Date.now() / 1000)

// a poll answer, and what the sign-in asks after one
function serve(route) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const c = { url: new URL(String(url)), body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(c)
    return (await route(c)) ?? new Response("", { status: 404 })
  }
  return calls
}

test("a ready poll with only the session JWT fails plainly, and nothing is exchanged", async () => {
  const calls = serve(({ url }) => {
    const p = url.pathname
    if (p === "/api/v1/oauth/cli/init") return ok({ flow_id: "f1", authorize_url: "https://chat.z.ai/login", poll_interval_sec: 0, expires_at: 0 })
    if (p === "/api/v1/oauth/cli/poll/f1") return ok({ status: "ready", token: jwt(now + 86400), user: { email: "noplan@example.com" } })
  })
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = hooks.auth.methods.find((x) => x.label === "ZCode: Z.ai GLM Coding Plan")
  const r = await (await m.authorize()).callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("the poll answered ready without an OAuth access token")
  expect(calls.some((c) => c.url.pathname === "/api/auth/z/login")).toBe(false)
})
