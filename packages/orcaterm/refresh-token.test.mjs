// #675 (orinsid, 2026-11-04): OrcaTerm's desktop client keeps a long-lived
// refresh token (oauth_refresh_token_v2) and renews from it, while the
// plugin threw the exchange's refresh token away and renewed from the
// two-hour access token, which OrcaTerm stops renewing once its web session
// is gone. The client's own bundle sends client "desktop" to
// /oauth/wechat/exchange, keeps data.refreshToken when its jti prefix is the
// access token's jti, and calls OAuthRefreshToken with {refreshToken} when it
// has one, {accessToken} otherwise.
import { test, afterEach } from "bun:test"
import assert from "node:assert/strict"
import { OrcaTermAuthPlugin } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const json = data => Response.json({ code: 0, data })
const JTI = "0d4c2f7e-9b1a-4c3d-8e5f-6a7b8c9d0e1f"
const tail = "A".repeat(43)
// One expiry for the whole file: a default read from the clock on each call
// made two tokens for the same jti differ across a second boundary (CI
// run 41774409142).
const LATER = Math.floor(Date.now() / 1000) + 7200
const access = (jti, exp = LATER) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ userId: "u1", jti, exp })).toString("base64url")}.test`
const refreshOf = (jti, n = 1) => `${jti}.${n}.${tail}`

async function scan(data, seen) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/oauth/wechat/config")) return json({
      appid: "rt-test", redirect_uri: "https://orcaterm.com/oauth/wechat/bridge",
      state: "rt-state", scope: "snsapi_login",
    })
    assert.ok(String(url).endsWith("/oauth/wechat/exchange"))
    seen.push(JSON.parse(init.body))
    return json(data)
  }
  const plugin = await OrcaTermAuthPlugin()
  const flow = await plugin.auth.methods[0].authorize()
  try {
    const res = await realFetch(new URL("/cb", flow.url), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(flow.url).origin, connection: "close" },
      body: JSON.stringify({ code: "c", state: "rt-state", error: null }),
    })
    assert.equal(res.status, 200)
    return await flow.callback()
  } finally { flow.__cap.close() }
}

test("QR sign-in asks for the desktop client's refresh token and keeps it as the sign-in's refresh", async () => {
  const seen = []
  const r = await scan({ userId: "u1", providerUsername: "A", accessToken: access(JTI), refreshToken: refreshOf(JTI), expiresIn: 7200 }, seen)
  assert.equal(r.type, "success")
  assert.equal(seen[0].client, "desktop")
  assert.equal(r.refresh, refreshOf(JTI))
  assert.equal(r.access, access(JTI))
})

test("a refresh token issued with another access token, or none, isn't kept", async () => {
  for (const refreshToken of [refreshOf("11111111-2222-3333-4444-555555555555"), "not-a-token", undefined]) {
    const r = await scan({ userId: "u1", providerUsername: "A", accessToken: access(JTI), refreshToken, expiresIn: 7200 }, [])
    assert.equal(r.type, "success")
    assert.equal(r.refresh, r.access)
  }
})

async function renew(stored, reply) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://orcaterm.com/cgi/api?action=OAuthRefreshToken")
    sent.push(JSON.parse(init.body).data)
    return json(reply)
  }
  const plugin = await OrcaTermAuthPlugin()
  return { next: await plugin.auth.refresh(stored), sent }
}

test("renewal sends the refresh token, not the access token, and keeps the one the reply rotates to", async () => {
  const next2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  const { next, sent } = await renew(
    { type: "oauth", access: access(JTI), refresh: refreshOf(JTI), expires: Date.now() + 60e3 },
    { AccessToken: access(next2), RefreshToken: refreshOf(next2, 2), ExpiresIn: 7200 },
  )
  assert.deepEqual(sent, [{ refreshToken: refreshOf(JTI) }])
  assert.equal(next.access, access(next2))
  assert.equal(next.refresh, refreshOf(next2, 2))
})

test("a reply with no refresh token keeps the one the sign-in has", async () => {
  const { next } = await renew(
    { type: "oauth", access: access(JTI), refresh: refreshOf(JTI), expires: Date.now() + 60e3 },
    { accessToken: access("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), expiresIn: 7200 },
  )
  assert.equal(next.refresh, refreshOf(JTI))
})

test("an access token past its expiry still renews from the refresh token", async () => {
  const old = access(JTI, Math.floor(Date.now() / 1000) - 3600)
  const { next, sent } = await renew(
    { type: "oauth", access: old, refresh: refreshOf(JTI), expires: Date.now() - 3600e3 },
    { accessToken: access("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), expiresIn: 7200 },
  )
  assert.deepEqual(sent, [{ refreshToken: refreshOf(JTI) }])
  assert.ok(next?.access)
})

test("a sign-in from before 0.1.6 renews from its access token as it did", async () => {
  const before = access(JTI)
  const { next, sent } = await renew(
    { type: "oauth", access: before, refresh: before, expires: Date.now() + 60e3 },
    { accessToken: access("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), expiresIn: 7200 },
  )
  assert.deepEqual(sent, [{ accessToken: before }])
  assert.equal(next.refresh, next.access)
})
