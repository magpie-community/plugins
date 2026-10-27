// Two Kiro accounts of one email, signed in with Google and with GitHub,
// are two accounts to Kiro, and magpie keeps both (#309): a sign-in is
// given a uid, the way it was signed in to, and magpie replaces an account
// of the same email only when the two uids agree or either has none
// (magpie's host.js settle). A sign-in again the same way still replaces
// its account; one kept before the uid was is given it, so a sign-in the
// other way no longer replaces it.
//
// magpie names a plugin's account by its accountId, and two of one email
// read "email (slot)"; the accountId is the email and the way it was
// signed in to, "email (Google)", "email (GitHub)" (#309), and an account
// kept by its bare email is given that name when next used.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { get } from "node:http"
import { Database } from "bun:sqlite"

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
const cliDir = () =>
  process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "kiro-cli") : join(homedir(), ".local", "share", "kiro-cli")
afterEach(() => {
  globalThis.fetch = offline
  rmSync(cliDir(), { recursive: true, force: true })
})

const EMAIL = "same@example.com"
const GOOGLE = EMAIL + " (Google)"
const GITHUB = EMAIL + " (GitHub)"
const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"

// Kiro's auth service gives a token for each code, and its management API
// names every account EMAIL
function kiro() {
  let n = 0
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token"))
      return Response.json({ accessToken: "a" + ++n, refreshToken: "r" + n, expiresIn: 3600, profileArn: PROFILE })
    if (String(url).startsWith("https://management."))
      return Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: EMAIL } })
    throw new Error("unexpected request to " + url)
  }
}

// signIn runs the browser sign-in as Kiro's page ends it: back to the
// plugin's port with the code and the way it was signed in to
async function signIn(hooks, option) {
  const m = hooks.auth.methods[0]
  const a = await m.authorize()
  const q = new URL(a.url).searchParams
  const back = new URL(q.get("redirect_uri"))
  back.pathname = "/oauth/callback"
  back.search = new URLSearchParams({ state: q.get("state"), code: "code-" + option, login_option: option }).toString()
  await new Promise((ok, fail) => get(back, (res) => (res.resume(), res.on("end", ok))).on("error", fail))
  return a.callback()
}

// settle is magpie's (internal/plugin/host.js settle): a sign-in saved at
// key replaces an account of the same accountId, unless both have a uid
// and the two differ
function settle(all, key) {
  const now = all[key]
  for (const k of Object.keys(all)) {
    if (k === key) continue
    const was = all[k]
    const other = now.uid && was.uid && now.uid !== was.uid
    if (now.accountId && was.accountId === now.accountId && !other) {
      all[k] = now
      delete all[key]
      return k
    }
  }
  return key
}
let next = 0
const keep = (all, r) => {
  const { type: _t, provider: _p, ...rest } = r
  const key = "kiro#" + next++
  all[key] = { type: "oauth", ...rest }
  return settle(all, key)
}

test("a Google and a GitHub sign-in of one email are two accounts; the same way again replaces its own", async () => {
  kiro()
  const hooks = await plugin({ client: { auth: { set: async () => {} } } })
  const google = await signIn(hooks, "google")
  const github = await signIn(hooks, "github")
  expect(google).toMatchObject({ type: "success", accountId: GOOGLE, loginProvider: "Google", uid: "google" })
  expect(github).toMatchObject({ type: "success", accountId: GITHUB, loginProvider: "Github", uid: "github" })

  const all = {}
  const g = keep(all, google)
  const h = keep(all, github)
  expect(Object.keys(all)).toHaveLength(2)
  expect(g).not.toBe(h)

  const again = await signIn(hooks, "google")
  expect(keep(all, again)).toBe(g)
  expect(Object.keys(all)).toHaveLength(2)
  expect(all[g].access).toBe(again.access)
  expect(all[h].access).toBe(github.access)
}, 20_000)

test("an account kept before the uid was is given it, by a renewal and by a request", async () => {
  const old = { type: "oauth", access: "old", refresh: "r0", expires: Date.now() + 60_000, method: "social", loginProvider: "Google",
    region: "us-east-1", profileArn: PROFILE, accountId: EMAIL }

  // magpie's renewal keeps the fields it gives over the old
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/refreshToken")) return Response.json({ accessToken: "new", refreshToken: "r1", expiresIn: 3600 })
    throw new Error("unexpected request to " + url)
  }
  let hooks = await plugin({ client: { auth: { set: async () => {} } } })
  expect(await hooks.auth.refresh(old)).toMatchObject({ access: "new", uid: "google", accountId: GOOGLE })
  const kept = await hooks.auth.refresh({ ...old, uid: "google", accountId: GOOGLE })
  expect(kept).not.toHaveProperty("uid")
  expect(kept).not.toHaveProperty("accountId")

  // a request, the models or the usage save it, once
  globalThis.fetch = async () => Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: EMAIL } })
  const saves = []
  hooks = await plugin({ client: { auth: { set: async (r) => void saves.push(r.body) } } })
  const stored = { ...old, expires: Date.now() + 3600_000 }
  await hooks.auth.usage(async () => stored)
  await hooks.auth.usage(async () => stored)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({ accountId: GOOGLE, loginProvider: "Google", uid: "google", access: "old" })

  // given it, a GitHub sign-in of the same email goes beside it
  const all = { kiro: { ...saves[0] } }
  expect(keep(all, { type: "success", accountId: GITHUB, uid: "github", access: "gh" })).not.toBe("kiro")
  expect(Object.keys(all)).toHaveLength(2)
  // and a Google one replaces it
  expect(keep(all, { type: "success", accountId: GOOGLE, uid: "google", access: "g2" })).toBe("kiro")
  expect(Object.keys(all)).toHaveLength(2)
})

test("an account kept by its bare email is given its name on first use, and a sign-in the same way then replaces it", async () => {
  globalThis.fetch = async () => Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: EMAIL } })
  const saves = []
  const hooks = await plugin({ client: { auth: { set: async (r) => void saves.push(r.body) } } })
  // kept by 0.1.13: its uid, and the bare email
  const old = { type: "oauth", access: "old", refresh: "r0", expires: Date.now() + 3600_000, method: "social", loginProvider: "Github",
    uid: "github", region: "us-east-1", profileArn: PROFILE, accountId: EMAIL }
  const u = await hooks.auth.usage(async () => old)
  expect(u.user).toBe(GITHUB)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({ accountId: GITHUB, uid: "github", access: "old" })

  // the way it was signed in to, each named as Kiro's sign-in page names it
  for (const [way, name] of [["BuilderId", "Builder ID"], ["Enterprise", "IAM Identity Center"], ["Internal", "Internal"]]) {
    saves.length = 0
    await hooks.auth.usage(async () => ({ ...old, access: "t-" + way, method: "idc", loginProvider: way, uid: undefined }))
    expect(saves[0]).toMatchObject({ accountId: `${EMAIL} (${name})`, uid: way.toLowerCase() })
  }

  // named, a GitHub sign-in again replaces it, and a Google one goes beside it
  const all = { kiro: { ...saves[0], ...{ accountId: GITHUB, uid: "github" } } }
  kiro()
  const again = await signIn(hooks, "github")
  expect(keep(all, again)).toBe("kiro")
  expect(Object.keys(all)).toHaveLength(1)
  expect(keep(all, await signIn(hooks, "google"))).not.toBe("kiro")
  expect(Object.keys(all)).toHaveLength(2)
}, 20_000)

test("kiro-cli's sign-in, with no way known, keeps the bare email", async () => {
  mkdirSync(cliDir(), { recursive: true })
  const db = new Database(join(cliDir(), "data.sqlite3"), { create: true })
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)")
  db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({ access_token: "t", refresh_token: "r",
    expires_at: new Date(Date.now() + 3600_000).toISOString(), region: "us-east-1", profile_arn: PROFILE }))
  db.close()
  globalThis.fetch = async () => Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: EMAIL } })
  const saves = []
  const hooks = await plugin({ client: { auth: { set: async (r) => void saves.push(r.body) } } })
  const r = await (await hooks.auth.methods[1].authorize()).callback()
  expect(r).toMatchObject({ type: "success", source: "kiro-cli", accountId: EMAIL })
  const u = await hooks.auth.usage(async () => ({ type: "oauth", source: "kiro-cli", access: "", refresh: "", expires: 0, accountId: EMAIL }))
  expect(u.user).toBe(EMAIL)
  expect(saves).toHaveLength(0)
})

test("an account with its uid, or with no way known, isn't saved for one", async () => {
  globalThis.fetch = async () => Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: EMAIL } })
  const saves = []
  const hooks = await plugin({ client: { auth: { set: async (r) => void saves.push(r.body) } } })
  const base = { type: "oauth", access: "t", refresh: "r", expires: Date.now() + 3600_000, method: "social", region: "us-east-1",
    profileArn: PROFILE, accountId: EMAIL }
  await hooks.auth.usage(async () => ({ ...base, loginProvider: "Github", uid: "github", accountId: GITHUB }))
  await hooks.auth.usage(async () => ({ ...base, access: "t2" })) // no way known: nothing to give it
  expect(saves).toHaveLength(0)
})
