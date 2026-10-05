// Renewing the JWT with the refresh token, once at a time (Trae spends a
// refresh token once): magpie's auth.refresh, and the check before a
// request.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeGlobalAuthPlugin } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

test("auth.refresh exchanges the refresh token, once for two asking", async () => {
  f = fakeTrae()
  let n = 0
  f.route("POST /cloudide/api/v3/trae/oauth/ExchangeToken", async () => {
    n++
    await Bun.sleep(20)
    return json({ Result: { Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: 2000000000 } })
  })
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  expect(hooks.auth.refreshLead).toBe(10 * 60 * 1000)
  const auth = signedIn({ expires: Date.now() + 60_000 })
  const [x, y] = await Promise.all([hooks.auth.refresh(auth), hooks.auth.refresh(auth)])
  expect(n).toBe(1)
  expect(x).toEqual({ access: "jwt-2", refresh: "r-2", expires: 2000000000 * 1000 })
  expect(y).toEqual(x)
  // asked again with the sign-in from before, it gives the one it got
  expect(await hooks.auth.refresh(auth)).toEqual(x)
  expect(n).toBe(1)
})

test("a refresh token Trae turns away is signIn expired", async () => {
  f = fakeTrae()
  f.route("POST /cloudide/api/v3/trae/oauth/ExchangeToken", () => json({ ResponseMetadata: { Error: { Code: "10101", Message: "refresh token is not matched to the client" } } }, 400))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  const e = await hooks.auth.refresh(signedIn()).catch((e) => e)
  expect(e.signIn).toBe("expired")
  expect(e.message).toContain("not matched")
})

test("a request with a token about to end renews it first and saves it", async () => {
  f = fakeTrae()
  f.route("POST /cloudide/api/v3/trae/oauth/ExchangeToken", () => json({ Result: { Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: Date.now() + 7200_000 } }))
  let auth = null
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    auth = r.headers.get("authorization")
    return sse([["output", { response: "hi" }], ["done", {}]])
  })
  const saved = []
  const hooks = await TraeGlobalAuthPlugin({ client: { auth: { set: async (x) => saved.push(x) } } })
  const opts = await hooks.auth.loader(async () => signedIn({ expires: Date.now() + 30_000 }))
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(200)
  expect(auth).toBe("Cloud-IDE-JWT jwt-2")
  expect(saved[0].body.access).toBe("jwt-2")
})
