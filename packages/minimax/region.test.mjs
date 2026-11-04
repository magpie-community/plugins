// A request from a mainland-China network to the international site:
// Akamai answers agent.minimax.io with a 307 to agent.minimaxi.com, whose
// China site turns the international token away (hetingyi, #666). The
// redirect is never followed: the account card, the check-in, the chats and
// the models say where it went and what to do, never that the sign-in was
// refused, and no refresh token is spent on it. The 307s here are the
// reporter's: their status, Location and X-From.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "a@example.com" }

// Akamai's answer from a mainland-China egress (#666's table)
const toChina = (r) => new Response(null, {
  status: 307,
  headers: { Location: "https://agent.minimaxi.com" + r.url.replace(/\?.*$/, ""), "X-From": "ak", "Set-Cookie": "_abck=0~-1~-1~-1; Domain=.minimax.io; Path=/" },
})

function chinaEgress(f) {
  for (const k of [
    "GET /v1/api/user/info",
    "POST /matrix/api/v1/user/get_user_extra_info",
    "POST /matrix/api/v1/commerce/get_membership_info",
    "GET /minimax-cloud/api/v1/signin/status",
    "GET /minimax-cloud/api/v1/credit/details",
    "POST /mavis/api/v1/llm/v1/messages",
    "GET /mavis/api/v1/models",
  ]) f.route(k, toChina)
  f.route("POST /oauth2/token", () => {
    throw new Error("a refresh was spent on a redirect")
  })
}

const china = /agent\.minimaxi\.com/

test("the account card says the request went to the China site, not that the sign-in was refused", async () => {
  f = fakeMiniMax()
  chinaEgress(f)
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toMatch(china)
  expect(u.error).toMatch(/proxy outside mainland China/)
  // The fake listens on a random port, so 401 counts only as a word: a port
  // like 40199 in the message is not a 401 (CI red at aaacefde).
  expect(u.error).not.toMatch(/refused|\b401\b/)
  expect(u.signIn).toBe("kept")
  expect(f.seen.some((r) => r.path === "/oauth2/token")).toBe(false)
})

test("the check-in fails with the reason and spends no refresh", async () => {
  f = fakeMiniMax()
  chinaEgress(f)
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: { auth: { set: async () => {} } } })
  const c = await hooks.auth.checkin(async () => ({ ...auth, realUserID: "u-42" }))
  expect(c.outcome).toBe("failed")
  expect(c.message).toMatch(/^check-in: .* sent the request on to agent\.minimaxi\.com \(HTTP 307\)/)
  expect(c.signIn).toBeUndefined()
  expect(f.seen.some((r) => r.path === "/oauth2/token")).toBe(false)
})

test("a chat is a 502 that names the redirect, the sign-in kept", async () => {
  f = fakeMiniMax()
  chinaEgress(f)
  const opts = await (await MiniMaxCodeGlobalAuthPlugin({ client: {} })).auth.loader(async () => auth)
  const res = await opts.fetch(opts.baseURL + "/messages", { method: "POST", body: '{"model":"MiniMax-M3","max_tokens":1,"messages":[]}' })
  expect(res.status).toBe(502)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const e = (await res.json()).error
  expect(e.type).toBe("api_error")
  expect(e.message).toMatch(china)
  // sent once: the 401 path (refresh, send again) wasn't taken
  expect(f.seen.filter((r) => r.path.endsWith("/messages")).length).toBe(1)
  expect(f.seen.some((r) => r.path === "/oauth2/token")).toBe(false)
})

test("the models fall back to the list", async () => {
  f = fakeMiniMax()
  chinaEgress(f)
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const listed = { "MiniMax-M3": { id: "MiniMax-M3" } }
  expect(await hooks.provider.models({ models: listed }, { auth })).toBe(listed)
})

test("a refresh sent on to the other site keeps the sign-in", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => new Response(null, { status: 307, headers: { Location: "https://account.minimaxi.com/oauth2/token" } }))
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const e = await hooks.auth.refresh({ ...auth, refresh: "r2" }).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.message).toMatch(/account\.minimaxi\.com/)
  expect(e.signIn).toBeUndefined()
})

test("a redirect on the same host is followed", async () => {
  f = fakeMiniMax()
  f.route("GET /v1/api/user/info", (r) => new Response(null, { status: 302, headers: { Location: "/v1/api/user/info2" + r.url.slice(r.path.length) } }))
  f.route("GET /v1/api/user/info2", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "a@example.com" } } }))
  f.route("POST /matrix/api/v1/user/get_user_extra_info", () => json({ statusInfo: { code: 0 }, data: { workspaces: [] } }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.user).toBe("a@example.com")
})
