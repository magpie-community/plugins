// An account whose sign-in Factory won't renew answers as the built-in's
// does: magpie's 502 in the shape of the API the request was for, not a
// throw, with X-Magpie-Sign-In: expired so magpie marks the account lapsed
// as factoryLapse did. Factory's own answers leave the mark as the built-in
// did: only a renewal takes it off.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const expired = {
  type: "oauth",
  access: "tok-old",
  refresh: "r-old",
  expires: Date.now() - 1000,
  accountId: "ada",
  activeOrganizationId: "fac_A",
  region: "",
  premBaseHost: "",
}

async function loaded() {
  const seen = []
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    if (u.pathname.endsWith("/authenticate")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    return new Response("upstream reached", { status: 500 })
  }
  let auth = { ...expired }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await FactoryAuthPlugin({ client })
  const l = await hooks.auth.loader(async () => auth)
  return { l, seen }
}

test("a refused renewal is Anthropic's 502 on /llm/a/, marking the account", async () => {
  const { l, seen } = await loaded()
  const res = await l.fetch("https://api.factory.ai/api/llm/a/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-x" }) })
  expect(res.status).toBe(502)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  const b = await res.json()
  expect(b.type).toBe("error")
  expect(b.error.type).toBe("api_error")
  expect(b.error.message).toBe("ada's Factory sign-in has expired — sign in again (Factory: invalid_grant)")
  expect(seen.some((p) => p.includes("/llm/"))).toBe(false)
})

test("and OpenAI's on /llm/o/", async () => {
  const { l } = await loaded()
  const res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })
  expect(res.status).toBe(502)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  const b = await res.json()
  expect(b.error.type).toBe("api_error")
  expect(b.error.code).toBe(null)
  expect(b.type).toBeUndefined()
})

test("a refusal says what to do after an em dash, as the built-in's Explain joins it", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "model not allowed" } }), { status: 403 })
  const auth = { ...expired, access: "tok", expires: Date.now() + 3_600_000 }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  let res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })
  expect(res.status).toBe(403)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toMatch(/^model not allowed — Factory refused the request\. /)
  globalThis.fetch = async () => new Response("", { status: 403 })
  res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })
  expect((await res.json()).error.message).toMatch(/^403 Forbidden — Factory refused the request\./)
})

// a live account whose requests fetch answers with serve
async function live(serve, auth = { ...expired, access: "tok", expires: Date.now() + 3_600_000 }) {
  globalThis.fetch = async (url) => serve(new URL(String(url)).pathname)
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (auth = body) } } })
  return hooks.auth.loader(async () => auth)
}
const ask = (l) => l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })

test("Factory's own 401 goes through as it is, leaving the account unmarked", async () => {
  const l = await live(() => new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 }))
  const res = await ask(l)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("bad token")
})

test("a success takes the mark off only after a renewal", async () => {
  let l = await live(() => new Response("{}", { status: 200 }))
  let res = await ask(l)
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  l = await live((path) => (path.endsWith("/authenticate") ? new Response(JSON.stringify({ access_token: "tok-new" })) : new Response("{}", { status: 200 })), { ...expired })
  res = await ask(l)
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a failure after a renewal still takes the mark off, as factoryFresh did before the request", async () => {
  const l = await live((path) => (path.endsWith("/authenticate") ? new Response(JSON.stringify({ access_token: "tok-new" })) : new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 })), { ...expired })
  const res = await ask(l)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a renewal WorkOS fails without refusing it is magpie's 502 for the throw, in Go's words, the account unmarked", async () => {
  const l = await live((path) => (path.endsWith("/authenticate") ? new Response("", { status: 500 }) : new Response("{}")), { ...expired })
  await expect(ask(l)).rejects.toThrow(/^Factory sign-in: Internal Server Error$/)
})

test("while the token still runs, a renewal that fails goes on with it", async () => {
  const l = await live(
    (path) => (path.endsWith("/authenticate") ? new Response("", { status: 503 }) : new Response("{}")),
    { ...expired, access: "tok", expires: Date.now() + 60_000 },
  )
  const res = await ask(l)
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})
