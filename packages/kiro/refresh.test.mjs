// magpie renews a sign-in kept here ahead of its end through auth.refresh,
// under the same lock as a request's own refresh, so one refresh token is
// never spent twice; OpenCode, which doesn't call it, still refreshes
// before a request.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in (~/.kiro, ~/.aws, kiro-cli's) is ever read or written
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = offline))

const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const REFRESH = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
const signIn = (over = {}) => ({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() + 5 * 60_000, method: "social",
  region: "us-east-1", profileArn: PROFILE, accountId: "me@example.com", ...over })

// kiro answers the refresh with the given status (and a new token when
// 200), and every request to Kiro's API with a 500; it notes both.
function kiro(status = 200, wait = 0) {
  const seen = { refreshes: [], sent: [] }
  globalThis.fetch = async (url, init) => {
    if (String(url) === REFRESH) {
      seen.refreshes.push(JSON.parse(init.body))
      if (wait) await new Promise((r) => setTimeout(r, wait))
      if (status !== 200) return new Response("{}", { status })
      return Response.json({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 })
    }
    // the experiment read before a chat (plugins#842) is no request's send
    if (new URL(String(url)).pathname !== "/featureConfiguration") seen.sent.push(new Headers(init.headers).get("Authorization"))
    return new Response(JSON.stringify({ message: "boom" }), { status: 500 })
  }
  return seen
}
const hooksWith = async () => {
  const saves = []
  const hooks = await plugin({ client: { auth: { set: async (r) => void saves.push(r) } } })
  return { hooks, saves }
}

test("magpie renews a sign-in ahead of its end; magpie saves what it gives", async () => {
  const seen = kiro()
  const { hooks, saves } = await hooksWith()
  expect(hooks.auth.refreshLead).toBeGreaterThanOrEqual(2 * 60_000)
  const got = await hooks.auth.refresh(signIn())
  expect(got).toEqual({ access: "new", refresh: "r2", expires: expect.any(Number) })
  expect(got.expires).toBeGreaterThan(Date.now() + 50 * 60_000)
  expect(seen.refreshes).toEqual([{ refreshToken: "r1" }])
  expect(saves).toEqual([])
})

test("a request's refresh and magpie's renewal spend the refresh token once", async () => {
  const seen = kiro(200, 50)
  const { hooks } = await hooksWith()
  const stored = signIn({ expires: Date.now() - 1000 }) // the store keeps the old one throughout
  const l = await hooks.auth.loader(async () => stored)
  const ask = () => l.fetch("https://kiro.invalid/v1/messages", { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }) })
  const [res, got] = await Promise.all([ask(), hooks.auth.refresh(stored)])
  expect(res.status).toBe(500)
  expect(got).toMatchObject({ access: "new", refresh: "r2" })
  expect(seen.refreshes.length).toBe(1)
  // the renewal not yet saved, a request goes on with its token
  await ask()
  expect(seen.refreshes.length).toBe(1)
  expect(seen.sent).toEqual(["Bearer new", "Bearer new"])
  // and asked again before magpie saved it, the same is given
  expect(await hooks.auth.refresh(stored)).toMatchObject({ access: "new", refresh: "r2" })
  expect(seen.refreshes.length).toBe(1)
})

// as the built-in, a refusal doesn't mark the account lapsed either
test("a refresh token Kiro refused is thrown plainly, the account not marked", async () => {
  for (const status of [400, 401, 403]) {
    kiro(status)
    const { hooks } = await hooksWith()
    const e = await hooks.auth.refresh(signIn()).catch((e) => e)
    expect(e.message).toBe("Kiro's sign-in has expired; sign in again with `kiro-cli login` or the Kiro IDE")
    expect(e.signIn).toBeUndefined()
  }
})

test("any other failure is thrown plainly, to be tried again", async () => {
  kiro(503)
  let { hooks } = await hooksWith()
  let e = await hooks.auth.refresh(signIn()).catch((e) => e)
  expect(e.message).toBe("refreshing Kiro's sign-in: 503 Service Unavailable")
  expect(e.signIn).toBeUndefined()
  ;({ hooks } = await hooksWith())
  globalThis.fetch = offline
  e = await hooks.auth.refresh(signIn()).catch((e) => e)
  expect(e.message).toBe("refreshing Kiro's sign-in: no network in tests")
  expect(e.signIn).toBeUndefined()
})

test("nothing to renew with is nothing renewed", async () => {
  const seen = kiro()
  const { hooks } = await hooksWith()
  expect(await hooks.auth.refresh(signIn({ refresh: "" }))).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "api", key: "ksk_x" })).toBeUndefined()
  // kiro-cli's and the IDE's sign-ins are their owners' to refresh
  expect(await hooks.auth.refresh({ type: "oauth", access: "", refresh: "", expires: 0, source: "kiro-cli" })).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "oauth", access: "a", refresh: "r", expires: 1, source: "kiro-ide" })).toBeUndefined()
  expect(seen.refreshes).toEqual([])
})
