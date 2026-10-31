// The sign-in: the console's OIDC walk with PKCE, the password sealed into
// a JWE under the platform's JWKS key, the code exchanged for a token pair.
// Everything runs against a local fake of the console, the IAM login and
// the token endpoint, with a JWKS the fake generates.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { SenseNovaAuthPlugin } from "./index.mjs"
import { fakeSenseNova, json, jwksOf } from "./fake.mjs"

let f
afterEach(() => f?.close())

// the JWKS the fake serves (a real RSA key the seal can encrypt to)
const JWKS_PATH = "/.well-known/jwks.json"
const AUTH_PATH = "/oauth2/auth"
const IAM_PATH = "/iam/authn/v1/auth/nova/login"
const TOKEN_PATH = "/oauth2/token"

// a one-hop authorize: the console's /oauth2/auth answers 302 to a URL that
// carries login_challenge, the walk the plugin follows to it. It sets the
// CSRF/session cookie a real Hydra does on the way out, which the IAM request
// must then carry back — the one thing a jar that lost its URL argument would
// silently drop.
function authRedirect(req) {
  const challenge = 'challenge-abc'
  const state = req.query.get('state')
  authState = state // kept for the IAM answer's callback
  const redirectUri = req.query.get('redirect_uri')
  return new Response(null, {
    status: 302,
    headers: {
      location: redirectUri + '?login_challenge=' + challenge + '&state=' + state,
      'set-cookie': 'hydra_session=csrf-123; Path=/',
    },
  })
}

// IAM accepts the sealed password and answers a redirect to the callback
// that carries the authorization code (and the round-tripped state)
let authState = ''
function iamAccept(req) {
  // the password is sealed: the request body carries is_encrypt true and a
  // 5-segment JWE, never the plaintext
  expect(req.json?.is_encrypt).toBe(true)
  expect(String(req.json?.password ?? '').split('.').length).toBe(5)
  expect(req.json?.challenge).toBe('challenge-abc')
  // the cookie the authorize set on this host comes back on the IAM request
  expect(req.headers.get("cookie") ?? "").toContain("hydra_session=csrf-123")
  // the state the authorize issued, kept from its hop; the callback comes
  // back on the console's own origin, as the real redirect_uri does
  return json({ redirect: f.origin + '/callback?code=auth-code-123&state=' + authState })
}

test("a password is sealed into a JWE and the tokens come back", async () => {
  f = fakeSenseNova()
  f.route("GET " + JWKS_PATH, () => json(jwksOf()))
  f.route("GET " + AUTH_PATH, (r) => authRedirect(r))
  f.route("POST " + IAM_PATH, (r) => iamAccept(r))
  f.route("POST " + TOKEN_PATH, (r) => {
    // the code is exchanged with the PKCE verifier and the client id
    expect(r.form?.grant_type).toBe("authorization_code")
    expect(r.form?.code).toBe("auth-code-123")
    expect(r.form?.code_verifier).toBeTruthy()
    return json({ access_token: "jwt-123", refresh_token: "r-123", expires_in: 10800 })
  })
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = p.auth.methods[0]
  const r = m.authorize({ username: "yiheng13", password: "secret", apiKey: "sk-abc" })
  const out = await r.callback()
  expect(out.type).toBe("success")
  expect(out.access).toBe("jwt-123")
  expect(out.refresh).toBe("r-123")
  expect(out.accountId).toBe("yiheng13")
  // the API key rides along on the account
  expect(out.apiKey).toBe("sk-abc")
})

test("a password the platform refuses is a failed sign-in, its reason kept", async () => {
  f = fakeSenseNova()
  f.route("GET " + JWKS_PATH, () => json(jwksOf()))
  f.route("GET " + AUTH_PATH, (r) => authRedirect(r))
  f.route("POST " + IAM_PATH, () =>
    json({ message: "InvalidArgument", details: [{ "@type": "x", reason: "invalidAccountOrPassword" }] }, 400),
  )
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = p.auth.methods[0]
  const r = m.authorize({ username: "yiheng13", password: "wrong", apiKey: "" })
  const out = await r.callback()
  expect(out.type).toBe("failed")
  expect(out.error).toContain("invalidAccountOrPassword")
})

test("a refresh token is renewed, and the new one replaces the old", async () => {
  f = fakeSenseNova()
  f.route("POST " + TOKEN_PATH, (r) => {
    expect(r.form?.grant_type).toBe("refresh_token")
    expect(r.form?.refresh_token).toBe("old-r")
    // Hydra rotates the refresh token: a new one comes back
    return json({ access_token: "jwt-2", refresh_token: "new-r", expires_in: 10800 })
  })
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const renewed = await p.auth.refresh({ type: "oauth", access: "old", refresh: "old-r", expires: Date.now() + 1000 })
  expect(renewed.access).toBe("jwt-2")
  expect(renewed.refresh).toBe("new-r")
})

test("a refresh token the platform has revoked says the sign-in is gone", async () => {
  f = fakeSenseNova()
  f.route("POST " + TOKEN_PATH, () => json({ error: "invalid_grant" }, 400))
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  // the host only marks an account signed-out on an error that says so
  // (host.js: e?.signIn === "expired"); without it the dead token is retried
  // every RENEW_RETRY (30 s) and the account never asks to be signed in again
  const err = await p
    .auth.refresh({ type: "oauth", access: "old", refresh: "dead", expires: Date.now() + 1000 })
    .then(() => null, (e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.dead).toBe(true)
  expect(err.signIn).toBe("expired")
})

test("a failed refresh that says nothing about the token keeps the sign-in", async () => {
  // a 500, or a 400 naming another problem, is not the token being dead: the
  // pair in hand is still good and the account must not be signed out
  f = fakeSenseNova()
  f.route("POST " + TOKEN_PATH, () => json({ error: "server_error" }, 500))
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  expect(await p.auth.refresh({ type: "oauth", access: "old", refresh: "r", expires: Date.now() + 1000 })).toBeUndefined()
})

test("a walk that leaves the SenseNova hosts is refused, not followed", async () => {
  // the walk carries Hydra session and CSRF cookies: a redirect to another
  // domain must not be fetched, or those cookies go with it
  f = fakeSenseNova()
  f.route("GET " + JWKS_PATH, () => json(jwksOf()))
  f.route("GET " + AUTH_PATH, () =>
    new Response(null, { status: 302, headers: { location: "https://not-sensenova.example/continue" } }),
  )
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await p.auth.methods[0].authorize({ username: "u", password: "p", apiKey: "" }).callback()
  expect(out.type).toBe("failed")
  expect(out.error).toContain("SenseNova hosts")
})

test("a page body pointing off-site is not taken as the next hop", async () => {
  // nextFromBody reads client-side redirects out of a 200 body; an off-site
  // one is dropped, so the walk ends without a challenge rather than leaving
  f = fakeSenseNova()
  f.route("GET " + JWKS_PATH, () => json(jwksOf()))
  f.route("GET " + AUTH_PATH, () =>
    new Response('<script>window.location.href="https://evil.example/?login_challenge=stolen"</script>', {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  )
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await p.auth.methods[0].authorize({ username: "u", password: "p", apiKey: "" }).callback()
  expect(out.type).toBe("failed")
  expect(out.error).toContain("login challenge")
})

test("a hop carrying what the walk seeks, on another domain, is not the answer", async () => {
  // the walk looks for a login_challenge. An off-site URL holding one must not
  // count as found: if what a hop looks like outranked where it points, the
  // session and CSRF cookies would leave with it
  f = fakeSenseNova()
  f.route("GET " + JWKS_PATH, () => json(jwksOf()))
  f.route("GET " + AUTH_PATH, () =>
    new Response(null, { status: 302, headers: { location: "https://evil.example/?login_challenge=stolen&state=x" } }),
  )
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await p.auth.methods[0].authorize({ username: "u", password: "p", apiKey: "" }).callback()
  expect(out.type).toBe("failed")
  expect(out.error).toContain("SenseNova hosts")
})

test("a downgraded http:// hop to a SenseNova domain is refused", async () => {
  // the platform is https only. A plain-http hop would carry the sealed
  // password and the session cookie where any link on the path can read them
  f = fakeSenseNova()
  f.route("GET " + JWKS_PATH, () => json(jwksOf()))
  f.route("GET " + AUTH_PATH, () =>
    new Response(null, { status: 302, headers: { location: "http://platform.sensenova.cn/continue" } }),
  )
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } })
  const out = await p.auth.methods[0].authorize({ username: "u", password: "p", apiKey: "" }).callback()
  expect(out.type).toBe("failed")
  expect(out.error).toContain("SenseNova hosts")
})
