// provider.models says what the built-in's model list did to the account's
// mark (internal/provider/zed.go zedFetchModels): Zed refusing the sign-in
// while the list is read marked it lapsed; anything else left it alone.
import { afterEach, expect, test } from "bun:test"
import { ZedAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
  _internal.lists.clear()
})

let n = 0
const auth = () => ({
  type: "oauth",
  access: "plain-access-" + ++n,
  refresh: JSON.stringify({ userId: String(5000 + n), systemId: "", org: "org-me", plan: "zed_pro" }),
  expires: 0,
  accountId: "octo",
})

const list = JSON.stringify({ models: [{ provider: "anthropic", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_token_count: 1000, max_output_tokens: 100 }] })

async function models(a, route) {
  const seen = []
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    return route(u.pathname)
  }
  const hooks = await ZedAuthPlugin({})
  return { run: () => hooks.provider.models({ models: { declared: {} } }, { auth: a }), seen }
}

test("the model token refused: the sign-in expired, as zedLapse marked it", async () => {
  const { run, seen } = await models(auth(), () => new Response("unauthorized", { status: 401 }))
  const err = await run().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.signIn).toBe("expired")
  expect(err.message).toContain("the Zed sign-in has expired")
  expect(seen).toEqual(["/client/llm_tokens"])
})

test("the list refused with the token just minted: no word on the sign-in, and no list", async () => {
  // a stale token is minted again once; /models refusing both is no word on
  // the account's own sign-in, which the built-in left unmarked. The
  // declared models aren't handed back as the account's (#229)
  const { run, seen } = await models(auth(), (p) =>
    p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response("nope", { status: 401 }),
  )
  const err = await run().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.signIn).toBeUndefined()
  expect(err.message).toContain("(401)")
  expect(seen).toEqual(["/client/llm_tokens", "/models", "/client/llm_tokens", "/models"])
})

test("Zed down before any list: the failure, not the declared models", async () => {
  const { run } = await models(auth(), () => new Response("bad gateway", { status: 502 }))
  const err = await run().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.signIn).toBeUndefined()
  expect(err.message).toContain("bad gateway")
})

// #229 (ReneXiong): an organization without an active subscription gets a
// 200 whose models are all disabled. The plugin handed back the six
// declared before sign-in, with their limits, and a host judging by the
// 200 showed them as the account's list with no error
test("a 200 listing nothing callable: says so, not the declared models", async () => {
  const off = JSON.stringify({ models: [{ provider: "anthropic", id: "claude-sonnet-5", is_disabled: true, max_token_count: 1000, max_output_tokens: 100 }] })
  const { run } = await models(auth(), (p) => (p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response(off)))
  const err = await run().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toContain("Zed lists no models for this account")
})

test("Zed down after a list was read: the list read last", async () => {
  const a = auth()
  let down = false
  const { run } = await models(a, (p) => {
    if (down) return new Response("bad gateway", { status: 502 })
    return p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response(list)
  })
  expect(Object.keys(await run())).toEqual(["claude-sonnet-5"])
  const uid = JSON.parse(a.refresh).userId
  _internal.lists.set(uid, { at: 0, models: _internal.lists.get(uid).models })
  down = true
  expect(Object.keys(await run())).toEqual(["claude-sonnet-5"])
})

test("a list read: the account's models", async () => {
  const { run } = await models(auth(), (p) => (p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response(list)))
  expect(Object.keys(await run())).toEqual(["claude-sonnet-5"])
})

test("refused after a list was read: still says expired", async () => {
  const a = auth()
  let refuse = false
  const { run } = await models(a, (p) => {
    if (refuse) return new Response("unauthorized", { status: 401 })
    return p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response(list)
  })
  expect(Object.keys(await run())).toEqual(["claude-sonnet-5"])
  // the list goes stale and the token with it
  const uid = JSON.parse(a.refresh).userId
  _internal.lists.set(uid, { at: 0, models: _internal.lists.get(uid).models })
  _internal.tokens.clear()
  refuse = true
  const err = await run().catch((e) => e)
  expect(err.signIn).toBe("expired")
})
