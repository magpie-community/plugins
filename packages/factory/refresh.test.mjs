// magpie's auth.refresh: the sign-in renewed ahead of its end, magpie
// saving what the hook gives. WorkOS rotates the refresh token, so the hook
// and the renewal before a request never spend one twice.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const jwt = (exp) => "h." + Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url") + ".s"
const later = Date.now() + 3_600_000
const NEW = jwt(later)

const due = () => ({
  type: "oauth",
  access: "tok-old",
  refresh: "r-old",
  expires: Date.now() + 60_000,
  accountId: "ada",
  activeOrganizationId: "fac_A",
  region: "",
  premBaseHost: "",
})

// fake WorkOS and Factory: authenticate answers with auth (a Response, or
// the new pair), slowly enough for another caller to come meanwhile
function serve(auth = () => new Response(JSON.stringify({ access_token: NEW, refresh_token: "r-new" }))) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    seen.push({ path: u.pathname, body: String(init?.body ?? "") })
    if (u.pathname.endsWith("/authenticate")) {
      await new Promise((r) => setTimeout(r, 20))
      return auth()
    }
    if (u.pathname.endsWith("/whoami")) return new Response(JSON.stringify({ orgId: "fac_A", region: "" }))
    return new Response("{}", { status: 200 })
  }
  return seen
}

async function plugin(stored) {
  let auth = stored
  const sets = []
  const client = { auth: { set: async ({ body }) => (sets.push(body), (auth = body)) } }
  const hooks = await FactoryAuthPlugin({ client })
  return { hooks, sets, getAuth: async () => auth, now: () => auth }
}

const renewals = (seen) => seen.filter((s) => s.path.endsWith("/authenticate"))

test("renews a sign-in near its end, giving magpie the new tokens to save", async () => {
  const seen = serve()
  const { hooks, sets } = await plugin(due())
  expect(hooks.auth.refreshLead).toBe(3 * 60 * 1000)
  expect(hooks.auth.rotating).toBe(true)
  const got = await hooks.auth.refresh(due(), "factory")
  expect(got).toMatchObject({ access: NEW, refresh: "r-new", expires: Math.floor(later / 1000) * 1000, activeOrganizationId: "fac_A" })
  expect(got.type).toBeUndefined()
  expect(sets).toEqual([]) // magpie saves it, not the hook
  expect(renewals(seen).length).toBe(1)
  expect(renewals(seen)[0].body).toContain("refresh_token=r-old")
})

test("a request's renewal and magpie's share one refresh", async () => {
  const seen = serve()
  const { hooks, getAuth, now } = await plugin(due())
  const l = await hooks.auth.loader(getAuth)
  const [res, got] = await Promise.all([
    l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: "{}" }),
    hooks.auth.refresh(due(), "factory"),
  ])
  expect(res.status).toBe(200)
  expect(renewals(seen).length).toBe(1)
  expect(got).toMatchObject({ access: NEW, refresh: "r-new" })
  expect(now().access).toBe(NEW)
})

test("a request after magpie's renewal, not yet saved, doesn't spend the old refresh token", async () => {
  const seen = serve()
  const { hooks, getAuth } = await plugin(due())
  const got = await hooks.auth.refresh(due(), "factory")
  expect(got.access).toBe(NEW)
  // the store still holds the old pair
  const l = await hooks.auth.loader(getAuth)
  const res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(renewals(seen).length).toBe(1)
  const sent = seen.find((s) => s.path.endsWith("/responses"))
  expect(sent).toBeDefined()
  // and asked again with the old sign-in, it gives what it got
  expect(await hooks.auth.refresh(due(), "factory")).toMatchObject({ access: NEW, refresh: "r-new" })
  expect(renewals(seen).length).toBe(1)
})

test("a refresh token WorkOS refuses is a sign-in expired", async () => {
  serve(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
  const { hooks, sets } = await plugin(due())
  const e = await hooks.auth.refresh(due(), "factory").catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBe("expired")
  expect(e.message).toContain("ada's Factory sign-in has expired")
  expect(sets).toEqual([])
})

test("a passing failure throws plainly, for magpie to try again", async () => {
  serve(() => new Response("busy", { status: 503 }))
  const { hooks } = await plugin(due())
  const e = await hooks.auth.refresh(due(), "factory").catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBeUndefined()
  // and so does a rate limit
  serve(() => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }))
  const r = await hooks.auth.refresh(due(), "factory").catch((e) => e)
  expect(r).toBeInstanceOf(Error)
  expect(r.signIn).toBeUndefined()
})

test("nothing to renew: no refresh token, or an API key", async () => {
  const seen = serve()
  const { hooks } = await plugin(due())
  expect(await hooks.auth.refresh({ ...due(), refresh: "" }, "factory")).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "api", key: "fk-abcdefghij" }, "factory")).toBeUndefined()
  expect(seen).toEqual([])
})
