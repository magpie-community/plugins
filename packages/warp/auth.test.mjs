// Every account, application read and HTTP endpoint here is synthetic.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const token = (email, minutes = 60) => `${b64({ alg: "RS256" })}.${b64({ email, sub: email, exp: Math.floor(Date.now() / 1000) + minutes * 60 })}.sig`
const account = (over = {}) => ({ type: "oauth", access: token("a@test.invalid"), refresh: "old", expires: Date.now() + 3600_000, accountId: "a@test.invalid", ...over })
const appUser = (email = "a@test.invalid", minutes = 60, refresh = "app-refresh") => ({
  email, local_id: email, id_token: { id_token: token(email, minutes), refresh_token: refresh, expiration_time: new Date(Date.now() + minutes * 60_000).toISOString() },
})
const client = { auth: { set: async () => {} } }

test("app and manual sign-in record separate sources and identities", async () => {
  const p = await _internal.createPlugin({ client }, { readUser: async () => appUser() })
  const saved = await (await p.auth.methods[0].authorize()).callback()
  expect(saved.metadata).toMatchObject({ source: "app", uid: "a@test.invalid", email: "a@test.invalid" })
  expect(saved.metadata.session).toBeTruthy()
  globalThis.fetch = async () => Response.json({ id_token: token("b@test.invalid"), refresh_token: "rotated", expires_in: "3600" })
  const manual = await p.auth.methods[1].authorize("manual-refresh")
  expect(manual).toMatchObject({ accountId: "b@test.invalid", metadata: { source: "manual", uid: "b@test.invalid" } })
})

test("refresh preserves an existing refresh token if the server does not rotate it", async () => {
  globalThis.fetch = async () => Response.json({ id_token: token("a@test.invalid"), expires_in: "3600" })
  expect((await _internal.exchange("keep-this")).refresh).toBe("keep-this")
})

for (const code of ["INVALID_REFRESH_TOKEN", "invalid_grant", "TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND"]) {
  test(`${code} marks the account expired`, async () => {
    globalThis.fetch = async () => Response.json({ error: { message: code } }, { status: 400 })
    try { await _internal.exchange("invalid"); throw new Error("expected failure") }
    catch (e) { expect(e).toMatchObject({ status: 401, signIn: "expired" }) }
  })
}

test("transient token failures do not mark a login expired", async () => {
  globalThis.fetch = async () => Response.json({ error: { message: "temporary failure" } }, { status: 503 })
  try { await _internal.exchange("old") } catch (e) { expect(e.status).toBe(503); expect(e.signIn).toBeUndefined() }
  globalThis.fetch = async () => { throw new Error("offline") }
  await expect(_internal.exchange("old")).rejects.toThrow("offline")
})

test("valid manual and legacy credentials never read the app", async () => {
  let reads = 0, writes = 0
  const live = _internal.createTokenSession({ auth: { set: async () => writes++ } }, async () => { reads++; return appUser("other@test.invalid") })
  for (const metadata of [undefined, { source: "manual" }]) {
    const auth = account({ metadata })
    expect((await live(auth)).access).toBe(auth.access)
  }
  expect(reads).toBe(0)
  expect(writes).toBe(0)
})

test("an app account change cannot replace the signed-in identity", async () => {
  let written
  globalThis.fetch = async () => Response.json({ id_token: token("a@test.invalid"), refresh_token: "own-fresh", expires_in: "3600" })
  const live = _internal.createTokenSession({ auth: { set: async (v) => (written = v.body) } }, async () => appUser("other@test.invalid"))
  const auth = account({ expires: 1, access: "expired", metadata: { source: "app", uid: "a@test.invalid" } })
  await live(auth, { getAuth: async () => auth })
  expect(written.refresh).toBe("own-fresh")
})

test("an older app token cannot replace a newer stored token", async () => {
  let calls = 0
  const live = _internal.createTokenSession(client, async () => appUser("a@test.invalid", 20))
  globalThis.fetch = async () => { calls++; return Response.json({ id_token: token("a@test.invalid"), refresh_token: "fresh", expires_in: "3600" }) }
  const auth = account({ metadata: { source: "app", uid: "a@test.invalid" } })
  expect((await live(auth, { force: true })).refresh).toBe("fresh")
  expect(calls).toBe(1)
})

test("simultaneous chat, usage and refresh share one exchange and one write", async () => {
  let finish, requests = 0, current
  const writes = []
  globalThis.fetch = async () => { requests++; return await new Promise((r) => (finish = r)) }
  const live = _internal.createTokenSession({ auth: { set: async (v) => { writes.push(v.body.refresh); current = v.body } } }, async () => null)
  const auth = account({ access: "expired", expires: 1 })
  current = auth
  const getAuth = async () => current
  const jobs = [live(auth, { getAuth }), live(auth), live(auth, { force: true })]
  await new Promise((r) => setTimeout(r, 0))
  expect(requests).toBe(1)
  finish(Response.json({ id_token: token("a@test.invalid"), refresh_token: "next", expires_in: "3600" }))
  expect((await Promise.all(jobs)).map((v) => v.refresh)).toEqual(["next", "next", "next"])
  expect(writes).toEqual(["next"])
  expect((await live(auth)).refresh).toBe("next")
  expect(writes).toEqual(["next"])
})

test("a refreshed app file recovers from a rotation race before marking expired", async () => {
  let reads = 0, requests = 0
  const auth = account({ access: "expired", expires: 1, metadata: { source: "app", uid: "a@test.invalid" } })
  const live = _internal.createTokenSession(client, async () => ++reads === 1 ? appUser("a@test.invalid", -1, "old") : appUser("a@test.invalid", 60, "new-app"))
  globalThis.fetch = async () => { requests++; return Response.json({ error: { message: "invalid_grant" } }, { status: 400 }) }
  expect((await live(auth)).refresh).toBe("new-app")
  expect(requests).toBe(1)
  expect(reads).toBe(2)
})

test("a sign-out during refresh is not undone by remember", async () => {
  let written = 0
  globalThis.fetch = async () => Response.json({ id_token: token("a@test.invalid"), refresh_token: "next", expires_in: "3600" })
  const live = _internal.createTokenSession({ auth: { set: async () => written++ } }, async () => null)
  await live(account({ access: "expired", expires: 1 }), { getAuth: async () => null })
  expect(written).toBe(0)
})

test("snapshot-only model discovery cannot resurrect an account after sign-out", async () => {
  let finish, writes = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes("securetoken")) return await new Promise((r) => (finish = r))
    throw new Error("offline discovery")
  }
  const p = await _internal.createPlugin({ client: { auth: { set: async () => writes++ } } }, { readUser: async () => null })
  const pending = p.provider.models({ models: {} }, { auth: account({ access: "expired", expires: 1 }) })
  await new Promise((r) => setTimeout(r, 0))
  // The auth snapshot passed to models() is no longer authoritative here.
  finish(Response.json({ id_token: token("a@test.invalid"), refresh_token: "fresh", expires_in: "3600" }))
  await pending
  expect(writes).toBe(0)
})

test("a newer stored token in the same session is not overwritten", async () => {
  let finish, writes = 0
  globalThis.fetch = async () => await new Promise((r) => (finish = r))
  const auth = account({ access: "expired", expires: 1, metadata: { session: "same-session", source: "manual" } })
  let current = auth
  const live = _internal.createTokenSession({ auth: { set: async () => writes++ } }, async () => null)
  const pending = live(auth, { getAuth: async () => current })
  await new Promise((r) => setTimeout(r, 0))
  current = { ...auth, access: token("a@test.invalid", 120), refresh: "newer", expires: Date.now() + 7200_000 }
  finish(Response.json({ id_token: token("a@test.invalid"), refresh_token: "older", expires_in: "3600" }))
  expect((await pending).refresh).toBe("newer")
  expect(writes).toBe(0)
})

test("a refresh without a current auth reader is persisted only when one becomes available", async () => {
  let writes = 0
  globalThis.fetch = async () => Response.json({ id_token: token("a@test.invalid"), refresh_token: "next", expires_in: "3600" })
  const auth = account({ access: "expired", expires: 1 })
  const live = _internal.createTokenSession({ auth: { set: async () => writes++ } }, async () => null)
  await live(auth, { force: true })
  expect(writes).toBe(0)
  expect((await live(auth, { getAuth: async () => auth })).refresh).toBe("next")
  expect(writes).toBe(1)
})
