// magpie's "Import accounts from a file…" (auth.import) takes Kiro sign-ins
// made elsewhere, by their refresh token: Kiro Account Manager's list
// ([{ email, refreshToken, provider }]) and export, kiro2api's, the Kiro
// IDE's kiro-auth-token.json with its client, kiro-cli's tokens. Each is
// renewed the way its kind is (Kiro's auth service for Google and GitHub,
// AWS's OIDC for Builder ID and Identity Center) and kept as the browser
// sign-in keeps it.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read or written
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = offline))

const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const SOCIAL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
const OIDC = (region) => `https://oidc.${region}.amazonaws.com/token`

// kiro renews every refresh token but the refused ones, and names each
// account by the email given for its token in emails (none: Kiro's usage
// read fails, as whoIs then names nothing)
function kiro({ emails = {}, refused = [] } = {}) {
  const seen = { social: [], oidc: [], usage: [] }
  let n = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === SOCIAL || u.startsWith("https://oidc.")) {
      const body = JSON.parse(init.body)
      ;(u === SOCIAL ? seen.social : seen.oidc).push({ url: u, body, ua: new Headers(init.headers).get("User-Agent") })
      if (refused.includes(body.refreshToken)) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      const access = "a" + ++n + ":" + body.refreshToken
      return Response.json({ accessToken: access, refreshToken: "next-" + body.refreshToken, expiresIn: 3600, ...(u === SOCIAL ? { profileArn: PROFILE } : {}) })
    }
    if (u.startsWith("https://management.")) {
      const token = new Headers(init.headers).get("Authorization").replace("Bearer ", "")
      seen.usage.push({ url: u, token })
      const email = emails[token.split(":").slice(1).join(":")] ?? emails[token]
      if (u.includes("/List-Available-Profiles")) return Response.json({ profiles: [{ arn: PROFILE }] })
      if (!email) return new Response(JSON.stringify({ message: "boom" }), { status: 500 })
      return Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO PRO" }, userInfo: { email } })
    }
    throw new Error("unexpected request to " + u)
  }
  return seen
}
const hooks = () => plugin({ client: { auth: { set: async () => {} } } })
const importing = async (...texts) => (await hooks()).auth.import(texts.map((t) => (typeof t === "string" ? t : JSON.stringify(t))))

test("magpie offers the import, saying what it takes in each language", async () => {
  const h = await hooks()
  expect(typeof h.auth.import).toBe("function")
  expect(h.auth.importFrom).toContain("refreshToken")
  for (const lang of ["zh", "zh-TW", "ja", "de"]) expect(h.auth.importFroms[lang]).toContain("refreshToken")
})

test("Kiro Account Manager's list of Google sign-ins: renewed in us-east-1 and kept as the browser sign-in keeps them", async () => {
  const seen = kiro({ emails: { r1: "billrodrigo0@gmail.com", r2: "other@gmail.com" } })
  const got = await importing([
    { email: "billrodrigo0@gmail.com", refreshToken: "r1", provider: "Google" },
    { email: "other@gmail.com", refreshToken: "r2", provider: "Google" },
  ])
  expect(seen.social.map((s) => s.body)).toEqual([{ refreshToken: "r1" }, { refreshToken: "r2" }])
  expect(seen.social[0].ua).toBe("Kiro-Desktop/0.2.13 (darwin; arm64)")
  expect(got).toEqual([
    { type: "success", provider: "kiro", refresh: "next-r1", access: expect.stringContaining(":r1"), expires: expect.any(Number),
      accountId: "billrodrigo0@gmail.com (Google)", uid: "google", method: "social", loginProvider: "Google", region: "us-east-1",
      profileArn: PROFILE, plan: "Kiro Pro" },
    expect.objectContaining({ type: "success", accountId: "other@gmail.com (Google)", refresh: "next-r2" }),
  ])
  expect(got[0].expires).toBeGreaterThan(Date.now() + 50 * 60_000)
})

test("the email Kiro has for the sign-in names it, the file's only when Kiro names none", async () => {
  kiro({ emails: { r1: "real@example.com" } })
  const [a, b] = await importing([
    { email: "typo@example.com", refreshToken: "r1", provider: "Google" },
    { email: "kept@example.com", refreshToken: "r2", provider: "Github" },
  ])
  expect(a.accountId).toBe("real@example.com (Google)")
  expect(b).toMatchObject({ type: "success", accountId: "kept@example.com (GitHub)", uid: "github", loginProvider: "Github", method: "social" })
})

test("Builder ID and Identity Center are renewed with their client at AWS, in their region", async () => {
  const seen = kiro({ emails: { r1: "b@example.com", r2: "e@example.com" } })
  const [b, e] = await importing([
    { refreshToken: "r1", clientId: "c1", clientSecret: "s1", provider: "BuilderId" },
    { refreshToken: "r2", clientId: "c2", clientSecret: "s2", provider: "Enterprise", region: "eu-central-1" },
  ])
  expect(seen.social).toEqual([])
  expect(seen.oidc.map((s) => [s.url, s.body])).toEqual([
    [OIDC("us-east-1"), { clientId: "c1", clientSecret: "s1", refreshToken: "r1", grantType: "refresh_token" }],
    [OIDC("eu-central-1"), { clientId: "c2", clientSecret: "s2", refreshToken: "r2", grantType: "refresh_token" }],
  ])
  expect(b).toMatchObject({ type: "success", accountId: "b@example.com (Builder ID)", uid: "builderid", method: "idc", loginProvider: "BuilderId",
    region: "us-east-1", profileArn: BUILDER_ID_PROFILE, clientId: "c1", clientSecret: "s1", refresh: "next-r1" })
  expect(e).toMatchObject({ type: "success", accountId: "e@example.com (IAM Identity Center)", uid: "enterprise", method: "idc",
    loginProvider: "Enterprise", region: "eu-central-1", profileArn: PROFILE, clientId: "c2", clientSecret: "s2" })
})

test("the Kiro IDE's kiro-auth-token.json goes with its client's file", async () => {
  const seen = kiro({ emails: { r1: "ide@example.com" } })
  const token = { accessToken: "old", refreshToken: "r1", expiresAt: "2020-01-01T00:00:00.000Z", authMethod: "IdC", provider: "BuilderId", clientIdHash: "abc", region: "us-east-1" }
  const [got] = await importing(token, { clientId: "c1", clientSecret: "s1", expiresAt: "2099-01-01T00:00:00.000Z" })
  expect(seen.oidc[0].body).toMatchObject({ clientId: "c1", clientSecret: "s1", refreshToken: "r1" })
  expect(got).toMatchObject({ type: "success", accountId: "ide@example.com (Builder ID)", clientId: "c1" })
  // without it, it can't be renewed, and says what is missing
  const [alone] = await importing(token)
  expect(alone.type).toBe("failed")
  expect(alone.error).toContain("clientId and clientSecret")
})

test("Kiro Account Manager's export keeps the tokens under credentials, the email beside them", async () => {
  kiro({ emails: { r1: "kam@example.com" } })
  const [got] = await importing({ version: "1.8", accounts: [{ email: "kam@example.com", provider: "Google", credentials: { refreshToken: "r1", authMethod: "social", region: "us-east-1" } }] })
  expect(got).toMatchObject({ type: "success", accountId: "kam@example.com (Google)", method: "social" })
})

test("kiro2api's Social and IdC, and kiro-cli's tokens, are read too", async () => {
  const seen = kiro({ emails: { r1: "s@example.com", r2: "i@example.com", r3: "cli@example.com" } })
  const got = await importing(
    [{ auth: "Social", refreshToken: "r1" }, { auth: "IdC", refreshToken: "r2", clientId: "c2", clientSecret: "s2" }],
    { access_token: "old", refresh_token: "r3", expires_at: "2020-01-01T00:00:00.000000Z", provider: "google", profile_arn: PROFILE },
  )
  expect(seen.social.map((s) => s.body.refreshToken)).toEqual(["r1", "r3"])
  expect(seen.oidc.map((s) => s.body.refreshToken)).toEqual(["r2"])
  expect(got.map((r) => r.accountId)).toEqual(["s@example.com", "i@example.com", "cli@example.com (Google)"])
  expect(got.every((r) => r.type === "success")).toBe(true)
})

test("kiro-cli's AWS sign-in, with its start URL and its client apart, is renewed at AWS", async () => {
  const seen = kiro({ emails: { r1: "cli@example.com" } })
  const [got] = await importing(
    { access_token: "old", refresh_token: "r1", expires_at: "2020-01-01T00:00:00Z", region: "us-east-1", start_url: "https://view.awsapps.com/start", scopes: ["codewhisperer:completions"] },
    { client_id: "c1", client_secret: "s1", region: "us-east-1" },
  )
  expect(seen.social).toEqual([])
  expect(seen.oidc[0].body).toMatchObject({ clientId: "c1", clientSecret: "s1", refreshToken: "r1" })
  expect(got).toMatchObject({ type: "success", method: "idc", loginProvider: "BuilderId", accountId: "cli@example.com (Builder ID)" })
})

test("from a sign-in store, only Kiro's entries are taken: no other provider's token is sent to Kiro", async () => {
  const seen = kiro({ emails: { r1: "k@example.com" } })
  const store = {
    kiro: { type: "oauth", access: "old", refresh: "r1", expires: 1, method: "social", loginProvider: "Google", accountId: "k@example.com (Google)" },
    openai: { type: "oauth", access: "OPENAI_ACCESS", refresh: "OPENAI_REFRESH", expires: Date.now() + 3600_000, accountId: "o@example.com" },
    "grok#ab12cd": { type: "oauth", access: "x", refresh: "GROK_REFRESH", expires: 1 },
  }
  const got = await importing(store)
  expect(got.map((r) => r.accountId)).toEqual(["k@example.com (Google)"])
  expect(seen.social.map((s) => s.body.refreshToken)).toEqual(["r1"])
  expect(seen.usage.every((u) => !u.token.includes("OPENAI"))).toBe(true)
})

test("accounts Kiro names no one for stay apart, each called by its own token", async () => {
  kiro()
  const [a, b] = await importing([{ auth: "Social", refreshToken: "t1" }, { auth: "Social", refreshToken: "t2" }])
  expect(a.type).toBe("success")
  expect(a.accountId).toMatch(/^Kiro account [0-9a-f]{8}$/)
  expect(b.accountId).toMatch(/^Kiro account [0-9a-f]{8}$/)
  expect(a.accountId).not.toBe(b.accountId)
})

test("an access token with time left is kept, not renewed, as the Kiro IDE keeps it", async () => {
  const seen = kiro({ emails: { live: "live@example.com" } })
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const [got] = await importing({ accessToken: "live", refreshToken: "r1", expiresAt, provider: "Google", profileArn: PROFILE })
  expect(seen.social).toEqual([])
  expect(got).toMatchObject({ type: "success", access: "live", refresh: "r1", accountId: "live@example.com (Google)" })
})

test("a refresh token Kiro refuses is a failure naming the account, the others still imported", async () => {
  kiro({ emails: { r2: "ok@example.com" }, refused: ["r1"] })
  const [bad, good] = await importing([
    { email: "gone@example.com", refreshToken: "r1", provider: "Google" },
    { email: "ok@example.com", refreshToken: "r2", provider: "Google" },
  ])
  expect(bad).toEqual({ type: "failed", accountId: "gone@example.com (Google)", error: expect.stringContaining("Kiro refused its refresh token") })
  expect(good).toMatchObject({ type: "success", accountId: "ok@example.com (Google)" })
})

test("one sign-in twice is renewed once", async () => {
  const seen = kiro({ emails: { r1: "a@example.com" } })
  const got = await importing([{ refreshToken: "r1", provider: "Google" }], [{ refreshToken: "r1", provider: "Google" }])
  expect(seen.social.length).toBe(1)
  expect(got.length).toBe(1)
})

test("what isn't a sign-in Kiro has is said, asking Kiro nothing", async () => {
  const seen = kiro()
  const got = await importing("not json", { hello: "world" }, [{ refreshToken: "r1", provider: "Facebook" }],
    [{ refreshToken: "r2", provider: "Enterprise" }], [{ refreshToken: "r3", provider: "ExternalIdp" }], [{ refreshToken: "r4", clientId: "c", clientSecret: "s", provider: "Enterprise", region: "moon" }])
  expect(got.map((r) => r.type)).toEqual(["failed", "failed", "failed", "failed", "failed", "failed"])
  expect(got[0].error).toBe("not JSON")
  expect(got[1].error).toContain("no Kiro sign-in")
  expect(got[2].error).toContain("Facebook")
  expect(got[3].error).toContain("clientId and clientSecret")
  expect(got[4].error).toContain("kiro-cli login")
  expect(got[5].error).toContain("isn't an AWS region")
  expect(seen.social.length + seen.oidc.length + seen.usage.length).toBe(0)
})
