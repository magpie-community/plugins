// plugins#1670: a models listing saves the sign-in only when its token
// changed. Each client.auth.set has magpie read every sign-in again, and
// before magpie v0.1.4992 it listed every plugin again too, without end.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let WorkBuddyAIAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ WorkBuddyAIAuthPlugin, _internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = offline
  _internal.renewing.clear()
  _internal.renewed.clear()
  _internal.aheadHeld.clear()
})

const ok = (data) => Response.json({ code: 0, msg: "ok", data })
const CONFIG = {
  agents: [{ name: "cli", models: ["default-model"] }],
  models: [{ id: "default-model", credits: "x1.00 credits" }],
}

// serve answers WorkBuddy AI's refresh with refresh() and its model list.
function serve(refresh) {
  const calls = []
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    calls.push(u.pathname)
    if (u.pathname === "/v2/plugin/auth/token/refresh") return ok(refresh())
    if (u.pathname === "/v3/config") return ok(CONFIG)
    return new Response("not here", { status: 404 })
  }
  return calls
}
const refreshes = (calls) => calls.filter((p) => p === "/v2/plugin/auth/token/refresh").length
const DAY = 86400_000
// a JWT issued lifeDays ago with leftDays to go, as WorkBuddy mints them
const tokenOf = (lifeDays, leftDays) => {
  const now = Date.now()
  const c = { iat: Math.floor((now - lifeDays * DAY) / 1000), exp: Math.floor((now + leftDays * DAY) / 1000) }
  return "h." + Buffer.from(JSON.stringify(c)).toString("base64url") + ".s"
}
const signIn = (access, leftDays) => ({ type: "oauth", access, refresh: "r1", expires: Date.now() + leftDays * DAY, refreshExpiresAt: Date.now() + (leftDays + 2) * DAY, uid: "u1", domain: "" })

async function plugin() {
  const sets = []
  const h = await WorkBuddyAIAuthPlugin({ client: { auth: { set: async (x) => sets.push(x) } } })
  const config = {}
  await h.config(config)
  const list = (auth) => h.provider.models(config.provider["workbuddy-ai"], { auth })
  return { sets, list }
}

test("listing models twice with an unchanged token saves nothing", async () => {
  const calls = serve(() => { throw new Error("not due: nothing renews") })
  const { sets, list } = await plugin()
  const stored = signIn(tokenOf(0.5, 27.5), 27.5)
  for (let i = 0; i < 2; i++) expect(Object.keys(await list(stored))).toContain("default-model")
  expect(refreshes(calls)).toBe(0)
  expect(sets.length).toBe(0)
})

// A refresh can hand the same token back. Up to 0.2.45 each listing a
// minute apart (past KEEP_RENEWED_MS) renewed the day-old sign-in again
// and saved it unchanged: three listings, three saves.
test("an ahead renewal that gives the same token back saves nothing, and is held like a failed one", async () => {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    const aged = tokenOf(1.5, 26.5) // a day old: renewed ahead (plugins#1598)
    const calls = serve(() => ({ accessToken: aged, refreshToken: "r1", expiresIn: 26.5 * 86400 }))
    const { sets, list } = await plugin()
    const stored = signIn(aged, 26.5)
    for (let i = 0; i < 3; i++) {
      expect(Object.keys(await list(stored))).toContain("default-model")
      now += 61_000
    }
    expect(sets.length).toBe(0)
    // asked at 0 and at 61s, when the minute's hold ended; held two
    // minutes then, so not at 122s
    expect(refreshes(calls)).toBe(2)
  } finally {
    Date.now = realNow
  }
})

test("an ahead renewal is saved once, and the renewed sign-in listed again saves nothing", async () => {
  let n = 0
  const calls = serve(() => ({ accessToken: tokenOf(0, 28), refreshToken: `r${++n + 1}`, expiresIn: 28 * 86400, refreshExpiresIn: 30 * 86400 }))
  const { sets, list } = await plugin()
  await list(signIn(tokenOf(1.5, 26.5), 26.5))
  expect(sets.length).toBe(1)
  expect(sets[0].body.refresh).toBe("r2")
  // magpie hands the next listing what was saved
  for (let i = 0; i < 2; i++) await list(sets[0].body)
  expect(sets.length).toBe(1)
  expect(refreshes(calls)).toBe(1)
})

test("a refresh that gives the same tokens is no new sign-in; another access or refresh token is", () => {
  const a = { access: "a1", refresh: "r1", expires: 1, domain: "", tokenType: "Bearer" }
  expect(_internal.renewedTokens(a, { ...a, expires: 2 })).toBe(false)
  expect(_internal.renewedTokens(a, { ...a, access: "a2" })).toBe(true)
  expect(_internal.renewedTokens(a, { ...a, refresh: "r2" })).toBe(true)
})
